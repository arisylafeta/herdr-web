import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chown, copyFile, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";
import { TranscriptStore, parseTranscript, readableTranscript, type AgentSession } from "./transcript";
import { StateEngine } from "./state-engine";
import type { HerdrClient } from "./herdr-client";
import { startServer } from "./server";
import type { TranscriptResponse } from "./transcript-types";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "herdr-transcript-")); temporary.push(root);
  const path = join(root, "session.jsonl");
  await copyFile(join(import.meta.dir, "fixtures/omp", `${name}.jsonl`), path);
  const session: AgentSession = { kind: "path", value: path };
  const store = new TranscriptStore([root]);
  return { root, path, session, store, read: (limit = 60) => store.transcript("p1", "default", "omp", session, "idle", limit) };
}
function entries(text: string): Record<string, unknown>[] {
  return text.trim().split("\n").flatMap(line => {
    try { const value: unknown = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : []; } catch { return []; }
  });
}

describe("omp fixture parser", () => {
  test("keeps assistant block order and stable ids", async () => {
    const f = await fixture("basic-chat"), result = await f.read();
    expect(result.sessionId).toBe("entry-000");
    expect(result.records.map(record => record.kind)).toEqual(["divider", "user", "thinking", "assistant"]);
    expect(result.records.slice(-2).map(record => record.id)).toEqual(["entry-004:0", "entry-004:1"]);
    expect(result.records.at(-1)).toMatchObject({ text: "Example output line." });
    expect((await f.read(2)).hasEarlier).toBe(true);
    expect((await f.read(2)).records.map(record => record.kind)).toEqual(["thinking", "assistant"]);
  });
  test("pairs results by call id in call positions, including errors", async () => {
    const f = await fixture("tool-roundtrip"), result = await f.read();
    const tools = result.records.filter(record => record.kind === "tool");
    expect(tools.map(tool => [tool.id, tool.status])).toEqual([["call-read", "ok"], ["call-bash", "ok"], ["call-edit", "ok"], ["call-grep", "ok"]]);
    expect(tools[0]?.output?.text).toBe("Example output line.");
    expect(tools[0]?.subject).toBe("/example/workspace/example.txt");
    const source = entries(await Bun.file(f.path).text());
    for (const entry of source) {
      const message = entry.message;
      if (message && typeof message === "object" && "toolCallId" in message && message.toolCallId === "call-bash") Object.assign(message, { isError: true });
    }
    expect(parseTranscript(source).records.find(record => record.id === "call-bash")).toMatchObject({ status: "error" });
  });
  test("custom execution start does not duplicate running call", async () => {
    const f = await fixture("running-tool"), result = await f.read();
    expect(result.records.filter(record => record.kind === "tool")).toMatchObject([{ id: "call-running", status: "running" }]);
  });
  test("exposes image references and raw bytes without base64 in transcript", async () => {
    const f = await fixture("image-result"), result = await f.read();
    const tool = result.records.find(record => record.kind === "tool");
    expect(tool).toMatchObject({ images: [{ index: 0, mediaType: "image/png" }] });
    if (!tool || tool.kind !== "tool") throw new Error("missing fixture tool");
    const image = await f.store.image("default", "omp", f.session, tool.id, 0);
    expect(image.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(tool.images?.[0]?.bytes).toBe(image.bytes.length);
    expect(JSON.stringify(result)).not.toContain("iVBOR");
  });
  test("maps context boundaries and follows newest branch", async () => {
    const context = await fixture("context-events"), result = await context.read();
    expect(result.records.filter(record => record.kind === "divider").map(record => record.variant)).toEqual(["model", "compaction", "reset", "model", "mode"]);
    const branch = await fixture("branch"), selected = await branch.read();
    const raw = entries(await Bun.file(branch.path).text()), last = raw.at(-1);
    expect(selected.records.at(-1)?.id).toBe(typeof last?.id === "string" ? last.id : undefined);
    expect(selected.records.some(record => record.id === "entry-004")).toBe(false);
  });
  test("caps output in list, retains full text for expansion", async () => {
    const f = await fixture("big-output"), result = await f.read();
    const tool = result.records.find(record => record.kind === "tool");
    if (!tool || tool.kind !== "tool") throw new Error("missing fixture tool");
    expect(tool.output?.truncated).toBe(true);
    expect(Buffer.byteLength(tool.output?.text ?? "")).toBeLessThanOrEqual(16 * 1024);
    const full = await f.store.record("default", "omp", f.session, tool.id);
    expect(full.truncated).toBe(false); expect(Buffer.byteLength(full.text)).toBe(215040);
  });
  test("ignores a torn tail until its newline is completed", async () => {
    const f = await fixture("torn-tail"), before = await f.read();
    const raw = await Bun.file(f.path).text(), prefix = raw.slice(raw.lastIndexOf("\n") + 1);
    expect(prefix).toContain("entry-");
    const complete = { type: "message", id: "completed", parentId: before.records.at(-1)?.id?.split(":")[0], message: { role: "assistant", content: [{ type: "text", text: "completed output" }] } };
    await writeFile(f.path, raw.slice(0, raw.lastIndexOf("\n") + 1) + JSON.stringify(complete));
    expect((await f.read()).revision).toBe(before.revision);
    await appendFile(f.path, "\n");
    const after = await f.read(); expect(after.records.at(-1)).toMatchObject({ text: "completed output" }); expect(after.revision).not.toBe(before.revision);
  });
  test("shrink and inode replacement reset cached records", async () => {
    const f = await fixture("tool-roundtrip"), before = await f.read();
    const basic = await Bun.file(join(import.meta.dir, "fixtures/omp/basic-chat.jsonl")).text();
    await writeFile(f.path, basic);
    expect((await f.read()).records.some(record => record.kind === "tool")).toBe(false);
    const replacement = join(f.root, "replacement.jsonl");
    await copyFile(join(import.meta.dir, "fixtures/omp/running-tool.jsonl"), replacement); await rename(replacement, f.path);
    const after = await f.read(); expect(after.records.find(record => record.kind === "tool")).toMatchObject({ status: "running" }); expect(after.revision).not.toBe(before.revision);
  });
  test("bounded tail window reports incomplete history", async () => {
    const f = await fixture("big-output"), raw = await Bun.file(f.path).text();
    await appendFile(f.path, JSON.stringify({ type: "message", id: "tail", parentId: "entry-005", message: { role: "user", content: "tail text" } }) + "\n");
    const bounded = new TranscriptStore([f.root], 2048);
    const response = await bounded.transcript("p1", "default", "omp", f.session, "idle");
    expect(raw.length).toBeGreaterThan(2048); expect(response.truncatedFile).toBe(true); expect(response.records.at(-1)).toMatchObject({ text: "tail text" });
  });
  test("only explicitly displayed custom messages are visible; developer/housekeeping are absent", () => {
    const parsed = parseTranscript([
      { id: "s", type: "session" },
      { id: "hidden", parentId: "s", type: "custom_message", content: "hidden" },
      { id: "dev", parentId: "hidden", type: "message", message: { role: "developer", content: "secret" } },
      { id: "shown", parentId: "dev", type: "custom_message", display: true, content: "shown" },
      { id: "usage", parentId: "shown", type: "model_usage" },
    ]);
    expect(parsed.records).toEqual([{ kind: "assistant", id: "shown:0", ts: "", text: "shown" }]);
  });
  test("bounds record count and concurrent readers do not duplicate appends", async () => {
    const f = await fixture("basic-chat");
    const appended: string[] = [];
    for (let index = 0; index < 650; index++) appended.push(JSON.stringify({ type: "message", id: `extra-${index}`, parentId: index === 0 ? "entry-004" : `extra-${index - 1}`, message: { role: "user", content: `message ${index}` } }));
    await f.read();
    await appendFile(f.path, appended.join("\n") + "\n");
    const results = await Promise.all([f.read(), f.read(), f.read(9999)]);
    expect(results.map(response => response.total)).toEqual([654, 654, 654]);
    expect(results.map(response => response.records.length)).toEqual([60, 60, 400]);
    expect(results[2]?.records[0]).toMatchObject({ id: "extra-250", text: "message 250" });
    expect(results[2]?.records.at(-1)).toMatchObject({ id: "extra-649", text: "message 649" });
  });
  test("redacts only the exact authoritative path in text and nested args", async () => {
    const f = await fixture("running-tool");
    await appendFile(f.path, JSON.stringify({ type: "message", id: "private-call", parentId: "entry-005", message: { role: "assistant", content: [{ type: "toolCall", id: "private-tool", name: "read", arguments: { path: f.path, nested: [f.path, "/other/file.jsonl"] } }] } }) + "\n");
    await appendFile(f.path, JSON.stringify({ type: "message", id: "private-result", parentId: "private-call", message: { role: "toolResult", toolCallId: "private-tool", content: [{ type: "text", text: `${f.path} /other/file.jsonl` }] } }) + "\n");
    const response = await f.read();
    const tool = response.records.find(record => record.id === "private-tool");
    expect(tool).toMatchObject({ args: { path: "[session file]", nested: ["[session file]", "/other/file.jsonl"] }, subject: "[session file]", output: { text: "[session file] /other/file.jsonl" } });
    expect(JSON.stringify(response)).not.toContain(f.path);
    expect(await f.store.record("default", "omp", f.session, "private-tool")).toMatchObject({ text: "[session file] /other/file.jsonl" });
  });
  test("caps UTF-8 without splitting characters and refuses oversized images", async () => {
    const f = await fixture("running-tool");
    await appendFile(f.path, JSON.stringify({ type: "message", id: "unicode", parentId: "entry-005", message: { role: "toolResult", toolCallId: "call-running", content: [{ type: "text", text: "😀".repeat(10000) }, { type: "image", mimeType: "image/png", data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }] } }) + "\n");
    const response = await f.read();
    const tool = response.records.find(record => record.kind === "tool");
    if (!tool || tool.kind !== "tool") throw new Error("missing tool");
    expect(Buffer.byteLength(tool.output?.text ?? "")).toBeLessThanOrEqual(16 * 1024);
    expect(tool.output?.text).not.toContain("�");
    await expect(f.store.image("default", "omp", f.session, tool.id, 0)).rejects.toThrow("transcript image exceeds limit");
  });
});

describe("transcript file security", () => {
  test("rejects untrusted agent, source kind, outside root, traversal, extension, symlinks, invalid headers and nonregular files", async () => {
    const f = await fixture("basic-chat");
    const outside = await fixture("basic-chat");
    const link = join(f.root, "link.jsonl"); await symlink(f.path, link);
    const bad = join(f.root, "bad.jsonl"); await writeFile(bad, '{"type":"message"}\n');
    const invalid = join(f.root, "invalid.jsonl"); await writeFile(invalid, 'not json\n');
    const directory = join(f.root, "directory.jsonl"); await mkdir(directory);
    const extension = join(f.root, "session.txt"); await copyFile(f.path, extension);
    for (const value of [outside.path, `${f.root}/../${f.root.split("/").at(-1)}/session.jsonl`, link, bad, invalid, directory, extension]) {
      expect(await readableTranscript("omp", { kind: "path", value }, [f.root])).toBe(false);
      await expect(f.store.transcript("p1", "default", "omp", { kind: "path", value }, "idle")).rejects.toThrow("omp transcript unavailable");
    }
    expect(await readableTranscript("claude", f.session, [f.root])).toBe(false);
    expect(await readableTranscript("omp", { kind: "id", value: f.path }, [f.root])).toBe(false);
    expect(await readableTranscript("omp", undefined, [f.root])).toBe(false);
    if (process.getuid?.() === 0) {
      await chown(f.path, 65534, 65534);
      expect(await readableTranscript("omp", f.session, [f.root])).toBe(false);
    }
  });
  test("accepts a title header and an additional absolute root", async () => {
    const f = await fixture("basic-chat"); await writeFile(f.path, '{"type":"title","title":"example"}\n');
    expect(await readableTranscript("omp", f.session, [f.root])).toBe(true);
    const original = process.env.COLLIE_TRANSCRIPT_ROOTS;
    try { process.env.COLLIE_TRANSCRIPT_ROOTS = `${f.root}:/another/root:relative`; expect(loadConfig().transcriptRoots).toContain(f.root); expect(loadConfig().transcriptRoots).not.toContain("relative"); } finally { if (original === undefined) delete process.env.COLLIE_TRANSCRIPT_ROOTS; else process.env.COLLIE_TRANSCRIPT_ROOTS = original; }
  });
});

async function routeFixture(name: string) {
  const f = await fixture(name);
  const fake = {
    sessionSnapshot: async () => ({ workspaces: [{ workspace_id: "w1", label: "space", number: 1 }], tabs: [], panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "t1", focused: true, agent: "omp", agent_status: "idle", agent_session: { ...f.session, agent: "omp" } },
      { pane_id: "p2", workspace_id: "w1", tab_id: "t1", focused: false, agent: "omp", agent_status: "idle" },
    ] }),
  };
  const engine = new StateEngine(fake as unknown as HerdrClient, 1500, [f.root]);
  await (engine as unknown as { poll(): Promise<void> }).poll();
  const config = { ...loadConfig(), port: 0, host: "127.0.0.1", trustedUser: "owner@example.com", publicHosts: ["remote.example"], transcriptRoots: [f.root], deviceHeader: "x-device", deviceAllowlist: ["writer"], allowedOrigins: [] };
  const server = startServer({
    cfg: config,
    registry: { get: (name: string) => name === "default" ? { name, engine } : null, list: () => [] } as unknown as Parameters<typeof startServer>[0]["registry"],
    push: { enabled: false, publicKey: "" } as never,
    snooze: { until: () => 0 } as never, notifyPrefs: {} as never,
    updateMonitor: { status: () => ({}) } as never, audit: {} as never, liveUpdates: {} as never,
  });
  return { ...f, engine, server, url: `http://127.0.0.1:${server.port}` };
}
describe("transcript HTTP seam", () => {
  test("ETag/304 changes on append; reads do not require write device; snapshot never exposes session path", async () => {
    const f = await routeFixture("running-tool");
    try {
      const endpoint = `${f.url}/api/pane/p1/transcript?session=default`;
      const first = await fetch(endpoint), body = await first.json() as TranscriptResponse;
      expect(first.status).toBe(200); expect(first.headers.get("etag")).toBe(body.revision);
      expect((await fetch(endpoint, { headers: { "if-none-match": body.revision } })).status).toBe(304);
      await appendFile(f.path, JSON.stringify({ type: "message", id: "result", parentId: "entry-005", message: { role: "toolResult", toolCallId: "call-running", isError: true, content: [{ type: "text", text: "failure details" }] } }) + "\n");
      const changed = await fetch(endpoint, { headers: { "if-none-match": body.revision } }); expect(changed.status).toBe(200);
      const next = await changed.json() as TranscriptResponse; expect(next.records.find(record => record.kind === "tool")).toMatchObject({ id: "call-running", status: "error", output: { text: "failure details" } }); expect(next.total).toBe(body.total);
      const snapshot = await fetch(`${f.url}/api/snapshot?session=default`), text = await snapshot.text();
      expect(text).toContain('"transcript":true'); expect(text).not.toContain(f.path); expect(text).not.toContain("agent_session"); expect(text).not.toContain("agentSession");
      const remoteRead = await fetch(endpoint, { headers: { host: "remote.example", "tailscale-user-login": "owner@example.com" } }); expect(remoteRead.status).toBe(200);
      expect((await fetch(endpoint, { headers: { host: "remote.example" } })).status).toBe(403);
      expect((await fetch(`${f.url}/api/pane/unknown/transcript?session=default`)).status).toBe(404);
      expect((await fetch(`${f.url}/api/pane/p2/transcript?session=default`)).status).toBe(404);
      expect((await fetch(`${f.url}/api/pane/p1/transcript?session=unknown`)).status).toBe(404);
      const malicious = await fetch(`${endpoint}&path=${encodeURIComponent("/etc/passwd")}`); expect(malicious.status).toBe(200);
    } finally { f.server.stop(true); }
  });
  test("record expansion route returns full output and bounded text", async () => {
    const f = await routeFixture("big-output");
    try {
      const response = await fetch(`${f.url}/api/pane/p1/transcript?session=default`), data = await response.json() as TranscriptResponse;
      const tool = data.records.find(record => record.kind === "tool"); if (!tool) throw new Error("missing tool");
      const full = await fetch(`${f.url}/api/pane/p1/transcript/record/${tool.id}?session=default`);
      expect(full.status).toBe(200); expect(await full.json()).toMatchObject({ recordId: tool.id, truncated: false, text: "Example output line.\n".repeat(10240) });
      expect((await fetch(`${f.url}/api/pane/p1/transcript/record/missing?session=default`)).status).toBe(404);
      await appendFile(f.path, JSON.stringify({ type: "message", id: "huge", parentId: "entry-005", message: { role: "user", content: "x".repeat(2 * 1024 * 1024) } }) + "\n");
      const expanded = await f.store.record("default", "omp", f.session, "huge"); expect(expanded.truncated).toBe(true); expect(Buffer.byteLength(expanded.text)).toBeLessThanOrEqual(1024 * 1024);
    } finally { f.server.stop(true); }
  });
  test("image route sends inert bytes with private caching and nosniff", async () => {
    const f = await routeFixture("image-result");
    try {
      const data = await (await fetch(`${f.url}/api/pane/p1/transcript?session=default`)).json() as TranscriptResponse;
      const tool = data.records.find(record => record.kind === "tool"); if (!tool) throw new Error("missing tool");
      const response = await fetch(`${f.url}/api/pane/p1/transcript/image/${tool.id}/0?session=default`);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toBe("private, max-age=3600"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect((await fetch(`${f.url}/api/pane/p1/transcript/image/${tool.id}/99?session=default`)).status).toBe(404);
    } finally { f.server.stop(true); }
  });
});
