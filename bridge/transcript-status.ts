import { Database } from "bun:sqlite";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentStatus } from "./types";
import type { TranscriptStatus } from "./transcript-types";
import { readWorkspaceGitStatus } from "./workspace-inspection";

type Entry = Record<string, unknown>;
const object = (value: unknown): Entry => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Entry : {};
const text = (value: unknown, cap = 256): string => typeof value === "string" ? value.slice(0, cap) : "";
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown): string | undefined => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
const live = (status: AgentStatus): boolean => status === "working" || status === "blocked";

// Only owner-controlled, non-symlink paths beneath the bridge user's home are inspected.
async function ownedPath(path: string): Promise<boolean> {
  const home = homedir(), rel = relative(home, path);
  if (!isAbsolute(path) || path.length > 4096 || path.split(sep).includes("..") || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  let current = home;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink() || info.uid !== process.getuid?.()) return false;
  }
  return await realpath(path).catch(() => "") === path;
}

type Metadata = { name: string; window?: number };
const modelCache = new Map<string, { at: number; value?: Metadata }>();
async function modelMetadata(provider: string, id: string): Promise<Metadata | undefined> {
  const key = `${provider}/${id}`, cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: Metadata | undefined;
  const path = join(homedir(), ".omp", "agent", "models.db");
  let db: Database | undefined;
  try {
    if (!await ownedPath(path)) return undefined;
    const before = await lstat(path);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) return undefined;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = await lstat(path + suffix).catch(() => undefined);
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.uid !== before.uid)) return undefined;
    }
    db = new Database(path, { readonly: true, create: false });
    const after = await lstat(path);
    if (before.ino !== after.ino || before.dev !== after.dev || after.isSymbolicLink()) return undefined;
    // Select only display metadata, never headers, keys or provider configuration.
    const row = db.query<{ name: string | null; window: number | null }, [string, string]>(`
      SELECT substr(json_extract(m.value, '$.name'), 1, 256) AS name,
             json_extract(m.value, '$.contextWindow') AS window
      FROM model_cache AS c, json_each(c.models) AS m
      WHERE c.provider_id = ? AND length(c.models) <= 8388608
        AND json_extract(m.value, '$.id') = ? LIMIT 1
    `).get(provider, id);
    if (row) value = { name: text(row.name).replace(/^Claude /, "") || id, window: number(row.window) };
  } catch { /* Missing, locked or incompatible cache means unknown metadata. */ }
  finally { db?.close(); }
  if (modelCache.size >= 128) modelCache.delete(modelCache.keys().next().value!);
  modelCache.set(key, { at: Date.now(), value });
  return value;
}

type Git = NonNullable<TranscriptStatus["git"]>;
const gitCache = new Map<string, { at: number; value?: Git; pending?: Promise<void> }>();
function cachedGit(cwd: string): Git | undefined {
  let cached = gitCache.get(cwd);
  if (!cached) {
    if (gitCache.size >= 64) {
      const disposable = [...gitCache].find(([, entry]) => !entry.pending);
      if (!disposable) return undefined;
      gitCache.delete(disposable[0]);
    }
    cached = { at: 0 };
    gitCache.set(cwd, cached);
  }
  const state = cached;
  if (!state.pending && Date.now() - state.at > 5_000) {
    state.pending = (async () => {
      try {
        if (!await ownedPath(cwd)) { state.value = undefined; return; }
        const result = await readWorkspaceGitStatus("transcript", cwd);
        if (!result.isRepo) { state.value = undefined; return; }
        let staged = 0, unstaged = 0, untracked = 0;
        for (const file of result.files) {
          if (file.indexStatus === "?" && file.worktreeStatus === "?") untracked++;
          else {
            if (file.indexStatus !== " " && file.indexStatus !== "?") staged++;
            if (file.worktreeStatus !== " " && file.worktreeStatus !== "?") unstaged++;
          }
        }
        state.value = { branch: result.branch ?? "detached", staged, unstaged, untracked, ahead: result.ahead, behind: result.behind, dirty: staged + unstaged + untracked > 0 };
      } catch { state.value = undefined; }
      finally { state.at = Date.now(); state.pending = undefined; }
    })();
  }
  // A slow git inspection never delays a transcript, and old values expire.
  return Date.now() - state.at <= 30_000 ? state.value : undefined;
}

