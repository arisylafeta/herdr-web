import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscript, TranscriptStore, type AgentSession } from "./transcript";
import { loadConfig } from "./config";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const header = { type: "session", id: "session-id" };
function assistant(id: string, parentId: string, message: Record<string, unknown>) {
  return { type: "message", id, parentId, timestamp: "2026-10-09T00:00:00Z", message: { role: "assistant", ...message } };
}
async function source(entries: Record<string, unknown>[], preamble = "") {
  const root = await mkdtemp(join(tmpdir(), "herdr-harden-")); dirs.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, preamble + [header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const session: AgentSession = { kind: "path", value: path };
  return { root, path, session };
}

test("empty-content assistant errors and aborts remain visible and bounded", () => {
  for (const stopReason of ["error", "aborted"]) {
    const parsed = parseTranscript([header, assistant("failed", "session-id", { content: [], stopReason, errorMessage: "failure detail\n".repeat(2000) })]);
    const record = parsed.records.at(-1);
    expect(record).toMatchObject({ kind: "divider", id: "failed:stop", variant: stopReason });
    if (record?.kind !== "divider") throw new Error("missing termination record");
    expect(record.label.length).toBeLessThanOrEqual(140);
    expect(Buffer.byteLength(record.detail ?? "")).toBeLessThanOrEqual(16 * 1024);
  }
});

test("failed turns interrupt only their own unresolved calls; only a proven working tail stays running", async () => {
  const failed = assistant("failed", "session-id", { stopReason: "aborted", errorMessage: "cancelled", content: [
    { type: "toolCall", id: "a", name: "bash", arguments: { command: "one" } },
    { type: "toolCall", id: "b", name: "bash", arguments: { command: "two" } },
  ] });
  const f = await source([failed]);
  const store = new TranscriptStore([f.root]);
  const read = (status: "idle" | "working") => store.transcript("p", "default", "omp", f.session, status);
  expect((await read("working")).records.filter(record => record.kind === "tool")).toMatchObject([{ id: "a", status: "error", output: { text: "interrupted" } }, { id: "b", status: "error", output: { text: "interrupted" } }]);
  await appendFile(f.path, JSON.stringify({ type: "custom", id: "older-start", parentId: "failed", customType: "tool_execution_start", data: { toolCallId: "a", toolName: "bash" } }) + "\n");
  expect((await read("working")).records.filter(record => record.kind === "tool").map(record => record.status)).toEqual(["error", "error"]);
  await appendFile(f.path, JSON.stringify({ type: "custom", id: "start", parentId: "older-start", customType: "tool_execution_start", data: { toolCallId: "b", toolName: "bash" } }) + "\n");
  expect((await read("idle")).records.filter(record => record.kind === "tool").map(record => record.status)).toEqual(["error", "error"]);
  expect((await read("working")).records.filter(record => record.kind === "tool").map(record => record.status)).toEqual(["error", "running"]);
  await expect(store.record("default", "omp", f.session, "b", "working")).rejects.toThrow("transcript record not found");
  expect((await store.record("default", "omp", f.session, "b", "idle")).text).toBe("interrupted");
  await appendFile(f.path, JSON.stringify({ type: "message", id: "result", parentId: "start", message: { role: "toolResult", toolCallId: "b", content: "finished", isError: false } }) + "\n");
  expect((await read("idle")).records.filter(record => record.kind === "tool").map(record => record.status)).toEqual(["error", "ok"]);
  const parsed = parseTranscript([header, assistant("earlier", "session-id", { content: [{ type: "toolCall", id: "earlier-call", name: "read", arguments: {} }] }), assistant("empty-error", "earlier", { content: [], stopReason: "error" })]);
  expect(parsed.records.find(record => record.id === "earlier-call")).toMatchObject({ status: "running" });
});

test("same-inode same-size rewrite and truncate-regrow cannot splice cached history", async () => {
  const f = await source([assistant("old", "session-id", { content: "OLD" })]);
  const store = new TranscriptStore([f.root]);
  const read = () => store.transcript("p", "default", "omp", f.session, "idle");
  const before = await read();
  const original = await Bun.file(f.path).text();
  await writeFile(f.path, original.replaceAll("OLD", "NEW"));
  expect((await read()).records.at(-1)).toMatchObject({ text: "NEW" });
  expect((await read()).revision).not.toBe(before.revision);
  const replacement = original.replaceAll("OLD", "BIG") + JSON.stringify(assistant("grown", "old", { content: "grown" })) + "\n";
  await writeFile(f.path, replacement);
  expect((await read()).records.map(record => record.kind === "assistant" ? record.text : "")).toEqual(["BIG", "grown"]);
});

test("consumed tail guard rejects middle-file truncate-regrow with unchanged first 4 KiB", async () => {
  const f = await source([assistant("padding", "session-id", { content: "x".repeat(5000) }), assistant("old", "padding", { content: "OLD" })]);
  const store = new TranscriptStore([f.root]);
  await store.transcript("p", "default", "omp", f.session, "idle");
  const raw = await Bun.file(f.path).text();
  await writeFile(f.path, raw.replaceAll("OLD", "NEW") + JSON.stringify(assistant("end", "old", { content: "end" })) + "\n");
  const records = (await store.transcript("p", "default", "omp", f.session, "idle")).records;
  expect(records.find(record => record.id === "old:0")).toMatchObject({ text: "NEW" });
});

test("interior rewrites followed by growth cannot bypass unchanged start/tail samples", async () => {
  const original = "x".repeat(5000) + "OLD" + "y".repeat(5000);
  const replacement = original.replace("OLD", "NEW");
  const f = await source([assistant("middle", "session-id", { content: original })]);
  const store = new TranscriptStore([f.root]);
  await store.transcript("p", "default", "omp", f.session, "idle");
  const raw = await Bun.file(f.path).text();
  await writeFile(f.path, raw.replace("OLD", "NEW") + JSON.stringify(assistant("end", "middle", { content: "end" })) + "\n");
  const records = (await store.transcript("p", "default", "omp", f.session, "idle")).records;
  expect(records.find(record => record.id === "middle:0")).toMatchObject({ text: replacement });
});

test("a changing descriptor retries once without publishing mixed generations", async () => {
  const f = await source([assistant("old", "session-id", { content: "old generation" })]);
  let changed = false;
  const store = new TranscriptStore([f.root], undefined, { readChunk: async (handle, buffer, offset, length, position) => {
    const { bytesRead } = await handle.read(buffer, offset, length, position);
    if (!changed) { changed = true; await writeFile(f.path, JSON.stringify(header) + "\n" + JSON.stringify(assistant("new", "session-id", { content: "new stable generation" })) + "\n"); }
    return bytesRead;
  } });
  const response = await store.transcript("p", "default", "omp", f.session, "idle");
  expect(response.records).toMatchObject([{ id: "new:0", text: "new stable generation" }]);
  let generation = 0;
  const unstable = new TranscriptStore([f.root], undefined, { readChunk: async (handle, buffer, offset, length, position) => {
    const { bytesRead } = await handle.read(buffer, offset, length, position);
    await appendFile(f.path, JSON.stringify(assistant(`mutation-${generation++}`, "session-id", { content: "changes" })) + "\n");
    return bytesRead;
  } });
  await expect(unstable.transcript("p", "default", "omp", f.session, "idle")).rejects.toThrow("transcript changed during read");
  expect(generation).toBe(2);
});

test("retained-byte budget evicts least-recently-used sessions", async () => {
  const first = await source([assistant("first", "session-id", { content: "a".repeat(1000) })]);
  const second = await source([assistant("second", "session-id", { content: "b".repeat(1000) })]);
  let bodyReads = 0;
  const store = new TranscriptStore([first.root, second.root], undefined, { cacheBytes: 10000, readChunk: async (handle, buffer, offset, length, position) => {
    bodyReads++; return (await handle.read(buffer, offset, length, position)).bytesRead;
  } });
  await store.transcript("p", "one", "omp", first.session, "idle");
  await store.transcript("p", "two", "omp", second.session, "idle");
  await store.transcript("p", "one", "omp", first.session, "idle");
  expect(bodyReads).toBe(3);
});

test("distinct file loads are bounded to two while callers queue", async () => {
  const files = await Promise.all([source([assistant("one", "session-id", { content: "one" })]), source([assistant("two", "session-id", { content: "two" })]), source([assistant("three", "session-id", { content: "three" })])]);
  let active = 0, peak = 0;
  let signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new TranscriptStore(files.map(file => file.root), undefined, { readChunk: async (handle, buffer, offset, length, position) => {
    active++; peak = Math.max(peak, active);
    if (active === 2) signalStarted();
    await gate;
    const { bytesRead } = await handle.read(buffer, offset, length, position);
    active--; return bytesRead;
  } });
  const pending = Promise.all(files.map((file, index) => store.transcript("p", String(index), "omp", file.session, "idle")));
  await started;
  const firstActive = active;
  release();
  const responses = await pending;
  expect(firstActive).toBe(2);
  expect(responses.map(response => response.records[0]?.id)).toEqual(["one:0", "two:0", "three:0"]);
  expect(peak).toBe(2);
});

test("args have bounded size and depth, with explicit string truncation markers", async () => {
  let nested: Record<string, unknown> = { value: "deep" };
  for (let index = 0; index < 30; index++) nested = { child: nested };
  const f = await source([assistant("call", "session-id", { content: [{ type: "toolCall", id: "large", name: "bash", arguments: { command: "x".repeat(100000), nested, wide: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`key-${index}`, "z".repeat(100)])) } }] })]);
  const response = await new TranscriptStore([f.root]).transcript("p", "default", "omp", f.session, "idle");
  const tool = response.records[0];
  if (tool?.kind !== "tool") throw new Error("missing tool");
  expect(Buffer.byteLength(JSON.stringify(tool.args))).toBeLessThanOrEqual(8192);
  expect(JSON.stringify(tool.args)).toContain("[truncated");
  function depth(value: unknown): number { return value !== null && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0; }
  expect(depth(tool.args)).toBeLessThanOrEqual(6);
});

