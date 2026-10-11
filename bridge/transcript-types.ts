import type { AgentStatus } from "./types";

export type ImageRef = { index: number; mediaType: string; bytes: number };
export type WorkerRow = { id: string; handle?: string; parentId?: string; cli?: "good" | "fast"; state: "starting" | "running" | "idle" | "dead"; turns?: number; queued?: number; turnsObservedAt?: string; queuedObservedAt?: string; elapsedMs?: number; model?: string; lastActivity?: string; currentTool?: string; outputTail?: string[]; observedAt?: string; prompt?: string; trace?: string[]; turnStartedAt?: string };
export type TodoStatus = "pending" | "active" | "completed" | "abandoned" | "blocked";
export type TodoPhase = { name: string; tasks: { content: string; status: TodoStatus; blocker?: string; details?: string; notes?: string }[] };
export type TodoSnapshot = { id: string; ts: string; phases: TodoPhase[]; visibility: "visible" | "dismissed" };
export type SubagentRow = { id: string; handle?: string; agentType: string; description: string; status: string; nesting: number; parentId?: string; toolCount?: number; model?: string; currentTool?: string; source?: "child" | "task-result" | "task-call" | "lifecycle"; childAvailable?: boolean };
export type TranscriptStatus = {
  model?: { id: string; name: string; provider: string }; thinking?: string; serviceTier?: string; mode?: string; turnStartedAt?: string;
  activity?: { label: string; toolName?: string; startedAt: string }; cwd?: string;
  git?: { branch: string; staged: number; unstaged: number; untracked: number; ahead?: number; behind?: number; dirty: boolean };
  context?: { tokens: number; window: number; percent: number; level: "ok" | "warn" | "high" | "critical"; source: "estimate" };
  todo?: TodoSnapshot;
  workers?: WorkerRow[]; freshness: { fileUpdatedAt: string; childUpdatedAt?: string };
};
export type TranscriptRecord =
  | { kind: "user"; id: string; ts: string; text: string; images?: ImageRef[] }
  | { kind: "assistant"; id: string; ts: string; text: string; model?: string }
  | { kind: "thinking"; id: string; ts: string; text: string; redacted?: boolean }
  | { kind: "tool"; id: string; ts: string; name: string; subject: string; summary?: string; args: Record<string, unknown>; status: "running" | "ok" | "error"; output?: { text: string; truncated: boolean }; images?: ImageRef[]; endedTs?: string }
  | { kind: "vibe"; id: string; ts: string; callId?: string; op: string; workers: WorkerRow[]; ack?: { id: string; mode?: "turn" | "steered" | "queued"; jobId?: string; cli?: "good" | "fast" }; killed?: { id: string; cancelledTurn: boolean }; wait?: { settled: number; stillRunning: number; timedOut: boolean; waiting: boolean } }
  | { kind: "irc"; id: string; ts: string; from: string; to?: string; body: string; replyTo?: string; auto?: boolean }
  | { kind: "todo"; id: string; ts: string; phases: TodoPhase[]; visibility?: "visible" | "dismissed" }
  | { kind: "subagents"; id: string; ts: string; callId?: string; children: SubagentRow[] }
  | { kind: "divider"; id: string; ts: string; variant: "compaction" | "reset" | "model" | "mode" | "error" | "aborted"; label: string; detail?: string };
export type TranscriptResponse = {
  paneId: string;
  sessionId: string;
  revision: string;
  total: number;
  records: TranscriptRecord[];
  hasEarlier: boolean;
  agentStatus: AgentStatus;
  truncatedFile: boolean;
  status?: TranscriptStatus;
};
