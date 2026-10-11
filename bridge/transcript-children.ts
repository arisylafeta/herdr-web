import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SubagentRow, WorkerRow } from "./transcript-types";

type Entry = Record<string, unknown>;
export type ChildProjection = { workers: WorkerRow[]; children: SubagentRow[]; childUpdatedAt?: string };
type Reference = { id: string; agent: string; description: string; cli?: "good" | "fast"; state: WorkerRow["state"]; turns?: number; turnsObservedAt?: string; startedAt?: number; lifecycle: boolean; source: "lifecycle" | "task-call" | "task-result"; unresolved?: boolean; callId?: string };
// Disk evidence expires: a saved unresolved tool is not proof of present liveness.
const RECENT_MS = 120_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 64;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 50_000;
const object = (value: unknown): Entry => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Entry : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const safeId = (value: unknown): string => { const id = string(value); return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) && !id.includes("..") && !id.startsWith("__advisor") ? id : ""; };
function text(value: unknown, limit = 240, paths: string[] = []): string {
  let scrubbed = string(value);
  for (const path of paths) scrubbed = scrubbed.replaceAll(path, "[path]");
  return scrubbed.slice(0, 4096).replace(/\b(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/gi, "[redacted]").replace(/(^|[\s"'`=(:])\/[^\s"'`),;]+/g, "$1[path]").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, limit);
}
function branch(entries: Entry[]): Entry[] {
  const bounded = entries.slice(-MAX_ENTRIES);
  const byId = new Map(bounded.map(entry => [string(entry.id), entry]));
  const result: Entry[] = [], seen = new Set<string>();
  let leaf = bounded.at(-1);
  while (leaf && result.length < MAX_ENTRIES) {
    const id = string(leaf.id);
    if (seen.has(id)) break;
    seen.add(id); result.push(leaf); leaf = byId.get(string(leaf.parentId));
  }
  return result.reverse();
}
function references(entries: Entry[]): Reference[] {
  const refs = new Map<string, Reference>();
  const taskCalls = new Set<string>();
  function add(idValue: unknown, values: Partial<Reference> = {}): Reference | undefined {
    const id = safeId(idValue);
    if (!id) return;
    const ref: Reference = refs.get(id) ?? { id, agent: "task", description: "", state: "starting", lifecycle: false, source: "task-call" };
    Object.assign(ref, values);
    if (!refs.has(id) && refs.size >= MAX_CHILDREN) {
      const priority = (value: Reference) => value.state === "running" ? 4 : value.state === "dead" ? 0 : value.unresolved ? 2 : 1;
      const oldest = [...refs.values()].reduce((candidate, value) => priority(value) < priority(candidate) ? value : candidate);
      if (priority(ref) < priority(oldest)) return;
      refs.delete(oldest.id);
    }
    refs.set(id, ref); return ref;
  }
  function call(name: string, args: Entry, callId: string) {
    if (name === "vibe_spawn") add(args.name, { description: text(args.prompt ?? args.message), cli: args.cli === "good" || args.cli === "fast" ? args.cli : undefined, unresolved: true, callId });
    if (name === "task") for (const value of items(args.tasks).slice(0, MAX_CHILDREN)) {
      const task = object(value); add(task.name ?? task.id, { agent: text(task.agent) || "task", description: text(task.description ?? task.task), unresolved: true, callId });
    }
  }
  for (const entry of entries) {
    const data = object(entry.data), message = object(entry.message);
    if (entry.type === "custom" && entry.customType === "vibe-session-lifecycle") {
      const id = safeId(data.id), action = string(data.action);
      if (!id || (action === "spawn" && data.childSessionFile !== `${id}.jsonl`)) continue;
      const ref = action === "spawn" ? add(id, { lifecycle: true, source: "lifecycle", agent: text(data.agent) || "task", cli: data.cli === "good" || data.cli === "fast" ? data.cli : undefined }) : refs.get(id);
      if (!ref) continue;
      if (action === "turn-started") {
        ref.state = "running"; ref.startedAt = Date.parse(string(entry.timestamp));
        if (typeof data.turn === "number" && Number.isFinite(data.turn)) {
          ref.turns = Math.max(0, Math.min(1_000_000, data.turn));
          ref.turnsObservedAt = Number.isFinite(ref.startedAt) ? new Date(ref.startedAt).toISOString() : undefined;
        }
      }
      if (action === "turn-settled" || action === "tombstone-revoked") ref.state = "idle";
      if (action === "tombstone") ref.state = "dead";
    }
    if (entry.type === "custom" && entry.customType === "tool_execution_start") {
      if (data.toolName === "task") taskCalls.add(string(data.toolCallId));
      call(string(data.toolName), object(data.args), string(data.toolCallId));
    }
    if (message.role === "assistant") for (const value of items(message.content).slice(-128)) {
      const block = object(value);
      if (block.type === "toolCall") {
        if (block.name === "task") taskCalls.add(string(block.id));
        call(string(block.name), object(block.arguments), string(block.id));
      }
    }
    if (message.role === "toolResult") for (const ref of refs.values()) if (ref.callId === message.toolCallId) ref.unresolved = false;
    // A task acknowledgement names generated IDs absent from the original call.
    if (message.role === "toolResult" && (message.toolName === "task" || taskCalls.has(string(message.toolCallId)))) for (const value of items(object(message.details).progress).slice(0, MAX_CHILDREN)) {
      const progress = object(value); add(progress.id, { source: "task-result", agent: text(progress.agent) || "task", description: text(progress.description ?? progress.task) });
    }
  }
  return [...refs.values()].reverse();
}
function contained(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); }
async function checkedPath(path: string, roots: string[], file: boolean): Promise<Stats | undefined> {
  if (!isAbsolute(path) || path !== resolve(path) || !roots.some(root => contained(root, path))) return;
  // Check every component, including ancestors above the allowed root.
  let current: string = sep;
  const parts = resolve(path).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return;
    if (roots.some(root => contained(root, current)) && info.uid !== process.getuid?.()) return;
    if (index === parts.length - 1) {
      if (info.uid !== process.getuid?.() || (file ? !info.isFile() : !info.isDirectory())) return;
      return info;
    }
  }
}
function activity(entries: Entry[], paths: string[]) {
  let model: string | undefined, latestTool: string | undefined, lastActivity: string | undefined;
  let ended = false, toolCount = 0;
  const pending = new Set<string>();
  let outputTail: string[] = [];
  for (const entry of entries) {
    const message = object(entry.message), data = object(entry.data);
    if (entry.type === "model_change") model = text(entry.modelId ?? entry.model, 160, paths) || model;
    if (entry.customType === "session_exit") { ended = true; pending.clear(); }
    if (entry.customType === "tool_execution_start") {
      pending.add(string(data.toolCallId)); latestTool = text(data.toolName, 80, paths); lastActivity = text(data.intent, 240, paths) || latestTool; toolCount++; ended = false;
    }
    if (message.role === "toolResult") pending.delete(string(message.toolCallId));
    if (message.role === "assistant") {
      model = text(message.model, 160, paths) || model;
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : items(message.content).slice(-128);
      for (const value of content) {
        const block = object(value);
        if (block.type === "text") {
          let output = string(block.text);
          for (const path of paths) output = output.replaceAll(path, "[path]");
          outputTail = output.slice(-4096).split("\n").filter(line => line.trim()).slice(-3).map(line => text(line, 320));
        }
        if (block.type === "toolCall") { pending.add(string(block.id)); latestTool = text(block.name, 80, paths); lastActivity = text(object(block.arguments).i ?? block.intent, 240, paths) || latestTool; }
      }
      if (["stop", "error", "aborted"].includes(string(message.stopReason))) { ended = true; pending.clear(); }
    }
  }
  return { model, latestTool, lastActivity, outputTail, ended, pending: pending.size > 0, toolCount };
}

/** Read referenced, owned child JSONL only; no directory scans or live-state claims. */
export async function readTranscriptChildren(sessionPath: string, entries: Record<string, unknown>[], roots: string[]): Promise<ChildProjection> {
  const workers: WorkerRow[] = [], children: SubagentRow[] = [];
  const empty = { workers, children };
  const canonicalRoots: string[] = [];
  for (const root of roots.slice(0, 32)) {
    if (!isAbsolute(root)) continue;
    try { const canonical = await realpath(root); if (canonical === resolve(root) && await checkedPath(canonical, [canonical], false)) canonicalRoots.push(canonical); } catch { /* unavailable root */ }
  }
  try { if (!sessionPath.endsWith(".jsonl") || !(await checkedPath(sessionPath, canonicalRoots, true))) return empty; } catch { return empty; }
  let bytes = 0, count = 0, latestMtime = 0;
  const seen = new Set<string>(), now = Date.now();
  type Branch = { path: string; entries: Entry[]; depth: number; parentId?: string; ancestry: string[]; paths: string[]; handle?: string };
  const queue: Branch[] = [{ path: sessionPath, entries, depth: 0, ancestry: [], paths: [sessionPath] }];
  async function visit(parent: Branch): Promise<void> {
    const { path: parentPath, entries: source, depth, parentId } = parent;
    if (depth >= MAX_DEPTH) return;
    const candidates = [];
    for (const ref of references(branch(source))) {
      const path = join(parentPath.slice(0, -6), `${ref.id}.jsonl`);
      let info: Stats | undefined;
      try { info = await checkedPath(path, canonicalRoots, true); } catch { /* unavailable child */ }
      const recent = !!info && now - info.mtimeMs <= RECENT_MS && info.mtimeMs <= now + 5000;
      const priority = ref.state === "dead" ? 0 : ref.state === "running" ? 4 : recent ? 3 : ref.unresolved ? 2 : 1;
      candidates.push({ ref, path, info, priority });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    for (const { ref, path, info } of candidates) {
      if (count >= MAX_CHILDREN) return;
      if (seen.has(path)) continue;
      seen.add(path); count++;
      const ancestry = [...parent.ancestry, ref.id];
      const id = createHash("sha256").update(JSON.stringify([sessionPath, ancestry])).digest("hex");
      const displayHandle = parent.handle && !ref.id.startsWith(`${parent.handle}.`) ? `${parent.handle}.${ref.id}` : ref.id;
      const paths = [path, ...parent.paths];
      const descriptor: SubagentRow = { id, handle: displayHandle, agentType: text(ref.agent, 240, paths), description: text(ref.description, 240, paths), status: ref.state === "dead" ? "dead" : "unknown", nesting: depth, parentId, source: ref.source, childAvailable: false };
      children.push(descriptor);
      let handle;
      try {
        if (!info || bytes >= MAX_BYTES || info.size > MAX_FILE_BYTES || info.size > MAX_BYTES - bytes) continue;
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== process.getuid?.() || !opened.isFile() || opened.size !== info.size) continue;
        // Recheck parents after open to reject a directory swapped for a symlink.
        if (!(await checkedPath(dirname(path), canonicalRoots, false))) continue;
        bytes += opened.size;
        const buffer = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await handle.stat();
        if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) continue;
        const childEntries: Entry[] = [];
        const raw = buffer.subarray(0, offset).toString("utf8");
        for (const line of raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n")) {
          if (!line) continue;
          if (childEntries.length >= MAX_ENTRIES) throw new Error("child entry limit");
          try { const entry = object(JSON.parse(line)); if (Object.keys(entry).length) childEntries.push(entry); } catch { /* torn or malformed line */ }
        }
        if (!childEntries.length) continue;
        latestMtime = Math.max(latestMtime, opened.mtimeMs);
        const a = activity(branch(childEntries), paths);
        const recent = now - opened.mtimeMs <= RECENT_MS && opened.mtimeMs <= now + 5000;
        let state = ref.state;
        if (state !== "dead" && !(ref.lifecycle && state === "idle")) {
          state = a.ended || !recent ? "idle" : a.pending || ref.state === "running" ? "running" : "idle";
        }
        workers.push({ id, handle: displayHandle, parentId, cli: ref.cli, state, ...(ref.turns !== undefined ? { turns: ref.turns, turnsObservedAt: ref.turnsObservedAt } : {}), model: a.model, lastActivity: a.lastActivity, currentTool: state === "running" && a.pending ? a.latestTool : undefined, outputTail: a.outputTail, observedAt: new Date(opened.mtimeMs).toISOString(), ...(state === "running" && ref.startedAt && ref.startedAt <= opened.mtimeMs ? { elapsedMs: opened.mtimeMs - ref.startedAt } : {}) });
        descriptor.source = "child";
        descriptor.childAvailable = true;
        descriptor.status = state === "running" ? "active" : state === "dead" ? "dead" : !recent ? "unknown" : a.ended || ref.lifecycle && ref.state === "idle" ? "idle" : "unknown";
        descriptor.toolCount = a.toolCount;
        descriptor.model = a.model;
        descriptor.currentTool = state === "running" && a.pending ? a.latestTool : undefined;
        queue.push({ path, entries: childEntries, depth: depth + 1, parentId: id, ancestry, paths, handle: displayHandle });
      } catch { /* unreadable, foreign or concurrently replaced child: retain unavailable descriptor */ }
      finally { await handle?.close(); }
    }
  }
  for (let index = 0; index < queue.length && count < MAX_CHILDREN; index++) await visit(queue[index]!);
  return { workers, children, ...(latestMtime ? { childUpdatedAt: new Date(latestMtime).toISOString() } : {}) };
}
