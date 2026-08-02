import { describe, expect, it } from "bun:test";

import {
  compareSemver,
  githubReleaseUrl,
  latestReleaseTag,
  parseSemverTag,
  publishedReleaseTags,
  shouldNotify,
  stampOf,
  UpdateMonitor,
  UpdateStateStore,
  type UpdateMonitorDeps,
  type UpdateStore,
} from "./update.ts";
import type { Config } from "./config.ts";

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.11.0", "0.12.0")).toBe(-1);
    expect(compareSemver("0.12.0", "0.11.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.11.0", "0.11.0")).toBe(0);
    expect(compareSemver("0.11.2", "0.11.10")).toBe(-1); // numeric, not lexical
  });
});

describe("parseSemverTag / latestReleaseTag", () => {
  it("accepts strict vX.Y.Z, rejects prereleases and junk", () => {
    expect(parseSemverTag("v0.11.0")).toEqual([0, 11, 0]);
    expect(parseSemverTag(" v1.2.3 ")).toEqual([1, 2, 3]);
    expect(parseSemverTag("v1.0.0-rc.1")).toBeNull();
    expect(parseSemverTag("0.11.0")).toBeNull(); // no leading v
    expect(parseSemverTag("latest")).toBeNull();
  });

  it("picks the max release and strips the leading v", () => {
    expect(latestReleaseTag(["v0.10.3", "v0.11.0", "v0.9.0"])).toBe("0.11.0");
    // Non-release refs and prereleases are ignored, not chosen.
    expect(latestReleaseTag(["v0.11.0", "v0.12.0-beta.1", "nightly"])).toBe("0.11.0");
    expect(latestReleaseTag([])).toBeNull();
    expect(latestReleaseTag(["main", "v1.0.0-rc"])).toBeNull();
  });
});

describe("publishedReleaseTags", () => {
  it("accepts only published stable GitHub releases", () => {
    expect(publishedReleaseTags([
      { tag_name: "v1.2.0", draft: false, prerelease: false },
      { tag_name: "v1.3.0-rc.1", draft: false, prerelease: true },
      { tag_name: "v2.0.0", draft: true, prerelease: false },
      { tag_name: 42, draft: false, prerelease: false },
    ])).toEqual(["v1.2.0"]);
    expect(publishedReleaseTags({ tag_name: "v9.0.0" })).toEqual([]);
  });
});

describe("shouldNotify", () => {
  const current = "0.11.0";
  it("fires only for a strictly-newer, not-yet-notified release", () => {
    expect(shouldNotify({ current, latest: "0.12.0", lastNotified: null })).toBe(true);
    // Already notified for this exact version → no re-nag.
    expect(shouldNotify({ current, latest: "0.12.0", lastNotified: "0.12.0" })).toBe(false);
    // A newer one than we last notified → fire again.
    expect(shouldNotify({ current, latest: "0.13.0", lastNotified: "0.12.0" })).toBe(true);
    expect(shouldNotify({ current, latest: "0.11.5", lastNotified: "0.12.0" })).toBe(false);
    // Not newer than what we're running → never.
    expect(shouldNotify({ current, latest: "0.11.0", lastNotified: null })).toBe(false);
    expect(shouldNotify({ current, latest: "0.10.0", lastNotified: null })).toBe(false);
    expect(shouldNotify({ current, latest: null, lastNotified: null })).toBe(false);
  });
});

describe("stampOf", () => {
  it("is order-independent and changes on any mtime/size change", () => {
    const a = [
      { path: "b.ts", mtimeMs: 2, size: 20 },
      { path: "a.ts", mtimeMs: 1, size: 10 },
    ];
    const b = [
      { path: "a.ts", mtimeMs: 1, size: 10 },
      { path: "b.ts", mtimeMs: 2, size: 20 },
    ];
    expect(stampOf(a)).toBe(stampOf(b)); // same set, different order → same stamp
    expect(stampOf(a)).not.toBe(stampOf([{ path: "a.ts", mtimeMs: 9, size: 10 }, { path: "b.ts", mtimeMs: 2, size: 20 }]));
    expect(stampOf(a)).not.toBe(stampOf([{ path: "a.ts", mtimeMs: 1, size: 99 }, { path: "b.ts", mtimeMs: 2, size: 20 }]));
  });
});

