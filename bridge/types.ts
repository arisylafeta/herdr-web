// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in herdr-client.ts). The rest of the app talks in these terms.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * A single pane the user might want to monitor or drive. Usually an agent-bearing pane (the
 * triage home), but also a bare **shell** pane (`kind:"shell"`, `agent:"shell"`) once we surface
 * those so a freshly-created tab/space is reachable and you can launch your own agent in it.
 */
export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  /** User-managed Herdr agent name. Agent kind remains in `agent`. */
  name?: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Defaults to "agent" when absent. */
  kind?: "agent" | "shell";
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. From `workspace.list`. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  /** Whether this is the focused workspace in the desktop TUI (read-only; we never set focus). */
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
  /** Git checkout identity reported by Herdr. Linked worktrees share repoKey with their parent. */
  worktree?: WorkspaceWorktreeView;
}

export interface WorkspaceWorktreeView {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  isLinkedWorktree: boolean;
}

/** A tab within a workspace (a layout/view holding one or more panes). From `tab.list`. */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
}

export type BridgeStatus = "connected" | "disconnected";

/**
 * One entry in the snapshot's `sessions` list — a herdr session this bridge fronts. Additive: a
 * single-session deployment reports exactly one (the primary), so nothing about the UI changes.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default" or "collie-demo". Client passes this back as `?session=`. */
  name: string;
  /** The session cfg.socketPath points at — all pre-multi-session behaviour maps to it. */
  isPrimary: boolean;
  /** Whether this session's last poll succeeded (a stale/unreachable socket reads false). */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  /** Agent panes currently working / blocked (0 when unreachable). */
  working: number;
  blocked: number;
}

/**
 * Per-device authorisation state for the requesting client (see `deviceAuth()` in server.ts).
 * Reported in the snapshot so the UI can show a read-only state. Optional on the wire so an older
 * bridge (or a response from before the feature existed) simply reads as "not enforced".
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all (COLLIE_DEVICE_HEADER is set). */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

// ── REST response shapes (authoritative reads; WebSocket events trigger refreshes) ────────

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  /** Agent-bearing panes, triage-sorted (the home list). */
  agents: AgentView[];
  /** Bare shell panes (no agent) — surfaced so freshly-created tabs/spaces are reachable. */
  shellPanes: AgentView[];
  /** All spaces (workspaces) and their tabs, for the space/tab navigator. */
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /**
   * Every herdr session this bridge fronts (primary first, then alphabetical). Always present; a
   * single-session deployment lists just the primary, so the switcher UI can stay hidden.
   */
  sessions: SessionSummary[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. */
  notifications?: { snoozedUntil: number | null };
  /** Update-availability signal. Optional — a stale bridge that predates the field simply omits it,
   *  which the client reads as "no info" (see bridge/update.ts). */
  update?: UpdateStatus;
  ts: number;
}

/**
 * GET /api/snapshot `update` — whether the running plugin is behind (see bridge/update.ts). Both a
 * newer upstream RELEASE (`releaseAvailable` + `latest`) and a rebuilt-but-not-restarted bridge
 * PROCESS (`bridgeStale`) surface here; the client shows one banner, `bridgeStale` taking precedence.
 */
export interface UpdateStatus {
  /** Whether a canonical upstream repository is configured for release checks. */
  enabled: boolean;
  /** Outcome of the most recent attempted upstream check; null until one is attempted. */
  lastCheckSucceeded: boolean | null;
  /** The running bridge/plugin version, captured at process start. */
  current: string;
  /** Newest upstream release (dotted `X.Y.Z`, no leading `v`), or null if unknown/none yet. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** `latest` is strictly newer than `current`. */
  releaseAvailable: boolean;
  /** The running process is behind the on-disk bridge source — restart the herdr-control service. */
  bridgeStale: boolean;
  /** When the upstream check last completed (epoch ms), or null if it hasn't run yet. */
  checkedAt: number | null;
}

/** GET /api/pane/:id — recent terminal output for one agent (ANSI/SGR, rendered colored). */
export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — passed through for the client's prompt-select race guard. */
  revision: number;
}

/**
 * POST /api/pane/:id/{reply,keys} — result of a send. Discriminated on `ok`: a failure always
 * carries the reason Herdr rejected it. `textDelivered` is the reply safety flag: true means the text
 * definitely landed OR its post-write acknowledgement was lost, so the client must not resend it —
 * resending could duplicate terminal input. Absent/false means nothing landed and a resend is safe.
 */
export type ActionResponse =
  | { ok: true }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      /** The mutation reached Herdr but its acknowledgement was lost; do not retry blindly. */
      deliveryAmbiguous?: boolean;
    };

/** POST /api/pane/:id/upload — image saved to a host file; `path` is the absolute path to ref. */
export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** One workspace-relative entry returned by the read-only file browser. */
export interface WorkspaceFileEntry {
  path: string;
  kind: "file" | "directory";
}

/** GET /api/workspace/:id/files — a bounded, workspace-root-relative project tree. */
export interface WorkspaceFilesResponse {
  workspaceId: string;
  root: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

/** GET /api/workspace/:id/file?path=... — a bounded text or image preview. */
export interface WorkspaceFileResponse {
  workspaceId: string;
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

export interface WorkspaceGitFile {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  insertions: number;
  deletions: number;
}

/** GET /api/workspace/:id/git — local, read-only repository state. */
export interface WorkspaceGitStatusResponse {
  workspaceId: string;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  files: WorkspaceGitFile[];
}

/** GET /api/workspace/:id/diff?path=... — a bounded unified patch. */
export interface WorkspaceGitDiffResponse {
  workspaceId: string;
  path: string;
  patch: string;
  truncated: boolean;
}

/** A freshly-created shell pane — enough for the client to navigate into before the next poll. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/**
 * POST /api/tab | /api/workspace — created a new tab/space with a fresh shell. On success `pane`
 * is that shell, so the client can navigate straight into it before the next poll lands.
 */
export type CreateResponse =
  | { ok: true; pane: CreatedPane }
  | { ok: false; error: string; deliveryAmbiguous?: boolean };

/** POST /api/worktree — a linked checkout and its initial terminal tab. */
export type WorktreeCreateResponse =
  | { ok: true; pane: CreatedPane; workspace: WorkspaceView; tab: TabView }
  | { ok: false; error: string; deliveryAmbiguous?: boolean };

/** GET /api/config — bridge capabilities and the build id (push setup + stale-cache detection). */
export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
}

/** Rank for triage ordering — lower sorts first ("NEEDS YOU" at the top). */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
};
