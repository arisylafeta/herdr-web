import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscriptChildren } from "./transcript-children";

type Entry = Record<string, unknown>;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const header: Entry = { type: "session", id: "root" };
function lifecycle(id: string, parentId: string, childId: string, action = "spawn"): Entry {
  return { type: "custom", id, parentId, timestamp: new Date().toISOString(), customType: "vibe-session-lifecycle", data: { version: 1, id: childId, action, childSessionFile: `${childId}.jsonl`, cli: "good", agent: "task", turn: 2 } };
}
async function fixture(entries: Entry[] = [header, lifecycle("spawn", "root", "review"), lifecycle("turn", "spawn", "review", "turn-started")]) {
  const root = await mkdtemp(join(tmpdir(), "herdr-children-")); dirs.push(root);
  const path = join(root, "session.jsonl"), childDir = join(root, "session");
  await mkdir(childDir); await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { root, path, childDir, entries };
}
async function child(path: string, entries: Entry[] = [{ type: "session", id: "child" }, { type: "custom", id: "start", parentId: "child", customType: "tool_execution_start", data: { toolCallId: "call", toolName: "read", intent: "Reading evidence" } }]) {
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

test("scrubbed lifecycle fixtures recover current child and nested referenced task, not stray files", async () => {
  const fixtureEntries = (await readFile(join(import.meta.dir, "fixtures/omp/lifecycle-children.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Entry);
  const f = await fixture(fixtureEntries);
  await writeFile(join(f.childDir, "review.jsonl"), await readFile(join(import.meta.dir, "fixtures/omp/lifecycle-child.jsonl")));
  await mkdir(join(f.childDir, "review"));
  await child(join(f.childDir, "review/review.Scope.jsonl"));
  await child(join(f.childDir, "stray.jsonl"));
  const result = await readTranscriptChildren(f.path, f.entries, [f.root]);
  expect(result.workers.map(row => row.handle)).toEqual(["review", "review.Scope"]);
  expect(result.workers[0]).toMatchObject({ state: "running", model: "fixture-model", currentTool: "read", lastActivity: "Reading scrubbed evidence", outputTail: ["Scrubbed review progress"] });
  expect(result.children[1]).toMatchObject({ handle: "review.Scope", parentId: result.children[0]!.id, nesting: 1, status: "active", agentType: "reviewer" });
  expect(result.childUpdatedAt).toBeDefined();
  expect(JSON.stringify(result)).not.toContain(f.root);
});

test("only active parent and child branches contribute lifecycle or activity", async () => {
  const entries = [header, lifecycle("discarded", "root", "discarded"), lifecycle("spawn", "root", "review"), lifecycle("turn", "spawn", "review", "turn-started")];
  const f = await fixture(entries);
  await child(join(f.childDir, "discarded.jsonl"));
  await child(join(f.childDir, "review.jsonl"), [
    { type: "session", id: "child" },
    { type: "custom", id: "abandoned", parentId: "child", customType: "tool_execution_start", data: { toolCallId: "old", toolName: "bash", intent: "Discarded activity" } },
    { type: "message", id: "answer", parentId: "child", message: { role: "assistant", model: "chosen", stopReason: "stop", content: "Finished branch" } },
  ]);
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(result.workers).toMatchObject([{ handle: "review", state: "idle", model: "chosen", outputTail: ["Finished branch"] }]);
  expect(result.workers[0]?.lastActivity).toBeUndefined();
});

test("old unresolved starts never remain active; settled and dead lifecycle win over fresh child", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path);
  const old = new Date(Date.now() - 10 * 60_000); await utimes(path, old, old);
  const stale = await readTranscriptChildren(f.path, f.entries, [f.root]);
  expect(stale.workers[0]).toMatchObject({ state: "idle" }); expect(stale.children[0]?.status).toBe("unknown");
  await utimes(path, new Date(), new Date());
  for (const [action, state] of [["turn-settled", "idle"], ["tombstone", "dead"]] as const) {
    const result = await readTranscriptChildren(f.path, [...f.entries, lifecycle("end", "turn", "review", action)], [f.root]);
    expect(result.workers[0]?.state).toBe(state); expect(result.workers[0]?.currentTool).toBeUndefined();
    expect(result.children[0]?.status).not.toBe("active");
  }
});

test("completed tools clear current tool without declaring the worker finished", async () => {
  const f = await fixture();
  await child(join(f.childDir, "review.jsonl"), [
    { type: "session", id: "child" },
    { type: "custom", id: "start", parentId: "child", customType: "tool_execution_start", data: { toolCallId: "call", toolName: "read", intent: "Reading evidence" } },
    { type: "message", id: "result", parentId: "start", message: { role: "toolResult", toolCallId: "call", content: "Done" } },
  ]);
  const result = await readTranscriptChildren(f.path, f.entries, [f.root]);
  expect(result.workers[0]).toMatchObject({ state: "running", lastActivity: "Reading evidence" });
  expect(result.workers[0]?.currentTool).toBeUndefined();
});

test("rejects traversal, mismatched lifecycle filenames, foreign roots and symlinks at every level", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path);
  expect((await readTranscriptChildren(f.path, f.entries, [join(f.root, "other")])).workers).toEqual([]);
  const bad = lifecycle("bad", "root", "../review");
  expect((await readTranscriptChildren(f.path, [header, bad], [f.root])).workers).toEqual([]);
  const mismatch = lifecycle("bad", "root", "review"); (mismatch.data as Entry).childSessionFile = "other.jsonl";
  expect((await readTranscriptChildren(f.path, [header, mismatch], [f.root])).workers).toEqual([]);
  await rm(path); await symlink(f.path, path);
  expect((await readTranscriptChildren(f.path, f.entries, [f.root])).workers).toEqual([]);
  await rm(f.childDir, { recursive: true }); await mkdir(join(f.root, "target")); await child(join(f.root, "target/review.jsonl")); await symlink(join(f.root, "target"), f.childDir);
  expect((await readTranscriptChildren(f.path, f.entries, [f.root])).workers).toEqual([]);
  const alias = join(f.root, "alias"); await symlink(f.root, alias);
  expect((await readTranscriptChildren(join(alias, "session.jsonl"), f.entries, [alias])).workers).toEqual([]);
});