test("nesting alone is capped even when args fit the byte limit", () => {
  let nested: Record<string, unknown> = { value: "deep" };
  for (let index = 0; index < 30; index++) nested = { child: nested };
  const parsed = parseTranscript([header, assistant("call", "session-id", { content: [{ type: "toolCall", id: "deep", name: "read", arguments: nested }] })]);
  const tool = parsed.records[0];
  if (tool?.kind !== "tool") throw new Error("missing tool");
  let cursor: unknown = tool.args, levels = 0;
  while (cursor !== null && typeof cursor === "object" && "child" in cursor) { levels++; cursor = cursor.child; }
  expect(levels).toBeLessThanOrEqual(6);
  expect(JSON.stringify(tool.args)).toContain("[truncated depth");
});

test("argument size remains bounded when JSON escaping expands a string", () => {
  const parsed = parseTranscript([header, assistant("call", "session-id", { content: [{ type: "toolCall", id: "escaped", name: "write", arguments: { content: String.fromCharCode(0).repeat(10000) } }] })]);
  const tool = parsed.records[0];
  if (tool?.kind !== "tool") throw new Error("missing tool");
  expect(Buffer.byteLength(JSON.stringify(tool.args))).toBeLessThanOrEqual(8192);
  expect(JSON.stringify(tool.args)).toContain("[truncated");
});

