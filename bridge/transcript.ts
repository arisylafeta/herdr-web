import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AgentStatus } from "./types";
import type { ImageRef, TranscriptRecord, TranscriptResponse } from "./transcript-types";
import { nativeCustomRecord, nativeResultRecords } from "./transcript-native";

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
const ARGS_CAP = 8 * 1024;
const MAX_DEPTH = 6;
const LINE_CAP = 8 * 1024 * 1024;
const GUARD_BYTES = 4096;

function prefixText(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text);
  if (total <= maxBytes) return text;
  const count = Math.max(0, maxBytes - 40);
  const prefix = Buffer.from(text.slice(0, count));
  const head = new TextDecoder().decode(prefix.subarray(0, count), { stream: true });
  return head + `…[truncated ${total - Buffer.byteLength(head)} bytes]`;
}

function boundedArgs(value: unknown, cap = ARGS_CAP, nodeCap = 256, depthCap = MAX_DEPTH): Record<string, unknown> {
  let nodes = 0, remaining = cap - 1024;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > nodeCap || depth >= depthCap) return "…[truncated depth/nodes]";
    if (typeof input === "string") {
      const result = prefixText(input, Math.max(64, remaining));
      remaining -= Buffer.byteLength(result);
      return result;
    }
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      for (const item of input) {
        if (nodes >= nodeCap || remaining <= 0) { result.push("…[truncated elements]"); break; }
        result.push(visit(item, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (nodes >= nodeCap || remaining <= 0) { result.truncated = "…[truncated properties]"; break; }
      const boundedKey = prefixText(key, 128);
      remaining -= Buffer.byteLength(boundedKey) + 4;
      Object.defineProperty(result, boundedKey, { value: visit(object(input)[key], depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  };
  const result = object(visit(object(value), 0));
  const serialized = JSON.stringify(result);
  return Buffer.byteLength(serialized) <= cap ? result : { truncated: prefixText(serialized, (cap - 128) / 2) };
}
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
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, { value: redactSessionPath(item, path), enumerable: true, configurable: true, writable: true });
    return result;
  }
  return value;
}
async function checkedOpen(agent: string, session: AgentSession | undefined, roots: string[]): Promise<{ handle: FileHandle; sessionId: string; info: Stats }> {
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
    if (bytesRead < opened.size && prefix[bytesRead - 1] !== 10) lines.pop();
    const first = lines.find(line => line.trim());
    if (!first) throw fail();
    const header = object(JSON.parse(first));
    if (header.type !== "session" && header.type !== "title") throw fail();
    let sessionId = "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = object(JSON.parse(line));
        if (entry.type === "session") { sessionId = str(entry.id); break; }
      } catch { /* A bounded trailing header fragment is not a session header. */ }
    }
    return { handle, sessionId: sessionId.replaceAll(session.value, "[session file]") || `file-${opened.dev}-${opened.ino}`, info: opened };
  } catch { await handle?.close(); throw fail(); }
}
export async function readableTranscript(agent: string, session: AgentSession | undefined, roots = defaultTranscriptRoots()): Promise<boolean> {
  try { const { handle } = await checkedOpen(agent, session, roots); await handle.close(); return true; } catch { return false; }
}
type Entry = Record<string, unknown>;
type Picture = { mediaType: string; data: string };
type ToolRecord = Extract<TranscriptRecord, { kind: "tool" }>;
type Parsed = { branch: Entry[]; records: TranscriptRecord[]; texts: Map<string, string>; images: Map<string, Picture[]>; tools: Map<string, ToolRecord>; todos: Map<string, { record: Extract<TranscriptRecord, { kind: "todo" }>; fingerprint: string }>; interrupted: Set<string>; unresolved: Set<string>; liveTailTool?: string };
function emptyParsed(): Parsed {
  return { branch: [], records: [], texts: new Map(), images: new Map(), tools: new Map(), todos: new Map(), interrupted: new Set(), unresolved: new Set() };
}

