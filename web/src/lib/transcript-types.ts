import type { AgentStatus } from "./types";

export type ImageRef = { index: number; mediaType: string; bytes: number };
export type TranscriptRecord =
  | { kind: "user"; id: string; ts: string; text: string; images?: ImageRef[] }
  | { kind: "assistant"; id: string; ts: string; text: string; model?: string }
  | { kind: "thinking"; id: string; ts: string; text: string; redacted?: boolean }
  | { kind: "tool"; id: string; ts: string; name: string; subject: string; args: Record<string, unknown>; status: "running" | "ok" | "error"; output?: { text: string; truncated: boolean }; images?: ImageRef[]; endedTs?: string }
  | { kind: "divider"; id: string; ts: string; variant: "compaction" | "reset" | "model" | "mode"; label: string; detail?: string };
export type TranscriptResponse = {
  paneId: string;
  sessionId: string;
  revision: string;
  total: number;
  records: TranscriptRecord[];
  hasEarlier: boolean;
  agentStatus: AgentStatus;
  truncatedFile: boolean;
};
