import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTranscriptBranch, TranscriptStore } from "./transcript";
import { deriveTranscriptStatus } from "./transcript-status";

type Entry = Record<string, unknown>;
const roots: string[] = [];
const ts = "2026-10-11T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const header: Entry = { type: "session", id: "root" };
const phases = [{ name: "Ship", tasks: [{ content: "Verify behavior", status: "pending" }] }];
const todo: Entry = { type: "custom", customType: "user_todo_edit", id: "plan", parentId: "root", timestamp: ts, data: { phases } };
const hud = (id: string, parentId: string, visibility: string): Entry => ({ type: "custom", customType: "todo_hud_state", id, parentId, timestamp: ts, data: { sourceEntryId: "plan", fingerprint: JSON.stringify(phases), visibility } });
const line = (entry: Entry) => JSON.stringify(entry) + "\n";
async function fixture(entries: Entry[]) {
  const root = await mkdtemp(join(tmpdir(), "herdr-parent-review-")); roots.push(root);
  const path = join(root, "session.jsonl"); await writeFile(path, entries.map(line).join(""));
  const store = new TranscriptStore([root]);
  return { root, path, read: (limit = 60, status: "working" | "idle" = "working") => store.transcript("p1", "default", "omp", { kind: "path", value: path }, status, limit) };
}

test("canonical todo survives the history window and reflects HUD updates independent of limit", async () => {
  const entries = [header, todo];
  let parentId = "plan";
  for (let n = 0; n < 65; n++) {
    const id = `answer-${n}`; entries.push({ type: "message", id, parentId, timestamp: ts, message: { role: "assistant", content: `Answer ${n}` } }); parentId = id;
  }
  const f = await fixture(entries), before = await f.read();
  expect(before.records.some(record => record.kind === "todo")).toBe(false);
  expect(before.hasEarlier).toBe(true);
  expect(before.status?.todo).toEqual({ id: "plan", ts, phases, visibility: "visible" });
  expect((await f.read(400)).status?.todo).toEqual(before.status?.todo);
  const beforeOne = await f.read(1);
  await appendFile(f.path, line(hud("dismiss", parentId, "dismissed")));
  const dismissed = await f.read(1);
  expect(dismissed.status?.todo?.visibility).toBe("dismissed");
  expect(dismissed.revision).not.toBe(beforeOne.revision);
});

test("todo status follows the selected fork rather than a newer abandoned plan", async () => {
  const f = await fixture([header, todo, hud("dismiss", "plan", "dismissed"), { ...todo, id: "discarded", parentId: "dismiss", data: { phases: [{ name: "Discarded", tasks: [] }] } }, { type: "message", id: "fork", parentId: "plan", message: { role: "assistant", content: "Selected branch" } }]);
  expect((await f.read(1)).status?.todo).toEqual({ id: "plan", ts, phases, visibility: "visible" });
});

test("compact normal stop matches raw status and clears stopped activity while Herdr is working", async () => {
  const entries = [header, { type: "message", id: "user", parentId: "root", timestamp: ts, message: { role: "user", content: "Work" } }, { type: "custom", id: "start", parentId: "user", timestamp: ts, customType: "tool_execution_start", data: { toolCallId: "call", toolName: "read", intent: "Old finished turn" } }];
  const f = await fixture(entries), running = await f.read();
  expect(running.status?.activity?.label).toBe("Old finished turn");
  const stopped: Entry = { type: "message", id: "stop", parentId: "start", timestamp: ts, message: { role: "assistant", stopReason: "stop", content: "Done" } };
  entries.push(stopped); await appendFile(f.path, line(stopped));
  const stored = await f.read(), raw = await deriveTranscriptStatus(activeTranscriptBranch(entries), "working", stored.status!.freshness.fileUpdatedAt);
  expect(raw.activity).toBeUndefined();
  expect(stored.status).toEqual(raw);
  expect(stored.revision).not.toBe(running.revision);
});