test("foreign uid child is omitted", async () => {
  if (process.getuid?.() !== 0) return;
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path); await chmod(path, 0o644); await chown(path, 65534, 65534);
  expect((await readTranscriptChildren(f.path, f.entries, [f.root])).workers).toEqual([]);
});

test("count, recursion, per-file and total byte caps bound disk reads", async () => {
  const entries: Entry[] = [header];
  for (let i = 0; i < 70; i++) entries.push(lifecycle(`spawn${i}`, i ? `spawn${i - 1}` : "root", `worker${i}`));
  const f = await fixture(entries);
  await Promise.all(Array.from({ length: 70 }, (_, i) => child(join(f.childDir, `worker${i}.jsonl`))));
  expect((await readTranscriptChildren(f.path, entries, [f.root])).workers).toHaveLength(64);
  const g = await fixture(); let dir = g.childDir;
  for (let depth = 0; depth < 6; depth++) {
    await child(join(dir, "review.jsonl"), [{ type: "session", id: "child" }, lifecycle("spawn", "child", "review")]);
    dir = join(dir, "review"); await mkdir(dir);
  }
  expect((await readTranscriptChildren(g.path, g.entries, [g.root])).children.map(row => row.nesting)).toEqual([0, 1, 2, 3]);
  const h = await fixture(); await writeFile(join(h.childDir, "review.jsonl"), "x".repeat(8 * 1024 * 1024 + 1));
  expect((await readTranscriptChildren(h.path, h.entries, [h.root])).workers).toEqual([]);
  const largeEntries = [header, lifecycle("a", "root", "a"), lifecycle("b", "a", "b"), lifecycle("c", "b", "c")];
  const large = await fixture(largeEntries);
  const body = JSON.stringify({ type: "session", id: "large", ignored: "x".repeat(6 * 1024 * 1024) }) + "\n";
  for (const id of ["a", "b", "c"]) await writeFile(join(large.childDir, `${id}.jsonl`), body);
  expect((await readTranscriptChildren(large.path, largeEntries, [large.root])).workers.map(row => row.handle)).toEqual(["c", "b"]);
});