function liveInterruptedTool(parsed: Parsed, status: AgentStatus): string | undefined {
  if (status !== "working" || !parsed.liveTailTool || !parsed.interrupted.has(parsed.liveTailTool)) return undefined;
  let last: string | undefined;
  for (const id of parsed.unresolved) last = id;
  return last === parsed.liveTailTool ? last : undefined;
}
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
export function activeTranscriptBranch(entries: Entry[]): Entry[] {
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
  return branch;
}
export function parseTranscript(entries: Entry[], entryImages?: Map<string, Picture[]>): Parsed {
  const parsed = emptyParsed();
  appendRecords(parsed, activeTranscriptBranch(entries), entryImages);
  return parsed;
}

function appendRecords(parsed: Parsed, branch: Entry[], entryImages?: Map<string, Picture[]>): void {
  const { records, texts, images, tools } = parsed;
  for (const entry of branch) {
    parsed.branch.push(entry);
    const id = str(entry.id), ts = str(entry.timestamp ?? entry.ts), type = str(entry.type);
    parsed.liveTailTool = undefined;
    if (type === "custom_message" && entry.customType === "async-result" && entry.display === true) {
      const jobs = object(entry.details).jobs;
      if (Array.isArray(jobs)) for (const value of jobs.slice(0, 64)) {
        const job = object(value), jobId = str(job.jobId);
        for (const record of records) if (record.kind === "subagents") {
          for (const child of record.children) if (child.id === jobId) {
            const result = object(object(job.schema).data);
            child.status = result.aborted === true ? "cancelled" : result.error ? "error" : "completed";
          }
        }
      }
    }
    const addImages = (recordId: string, content: unknown[]) => {
      const found = entryImages?.get(id) ?? pictures(content);
      if (found.length) images.set(recordId, found);
      return found.length ? refs(found) : undefined;
    };
    const native = nativeCustomRecord(entry);
    if (native) {
      records.push(native);
      if (native.kind === "todo") parsed.todos.set(id, { record: native, fingerprint: JSON.stringify(object(entry.data).phases) });
      continue;
    }
    if (type === "custom" && entry.customType === "todo_hud_state") {
      const data = object(entry.data);
      const source = str(data.sourceEntryId);
      const todo = parsed.todos.get(source);
      if (todo && str(data.fingerprint) === todo.fingerprint) todo.record.visibility = data.visibility === "dismissed" ? "dismissed" : "visible";
      continue;
    }
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
      parsed.interrupted.delete(tool.id);
      parsed.unresolved.delete(tool.id);
      tool.endedTs = ts; tool.images = addImages(tool.id, content);
      const nativeRecords = nativeResultRecords(tool.name, details, tool.id, ts);
      records.push(...nativeRecords);
      for (const record of nativeRecords) if (record.kind === "todo") parsed.todos.set(id, { record, fingerprint: JSON.stringify(details.phases) });
      continue;
    }
    if (role === "user") {
      const text = content.map(value => str(object(value).text)).filter(Boolean).join("\n"); texts.set(id, text);
      records.push({ kind: "user", id, ts, text: capped(text, TEXT_CAP).text, images: addImages(id, content) }); continue;
    }
    if (role !== "assistant" && !startEvent) continue;
    const start = type === "custom" ? object(entry.data) : entry;
    const assistantBlocks = startEvent ? [{ type: "toolCall", id: start.toolCallId, name: start.toolName, arguments: start.args }] : content;
    if (startEvent) {
      const existing = tools.get(str(start.toolCallId));
      if (existing) existing.summary = prefixText(str(start.intent) || str(object(start.args).i) || existing.subject, 256);
    }
    const turnCalls: string[] = [];
    if (startEvent) parsed.liveTailTool = str(start.toolCallId);
    assistantBlocks.forEach((value, index) => {
      const block = object(value), blockId = `${id}:${index}`, blockType = str(block.type);
      if (blockType === "toolCall" || blockType === "tool_call") {
        const callId = str(block.id ?? block.toolCallId) || blockId;
        if (tools.has(callId)) return;
        const name = str(block.name), args = boundedArgs(block.arguments ?? block.args);
        const tool: Extract<TranscriptRecord, { kind: "tool" }> = { kind: "tool", id: callId, ts, name, subject: subject(name, args), summary: prefixText(str(startEvent ? start.intent : block.intent) || str(args.i) || subject(name, args), 256), args, status: "running" };
        tools.set(callId, tool); records.push(tool);
        parsed.unresolved.add(callId);
        if (!startEvent) turnCalls.push(callId);
      } else if (blockType === "text" || blockType === "thinking") {
        const text = str(block.text ?? block.thinking); texts.set(blockId, text);
        if (blockType === "thinking") records.push({ kind: "thinking", id: blockId, ts, text: capped(text, TEXT_CAP).text, ...(block.redacted === true ? { redacted: true } : {}) });
        else records.push({ kind: "assistant", id: blockId, ts, text: capped(text, TEXT_CAP).text, ...(typeof message.model === "string" ? { model: message.model } : {}) });
      }
    });
    const stopReason = str(message.stopReason);
    if (role === "assistant" && (stopReason === "error" || stopReason === "aborted")) {
      const detail = capped(str(message.errorMessage), TEXT_CAP).text;
      records.push({ kind: "divider", id: `${id}:stop`, ts, variant: stopReason, label: prefixText(detail.split("\n")[0] || `Assistant ${stopReason}`, 140), ...(detail ? { detail } : {}) });
      for (const callId of turnCalls) {
        const tool = tools.get(callId);
        if (!tool || tool.status !== "running" || tool.endedTs !== undefined) continue;
        tool.status = "error";
        tool.output = { text: "interrupted", truncated: false };
        texts.set(callId, "interrupted");
        parsed.interrupted.add(callId);
      }
    }
  }
}
// Keep branch topology and rendering inputs, not model accounting or request controls.
// Images live separately so inactive branches remain replayable without retaining base64 in entries.
function compactEntry(entry: Entry, images: Map<string, Picture[]>): Entry {
  const compact: Entry = { id: str(entry.id), parentId: str(entry.parentId), type: str(entry.type), timestamp: str(entry.timestamp ?? entry.ts) };
  const type = str(entry.type);
  for (const key of ["cwd", "model", "modelId", "provider", "thinkingLevel", "configured", "serviceTier", "mode"]) {
    if (typeof entry[key] === "string") compact[key] = prefixText(entry[key], 1024);
  }
  if (type === "custom" && ["user_todo_edit", "todo_hud_state", "vibe-session-lifecycle"].includes(str(entry.customType))) {
    compact.customType = entry.customType;
    compact.data = boundedArgs(entry.data, 64 * 1024, 2048, 10);
    return compact;
  }
  if (["compaction", "reset_boundary", "model_change", "mode_change"].includes(type)) {
    for (const key of ["label", "modelId", "model"]) if (typeof entry[key] === "string") compact[key] = prefixText(entry[key], 1024);
    if (typeof entry.summary === "string") compact.summary = capped(entry.summary, TEXT_CAP).text;
    return compact;
  }
  const startEvent = type === "tool_execution_start" || (type === "custom" && entry.customType === "tool_execution_start");
  if (startEvent) {
    const source = type === "custom" ? object(entry.data) : entry;
    const start = { toolCallId: str(source.toolCallId), toolName: str(source.toolName), args: boundedArgs(source.args), intent: prefixText(str(source.intent), 2048), startedAt: str(source.startedAt) };
    if (type === "custom") { compact.customType = "tool_execution_start"; compact.data = start; }
    else Object.assign(compact, start);
    return compact;
  }
  if (type !== "message" && (type !== "custom_message" || entry.display !== true)) return compact;
  const source = type === "message" ? object(entry.message) : entry;
  const role = type === "custom_message" ? "assistant" : str(source.role);
  if (!["user", "developer", "assistant", "toolResult", "tool_result"].includes(role)) return compact;
  const content = blocks(source);
  if (role === "user" || role === "toolResult" || role === "tool_result") {
    const found = pictures(content);
    if (found.length) images.set(str(entry.id), found);
  }
  const message: Entry = { role, content: content.map(value => {
    const block = object(value), blockType = str(block.type);
    if (blockType === "text") return { type: blockType, text: str(block.text) };
    if (blockType === "thinking") return { type: blockType, text: str(block.text ?? block.thinking), redacted: block.redacted === true };
    if (blockType === "toolCall" || blockType === "tool_call") return { type: blockType, id: str(block.id ?? block.toolCallId), name: str(block.name), intent: prefixText(str(block.intent), 2048), arguments: boundedArgs(block.arguments ?? block.args) };
    return { type: blockType };
  }) };
  if (typeof source.model === "string") message.model = source.model;
  if (typeof source.provider === "string") message.provider = source.provider;
  if (source.usage) message.usage = boundedArgs(source.usage);
  if (source.contextSnapshot) message.contextSnapshot = boundedArgs(source.contextSnapshot);
  if (role === "assistant" && (source.stopReason === "error" || source.stopReason === "aborted")) {
    message.stopReason = str(source.stopReason);
    message.errorMessage = capped(str(source.errorMessage), TEXT_CAP).text;
  }
  if (role === "toolResult" || role === "tool_result") {
    message.toolCallId = str(source.toolCallId ?? source.tool_call_id);
    const details = object(source.details);
    message.details = boundedArgs(details, 64 * 1024, 2048, 10);
    message.isError = source.isError === true || details.isError === true || details.error !== undefined || (typeof details.exitCode === "number" && details.exitCode !== 0);
  }
  if (type === "custom_message") { compact.display = true; compact.customType = entry.customType; compact.details = boundedArgs(source.details, 16 * 1024, 512); compact.content = message.content; compact.model = message.model; compact.stopReason = message.stopReason; compact.errorMessage = message.errorMessage; }
  else compact.message = message;
  return compact;
}

