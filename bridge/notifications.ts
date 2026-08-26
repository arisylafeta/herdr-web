import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle and collapses the herd into a single, always-accurate notification:
//
//   • Debounce + cancel — an agent that blocks and unblocks within the window (you handled it at your
//     desk) never reaches your phone. Herdr exposes no "user present" signal (only a `focused` pane,
//     no activity timestamp), so we infer presence: a quickly-resolved transition is an at-desk one.
//   • Coalesce — instead of N stacked notifications, we keep ONE summary of everything currently
//     outstanding: the named agent when exactly one needs you, or "N agents need you" for several.
//     Each change re-renders that single summary; when the last one resolves, we clear it.
//   • Retract — clearing an agent at the PC (or its pane closing) updates or removes the summary, so
//     handled work never lingers on your lock screen.
//
// Pure and clock-injected so `bun test` drives it without real timers: the bridge passes
// setTimeout/clearTimeout (see server.ts); tests pass a fake clock they fire on demand.

type NotifiableStatus = "blocked" | "done";

/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** The current state of the herd's single notification, derived from everything outstanding. */
export interface HerdSummary {
  /** Headline: "claude needs you" for one, or "3 agents need you" for several. */
  title: string;
  /** Sub-line: "demo · /path" for one outstanding alert, or the agent names for a digest. */
  body: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
}