test("oversized complete JSONL lines are skipped as inert", async () => {
  const f = await source([assistant("oversized", "session-id", { content: "x".repeat(9 * 1024 * 1024) }), assistant("tail", "oversized", { content: "safe tail" })]);
  const response = await new TranscriptStore([f.root]).transcript("p", "default", "omp", f.session, "idle");
  expect(response.records.some(record => record.id === "oversized:0")).toBe(false);
  expect(response.records.at(-1)).toMatchObject({ text: "safe tail" });
});

test("title preamble yields the subsequent omp session id, not file identity", async () => {
  const f = await source([assistant("answer", "session-id", { content: "answer" })], '{"type":"title","title":"example"}\n');
  expect((await new TranscriptStore([f.root]).transcript("p", "default", "omp", f.session, "idle")).sessionId).toBe("session-id");
});

test("ETag identifies the requested record window", async () => {
  const f = await source([assistant("one", "session-id", { content: "one" }), assistant("two", "one", { content: "two" })]);
  const store = new TranscriptStore([f.root]);
  const one = await store.transcript("p", "default", "omp", f.session, "idle", 1);
  const two = await store.transcript("p", "default", "omp", f.session, "idle", 2);
  expect(one.revision).not.toBe(two.revision);
});

test("cache budget environment is parsed as a bounded integer", () => {
  const original = process.env.COLLIE_TRANSCRIPT_CACHE_MB;
  try { process.env.COLLIE_TRANSCRIPT_CACHE_MB = "7"; expect(loadConfig().transcriptCacheMb).toBe(7); }
  finally { if (original === undefined) delete process.env.COLLIE_TRANSCRIPT_CACHE_MB; else process.env.COLLIE_TRANSCRIPT_CACHE_MB = original; }
});