type Cache = {
  size: number; offset: number; start: number; sessionId: string;
  entries: Entry[]; ids: Set<string>; images: Map<string, Picture[]>; parsed: Parsed;
  revision: string; hash: Hash; prefixHash: string; boundaryHash: string;
  mtimeMs: number; ctimeMs: number; entryBytes: number; imageBytes: number; retainedBytes: number;
  generationChecksum: number | bigint; fullSeed: number | bigint; fullOffset: number;
};

type StoreOptions = {
  cacheBytes?: number;
  readChunk?: (handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number) => Promise<number>;
};

async function fingerprint(handle: FileHandle, position: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return createHash("sha256").update(buffer.subarray(0, offset)).digest("hex");
}

// Fixed chunk boundaries permit extending the checksum from the last complete chunk.
// The scratch buffer is reused; no consumed-file bytes are retained in the cache.
async function regionChecksum(handle: FileHandle, start: number, end: number, seed: number | bigint = 0): Promise<{ checksum: number | bigint; fullSeed: number | bigint; fullOffset: number }> {
  const chunkBytes = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, end - start));
  let position = start, fullOffset = start;
  let checksum: number | bigint = seed, fullSeed: number | bigint = seed;
  while (position < end) {
    const length = Math.min(chunkBytes, end - position);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    if (!filled) break;
    checksum = Bun.hash(buffer.subarray(0, filled), checksum);
    position += filled;
    if (filled === chunkBytes) { fullSeed = checksum; fullOffset = position; }
    if (filled < length) break;
  }
  return { checksum, fullSeed, fullOffset };
}

