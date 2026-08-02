import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

// A global "do not disturb" for push. While a future deadline is set, the bridge sends no
// notifications (and the act of snoozing retracts the current one) — for when you're heads-down at
// the desk and the phone in your pocket doesn't need to buzz. Persisted to the state dir so a snooze
// survives the `systemctl restart` that backend changes require, and self-expiring. `now` is
// injected so `bun test` can drive expiry without real time.

export interface SnoozeClock {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const realClock: SnoozeClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class Snooze {
  private mutedUntil: number | null = null;
  private readonly file: string;
  private saveChain: Promise<void> = Promise.resolve();
  private timer: unknown | null = null;
  private readonly resumeListeners = new Set<() => void>();

  constructor(
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
    private readonly clock: SnoozeClock = realClock,
  ) {
    this.file = join(cfg.stateDir, "snooze.json");
  }

  async load(): Promise<void> {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return;
    const raw = await file.json() as unknown;
    if (typeof raw !== "object" || raw === null || !("mutedUntil" in raw)) {
      throw new Error("invalid persisted snooze state");
    }
    const mutedUntil = (raw as { mutedUntil: unknown }).mutedUntil;
    if (mutedUntil !== null && (typeof mutedUntil !== "number" || !Number.isFinite(mutedUntil))) {
      throw new Error("invalid persisted snooze deadline");
    }
    this.mutedUntil = mutedUntil;
    if (this.mutedUntil !== null && this.mutedUntil <= this.now()) this.mutedUntil = null;
    this.armTimer();
  }

  /** Fires when an active snooze explicitly resumes or reaches its deadline. */
  onResume(listener: () => void): () => void {
    this.resumeListeners.add(listener);
    return () => this.resumeListeners.delete(listener);
  }

  /** The active snooze deadline (epoch ms), or null if not snoozed / already elapsed. */
  until(): number | null {
    if (this.mutedUntil !== null && this.now() >= this.mutedUntil) this.resume();
    return this.mutedUntil;
  }

  isMuted(): boolean {
    return this.until() !== null;
  }

  /** Snooze until `mutedUntil` (epoch ms); a past timestamp or null resumes immediately. */
  async set(mutedUntil: number | null): Promise<void> {
    const write = async () => {
      const next = mutedUntil !== null && Number.isFinite(mutedUntil) && mutedUntil > this.now()
        ? mutedUntil
        : null;
      await this.writeState(JSON.stringify({ mutedUntil: next }, null, 2));
      const wasSnoozed = this.mutedUntil !== null;
      this.mutedUntil = next;
      this.armTimer();
      if (wasSnoozed && next === null) this.emitResume();
    };
    const run = this.saveChain.then(write, write);
    this.saveChain = run.catch(() => {});
    await run;
  }

  private armTimer(): void {
    if (this.timer !== null) this.clock.cancel(this.timer);
    this.timer = null;
    if (this.mutedUntil === null) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, this.mutedUntil - this.now()),
    );
    this.timer = this.clock.schedule(() => {
      this.timer = null;
      if (this.mutedUntil === null) return;
      if (this.now() >= this.mutedUntil) this.resume();
      else this.armTimer();
    }, delay);
  }

  private resume(): void {
    if (this.mutedUntil === null) return;
    this.mutedUntil = null;
    if (this.timer !== null) this.clock.cancel(this.timer);
    this.timer = null;
    this.emitResume();
  }

  private emitResume(): void {
    for (const listener of this.resumeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(
          `[snooze] resume listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async writeState(data: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
