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
      agent: "codex",
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
      agent: "claude",
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