export class TranscriptStore {
  private readonly cache = new Map<string, Cache>();
  private readonly pending = new Map<string, Promise<Cache>>();
  private readonly waiters: Array<() => void> = [];
  private activeLoads = 0;
  private retainedBytes = 0;
  private readonly cacheBudget: number;

  constructor(private readonly roots = defaultTranscriptRoots(), private readonly fileCap = FILE_CAP, private readonly options: StoreOptions = {}) {
    this.cacheBudget = options.cacheBytes ?? 192 * 1024 * 1024;
  }

  private async load(agent: string, session: AgentSession | undefined, sessionId: string): Promise<Cache> {
    const key = JSON.stringify([sessionId, agent, session?.kind, session?.value]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.queuedRead(agent, session, sessionId);
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }

  private async queuedRead(agent: string, session: AgentSession | undefined, sessionId: string): Promise<Cache> {
    if (this.activeLoads >= 2) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.activeLoads++;
    try { return await this.read(agent, session, sessionId); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.activeLoads--;
    }
  }

  private remove(key: string): Cache | undefined {
    const cached = this.cache.get(key);
    if (cached) { this.retainedBytes -= cached.retainedBytes; this.cache.delete(key); }
    return cached;
  }

  private async read(agent: string, session: AgentSession | undefined, sessionId: string): Promise<Cache> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { handle, sessionId: ompSessionId, info } = await checkedOpen(agent, session, this.roots);
      try {
        // Separate aliases cannot concurrently mutate one cached object or redact against a different path.
        const key = JSON.stringify([info.dev, info.ino, sessionId, session?.value]);
        let cache = this.remove(key);
        const start = Math.max(0, info.size - this.fileCap);
        let reuse = cache !== undefined;
        if (cache) {
          reuse = info.size >= cache.size && !(info.size <= cache.size && (info.mtimeMs !== cache.mtimeMs || info.ctimeMs !== cache.ctimeMs)) && !(cache.start === 0 && start > 0) && !(cache.start > 0 && info.size !== cache.size);
          if (reuse) {
            const guardLength = Math.min(cache.offset, GUARD_BYTES);
            const prefix = await fingerprint(handle, 0, guardLength);
            const boundary = await fingerprint(handle, cache.offset - guardLength, guardLength);
            reuse = prefix === cache.prefixHash && boundary === cache.boundaryHash;
            if (reuse && info.size > cache.size) {
              const retained = await regionChecksum(handle, cache.start, cache.offset);
              reuse = retained.checksum === cache.generationChecksum;
            }
          }
        }
        if (!cache || !reuse) {
          cache = {
            size: 0, offset: start, start, sessionId: ompSessionId, entries: [], ids: new Set(), images: new Map(), parsed: emptyParsed(),
            revision: "", hash: createHash("sha256").update(`${key}:${start}`), prefixHash: "", boundaryHash: "",
            mtimeMs: 0, ctimeMs: 0, entryBytes: 0, imageBytes: 0, retainedBytes: 0,
            generationChecksum: 0, fullSeed: 0, fullOffset: start,
          };
        }
        const priorOffset = cache.offset;
        const length = Math.min(info.size - cache.offset, this.fileCap);
        if (length > 0) {
          const buffer = Buffer.alloc(length);
          let count = 0;
          while (count < length) {
            const bytesRead = this.options.readChunk
              ? await this.options.readChunk(handle, buffer, count, length - count, cache.offset + count)
              : (await handle.read(buffer, count, length - count, cache.offset + count)).bytesRead;
            if (!bytesRead) break;
            count += bytesRead;
          }
          const end = buffer.subarray(0, count).lastIndexOf(10);
          if (end >= 0) {
            const data = buffer.subarray(0, end + 1);
            let cursor = cache.start > 0 && cache.offset === cache.start ? data.indexOf(10) + 1 : 0;
            const appended: Entry[] = [];
            let previousId = str(cache.entries.at(-1)?.id);
            let continuesBranch = cache.entries.length > 0;
            while (cursor < data.length) {
              const newline = data.indexOf(10, cursor);
              const line = data.subarray(cursor, newline);
              cursor = newline + 1;
              if (line.length > LINE_CAP) continue;
              try {
                const raw = object(JSON.parse(line.toString("utf8")));
                if (typeof raw.id !== "string") continue;
                const oldImages = cache.images.get(raw.id);
                const entry = object(redactSessionPath(compactEntry(raw, cache.images), session!.value));
                const newImages = cache.images.get(raw.id);
                if (newImages !== oldImages) {
                  cache.imageBytes += (newImages ?? []).reduce((sum, image) => sum + Buffer.byteLength(image.data) + Buffer.byteLength(image.mediaType), 0);
                  cache.imageBytes -= (oldImages ?? []).reduce((sum, image) => sum + Buffer.byteLength(image.data) + Buffer.byteLength(image.mediaType), 0);
                }
                const id = str(entry.id);
                if (str(entry.parentId) !== previousId || cache.ids.has(id) || ["compaction", "reset_boundary"].includes(str(entry.type))) continuesBranch = false;
                previousId = id;
                cache.ids.add(id);
                cache.entries.push(entry);
                cache.entryBytes += Buffer.byteLength(JSON.stringify(entry));
                appended.push(entry);
              } catch { /* Invalid and oversized complete lines remain inert. */ }
            }
            cache.offset += end + 1;
            if (continuesBranch) appendRecords(cache.parsed, appended, cache.images);
            else cache.parsed = parseTranscript(cache.entries, cache.images);
            cache.hash.update(data);
            cache.revision = `"${cache.hash.copy().digest("hex")}"`;
          }
        }
        if (!reuse || cache.offset !== priorOffset) {
          const generation = await regionChecksum(handle, cache.fullOffset, cache.offset, cache.fullSeed);
          cache.generationChecksum = generation.checksum;
          cache.fullSeed = generation.fullSeed;
          cache.fullOffset = generation.fullOffset;
        }
        const guardLength = Math.min(cache.offset, GUARD_BYTES);
        cache.prefixHash = await fingerprint(handle, 0, guardLength);
        cache.boundaryHash = await fingerprint(handle, cache.offset - guardLength, guardLength);
        const after = await handle.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) continue;
        if (!cache.revision) cache.revision = `"${createHash("sha256").update(key).digest("hex")}"`;
        cache.size = after.size;
        cache.mtimeMs = after.mtimeMs;
        cache.ctimeMs = after.ctimeMs;
        // Conservative charged bytes include strings, replay/render maps and per-entry object overhead;
        // this is a retained-payload budget, not a claim about the JS engine's exact RSS.
        cache.retainedBytes = (cache.entryBytes + cache.imageBytes) * 4 + cache.entries.length * 256;
        this.cache.set(key, cache);
        this.retainedBytes += cache.retainedBytes;
        while (this.cache.size > 8 || this.retainedBytes > this.cacheBudget) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.remove(oldest);
        }
        return cache;
      } finally { await handle.close(); }
    }
    throw new TranscriptError(503, "transcript changed during read");
  }

  async transcript(paneId: string, sessionId: string, agent: string, agentSession: AgentSession | undefined, agentStatus: AgentStatus, limit = 60): Promise<TranscriptResponse> {
    const cache = await this.load(agent, agentSession, sessionId), total = cache.parsed.records.length;
    const count = Number.isFinite(limit) && limit > 0 ? Math.min(400, Math.floor(limit)) : 60;
    const revision = `"${createHash("sha256").update(cache.revision).update(agentStatus).update(String(count)).digest("hex")}"`;
    const liveTool = liveInterruptedTool(cache.parsed, agentStatus);
    const records = cache.parsed.records.slice(-count).map(record => {
      if (record.kind === "tool" && record.id === liveTool) return { ...record, status: "running" as const, output: undefined };
      return record;
    });
    return { paneId, sessionId: cache.sessionId, revision, total, records, hasEarlier: total > count, agentStatus, truncatedFile: cache.start > 0 };
  }
  async record(sessionId: string, agent: string, session: AgentSession | undefined, recordId: string, agentStatus: AgentStatus = "idle"): Promise<{ recordId: string; text: string; truncated: boolean }> {
    const cache = await this.load(agent, session, sessionId), text = cache.parsed.texts.get(recordId);
    if (text === undefined || recordId === liveInterruptedTool(cache.parsed, agentStatus)) throw new TranscriptError(404, "transcript record not found");
    return { recordId, ...capped(text, FULL_CAP) };
  }
  async image(sessionId: string, agent: string, session: AgentSession | undefined, recordId: string, index: number): Promise<{ bytes: Buffer; mediaType: string }> {
    const cache = await this.load(agent, session, sessionId), image = cache.parsed.images.get(recordId)?.[index];
    if (!image || !Number.isInteger(index) || index < 0) throw new TranscriptError(404, "transcript image not found");
    if (Buffer.byteLength(image.data, "base64") > IMAGE_CAP) throw new TranscriptError(413, "transcript image exceeds limit");
    return { bytes: Buffer.from(image.data, "base64"), mediaType: image.mediaType };
  }
}
