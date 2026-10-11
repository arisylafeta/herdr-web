import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { AgentStatus } from "./types.ts";

// Which agent lifecycle events are worth a push. A companion to Snooze (the do-not-disturb deadline):
// where Snooze mutes everything for a while, this decides which *kinds* of alert ever fire. By default
// both blocked and done pushes are on. Done alerts have their own long delay and are cancelled when
// the pane is seen, so enabling them does not buzz for every actively-managed task. Bridge-wide
// (not per-device), like Snooze, because a push fans out to
// every subscribed device. Persisted to the state dir so a preference survives the `systemctl restart`
// that backend changes require. Missing file / missing keys fall back to defaults.

/** Notification type preferences: which notifiable statuses actually push. */
export interface NotifyPrefs {
  /** Push when an agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes its task and remains unseen past the completion delay. Default on. */
  done: boolean;
  /** Push when a newer Collie release is available. Default on — the off-switch for update alerts,
   *  which otherwise bypass snooze (an update isn't quiet-hours material). Not an agent status, so it
   *  never flows through {@link isNotifiable}; the update monitor reads it directly. */
  updates: boolean;
}

export interface NotifyPrefsChange {
  previous: NotifyPrefs;
  updated: NotifyPrefs;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { blocked: true, done: true, updates: true };

/**
 * Coerce an untrusted parsed value into a {@link NotifyPrefs}, filling any missing or non-boolean key
 * from the defaults. Pure + exported so the file-shape handling is unit-testable.
 */
export function coerceNotifyPrefs(raw: unknown): NotifyPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    blocked: typeof o.blocked === "boolean" ? o.blocked : DEFAULT_NOTIFY_PREFS.blocked,
    done: typeof o.done === "boolean" ? o.done : DEFAULT_NOTIFY_PREFS.done,
    updates: typeof o.updates === "boolean" ? o.updates : DEFAULT_NOTIFY_PREFS.updates,
  };
}

export class NotifyPrefsStore {
  private prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS };
  private readonly file: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: Config) {
    this.file = join(cfg.stateDir, "notify-prefs.json");
  }

  async load(): Promise<void> {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return;
    this.prefs = coerceNotifyPrefs(await file.json());
  }

  /** A copy of the current prefs (never the internal object, so callers can't mutate our state). */
  current(): NotifyPrefs {
    return { ...this.prefs };
  }

  /**
   * Whether a transition into `status` should notify, per the current prefs. Any status that isn't a
   * notifiable kind (idle/working/unknown) is always false — mirrors the coordinator's old static set.
   */
  isNotifiable(status: AgentStatus): boolean {
    if (status === "blocked") return this.prefs.blocked;
    if (status === "done") return this.prefs.done;
    return false;
  }

  /** Merge a partial patch (only booleans are applied), persist, and return the updated prefs. */
  set(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
    return this.setWithPrevious(patch).then(({ updated }) => updated);
  }

  /** Persist a patch and atomically report the state transition from inside the write queue. */
  setWithPrevious(patch: Partial<NotifyPrefs>): Promise<NotifyPrefsChange> {
    const write = async (): Promise<NotifyPrefsChange> => {
      const previous = this.current();
      const next = { ...this.prefs };
      if (typeof patch.blocked === "boolean") next.blocked = patch.blocked;
      if (typeof patch.done === "boolean") next.done = patch.done;
      if (typeof patch.updates === "boolean") next.updates = patch.updates;
      await this.writeState(JSON.stringify(next, null, 2));
      this.prefs = next;
      return { previous, updated: this.current() };
    };
    const run = this.saveChain.then(write, write);
    this.saveChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async writeState(data: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
