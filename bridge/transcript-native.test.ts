import { test, expect } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore, parseTranscript } from "./transcript";
import { workerRows, todoPhases } from "./transcript-native";
const source = await Bun.file(join(import.meta.dir, "fixtures/omp/native-working.jsonl")).text();
const entries = source.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
test("native cards preserve acknowledgements, messages, todo and async progress", () => {
  const records = parseTranscript(entries).records;
  expect(records.filter(r => r.kind === "vibe")).toMatchObject([{ op: "send", ack: { mode: "queued" }, workers: [{ queued: 1, elapsedMs: 2000 }] }, { op: "wait", wait: { settled: 1, stillRunning: 0 } }, { op: "list" }]);
  expect(records.find(r => r.kind === "irc")).toMatchObject({ from: "WorkerA", body: "Example review complete.", replyTo: "example-reply" });
  expect(records.find(r => r.kind === "todo")).toMatchObject({ phases: [{ tasks: [{ status: "active" }, { status: "blocked", blocker: "Example missing input" }] }] });
  expect(records.find(r => r.kind === "subagents")).toMatchObject({ children: [{ id: "WorkerA.Reviewer", status: "pending", nesting: 1 }] });
});
test("hidden incoming messages stay hidden and todo visibility matches its canonical source", () => {
  const hidden = { ...entries[8], display: false };
  expect(parseTranscript([...entries.slice(0, 8), hidden]).records.some(r => r.kind === "irc")).toBe(false);
  const phases = [{ name: "Example", tasks: [{ content: "Example", status: "in_progress" }] }];
  const edit = { type: "custom", customType: "user_todo_edit", id: "edit", parentId: "entry-013", data: { phases } };
  const hide = { type: "custom", customType: "todo_hud_state", id: "hide", parentId: "edit", data: { sourceEntryId: "edit", fingerprint: JSON.stringify(phases), visibility: "dismissed" } };
  expect(parseTranscript([...entries, edit, hide]).records.at(-1)).toMatchObject({ kind: "todo", visibility: "dismissed" });
  expect(parseTranscript([...entries, edit, { ...hide, data: { ...hide.data, fingerprint: "different" } }]).records.at(-1)).toMatchObject({ visibility: "visible" });
});
test("native structured content obeys row and text budgets", () => {
  const workers = workerRows(Array.from({ length: 100 }, (_, i) => ({ id: `worker-${i}`, state: "running", outputTail: Array(20).fill("x".repeat(10000)) })), "2026-01-01T00:00:00Z");
  expect(workers.length).toBe(64); expect(workers[0]?.outputTail?.length).toBe(3); expect(workers[0]?.outputTail?.[0]?.length).toBe(1024);
  expect(todoPhases([{ name: "Example", tasks: Array(200).fill({ content: "x", status: "blocked" }) }])[0]?.tasks.length).toBe(128);
});
test("every native append prefix renders identically to a fresh full parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-equivalence-"));
  try {
    const path = join(root, "session.jsonl"), session = { kind: "path", value: path }, store = new TranscriptStore([root]);
    await writeFile(path, "");
    for (const entry of entries) {
      await appendFile(path, JSON.stringify(entry) + "\n");
      const incremental = await store.transcript("p", "s", "omp", session, "working", 400);
      const full = await new TranscriptStore([root]).transcript("p", "s", "omp", session, "working", 400);
      expect(incremental).toEqual(full);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
