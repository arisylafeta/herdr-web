import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Snooze, type SnoozeClock } from "./snooze.ts";
import { loadConfig } from "./config.ts";

// Snooze owns the global do-not-disturb deadline: its expiry/coercion logic is pure (clock injected),
// and we verify the disk round-trip through a throwaway temp state dir.

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-snooze-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("Snooze", () => {
  class FakeClock implements SnoozeClock {
    callback: (() => void) | null = null;
    schedule(callback: () => void): unknown {
      this.callback = callback;
      return callback;
    }
    cancel(handle: unknown): void {
      if (this.callback === handle) this.callback = null;
    }
    fire(): void {
      const callback = this.callback;
      this.callback = null;
      callback?.();
    }
  }

  test("a future deadline mutes; the clock advancing past it un-mutes", async () => {
    let now = 1_000;
    const snooze = new Snooze(await tempCfg(), () => now);
    await snooze.set(1_000 + 60_000);
    expect(snooze.isMuted()).toBe(true);
    expect(snooze.until()).toBe(61_000);
    now = 61_000; // deadline reached
    expect(snooze.isMuted()).toBe(false);
    expect(snooze.until()).toBe(null);
  });

  test("a past deadline or null resumes immediately", async () => {
    const now = 5_000;
    const snooze = new Snooze(await tempCfg(), () => now);
    await snooze.set(4_000); // already in the past
    expect(snooze.isMuted()).toBe(false);
    await snooze.set(10_000);
    expect(snooze.isMuted()).toBe(true);
    await snooze.set(null); // explicit resume
    expect(snooze.isMuted()).toBe(false);
  });

  test("deadline expiry automatically emits one resume event", async () => {
    let now = 1_000;
    const clock = new FakeClock();
    const snooze = new Snooze(await tempCfg(), () => now, clock);
    let resumes = 0;
    snooze.onResume(() => resumes++);

    await snooze.set(2_000);
    now = 2_000;
    clock.fire();

    expect(snooze.isMuted()).toBe(false);
    expect(resumes).toBe(1);
    clock.fire();
    expect(resumes).toBe(1);
  });

  test("explicit resume cancels expiry and emits one resume event", async () => {
    const clock = new FakeClock();
    const snooze = new Snooze(await tempCfg(), () => 1_000, clock);
    let resumes = 0;
    snooze.onResume(() => resumes++);

    await snooze.set(2_000);
    await snooze.set(null);

    expect(clock.callback).toBeNull();
    expect(resumes).toBe(1);
  });

  test("non-finite deadlines never mute or persist as an active snooze", async () => {
    const cfg = await tempCfg();
    const snooze = new Snooze(cfg, () => 1_000);
    await snooze.set(Number.POSITIVE_INFINITY);
    expect(snooze.isMuted()).toBe(false);
    expect(JSON.parse(await readFile(join(cfg.stateDir, "snooze.json"), "utf8"))).toEqual({ mutedUntil: null });
  });

  test("persists across a reload (survives a restart)", async () => {
    const cfg = await tempCfg();
    let now = 2_000;
    const a = new Snooze(cfg, () => now);
    await a.set(2_000 + 30_000);

    const b = new Snooze(cfg, () => now);
    await b.load();
    expect(b.until()).toBe(32_000);

    now = 32_000;
    expect(b.isMuted()).toBe(false); // a persisted deadline still expires on its own
  });

  test("serializes concurrent changes into a valid owner-only final state", async () => {
    const cfg = await tempCfg();
    const snooze = new Snooze(cfg, () => 1_000);

    await Promise.all([snooze.set(10_000), snooze.set(null), snooze.set(20_000)]);

    const saved = JSON.parse(await readFile(join(cfg.stateDir, "snooze.json"), "utf8"));
    expect(saved).toEqual({ mutedUntil: 20_000 });
    expect((await stat(join(cfg.stateDir, "snooze.json"))).mode & 0o777).toBe(0o600);
    const reloaded = new Snooze(cfg, () => 1_000);
    await reloaded.load();
    expect(reloaded.until()).toBe(20_000);
  });

  test("load tolerates a missing file", async () => {
    const snooze = new Snooze(await tempCfg());
    await snooze.load();
    expect(snooze.until()).toBe(null);
  });

  test("load rejects an invalid persisted deadline instead of resuming notifications", async () => {
    const cfg = await tempCfg();
    await writeFile(join(cfg.stateDir, "snooze.json"), JSON.stringify({ mutedUntil: "tomorrow" }));
    const snooze = new Snooze(cfg);
    await expect(snooze.load()).rejects.toBeDefined();
  });

  test("a failed save leaves the live snooze state unchanged", async () => {
    const snooze = new Snooze(
      { ...loadConfig(), stateDir: "/dev/null/herdr-control" },
      () => 1_000,
    );
    await expect(snooze.set(10_000)).rejects.toBeDefined();
    expect(snooze.isMuted()).toBe(false);
  });
});