test("output is bounded, paths and credential assignments scrubbed, torn tail ignored", async () => {
  const f = await fixture();
  const path = join(f.childDir, "review.jsonl");
  await child(path, [{ type: "session", id: "child" }, { type: "message", id: "text", parentId: "child", message: { role: "assistant", content: `older\n${"x".repeat(1000)}\n/secret/private/file token=secret\nlast`, stopReason: "stop" } }]);
  await writeFile(path, (await readFile(path, "utf8")) + '{"type":"custom","id":"torn"');
  const result = await readTranscriptChildren(f.path, f.entries, [f.root]);
  expect(result.workers[0]?.outputTail).toEqual(["x".repeat(320), "[path] [redacted]", "last"]);
  expect(result.workers[0]?.state).toBe("idle");
});

test("generated task IDs survive compacted results without toolName and missing details stay unknown", async () => {
  const entries: Entry[] = [header,
    { type: "message", id: "call", parentId: "root", message: { role: "assistant", content: [{ type: "toolCall", id: "task", name: "task", arguments: { tasks: [{ name: "named", agent: "reviewer", task: "Named review" }] } }] } },
    { type: "message", id: "ack", parentId: "call", message: { role: "toolResult", toolCallId: "task", details: { progress: [{ id: "generated", agent: "reviewer", task: "Generated review", status: "pending" }] } } },
  ];
  const f = await fixture(entries); await child(join(f.childDir, "generated.jsonl"));
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(result.children.find(row => row.handle === "named")).toMatchObject({ status: "unknown", description: "Named review" });
  expect(result.children.find(row => row.handle === "generated")).toMatchObject({ status: "active", description: "Generated review" });
  expect(result.workers.map(row => row.handle)).toEqual(["generated"]);
});

test("historical task references cannot evict an owned lifecycle worker", async () => {
  const f = await fixture();
  let parentId = String(f.entries.at(-1)?.id);
  const entries = [...f.entries];
  for (let i = 0; i < 100; i++) {
    const id = `old-call-${i}`;
    entries.push({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "toolCall", id, name: "task", arguments: { tasks: [{ name: `old-${i}`, task: "Historical example" }] } }] } });
    parentId = id;
  }
  await child(join(f.childDir, "review.jsonl"));
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(result.children.find(row => row.handle === "review")).toMatchObject({ status: "active" });
  expect(result.workers.find(row => row.handle === "review")).toMatchObject({ currentTool: "read" });
  expect(result.children.length).toBeLessThanOrEqual(64);
});

test("observed elapsed stays frozen across polls on unchanged disk", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path);
  const first = await readTranscriptChildren(f.path, f.entries, [f.root]);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
  try { expect(await readTranscriptChildren(f.path, f.entries, [f.root])).toEqual(first); }
  finally { clock.mockRestore(); }
});

test("opaque identity distinguishes dotted handles from nested ancestry and other sessions", async () => {
  const entries = [header, lifecycle("crew", "root", "crew"), lifecycle("flat", "crew", "crew.Review")];
  const f = await fixture(entries);
  await child(join(f.childDir, "crew.Review.jsonl"));
  await child(join(f.childDir, "crew.jsonl"), [{ type: "session", id: "child" }, lifecycle("nested", "child", "Review")]);
  await mkdir(join(f.childDir, "crew")); await child(join(f.childDir, "crew/Review.jsonl"));
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(new Set(result.children.map(row => row.id)).size).toBe(3);
  const crew = result.children.find(row => row.handle === "crew")!;
  const nested = result.children.find(row => row.parentId === crew.id)!;
  expect(nested.handle).toBe("crew.Review");
  expect(result.workers.find(row => row.id === nested.id)?.parentId).toBe(crew.id);
  expect(result.children.every(row => row.id !== row.handle)).toBe(true);
  expect(await readTranscriptChildren(f.path, entries, [f.root])).toEqual(result);
  const other = await fixture(entries);
  expect((await readTranscriptChildren(other.path, entries, [other.root])).children.map(row => row.id)).not.toEqual(result.children.filter(row => !row.parentId).map(row => row.id));
  expect(JSON.stringify(result)).not.toContain(f.root);
});

