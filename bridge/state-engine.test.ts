import { describe, expect, test } from "bun:test";

import { StateEngine, type EngineSnapshot } from "./state-engine.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { AgentStatus } from "./types.ts";

// The state engine polls Herdr, shapes the snapshot, and fires status transitions (which drive push
// notifications). We exercise it with a fake HerdrClient whose returned panes change between polls.

interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent?: string | null;
  agent_status: AgentStatus;
  revision: number;
}

interface FakeWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    checkout_path: string;
    is_linked_worktree: boolean;
  };
}

function pane(id: string, ws: string, status: AgentStatus, agent: string | null): FakePane {
  return {
    pane_id: id,
    terminal_id: "term",
    workspace_id: ws,
    tab_id: `${ws}:t1`,
    focused: false,
    cwd: "/home/you/demo",
    agent,
    agent_status: status,
    revision: 0,
  };
}

const ws = (id: string, number: number): FakeWorkspace => ({
  workspace_id: id,
  number,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle" as AgentStatus,
});

class FakeHerdr {
  panes: FakePane[] = [];
  workspaces = [ws("w1", 1), ws("w2", 2)];
  tabs = [
    {
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: false,
      pane_count: 1,
      agent_status: "idle" as AgentStatus,
    },
  ];
  // The default path (herdr ≥ 0.7.2): one snapshot call carries workspaces + panes + tabs.
  sessionSnapshot() {
    return Promise.resolve({
      version: "0.7.2",
      protocol: 16,
      workspaces: this.workspaces,
      tabs: this.tabs,
      panes: this.panes,
    });
  }
  listWorkspaces() {
    return Promise.resolve(this.workspaces);
  }
  listPanes() {
    return Promise.resolve(this.panes);
  }
  listTabs() {
    return Promise.resolve(this.tabs);
  }
}

function makeEngine() {
  const herdr = new FakeHerdr();
  const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
  const transitions: Array<{ pane: string; from: AgentStatus; to: AgentStatus }> = [];
  engine.onTransition((a, from, to) => transitions.push({ pane: a.paneId, from, to }));
  const removed: string[] = [];
  engine.onRemove((paneId) => removed.push(paneId));
  const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
  return { herdr, engine, transitions, removed, poll };
}

describe("StateEngine — transition detection", () => {
  test("does not fire a transition on the first sighting of a pane", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([]);
  });

  test("fires when an agent's status changes between polls", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll(); // first sighting — suppressed
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
  });

  test("alerts when a blocked pane first appears after initial hydration", async () => {
    const { herdr, transitions, poll } = makeEngine();
    await poll(); // initial empty hydration
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "unknown", to: "blocked" }]);
  });
});

describe("StateEngine — removal events", () => {
  test("fires onRemove when a previously-seen agent pane vanishes", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting — now tracked
    herdr.panes = []; // pane closed
    await poll();
    expect(removed).toEqual(["w1:p1"]);
  });

  test("does not fire onRemove while a pane persists or merely changes status", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")]; // status change, still present
    await poll();
    expect(removed).toEqual([]);
  });

  test("does not fire onRemove for a vanished bare shell pane (never tracked)", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p2", "w1", "unknown", null)]; // shell pane, no agent
    await poll();
    herdr.panes = [];
    await poll();
    expect(removed).toEqual([]);
  });
});

describe("StateEngine — in-flight guard", () => {
  // A Herdr whose snapshot call hangs until released, so we can catch a second tick landing mid-poll.
  class GatedHerdr {
    starts = 0;
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    constructor(private readonly panes: FakePane[]) {}
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.starts++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes };
    }
  }

  test("skips a tick while the previous poll is still in flight", async () => {
    const herdr = new GatedHerdr([pane("w1:p1", "w1", "idle", "claude")]);
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();

    const first = poll(); // starts the poll, hangs on the gate
    await poll(); // second tick — must early-return, not start a second poll
    expect(herdr.starts).toBe(1);

    herdr.release();
    await first;
    expect(herdr.starts).toBe(1);
  });

  test("stop discards an in-flight poll before it publishes state or listeners", async () => {
    const herdr = new GatedHerdr([pane("w1:p1", "w1", "blocked", "claude")]);
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    const updates: EngineSnapshot[] = [];
    const transitions: string[] = [];
    engine.onUpdate((snapshot) => updates.push(snapshot));
    engine.onTransition((agent) => transitions.push(agent.paneId));
    (engine as unknown as { started: boolean }).started = true;
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();

    const inFlight = poll();
    engine.stop();
    herdr.release();
    await inFlight;

    expect(updates).toEqual([]);
    expect(transitions).toEqual([]);
    expect(engine.current()).toMatchObject({ agents: [], bridge: "disconnected" });
  });
});

