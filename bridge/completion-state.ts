import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CompletionLedger } from "./notifications.ts";

interface PersistedCompletionState {
  version: 1;
  completions: Record<string, number>;
}

function entryKey(session: string, paneId: string): string {
  return JSON.stringify([session, paneId]);
}

/** Durable completion timestamps shared by every session coordinator in one bridge process. */
export class CompletionStateStore {
  private readonly completions = new Map<string, number>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const source = Bun.file(this.file);
    if (!(await source.exists())) return;
    const raw = (await source.json()) as Partial<PersistedCompletionState>;
    if (raw.version !== 1 || typeof raw.completions !== "object" || raw.completions === null) {
      throw new Error("invalid completion state");
    }
    this.completions.clear();
    for (const [key, value] of Object.entries(raw.completions)) {
      if (!Number.isFinite(value) || value < 0) throw new Error("invalid completion timestamp");
      this.completions.set(key, value);
    }
  }

  forSession(session: string): CompletionLedger {
    return {
      get: (paneId) => this.completions.get(entryKey(session, paneId)),
      set: (paneId, completedAt) => {
        this.completions.set(entryKey(session, paneId), completedAt);
        this.persist();
      },
      delete: (paneId) => {
        if (!this.completions.delete(entryKey(session, paneId))) return;
        this.persist();
      },
    };
  }

  private persist(): void {
    const state: PersistedCompletionState = {
      version: 1,
      completions: Object.fromEntries(this.completions),
    };
    const temp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best effort only. Notification state remains available in memory for this process.
      }
      console.warn(
        `[notifications] completion state persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