/** Prompt-anchor estimate only: no live tokenizer, pending prompt or settings correction is available on disk. */
export function estimateTranscriptContext(entries: Entry[], window: number): TranscriptStatus["context"] {
  if (!Number.isFinite(window) || window <= 0) return undefined;
  let tokens: number | undefined;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "reset_boundary" || entry.type === "branch_summary") {
      // Never reuse pre-compaction usage or pretend tokensBefore describes the new prompt.
      tokens = undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = object(entry.message), usage = object(message.usage), snapshot = object(message.contextSnapshot);
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
      const input = number(usage.input);
      const prompt = number(snapshot.promptTokens) ?? (input === undefined ? undefined : input + (number(usage.cacheRead) ?? 0) + (number(usage.cacheWrite) ?? 0));
      if (prompt !== undefined && prompt > 0) {
        tokens = Math.max(0, prompt - (number(snapshot.historyRewriteTokensRemoved) ?? 0));
        continue;
      }
    }
    if (tokens !== undefined) {
      // Bounded text approximation; images and unseen system/tool state remain unknown.
      const content = message.content;
      let chars = typeof content === "string" ? Math.min(content.length, 1_048_576) : 0;
      if (Array.isArray(content)) for (const raw of content.slice(0, 256)) {
        const block = object(raw);
        chars += text(block.text ?? block.thinking, 1_048_576).length;
        if (block.type === "toolCall") {
          try { chars += JSON.stringify(block.arguments ?? block.args ?? {}).slice(0, 1_048_576).length; } catch { /* malformed input */ }
        }
      }
      tokens += Math.ceil(chars / 4);
    }
  }
  if (tokens === undefined) return undefined;
  const percent = tokens / window * 100;
  const level = percent >= 90 || tokens >= 500_000 ? "critical" : percent >= 70 || tokens >= 270_000 ? "high" : percent >= 50 || tokens >= 150_000 ? "warn" : "ok";
  return { tokens, window, percent, level, source: "estimate" };
}

/** Entries must already be the active branch, in chronological order. */
export async function deriveTranscriptStatus(entries: Entry[], agentStatus: AgentStatus, fileUpdatedAt: string, cwd?: string): Promise<TranscriptStatus> {
  const status: TranscriptStatus = { freshness: { fileUpdatedAt } };
  let modelId = "", provider = "", headerCwd = "", turnStartedAt: string | undefined;
  const starts = new Map<string, NonNullable<TranscriptStatus["activity"]>>();
  for (const entry of entries) {
    const message = object(entry.message), data = object(entry.data);
    if (entry.type === "session") headerCwd = text(entry.cwd, 4096);
    if (entry.type === "model_change") {
      const model = text(entry.model);
      const slash = model.indexOf("/");
      provider = text(entry.provider) || (slash > 0 ? model.slice(0, slash) : "");
      modelId = text(entry.modelId) || (slash > 0 ? model.slice(slash + 1) : model);
    } else if (entry.type === "message" && message.role === "assistant" && text(message.model)) {
      modelId = text(message.model); provider = text(message.provider);
    }
    if (entry.type === "thinking_level_change") status.thinking = text(entry.thinkingLevel) || undefined;
    if (entry.type === "service_tier_change") status.serviceTier = text(entry.serviceTier) || undefined;
    if (entry.type === "mode_change") status.mode = text(entry.mode) || undefined;
    if (entry.type === "message" && (message.role === "user" || message.role === "developer")) {
      turnStartedAt = timestamp(entry.timestamp);
      starts.clear();
    }
    if (entry.type === "compaction" || entry.type === "reset_boundary" || (entry.type === "custom" && entry.customType === "session_exit")) {
      starts.clear();
      if (entry.type !== "compaction") turnStartedAt = undefined;
    }
    if (entry.type === "custom" && entry.customType === "tool_execution_start") {
      const id = text(data.toolCallId), startedAt = timestamp(data.startedAt) ?? timestamp(entry.timestamp), toolName = text(data.toolName);
      if (id && startedAt) {
        starts.delete(id);
        starts.set(id, { label: text(data.intent, 1024) || toolName || "Working", toolName: toolName || undefined, startedAt });
      }
    }
    if (entry.type === "message" && message.role === "toolResult") starts.delete(text(message.toolCallId));
    if (entry.type === "message" && message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "stop")) starts.clear();
  }
  if (modelId) {
    const metadata = provider ? await modelMetadata(provider, modelId) : undefined;
    status.model = { id: modelId, provider, name: metadata?.name ?? modelId.replace(/^Claude /, "") };
    if (metadata?.window) status.context = estimateTranscriptContext(entries, metadata.window);
  }
  if (live(agentStatus)) {
    status.turnStartedAt = turnStartedAt;
    status.activity = [...starts.values()].at(-1);
  }
  const effectiveCwd = text(cwd, 4096) || headerCwd;
  if (effectiveCwd && isAbsolute(effectiveCwd) && !effectiveCwd.split(sep).includes("..")) {
    status.cwd = effectiveCwd;
    status.git = cachedGit(effectiveCwd);
  }
  return status;
}