test("current peer reads precede dead historical byte consumers and skipped descriptors survive", async () => {
  const entries = [header, lifecycle("current", "root", "Current"), lifecycle("running", "current", "Current", "turn-started"),
    lifecycle("a", "running", "oldA"), lifecycle("deadA", "a", "oldA", "tombstone"),
    lifecycle("b", "deadA", "oldB"), lifecycle("deadB", "b", "oldB", "tombstone")];
  const f = await fixture(entries); await child(join(f.childDir, "Current.jsonl"));
  const body = JSON.stringify({ type: "session", id: "old", padding: "" });
  const large = body.slice(0, -2) + "x".repeat(8 * 1024 * 1024 - body.length - 1) + '"}\n';
  for (const id of ["oldA", "oldB"]) await writeFile(join(f.childDir, `${id}.jsonl`), large);
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(result.workers.find(row => (row.handle ?? row.id) === "Current")?.state).toBe("running");
  expect(result.children.map(row => row.handle).sort()).toEqual(["Current", "oldA", "oldB"]);
  expect(result.children.filter(row => row.childAvailable === false)).toHaveLength(1);
});

test("unknown child counters remain absent and only explicit lifecycle counts carry observation time", async () => {
  const spawn = lifecycle("spawn", "root", "review");
  const f = await fixture([header, spawn]); await child(join(f.childDir, "review.jsonl"));
  const unknown = (await readTranscriptChildren(f.path, f.entries, [f.root])).workers[0]!;
  expect(unknown.turns).toBeUndefined(); expect(unknown.queued).toBeUndefined();
  expect(unknown.turnsObservedAt).toBeUndefined(); expect(unknown.queuedObservedAt).toBeUndefined();
  const started = lifecycle("turn", "spawn", "review", "turn-started");
  const known = (await readTranscriptChildren(f.path, [...f.entries, started], [f.root])).workers[0]!;
  expect(known.turns).toBe(2); expect(known.turnsObservedAt).toBe(started.timestamp as string);
  delete (started.data as Entry).turn;
  expect((await readTranscriptChildren(f.path, [...f.entries, started], [f.root])).workers[0]?.turns).toBeUndefined();
});

test("child excerpts scrub authoritative file URIs punctuation and inherited ancestor paths", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl");
  await child(path, [{ type: "session", id: "child" }, lifecycle("nested", "child", "nested")]);
  await mkdir(join(f.childDir, "review")); const nested = join(f.childDir, "review/nested.jsonl");
  await child(nested, [{ type: "session", id: "nested" }, { type: "message", id: "out", parentId: "nested", message: { role: "assistant", content: `file://${nested} cwd:${path}; ancestor:file://${f.path}`, stopReason: "stop" } }]);
  const result = await readTranscriptChildren(f.path, f.entries, [f.root]);
  for (const authoritative of [nested, path, f.path]) expect(JSON.stringify(result)).not.toContain(authoritative);
  expect(result.workers.find(row => row.parentId)?.outputTail?.[0]).toContain("[path]");
});

