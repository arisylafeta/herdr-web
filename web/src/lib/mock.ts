import type { TranscriptRecord, TranscriptResponse } from "./transcript-types";
import type { PaneReadResponse, SnapshotResponse } from "./types";

const now = Date.now();

export const demoSnapshot: SnapshotResponse = {
  bridge: "connected",
  agents: [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "t3-herdr",
      workspaceNumber: 1,
      tabId: "w1:t1",
      name: "api-review",
      agent: "omp",
      transcript: true,
      status: "blocked",
      cwd: "/Users/demo/Projects/herdr-control",
      focused: true,
    },
    {
      paneId: "w2:p1",
      workspaceId: "w2",
      workspaceLabel: "herdr",
      workspaceNumber: 2,
      tabId: "w2:t1",
      name: "docs-worker",
      agent: "omp",
      transcript: true,
      status: "working",
      cwd: "/Users/demo/Projects/herdr",
      focused: false,
    },
    {
      paneId: "w3:p1",
      workspaceId: "w3",
      workspaceLabel: "collie",
      workspaceNumber: 3,
      tabId: "w3:t1",
      name: "release-check",
      agent: "opencode",
      status: "done",
      cwd: "/home/dev/collie",
      focused: false,
    },
    {
      paneId: "w4:p1",
      workspaceId: "w4",
      workspaceLabel: "remodex",
      workspaceNumber: 4,
      tabId: "w4:t1",
      name: "mobile-client",
      agent: "claude",
      status: "idle",
      cwd: "/home/dev/remodex",
      focused: false,
    },
  ],
  shellPanes: [
    {
      paneId: "w1:p2",
      workspaceId: "w1",
      workspaceLabel: "t3-herdr",
      workspaceNumber: 1,
      tabId: "w1:t2",
      agent: "shell",
      status: "idle",
      cwd: "/Users/demo/Projects/herdr-control",
      focused: false,
      kind: "shell",
    },
  ],
  workspaces: [
    {
      workspaceId: "w1",
      number: 1,
      label: "t3-herdr",
      focused: true,
      activeTabId: "w1:t1",
      tabCount: 2,
      paneCount: 2,
    },
    {
      workspaceId: "w2",
      number: 2,
      label: "herdr",
      focused: false,
      activeTabId: "w2:t1",
      tabCount: 1,
      paneCount: 1,
    },
    {
      workspaceId: "w3",
      number: 3,
      label: "collie",
      focused: false,
      activeTabId: "w3:t1",
      tabCount: 1,
      paneCount: 1,
    },
    {
      workspaceId: "w4",
      number: 4,
      label: "remodex",
      focused: false,
      activeTabId: "w4:t1",
      tabCount: 1,
      paneCount: 1,
    },
  ],
  tabs: [
    { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "control-plane", focused: true, paneCount: 1 },
    { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "shell", focused: false, paneCount: 1 },
    { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "main", focused: true, paneCount: 1 },
    { tabId: "w3:t1", workspaceId: "w3", number: 1, label: "main", focused: true, paneCount: 1 },
    { tabId: "w4:t1", workspaceId: "w4", number: 1, label: "ios-client", focused: true, paneCount: 1 },
  ],
  sessions: [
    { name: "default", isPrimary: true, reachable: true, agents: 4, working: 1, blocked: 1 },
  ],
  ts: now,
};

const demoOutput = `Codex  ·  gpt-5.4  ·  full access
~/Code/t3-herdr

I inspected T3 Code, Herdr, and Collie's current protocol boundaries.

The bridge should stay outside Herdr's terminal panes so it survives detach,
client disconnects, and Herdr restarts. The browser can then treat each
agent-bearing pane as a durable thread.

Completed
  ✓ mapped projects to Herdr workspaces
  ✓ mapped threads to panes and tabs
  ✓ retained event-poked session.snapshot polling
  ✓ retained loopback-only serving and Tailscale identity gates

Changed files (12)  +1,284 / -0
  bridge/                 socket adapter and secure REST bridge
  web/src/App.tsx         T3-style workspace shell
  web/src/index.css       responsive desktop and mobile design
  docs/ARCHITECTURE.md    reusable client boundary

Before I continue: should a new thread create a Herdr tab in the current
workspace, or create an isolated worktree as well?`;

export const demoPaneById: Record<string, PaneReadResponse> = Object.fromEntries(
  [...demoSnapshot.agents, ...demoSnapshot.shellPanes].map((pane) => [
    pane.paneId,
    {
      paneId: pane.paneId,
      text:
        pane.paneId === "w1:p1"
          ? demoOutput
          : `${pane.agent} · ${pane.workspaceLabel}\n${pane.cwd}\n\nSession is ${pane.status}.\n\nThis preview is using the local demo transport until the Herdr bridge is reachable.`,
      truncated: false,
      revision: 1,
    },
  ]),
);

