export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  name?: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  kind?: "agent" | "shell";
}

export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
}

export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
}

export interface SessionSummary {
  name: string;
  isPrimary: boolean;
  reachable: boolean;
  agents: number;
  working: number;
  blocked: number;
}

export interface DeviceAuth {
  enforced: boolean;
  device: string | null;
  authorized: boolean;
}

export interface UpdateStatus {
  enabled: boolean;
  lastCheckSucceeded: boolean | null;
  current: string;
  latest: string | null;
  latestUrl: string | null;
  releaseAvailable: boolean;
  bridgeStale: boolean;
  checkedAt: number | null;
}

export interface SnapshotResponse {
  bridge: "connected" | "disconnected";
  device?: DeviceAuth;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  sessions?: SessionSummary[];
  notifications?: { snoozedUntil: number | null };
  update?: UpdateStatus;
  ts: number;
}

export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  revision: number;
  notModified?: boolean;
}

export type ActionResponse =
  | { ok: true }
  | { ok: false; error: string; textDelivered?: boolean; deliveryAmbiguous?: boolean };

export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

export type CreateResponse =
  | { ok: true; pane: CreatedPane }
  | { ok: false; error: string; deliveryAmbiguous?: boolean };
export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  build?: string;
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "Needs input",
  working: "Working",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown",
};

export function isReadOnly(device: DeviceAuth | undefined): boolean {
  return Boolean(device?.enforced && !device.authorized);
}