function spawn(id: string, parentId: string, handle: string): Entry {
  return { type: "custom", customType: "vibe-session-lifecycle", id, parentId, timestamp: ts, data: { version: 1, id: handle, action: "spawn", childSessionFile: `${handle}.jsonl`, cli: "good" } };
}
function wall(parentId: string, handle: string): Entry[] {
  return [{ type: "message", id: "wall-call", parentId, timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "wall", name: "vibe_list", arguments: {} }] } }, { type: "message", id: "wall-result", parentId: "wall-call", timestamp: ts, message: { role: "toolResult", toolCallId: "wall", content: "Saved wall", details: { op: "list", screens: [{ id: handle, state: "idle", turns: 4, queued: 3, model: "saved-model" }] } } }];
}
for (const available of [true, false]) test(`saved wall counters survive child ${available ? "without counters" : "unavailability"} with provenance`, async () => {
  const f = await fixture([header, spawn("spawn", "root", "review"), ...wall("spawn", "review")]);
  if (available) { await mkdir(join(f.root, "session")); await writeFile(join(f.root, "session/review.jsonl"), line({ type: "session", id: "child" })); }
  const rows = (await f.read()).status?.workers;
  expect(rows).toHaveLength(1);
  expect(rows?.[0]).toMatchObject({ handle: "review", turns: 4, queued: 3, turnsObservedAt: ts, queuedObservedAt: ts });
  expect(rows?.[0]?.id).not.toBe("review");
});

test("colliding flattened child handles preserve every opaque identity and parent relationship", async () => {
  const f = await fixture([header, spawn("spawn-crew", "root", "crew"), spawn("spawn-flat", "spawn-crew", "crew.Review"), ...wall("spawn-flat", "crew.Review")]);
  await mkdir(join(f.root, "session/crew"), { recursive: true });
  await writeFile(join(f.root, "session/crew.jsonl"), [header, spawn("nested", "root", "Review")].map(line).join(""));
  await writeFile(join(f.root, "session/crew/Review.jsonl"), line(header));
  await writeFile(join(f.root, "session/crew.Review.jsonl"), line(header));
  const result = await f.read(), rows = result.status?.workers ?? [];
  const projection = result.records.find(record => record.kind === "subagents" && record.id.endsWith(":children"));
  if (projection?.kind !== "subagents") throw new Error("Missing child projection");
  expect(projection.children).toHaveLength(3);
  expect(new Set(projection.children.map(child => child.id)).size).toBe(3);
  expect(rows).toHaveLength(4); // Ambiguous historical wall remains separate.
  expect(new Set(rows.map(row => row.id)).size).toBe(4);
  const crew = rows.find(row => row.handle === "crew"), nested = rows.find(row => row.parentId);
  expect(nested?.parentId).toBe(crew?.id);
  expect(crew?.id).not.toBe("crew");
});

test("older child fields cannot replace newer wall evidence but later lifecycle counters can", async () => {
  const wallEntries = wall("spawn", "review");
  const wallTs = "2098-01-01T00:00:00.000Z", turnTs = "2099-01-01T00:00:00.000Z";
  for (const entry of wallEntries) entry.timestamp = wallTs;
  const turn: Entry = { type: "custom", customType: "vibe-session-lifecycle", id: "turn", parentId: "wall-result", timestamp: turnTs, data: { id: "review", action: "turn-started", turn: 5 } };
  const f = await fixture([header, spawn("spawn", "root", "review"), ...wallEntries, turn]);
  await mkdir(join(f.root, "session"));
  await writeFile(join(f.root, "session/review.jsonl"), [header, { type: "message", id: "answer", parentId: "root", message: { role: "assistant", model: "older-child-model", content: "Old child output" } }].map(line).join(""));
  const rows = (await f.read()).status?.workers;
  expect(rows).toHaveLength(1);
  expect(rows?.[0]).toMatchObject({ model: "saved-model", observedAt: wallTs, turns: 5, turnsObservedAt: turnTs, queued: 3, queuedObservedAt: wallTs });
});

test("failed todo results cannot replace the last canonical good plan", async () => {
  const f = await fixture([header, todo, { type: "message", id: "call", parentId: "plan", message: { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "todo", arguments: {} }] } }, { type: "message", id: "result", parentId: "call", timestamp: ts, message: { role: "toolResult", toolCallId: "failed", isError: true, content: "Rejected", details: { phases: [{ name: "Rejected", tasks: [] }] } } }]);
  expect((await f.read(1)).status?.todo).toEqual({ id: "plan", ts, phases, visibility: "visible" });
});
