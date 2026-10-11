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
  expect(result.workers.map(row => row.id)).toEqual(["review", "review.Scope"]);
  expect(result.workers[0]).toMatchObject({ state: "running", model: "fixture-model", currentTool: "read", lastActivity: "Reading scrubbed evidence", outputTail: ["Scrubbed review progress"] });
  expect(result.children[1]).toMatchObject({ id: "review.Scope", parentId: "review", nesting: 1, status: "active", agentType: "reviewer" });
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
  expect(result.workers).toMatchObject([{ id: "review", state: "idle", model: "chosen", outputTail: ["Finished branch"] }]);
  expect(result.workers[0]?.lastActivity).toBeUndefined();
});

test("old unresolved starts never remain active; settled and dead lifecycle win over fresh child", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path);
  const old = new Date(Date.now() - 10 * 60_000); await utimes(path, old, old);
  const stale = await readTranscriptChildren(f.path, f.entries, [f.root]);
  expect(stale.workers[0]).toMatchObject({ state: "idle" }); expect(stale.children[0]?.status).toBe("unknown");
  await utimes(path, new Date(), new Date());
  for (const [action, state] of [["turn-settled", "idle"], ["tombstone", "dead"]]) {
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
  expect((await readTranscriptChildren(large.path, largeEntries, [large.root])).workers.map(row => row.id)).toEqual(["c", "b"]);
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
  expect(result.children.find(row => row.id === "named")).toMatchObject({ status: "unknown", description: "Named review" });
  expect(result.children.find(row => row.id === "generated")).toMatchObject({ status: "active", description: "Generated review" });
  expect(result.workers.map(row => row.id)).toEqual(["generated"]);
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
  expect(result.children.find(row => row.id === "review")).toMatchObject({ status: "active" });
  expect(result.workers.find(row => row.id === "review")).toMatchObject({ currentTool: "read" });
  expect(result.children.length).toBeLessThanOrEqual(64);
});

test("observed elapsed stays frozen across polls on unchanged disk", async () => {
  const f = await fixture(); const path = join(f.childDir, "review.jsonl"); await child(path);
  const first = await readTranscriptChildren(f.path, f.entries, [f.root]);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
  try { expect(await readTranscriptChildren(f.path, f.entries, [f.root])).toEqual(first); }
  finally { clock.mockRestore(); }
});