export interface NotifySink {
  /** Render (or replace) the herd's single notification. */
  render(summary: HerdSummary): void;
  /** Close the herd notification — nothing is outstanding any more. */
  clear(): void;
  /** Queue a clear even when the mute gate is active (used when snooze is first enabled). */
  forceClear(): void;
  /** Resolve once every queued replacement for this notification slot has settled. */
  flush(): Promise<void>;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): unknown;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/**
 * Build the {@link NotifySink} the coordinator drives. One session's whole herd shares one
 * notification slot (`herdTag`), so a render replaces rather than stacks; an active snooze mutes both
 * render and clear (nothing is shown, so there's nothing to close). `sessionName` (the registry name)
 * is stamped into the push payload so the service worker can deep-link to the right session — omit it
 * (undefined) for the primary, keeping its payload byte-identical to the single-session case. Kept
 * here, decoupled from `Push`/`Snooze`, so the gating + summary→message mapping is unit-testable.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  sessionName?: string,
): NotifySink {
  // One sink owns one collapse tag. While a delivery is in flight, only the newest replacement is
  // relevant, so coalescing bounds memory and avoids sending already-obsolete intermediate states.
  let queued: PushMessage | null = null;
  let delivering = false;
  let flushWaiters: Array<() => void> = [];
  const settleFlushWaiters = (): void => {
    if (delivering || queued) return;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const pump = (): void => {
    if (delivering) return;
    const next = queued;
    queued = null;
    if (!next) {
      settleFlushWaiters();
      return;
    }
    delivering = true;
    let delivery: unknown;
    try {
      delivery = push.send(next);
    } catch (error) {
      console.warn(
        `[notifications] push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      delivering = false;
      pump();
      return;
    }
    void Promise.resolve(delivery)
      .catch((error) => {
        console.warn(
          `[notifications] push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        delivering = false;
        pump();
      });
  };
  const enqueue = (message: PushMessage): void => {
    // A new alert edge must survive a later silent summary while delivery is busy. A final clear
    // still wins outright; it closes the slot and must not inherit render-only flags.
    queued =
      message.type !== "clear" &&
      queued?.type !== "clear" &&
      queued?.renotify === true &&
      message.renotify !== true
        ? { ...message, renotify: true, silent: false }
        : message;
    pump();
  };
  return {
    render: (s) => {
      if (mute.isMuted()) return;
      const msg: PushMessage = {
        title: s.title,
        body: s.body,
        tag: herdTag,
        paneId: s.paneId,
        renotify: s.renotify,
        ...(!s.renotify ? { silent: true } : {}),
      };
      if (sessionName !== undefined) msg.session = sessionName;
      enqueue(msg);
    },
    clear: () => {
      if (mute.isMuted()) return;
      enqueue({ type: "clear", tag: herdTag });
    },
    forceClear: () => enqueue({ type: "clear", tag: herdTag }),
    flush: () => {
      if (!delivering && !queued) return Promise.resolve();
      return new Promise<void>((resolve) => flushWaiters.push(resolve));
    },
  };
}

interface Alert {
  agent: string;
  workspaceLabel: string;
  cwd: string;
  status: NotifiableStatus;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → debouncing alert (timer + its kind) that hasn't entered the summary yet. */
  private readonly pending = new Map<string, { handle: H; status: NotifiableStatus }>();
  /** paneId → alert that has fired and is reflected in the current summary (insertion-ordered). */
  private readonly outstanding = new Map<string, Alert>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
    // Whether a transition into a status should notify, read live from the prefs store so a runtime
    // change is honoured. A disabled kind behaves exactly like a non-notifiable status (idle/working).
    private readonly isNotifiable: (status: AgentStatus) => boolean,
    private readonly doneDelayMs: number = delayMs,
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    if (!this.isNotifiable(to)) {
      // Resolved to a non-notifiable (or preference-disabled) state: drop a still-pending alert,
      // retract a delivered one.
      this.resolve(id);
      return;
    }
    if (to === "done" && agent.focused) {
      // A focused pane is already in front of the terminal operator, so its completion has been
      // seen and must not become a delayed phone notification.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    if (this.outstanding.delete(id)) this.emit(false);
    const alert: Alert = {
      agent: agent.agent,
      workspaceLabel: agent.workspaceLabel,
      cwd: agent.cwd,
      status: to as NotifiableStatus,
    };
    const handle = this.clock.schedule(() => {
      this.pending.delete(id);
      this.outstanding.set(id, alert);
      this.emit(true);
    }, alert.status === "done" ? this.doneDelayMs : this.delayMs);
    this.pending.set(id, { handle, status: alert.status });
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
  }

  /** Mark a completed pane as seen, cancelling or retracting only its done notification. */
  onSeen(paneId: string): void {
    if (this.pending.get(paneId)?.status === "done") this.cancelPending(paneId);
    if (this.outstanding.get(paneId)?.status !== "done") return;
    this.outstanding.delete(paneId);
    this.emit(false);
  }

  /**
   * Re-evaluate every pending + outstanding alert against the current prefs after they change,
   * dropping any whose kind is now disabled: cancel a still-debouncing timer, retract a delivered
   * alert. Retractions re-emit the shrunk summary (or a clear) once, silently. Call after the prefs
   * store is updated (see the /api/notifications/prefs route).
   */
  applyPrefs(): void {
    // Drop pending timers for a now-disabled kind — nothing was shown yet, so no re-emit is needed.
    for (const [id, p] of [...this.pending]) {
      if (!this.isNotifiable(p.status)) this.cancelPending(id);
    }
    // Retract delivered alerts of a now-disabled kind; re-emit the shrunk summary once if any went.
    let removed = false;
    for (const [id, a] of [...this.outstanding]) {
      if (!this.isNotifiable(a.status)) {
        this.outstanding.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit(false);
  }

  /** Reconcile a notification slot preserved across process restart with the first fresh snapshot. */
  reconcile(agents: AgentView[]): void {
    // Reconciliation replaces every derived alert with an authoritative snapshot. Cancel timers
    // armed before it (notably transitions observed while snoozed) so they cannot later re-alert
    // with stale state or duplicate the restored summary.
    for (const id of [...this.pending.keys()]) this.cancelPending(id);
    this.outstanding.clear();
    for (const agent of agents) {
      if (!this.isNotifiable(agent.status)) continue;
      this.outstanding.set(agent.paneId, {
        agent: agent.agent,
        workspaceLabel: agent.workspaceLabel,
        cwd: agent.cwd,
        status: agent.status as NotifiableStatus,
      });
    }
    this.emit(false);
  }

  /**
   * Tear down this session's notifications: cancel every pending timer and retract everything
   * outstanding, closing the herd slot. Called when a session is disposed (its socket vanished) so
   * its alerts never linger on the lock screen with no live session behind them.
   */
  async clearAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.cancelPending(id);
    this.outstanding.clear();
    // The lock-screen slot can predate this process (for example after a crash followed by an
    // offline restart), so local coordinator state cannot prove it is empty. Clearing an absent tag
    // is harmless; always retract it to uphold the teardown contract.
    this.sink.forceClear();
    await this.sink.flush();
  }

  /** Wait for already-enqueued delivery without retracting the current notification slot. */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  private resolve(id: string): void {
    this.cancelPending(id);
    if (this.outstanding.delete(id)) this.emit(false);
  }

  /** Re-render the single herd summary from whatever's outstanding (or clear it when empty). */
  private emit(renotify: boolean): void {
    if (this.outstanding.size === 0) {
      this.sink.clear();
      return;
    }
    this.sink.render(this.summarize(renotify));
  }

  private summarize(renotify: boolean): HerdSummary {
    const entries = [...this.outstanding.entries()];
    if (entries.length === 1) {
      const [paneId, a] = entries[0]!;
      const verb = a.status === "blocked" ? "needs you" : "is done";
      // One outstanding agent → deep-link straight to its pane on tap.
      return {
        title: `${a.agent} ${verb}`,
        body: `${a.workspaceLabel} · ${a.cwd}`,
        paneId,
        renotify,
      };
    }
    const alerts = entries.map(([, a]) => a);
    const n = alerts.length;
    const allBlocked = alerts.every((a) => a.status === "blocked");
    const allDone = alerts.every((a) => a.status === "done");
    const title = allBlocked
      ? `${n} agents need you`
      : allDone
        ? `${n} agents done`
        : `${n} agents need attention`;
    return { title, body: alerts.map((a) => a.agent).join(", "), renotify };
  }

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clock.cancel(p.handle);
    this.pending.delete(id);
  }
}

export interface NotificationSnapshot {
  bridge: "connected" | "disconnected";
  agents: AgentView[];
}

/**
 * Reconciles a preserved notification slot on first hydration and after snooze. If snooze ends
 * during a Herdr outage, reconciliation waits for the next connected snapshot rather than clearing
 * from stale/empty state and then missing an unchanged blocked agent on recovery.
 */
export class NotificationReconciler<H = unknown> {
  private initiallyReconciled = false;
  private resumePending = false;

  constructor(private readonly coordinator: NotificationCoordinator<H>) {}

  onUpdate(snapshot: NotificationSnapshot): void {
    if (snapshot.bridge !== "connected") return;
    if (!this.initiallyReconciled || this.resumePending) {
      this.initiallyReconciled = true;
      this.resumePending = false;
      this.coordinator.reconcile(snapshot.agents);
    }
  }

  onResume(snapshot: NotificationSnapshot): void {
    if (snapshot.bridge !== "connected") {
      this.resumePending = true;
      return;
    }
    this.initiallyReconciled = true;
    this.resumePending = false;
    this.coordinator.reconcile(snapshot.agents);
  }
}