// A fake store + a scripted clock for the monitor.
function fakeStore(initial: string | null = null): UpdateStore {
  let last = initial;
  return {
    lastNotified: () => last,
    setLastNotified: async (v) => {
      last = v;
    },
  };
}

function makeMonitor(over: Partial<UpdateMonitorDeps> = {}) {
  const notified: string[] = [];
  let cleared = 0;
  const store = fakeStore();
  let clock = 1_000_000;
  const monitor = new UpdateMonitor({
    enabled: true,
    repo: "AltanS/collie",
    current: "0.11.0",
    startupStamp: "STAMP@boot",
    fetchReleaseTags: async () => ["v0.12.0"],
    bridgeStamp: () => "STAMP@boot",
    store,
    now: () => clock,
    updatesEnabled: () => true,
    notify: (v) => notified.push(v),
    clear: () => { cleared++; },
    ...over,
  });
  return { monitor, notified, store, cleared: () => cleared, tick: (ms: number) => (clock += ms) };
}

describe("UpdateMonitor", () => {
  it("reports an unconfigured checker without claiming a completed check", async () => {
    const { monitor } = makeMonitor({ enabled: false });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      enabled: false,
      lastCheckSucceeded: null,
      latest: null,
      checkedAt: null,
    });
  });
  it("surfaces releaseAvailable + latest + latestUrl after a successful check", async () => {
    // Use a REAL Collie release (v0.10.3) with `current` below it, so the asserted release URL exists.
    const { monitor } = makeMonitor({
      current: "0.9.0",
      fetchReleaseTags: async () => ["v0.2.0", "v0.10.0", "v0.10.3"],
    });
    expect(monitor.status()).toMatchObject({ current: "0.9.0", latest: null, latestUrl: null, releaseAvailable: false, checkedAt: null });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "0.10.3",
      latestUrl: "https://github.com/AltanS/collie/releases/tag/v0.10.3",
      releaseAvailable: true,
    });
    expect(monitor.status().checkedAt).not.toBeNull();
  });

  it("githubReleaseUrl reconstructs the vX.Y.Z tag page", () => {
    expect(githubReleaseUrl("AltanS/collie", "0.10.3")).toBe(
      "https://github.com/AltanS/collie/releases/tag/v0.10.3",
    );
  });

  it("fires the push exactly once per new version, persisting BEFORE notifying", async () => {
    const order: string[] = [];
    const store = fakeStore();
    const wrapped: UpdateStore = {
      lastNotified: store.lastNotified,
      setLastNotified: async (v) => {
        order.push(`persist:${v}`);
        await store.setLastNotified(v);
      },
    };
    const { monitor, notified } = makeMonitor({ store: wrapped, notify: (v) => order.push(`notify:${v}`) });
    await monitor.checkRelease();
    await monitor.checkRelease(); // same latest → no re-nag
    expect(order).toEqual(["persist:0.12.0", "notify:0.12.0"]); // persisted first, fired once
    expect(notified).toEqual([]); // notify routed into `order` above
  });

  it("does not push when the updates pref is off, but still surfaces releaseAvailable", async () => {
    const { monitor, notified } = makeMonitor({ updatesEnabled: () => false });
    await monitor.checkRelease();
    expect(notified).toEqual([]);
    expect(monitor.status().releaseAvailable).toBe(true); // the banner still shows; only the push is gated
  });

  it("is fail-soft: a fetch error keeps prior state and sends nothing", async () => {
    const { monitor, notified } = makeMonitor({
      fetchReleaseTags: async () => {
        throw new Error("network down");
      },
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      lastCheckSucceeded: false,
      latest: null,
      releaseAvailable: false,
      checkedAt: null,
    });
    expect(notified).toEqual([]);
  });

  it("is fail-soft when the notification marker cannot be persisted", async () => {
    const store: UpdateStore = {
      lastNotified: () => null,
      setLastNotified: async () => {
        throw new Error("disk full");
      },
    };
    const { monitor, notified } = makeMonitor({ store });

    await expect(monitor.checkRelease()).resolves.toBeUndefined();
    expect(monitor.status().releaseAvailable).toBe(true);
    expect(notified).toEqual([]);
  });

  it("does not notify when latest is not newer than current", async () => {
    const { monitor, notified, cleared } = makeMonitor({ fetchReleaseTags: async () => ["v0.11.0", "v0.10.0"] });
    await monitor.checkRelease();
    expect(monitor.status().releaseAvailable).toBe(false);
    expect(notified).toEqual([]);
    expect(cleared()).toBe(1);
  });

  it("clears the update slot when update notifications are disabled", async () => {
    const { monitor, cleared } = makeMonitor({ updatesEnabled: () => false });
    await monitor.checkRelease();
    expect(cleared()).toBe(1);
    monitor.clearNotification();
    expect(cleared()).toBe(2);
  });

  it("does not re-show an update when preferences disable alerts during marker persistence", async () => {
    let enabled = true;
    let releaseWrite!: () => void;
    let marker: string | null = null;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const store: UpdateStore = {
      lastNotified: () => marker,
      setLastNotified: async (version) => {
        await gate;
        marker = version;
      },
    };
    const { monitor, notified, cleared } = makeMonitor({
      store,
      updatesEnabled: () => enabled,
    });

    const checking = monitor.checkRelease();
    await Promise.resolve();
    enabled = false;
    monitor.clearNotification();
    releaseWrite();
    await checking;

    expect(notified).toEqual([]);
    expect(cleared()).toBeGreaterThan(0);
    expect(marker).toBeNull();
  });

  it("clears an already-notified slot immediately after the running version catches up", () => {
    const store = fakeStore("0.12.0");
    const { monitor, cleared } = makeMonitor({ current: "0.12.0", store });
    monitor.reconcileStartupNotification();
    expect(cleared()).toBe(1);
  });

  it("shutdown resets the marker before retracting so a restart may notify again", async () => {
    let marker: string | null = "0.12.0";
    let clears = 0;
    const store: UpdateStore = {
      lastNotified: () => marker,
      setLastNotified: async (version) => { marker = version; },
    };
    const { monitor } = makeMonitor({ store, clear: () => { clears++; } });

    await monitor.prepareShutdown();

    expect(marker).toBeNull();
    expect(clears).toBe(1);
  });

  it("shutdown still retracts the update slot when resetting the marker fails", async () => {
    let clears = 0;
    const store: UpdateStore = {
      lastNotified: () => "0.12.0",
      setLastNotified: async () => { throw new Error("read-only filesystem"); },
    };
    const { monitor } = makeMonitor({ store, clear: () => { clears++; } });

    await monitor.prepareShutdown();

    expect(clears).toBe(1);
  });

  it("de-dupes concurrent checks — one fetch backs both callers, then the guard clears", async () => {
    let calls = 0;
    let release!: (tags: string[]) => void;
    const gate = new Promise<string[]>((r) => {
      release = r;
    });
    const { monitor } = makeMonitor({
      fetchReleaseTags: () => {
        calls++;
        return gate;
      },
    });
    const a = monitor.checkRelease();
    const b = monitor.checkRelease(); // lands while the first is still in flight → same promise
    release(["v0.12.0"]);
    await Promise.all([a, b]);
    expect(calls).toBe(1); // NOT two hits on the API
    expect(monitor.status().latest).toBe("0.12.0");

    await monitor.checkRelease(); // guard cleared → a later check fetches afresh
    expect(calls).toBe(2);
  });

  it("reports bridgeStale when the on-disk stamp diverges from the boot stamp (throttled)", async () => {
    let disk = "STAMP@boot";
    const { monitor, tick } = makeMonitor({ bridgeStamp: () => disk });
    expect(monitor.status().bridgeStale).toBe(false);
    disk = "STAMP@rebuilt";
    // Within the throttle window the cached value stands...
    expect(monitor.status().bridgeStale).toBe(false);
    tick(6_000); // ...past it, the recompute sees the divergence.
    expect(monitor.status().bridgeStale).toBe(true);
  });
});

describe("UpdateStateStore", () => {
  it("does not poison the in-memory marker when persistence fails", async () => {
    const store = new UpdateStateStore({ stateDir: "/dev/null/herdr-control" } as Config);

    await expect(store.setLastNotified("0.12.0")).rejects.toBeDefined();
    expect(store.lastNotified()).toBeNull();
  });
});