export const demoImageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280" viewBox="0 0 640 280"><rect width="640" height="280" fill="#151820"/><g fill="none" stroke="#00b4ff" stroke-width="2"><rect x="40" y="60" width="150" height="150"/><rect x="240" y="60" width="150" height="150"/><rect x="440" y="60" width="150" height="150"/><path d="M190 135h50m150 0h50"/></g><g fill="#e8ecf4" font-family="monospace" font-size="18" text-anchor="middle"><text x="115" y="140">Browser</text><text x="315" y="140">Bridge</text><text x="515" y="140">omp</text></g></svg>')}`;

const ts = new Date(now).toISOString();
const earlierRecords: TranscriptRecord[] = Array.from({ length: 156 }, (_, index) =>
  index % 2 === 0
    ? { kind: "user", id: `history-${index}`, ts, text: `Review checkpoint ${index / 2 + 1}: keep the receiver boundary explicit.` }
    : { kind: "assistant", id: `history-${index}`, ts, text: `Checkpoint ${(index + 1) / 2} complete. Session-scoped reads stay isolated; the terminal remains available.` },
);
export const demoLongOutput = Array.from({ length: 92 }, (_, index) => `PASS ${String(index + 1).padStart(3, "0")}  receiver boundary / session ${index % 4 + 1} / conditional read`).join("\n");
export const demoRecords: TranscriptRecord[] = [
  ...earlierRecords,
  { kind: "divider", id: "model", ts, variant: "model", label: "Model · omp", detail: "Completed messages only. Tool activity is shown separately." },
  { kind: "divider", id: "mode", ts, variant: "mode", label: "Mode · coding" },
  { kind: "divider", id: "reset", ts, variant: "reset", label: "New context", detail: "Continuing the browser transcript review." },
  { kind: "user", id: "request", ts, text: "Inspect the bridge boundary and make the mobile conversation easier to follow." },
  { kind: "thinking", id: "thought", ts, text: "I’ll inspect the receiver seam first, keep existing terminal controls intact, then verify the transcript on a narrow viewport." },
  { kind: "tool", id: "read", ts, name: "read", subject: "web/src/lib/receiver.ts", args: { path: "web/src/lib/receiver.ts" }, status: "ok", output: { text: "BridgeReceiver owns session-scoped URLs, conditional requests, and abort signals.\nNo transport details need to leak into the message components.", truncated: false } },
  { kind: "tool", id: "test", ts, name: "bash", subject: "bun run test · receiver contract", args: { command: "bun run test" }, status: "ok", output: { text: demoLongOutput.slice(0, 900), truncated: true } },
  { kind: "tool", id: "error", ts, name: "bash", subject: "Checking optional preview server", args: { command: "curl http://127.0.0.1:19999/health" }, status: "error", output: { text: "Connection refused: the optional preview server is not running.\nThe bridge connection is unaffected.", truncated: false } },
  { kind: "divider", id: "compaction", ts, variant: "compaction", label: "Context compacted", detail: "Preserved the receiver contract and mobile accessibility decisions." },
  { kind: "assistant", id: "answer", ts, text: "### Ready for review\nThe conversation now keeps **answers readable** and machine evidence one tap away.\n\n- Session-scoped reads remain inside the receiver.\n- Tool cards retain their identity when work completes.\n- The terminal is always available as a fallback.\n\n```typescript\nconst view = pane.transcript ? \"chat\" : \"terminal\";\n```\n\n| Surface | Behavior |\n| --- | --- |\n| Chat | Completed messages and live tool status |\n| Terminal | Original pane output and controls |" },
  { kind: "tool", id: "image", ts, name: "render", subject: "Receiver architecture preview", args: { format: "png" }, status: "ok", output: { text: "Browser → bridge → omp; each boundary has one owner.", truncated: false }, images: [{ index: 0, mediaType: "image/png", bytes: 1024 }] },
  { kind: "tool", id: "running", ts, name: "bash", subject: "Inspecting responsive layout", args: { command: "viewport-check --width 390" }, status: "running" },
];

const demoSubmitted = new Map<string, TranscriptRecord[]>();

export function appendDemoTranscript(paneId: string, text: string) {
  const submitted = demoSubmitted.get(paneId) ?? [];
  submitted.push({ kind: "user", id: `submitted-${submitted.length}`, ts: new Date().toISOString(), text });
  demoSubmitted.set(paneId, submitted);
}
export function demoTranscript(paneId: string, limit: number, status: TranscriptResponse["agentStatus"]): TranscriptResponse {
  const all = [...demoRecords, ...(demoSubmitted.get(paneId) ?? [])];
  const records = all.slice(-limit);
  return { paneId, sessionId: "demo", revision: `demo-${all.length}`, total: all.length, records, hasEarlier: records.length < all.length, agentStatus: status, truncatedFile: false };
}
