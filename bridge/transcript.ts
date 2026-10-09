import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AgentStatus } from "./types";
import type { ImageRef, TranscriptRecord, TranscriptResponse } from "./transcript-types";

export type AgentSession = { kind: string; value: string; source?: string };
export function defaultTranscriptRoots(): string[] {
  return [join(homedir(), ".omp/agent/sessions"), ...(process.env.COLLIE_TRANSCRIPT_ROOTS ?? "").split(":").filter(isAbsolute)];
}
export class TranscriptError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
const FILE_CAP = 64 * 1024 * 1024;
const TEXT_CAP = 16 * 1024;
const FULL_CAP = 1024 * 1024;
const IMAGE_CAP = 5 * 1024 * 1024;
function capped(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= cap) return { text, truncated: false };
  const marker = "\n… output truncated …\n";
  const half = Math.floor((cap - Buffer.byteLength(marker)) / 2);
  let tailStart = bytes.length - half;
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const head = new TextDecoder().decode(bytes.subarray(0, half), { stream: true });
  return { text: head + marker + bytes.subarray(tailStart).toString("utf8"), truncated: true };
}

function redactSessionPath(value: unknown, path: string): unknown {
  if (typeof value === "string") return value.replaceAll(path, "[session file]");
  if (Array.isArray(value)) return value.map(item => redactSessionPath(item, path));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactSessionPath(item, path);
    return result;
  }
  return value;
}
async function checkedOpen(agent: string, session: AgentSession | undefined, roots: string[]): Promise<{ handle: FileHandle; sessionId: string }> {
  const fail = () => new TranscriptError(404, "omp transcript unavailable");
  if (agent !== "omp" || session?.kind !== "path" || !isAbsolute(session.value) || session.value.split(sep).includes("..") || extname(session.value) !== ".jsonl") throw fail();
  let handle: FileHandle | undefined;
  try {
    const info = await lstat(session.value);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw fail();
    const path = await realpath(session.value);
    const canonicalRoots = await Promise.all(roots.filter(isAbsolute).map(root => realpath(root).catch(() => "")));
    if (!canonicalRoots.some(root => root && contained(root, path))) throw fail();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.dev !== info.dev || opened.ino !== info.ino) throw fail();
    const prefix = Buffer.alloc(Math.min(opened.size, 64 * 1024));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const lines = prefix.subarray(0, bytesRead).toString("utf8").split("\n");
    const first = lines.find(line => line.trim());
    if (!first || (bytesRead < opened.size && !first.includes("}") )) throw fail();
    const header = object(JSON.parse(first));
    if (header.type !== "session" && header.type !== "title") throw fail();
    return { handle, sessionId: str(header.id).replaceAll(session.value, "[session file]") || `file-${opened.dev}-${opened.ino}` };
  } catch { await handle?.close(); throw fail(); }
}
export async function readableTranscript(agent: string, session: AgentSession | undefined, roots = defaultTranscriptRoots()): Promise<boolean> {
  try { const { handle } = await checkedOpen(agent, session, roots); await handle.close(); return true; } catch { return false; }
}
type Entry = Record<string, unknown>;
type Picture = { mediaType: string; data: string };
type Parsed = { records: TranscriptRecord[]; texts: Map<string, string>; images: Map<string, Picture[]> };
function subject(name: string, args: Record<string, unknown>): string {
  if (["read", "edit", "write"].includes(name)) {
    const path = str(args.path ?? args.file_path ?? args.filePath) || str(args.input).match(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]/m)?.[1] || name;
    return path.split("\n")[0] || name;
  }
  if (name === "bash") return str(args.command ?? args.cmd).replace(/\s+/g, " ").slice(0, 140);
  return `${name} ${JSON.stringify(args)}`.slice(0, 100);
}
function pictures(blocks: unknown[]): Picture[] {
  return blocks.flatMap(value => {
    const block = object(value), source = object(block.source);
    const mediaType = str(block.mimeType ?? block.mediaType ?? source.media_type);
    const data = str(block.data ?? source.data);
    return block.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(mediaType) && data ? [{ mediaType, data }] : [];
  });
}
function refs(images: Picture[]): ImageRef[] { return images.map((image, index) => ({ index, mediaType: image.mediaType, bytes: Buffer.byteLength(image.data, "base64") })); }
function blocks(message: Entry): unknown[] { return Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : []; }
export function parseTranscript(entries: Entry[]): Parsed {
  const byId = new Map(entries.map(entry => [str(entry.id), entry]));
  const branch: Entry[] = [], seen = new Set<string>();
  let leaf = entries.at(-1);
  while (leaf) {
    const id = str(leaf.id);
    if (seen.has(id)) break;
    seen.add(id); branch.push(leaf);
    leaf = byId.get(str(leaf.parentId));
  }
  branch.reverse();
  const records: TranscriptRecord[] = [], texts = new Map<string, string>(), images = new Map<string, Picture[]>(), tools = new Map<string, Extract<TranscriptRecord, {kind: "tool"}>>();
  const addImages = (id: string, content: unknown[]) => { const found = pictures(content); if (found.length) images.set(id, found); return found.length ? refs(found) : undefined; };
  for (const entry of branch) {
    const id = str(entry.id), ts = str(entry.timestamp ?? entry.ts), type = str(entry.type);
    const variants: Record<string, "compaction" | "reset" | "model" | "mode"> = { compaction: "compaction", reset_boundary: "reset", model_change: "model", mode_change: "mode" };
    const variant = variants[type];
    if (variant) { records.push({ kind: "divider", id, ts, variant, label: str(entry.label) || (variant === "model" ? str(entry.modelId ?? entry.model) : variant), ...(typeof entry.summary === "string" ? { detail: capped(entry.summary, TEXT_CAP).text } : {}) }); continue; }
    const startEvent = type === "tool_execution_start" || (type === "custom" && entry.customType === "tool_execution_start");
    if (type !== "message" && type !== "custom_message" && !startEvent) continue;
    if (type === "custom_message" && entry.display !== true) continue;
    const message = type === "message" ? object(entry.message) : entry;
    const role = type === "custom_message" ? "assistant" : str(message.role);
    const content = blocks(message);
    if (role === "toolResult" || role === "tool_result") {
      const tool = tools.get(str(message.toolCallId ?? message.tool_call_id));
      if (!tool) continue;
      const text = content.map(value => str(object(value).text)).filter(Boolean).join("\n");
      texts.set(tool.id, text); tool.output = capped(text, TEXT_CAP);
      const details = object(message.details);
      tool.status = message.isError === true || details.isError === true || details.error !== undefined || (typeof details.exitCode === "number" && details.exitCode !== 0) ? "error" : "ok";
      tool.endedTs = ts; tool.images = addImages(tool.id, content); continue;
    }
    if (role === "user") {
      const text = content.map(value => str(object(value).text)).filter(Boolean).join("\n"); texts.set(id, text);
      records.push({ kind: "user", id, ts, text: capped(text, TEXT_CAP).text, images: addImages(id, content) }); continue;
    }
    if (role !== "assistant" && !startEvent) continue;
    const start = type === "custom" ? object(entry.data) : entry;
    const assistantBlocks = startEvent ? [{ type: "toolCall", id: start.toolCallId, name: start.toolName, arguments: start.args }] : content;
    assistantBlocks.forEach((value, index) => {
      const block = object(value), blockId = `${id}:${index}`, blockType = str(block.type);
      if (blockType === "toolCall" || blockType === "tool_call") {
        const callId = str(block.id ?? block.toolCallId) || blockId;
        if (tools.has(callId)) return;
        const name = str(block.name), args = object(block.arguments ?? block.args);
        const tool: Extract<TranscriptRecord, { kind: "tool" }> = { kind: "tool", id: callId, ts, name, subject: subject(name, args), args, status: "running" };
        tools.set(callId, tool); records.push(tool);
      } else if (blockType === "text" || blockType === "thinking") {
        const text = str(block.text ?? block.thinking); texts.set(blockId, text);
        if (blockType === "thinking") records.push({ kind: "thinking", id: blockId, ts, text: capped(text, TEXT_CAP).text, ...(block.redacted === true ? { redacted: true } : {}) });
        else records.push({ kind: "assistant", id: blockId, ts, text: capped(text, TEXT_CAP).text, ...(typeof message.model === "string" ? { model: message.model } : {}) });
      }
    });
  }
  return { records, texts, images };
}
type Cache = { size: number; offset: number; start: number; sessionId: string; entries: Entry[]; parsed: Parsed; revision: string; hash: Hash };
export class TranscriptStore {
  private readonly cache = new Map<string, Cache>();
  private readonly pending = new Map<string, Promise<Cache>>();
  constructor(private readonly roots = defaultTranscriptRoots(), private readonly fileCap = FILE_CAP) {}
  private async load(agent: string, session: AgentSession | undefined, sessionId: string): Promise<Cache> {
    const key = JSON.stringify([sessionId, agent, session?.kind, session?.value]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.read(agent, session, sessionId);
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
  private async read(agent: string, session: AgentSession | undefined, sessionId: string): Promise<Cache> {
    const { handle, sessionId: ompSessionId } = await checkedOpen(agent, session, this.roots);
    try {
      const info = await handle.stat(), key = `${info.dev}:${info.ino}:${sessionId}`;
      let cache = this.cache.get(key);
      const start = Math.max(0, info.size - this.fileCap);
      if (!cache || info.size < cache.size || (cache.start === 0 && start > 0) || (cache.start > 0 && info.size !== cache.size)) {
        cache = { size: 0, offset: start, start, sessionId: ompSessionId, entries: [], parsed: { records: [], texts: new Map(), images: new Map() }, revision: "", hash: createHash("sha256").update(`${key}:${start}`) };
      }
      const length = Math.min(info.size - cache.offset, this.fileCap);
      if (length > 0) {
        const buffer = Buffer.alloc(length); let count = 0;
        while (count < length) { const read = await handle.read(buffer, count, length - count, cache.offset + count); if (!read.bytesRead) break; count += read.bytesRead; }
        const end = buffer.subarray(0, count).lastIndexOf(10);
        if (end >= 0) {
          let data = buffer.subarray(0, end + 1);
          if (cache.start > 0 && cache.offset === cache.start) data = data.subarray(data.indexOf(10) + 1);
          for (const line of data.toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            try { const entry = object(redactSessionPath(JSON.parse(line), session!.value)); if (typeof entry.id === "string") cache.entries.push(entry); } catch { /* Malformed complete entries are inert and omitted. */ }
          }
          cache.offset += end + 1;
          cache.parsed = parseTranscript(cache.entries);
          cache.hash.update(data);
          cache.revision = `"${cache.hash.copy().digest("hex")}"`;
        }
      }
      if (!cache.revision) cache.revision = `"${createHash("sha256").update(key).digest("hex")}"`;
      cache.size = info.size;
      this.cache.delete(key); this.cache.set(key, cache);
      while (this.cache.size > 8) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
      return cache;
    } finally { await handle.close(); }
  }
  async transcript(paneId: string, sessionId: string, agent: string, agentSession: AgentSession | undefined, agentStatus: AgentStatus, limit = 60): Promise<TranscriptResponse> {
    const cache = await this.load(agent, agentSession, sessionId), total = cache.parsed.records.length;
    const count = Number.isFinite(limit) && limit > 0 ? Math.min(400, Math.floor(limit)) : 60;
    const revision = `"${createHash("sha256").update(cache.revision).update(agentStatus).digest("hex")}"`;
    return { paneId, sessionId: cache.sessionId, revision, total, records: cache.parsed.records.slice(-count), hasEarlier: total > count, agentStatus, truncatedFile: cache.start > 0 };
  }
  async record(sessionId: string, agent: string, session: AgentSession | undefined, recordId: string): Promise<{ recordId: string; text: string; truncated: boolean }> {
    const cache = await this.load(agent, session, sessionId), text = cache.parsed.texts.get(recordId);
    if (text === undefined) throw new TranscriptError(404, "transcript record not found");
    return { recordId, ...capped(text, FULL_CAP) };
  }
  async image(sessionId: string, agent: string, session: AgentSession | undefined, recordId: string, index: number): Promise<{ bytes: Buffer; mediaType: string }> {
    const cache = await this.load(agent, session, sessionId), image = cache.parsed.images.get(recordId)?.[index];
    if (!image || !Number.isInteger(index) || index < 0) throw new TranscriptError(404, "transcript image not found");
    if (Buffer.byteLength(image.data, "base64") > IMAGE_CAP) throw new TranscriptError(413, "transcript image exceeds limit");
    return { bytes: Buffer.from(image.data, "base64"), mediaType: image.mediaType };
  }
}