describe("StateEngine — snapshot shaping", () => {
  test("prefers foreground cwd and normalizes missing pane paths", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      { ...pane("w1:p1", "w1", "idle", "claude"), cwd: "/stale", foreground_cwd: "/active" },
      { ...pane("w1:p2", "w1", "idle", "codex"), cwd: null },
    ];
    await poll();
    expect(engine.current().agents.map((agent) => agent.cwd)).toEqual(["/active", "/"]);
  });

  test("splits agent panes from bare shell panes", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "unknown", null)];
    await poll();
    const snap = engine.current();
    expect(snap.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(snap.shellPanes.map((a) => a.paneId)).toEqual(["w1:p2"]);
    expect(snap.shellPanes[0]!.agent).toBe("shell");
    expect(snap.bridge).toBe("connected");
  });

  test("sorts agents by urgency (blocked first), then workspace number", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w2:p1", "w2", "idle", "claude"),
      pane("w1:p1", "w1", "blocked", "codex"),
      pane("w2:p2", "w2", "working", "claude"),
    ];
    await poll();
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w2:p2", "w2:p1"]);
  });

  test("preserves repository identity so linked worktrees can nest under their parent", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.workspaces = [
      {
        ...ws("w1", 1),
        worktree: {
          repo_key: "/repo/.git",
          repo_name: "repo",
          repo_root: "/repo",
          checkout_path: "/repo",
          is_linked_worktree: false,
        },
      },
      {
        ...ws("w2", 2),
        worktree: {
          repo_key: "/repo/.git",
          repo_name: "repo",
          repo_root: "/repo",
          checkout_path: "/worktrees/feature",
          is_linked_worktree: true,
        },
      },
    ];
    await poll();
    expect(engine.current().workspaces.map((workspace) => workspace.worktree)).toEqual([
      {
        repoKey: "/repo/.git",
        repoName: "repo",
        repoRoot: "/repo",
        checkoutPath: "/repo",
        isLinkedWorktree: false,
      },
      {
        repoKey: "/repo/.git",
        repoName: "repo",
        repoRoot: "/repo",
        checkoutPath: "/worktrees/feature",
        isLinkedWorktree: true,
      },
    ]);
  });

  test("marks the bridge disconnected when a poll throws", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().bridge).toBe("connected");
    herdr.sessionSnapshot = () => Promise.reject(new Error("socket down"));
    await poll();
    expect(engine.current().bridge).toBe("disconnected");
  });
});

describe("StateEngine — snapshot vs legacy path", () => {
  const drivePoll = (engine: StateEngine) =>
    (engine as unknown as { poll(): Promise<void> }).poll();

  const snap = (panes: FakePane[]) => ({
    version: "0.7.2",
    protocol: 16,
    workspaces: [ws("w1", 1)],
    tabs: [],
    panes,
  });

  test("polls via session.snapshot and never touches the list calls when supported", async () => {
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => Promise.resolve(snap([pane("w1:p1", "w1", "idle", "claude")])),
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => ((listCalls++), Promise.resolve([])),
      listTabs: () => ((listCalls++), Promise.resolve([])),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    expect(listCalls).toBe(0);
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(engine.current().bridge).toBe("connected");
  });

  test("an unknown-variant error falls through to list calls in the SAME tick, then never retries snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(
          new Error(
            "herdr session.snapshot: invalid_request: invalid request: unknown variant `session.snapshot`, expected one of `ping`",
          ),
        );
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([ws("w1", 1)])),
      listPanes: () => Promise.resolve([pane("w1:p1", "w1", "idle", "claude")]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    // Same-tick fallback: one snapshot attempt, then the list path, connected with real data.
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(engine.current().bridge).toBe("connected");
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    // Permanent: the next tick goes straight to the list path, no wasted snapshot probe.
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  test("a transient snapshot error does NOT fall back and keeps trying snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(new Error("herdr session.snapshot: timed out after 5000ms"));
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => Promise.resolve([]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(0); // no fallback on a transient error
    expect(engine.current().bridge).toBe("disconnected");
    await drivePoll(engine);
    expect(snapCalls).toBe(2); // still on the snapshot path
    expect(listCalls).toBe(0);
  });
});

describe("StateEngine — poke / cadence / onUpdate", () => {
  test("onUpdate fires with the fresh snapshot after a successful poll, but not after a failed one", async () => {
    const { herdr, engine, poll } = makeEngine();
    const updates: EngineSnapshot[] = [];
    engine.onUpdate((s) => updates.push(s));
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(updates.length).toBe(1);
    expect(updates[0]!.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    herdr.sessionSnapshot = () => Promise.reject(new Error("down"));
    await poll();
    expect(updates.length).toBe(1); // failed poll does not notify
  });

  // A snapshot call gated on a manual release, so a poke can land while a poll is in flight.
  class GatedSnapshot {
    calls = 0;
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.calls++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: [] as FakePane[] };
    }
  }

  test("pokeNow queues exactly one follow-up poll when one is already in flight", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    // Mark started without the interval firing: drive polls by hand.
    (engine as unknown as { started: boolean }).started = true;
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();

    const first = poll(); // calls=1, hangs on the gate
    engine.pokeNow(); // in-flight → queue one follow-up
    engine.pokeNow(); // coalesced into the same single follow-up
    herdr.release();
    await first;
    await Promise.resolve(); // let the drained follow-up poll settle
    await Promise.resolve();
    expect(herdr.calls).toBe(2); // initial + one follow-up, not three
    (engine as unknown as { started: boolean }).started = false;
  });

  test("pokeNow is a no-op once stopped", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    engine.pokeNow(); // never started → no-op
    expect(herdr.calls).toBe(0);
  });

  test("setCadence re-arms the interval only when started and changed", () => {
    const { engine } = makeEngine();
    const cadence = () => (engine as unknown as { cadenceMs: number }).cadenceMs;
    const timer = () => (engine as unknown as { timer: unknown }).timer;

    engine.setCadence(9000); // not started → no-op
    expect(cadence()).toBe(1500);

    engine.start();
    expect(cadence()).toBe(1500);
    const before = timer();
    engine.setCadence(1500); // unchanged → no re-arm
    expect(timer()).toBe(before);
    engine.setCadence(12_000); // changed → re-arm
    expect(cadence()).toBe(12_000);
    expect(timer()).not.toBe(before);
    engine.stop();
  });
});