test("every child descriptor identifies unavailable reference source or successful child evidence", async () => {
  const entries = [header, lifecycle("spawn", "root", "missing"),
    { type: "custom", id: "call", parentId: "spawn", customType: "tool_execution_start", data: { toolName: "task", toolCallId: "task", args: { tasks: [{ name: "named" }] } } },
    { type: "message", id: "ack", parentId: "call", message: { role: "toolResult", toolCallId: "task", details: { progress: [{ id: "generated" }, { id: "readable" }] } } }];
  const f = await fixture(entries); await child(join(f.childDir, "readable.jsonl"));
  await writeFile(join(f.childDir, "generated.jsonl"), "malformed\n");
  const rows = (await readTranscriptChildren(f.path, entries, [f.root])).children;
  for (const [handle, source, childAvailable] of [["missing", "lifecycle", false], ["named", "task-call", false], ["generated", "task-result", false], ["readable", "child", true]] as const)
    expect(rows.find(row => (row.handle ?? row.id) === handle)).toMatchObject({ source, childAvailable });
});

test("current references survive dead lifecycle descriptor pressure and peer reads precede recursion", async () => {
  const entries: Entry[] = [header];
  let parentId = "root";
  for (let index = 0; index < 64; index++) {
    const spawn = `spawn-${index}`, dead = `dead-${index}`;
    entries.push(lifecycle(spawn, parentId, `old${index}`), lifecycle(dead, spawn, `old${index}`, "tombstone"));
    parentId = dead;
  }
  entries.push({ type: "custom", id: "current", parentId, customType: "tool_execution_start", data: { toolName: "task", toolCallId: "task", args: { tasks: [{ name: "Current" }, { name: "Other" }] } } });
  const f = await fixture(entries); await child(join(f.childDir, "Current.jsonl")); await child(join(f.childDir, "Other.jsonl"));
  const projected = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(projected.children).toHaveLength(64);
  for (const handle of ["Current", "Other"]) expect(projected.workers.find(row => (row.handle ?? row.id) === handle)?.state).toBe("running");

  const peers = [header, lifecycle("peer", "root", "Peer"), lifecycle("crew", "peer", "Crew")];
  const g = await fixture(peers); await child(join(g.childDir, "Peer.jsonl"));
  const crew: Entry[] = [{ type: "session", id: "child" }];
  let ancestor = "child";
  for (let index = 0; index < 64; index++) {
    const id = `nested-${index}`; crew.push(lifecycle(id, ancestor, `nested${index}`)); ancestor = id;
  }
  await child(join(g.childDir, "Crew.jsonl"), crew);
  const result = await readTranscriptChildren(g.path, peers, [g.root]);
  expect(result.workers.find(row => (row.handle ?? row.id) === "Peer")?.currentTool).toBe("read");
  expect(result.children).toHaveLength(64);
});

test("newly discovered current descendants precede dead root byte consumers", async () => {
  const entries = [header, lifecycle("crew", "root", "Crew"),
    lifecycle("a", "crew", "oldA"), lifecycle("deadA", "a", "oldA", "tombstone"),
    lifecycle("b", "deadA", "oldB"), lifecycle("deadB", "b", "oldB", "tombstone")];
  const f = await fixture(entries);
  await child(join(f.childDir, "Crew.jsonl"), [{ type: "session", id: "child" }, lifecycle("current", "child", "Current"), lifecycle("run", "current", "Current", "turn-started")]);
  await mkdir(join(f.childDir, "Crew")); await child(join(f.childDir, "Crew/Current.jsonl"), [
    { type: "session", id: "current", padding: "x".repeat(16 * 1024) },
    { type: "custom", id: "read", parentId: "current", customType: "tool_execution_start", data: { toolCallId: "call", toolName: "read" } },
  ]);
  const prefix = JSON.stringify({ type: "session", id: "old", padding: "" });
  const large = prefix.slice(0, -2) + "x".repeat(8 * 1024 * 1024 - 4096 - prefix.length - 1) + '"}\n';
  for (const id of ["oldA", "oldB"]) await writeFile(join(f.childDir, `${id}.jsonl`), large);
  const result = await readTranscriptChildren(f.path, entries, [f.root]);
  expect(result.workers.find(row => row.handle === "Crew.Current")?.currentTool).toBe("read");
  expect(result.children).toHaveLength(4);
  expect(result.children.filter(row => !row.childAvailable)).toHaveLength(1);
});
