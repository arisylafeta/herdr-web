import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collapseTopic, isTrustedPushSubscription, Push, PushDeliveryQueue } from "./push.ts";
import type {
  PushSender,
  PushSubscription,
  PushSubscriptionOwner,
  SendOptions,
  StoredPushSubscription,
} from "./push.ts";
import { loadConfig } from "./config.ts";

// The broadcast prune-vs-log logic and the on-disk persistence are the untested-by-Bun.serve parts.
// We inject a fake sender so the 404/410-prune path is exercised without the real web-push library,
// and round-trip the subscriptions file through a throwaway temp state dir.

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-push-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function endpoint(id: string): string {
  return `https://fcm.googleapis.com/fcm/send/${id}`;
}

function sub(id: string): PushSubscription {
  return { endpoint: endpoint(id), keys: { p256dh: "p", auth: "a" } };
}

const unrestrictedOwner: PushSubscriptionOwner = { kind: "unrestricted" };

function stored(
  subscription: PushSubscription,
  owner: PushSubscriptionOwner = unrestrictedOwner,
): StoredPushSubscription {
  return { subscription, owner };
}

/** Enable push and seed subscriptions without the real VAPID/web-push init handshake. */
function enable(
  push: Push,
  seed: StoredPushSubscription[],
): Map<string, StoredPushSubscription> {
  const internals = push as unknown as {
    _enabled: boolean;
    subs: Map<string, StoredPushSubscription>;
  };
  internals._enabled = true;
  for (const entry of seed) internals.subs.set(entry.subscription.endpoint, entry);
  return internals.subs;
}

async function fileEndpoints(dir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8"));
  return (raw as StoredPushSubscription[]).map((entry) => entry.subscription.endpoint);
}

const gone = (endpoint: string) => Object.assign(new Error(`${endpoint} gone`), { statusCode: 410 });

describe("Push — broadcast delivery & pruning", () => {
  test("a 410 response prunes the subscription and persists the pruned set", async () => {
    const cfg = await tempCfg();
    const sender: PushSender = (s) =>
      s.endpoint === endpoint("dead") ? Promise.reject(gone("dead")) : Promise.resolve();
    const push = new Push(cfg, sender);
    const subs = enable(push, [stored(sub("live")), stored(sub("dead"))]);

    await push.notify("hi", "there");

    expect([...subs.keys()]).toEqual([endpoint("live")]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual([endpoint("live")]);
  });

  test("a non-410 error logs and keeps the subscription", async () => {
    const cfg = await tempCfg();
    const sender: PushSender = () =>
      Promise.reject(Object.assign(new Error(`boom at ${endpoint("live")}`), { statusCode: 500 }));
    const push = new Push(cfg, sender);
    const subs = enable(push, [stored(sub("live"))]);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;
    try {
      await push.notify("hi", "there");
    } finally {
      console.warn = origWarn;
    }

    expect([...subs.keys()]).toEqual([endpoint("live")]); // kept
    expect(warnings).toEqual(["[push] send failed via https://fcm.googleapis.com (HTTP 500)"]);
    expect(warnings[0]).not.toContain(endpoint("live"));
    // No prune ⇒ no write ⇒ no file created.
    await expect(readFile(join(cfg.stateDir, "push-subscriptions.json"), "utf8")).rejects.toThrow();
  });

  test("reports delivery failure when no endpoint accepts a diagnostic message", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.reject(new Error("network down")));
    enable(push, [stored(sub("a")), stored(sub("b"))]);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(push.notify("hi", "there")).resolves.toEqual({
        attempted: 2,
        succeeded: 0,
        failed: 2,
        pruned: 0,
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("successful sends touch neither the in-memory set nor disk", async () => {
    const cfg = await tempCfg();
    let calls = 0;
    const sender: PushSender = () => {
      calls++;
      return Promise.resolve();
    };
    const push = new Push(cfg, sender);
    const subs = enable(push, [stored(sub("a")), stored(sub("b"))]);

    await push.notify("hi", "there");

    expect(calls).toBe(2);
    expect([...subs.keys()]).toEqual([endpoint("a"), endpoint("b")]);
    await expect(readFile(join(cfg.stateDir, "push-subscriptions.json"), "utf8")).rejects.toThrow();
  });
});

describe("Push — persistence", () => {
  test("addSubscription persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);

    await push.addSubscription(sub("one"), { kind: "device", device: "phone" });

    expect(await fileEndpoints(cfg.stateDir)).toEqual([endpoint("one")]);
    expect(JSON.parse(await readFile(join(cfg.stateDir, "push-subscriptions.json"), "utf8"))).toEqual([
      stored(sub("one"), { kind: "device", device: "phone" }),
    ]);
    const mode = (await stat(join(cfg.stateDir, "push-subscriptions.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("concurrent saves serialise to a consistent final file", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);

    await Promise.all([
      push.addSubscription(sub("a"), unrestrictedOwner),
      push.addSubscription(sub("b"), unrestrictedOwner),
      push.addSubscription(sub("c"), unrestrictedOwner),
    ]);

    expect((await fileEndpoints(cfg.stateDir)).sort()).toEqual(
      [endpoint("a"), endpoint("b"), endpoint("c")].sort(),
    );
  });

  test("rejects untrusted endpoints and caps the stored fanout", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    const subs = enable(
      push,
      Array.from({ length: 64 }, (_, index) => stored(sub(`seed-${index}`))),
    );

    expect(await push.addSubscription(sub("overflow"), unrestrictedOwner)).toBe("full");
    expect(subs.size).toBe(64);
    expect(await push.addSubscription(
      { ...sub("bad"), endpoint: "https://127.0.0.1/push" },
      unrestrictedOwner,
    )).toBe("invalid");
  });

  test("revoked device subscriptions are pruned before delivery", async () => {
    const cfg = {
      ...(await tempCfg()),
      deviceHeader: "x-device-id",
      deviceAllowlist: ["phone", "tablet"],
    };
    const delivered: string[] = [];
    const push = new Push(cfg, (subscription) => {
      delivered.push(subscription.endpoint);
      return Promise.resolve();
    });
    enable(push, []);
    await push.addSubscription(sub("phone"), { kind: "device", device: "phone" });
    await push.addSubscription(sub("tablet"), { kind: "device", device: "tablet" });

    cfg.deviceAllowlist = ["phone"];
    await push.notify("hi", "there");

    expect(delivered).toEqual([endpoint("phone")]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual([endpoint("phone")]);
  });

  test("explicit local-owner subscriptions remain active when device auth is enforced", async () => {
    const cfg = {
      ...(await tempCfg()),
      deviceHeader: "x-device-id",
      deviceAllowlist: [],
    };
    const delivered: string[] = [];
    const push = new Push(cfg, (subscription) => {
      delivered.push(subscription.endpoint);
      return Promise.resolve();
    });
    enable(push, []);
    await push.addSubscription(sub("local"), { kind: "local" });

    await push.notify("hi", "there");

    expect(delivered).toEqual([endpoint("local")]);
  });

  test("legacy unattributed entries migrate when auth is off and fail closed when it is on", async () => {
    const offCfg = await tempCfg();
    await writeFile(join(offCfg.stateDir, "push-subscriptions.json"), JSON.stringify([sub("legacy-off")]));
    const off = new Push(offCfg, () => Promise.resolve());
    const offInternals = off as unknown as {
      load(): Promise<void>;
      subs: Map<string, StoredPushSubscription>;
    };
    await offInternals.load();
    expect(offInternals.subs.get(endpoint("legacy-off"))?.owner).toEqual(unrestrictedOwner);
    expect(await fileEndpoints(offCfg.stateDir)).toEqual([endpoint("legacy-off")]);

    const onCfg = {
      ...(await tempCfg()),
      deviceHeader: "x-device-id",
      deviceAllowlist: ["phone"],
    };
    await writeFile(join(onCfg.stateDir, "push-subscriptions.json"), JSON.stringify([sub("legacy-on")]));
    const on = new Push(onCfg, () => Promise.resolve());
    const onInternals = on as unknown as {
      load(): Promise<void>;
      subs: Map<string, StoredPushSubscription>;
    };
    await onInternals.load();
    expect(onInternals.subs.size).toBe(0);
    expect(await fileEndpoints(onCfg.stateDir)).toEqual([]);
  });

  test("a failed persistence write does not activate the subscription in memory", async () => {
    let deliveries = 0;
    const push = new Push(
      { ...loadConfig(), stateDir: "/dev/null/herdr-control" },
      () => {
        deliveries++;
        return Promise.resolve();
      },
    );
    const subs = enable(push, []);

    await expect(push.addSubscription(sub("not-stored"), unrestrictedOwner)).rejects.toBeDefined();
    await push.notify("hi", "there");

    expect(subs.size).toBe(0);
    expect(deliveries).toBe(0);
  });

  test("subscription deletion is limited to its persisted device owner or the local operator", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);
    await push.addSubscription(sub("phone"), { kind: "device", device: "phone" });
    await push.addSubscription(sub("tablet"), { kind: "device", device: "tablet" });

    expect(await push.removeSubscription(
      endpoint("phone"),
      { kind: "device", device: "tablet" },
    )).toBe("forbidden");
    expect((await fileEndpoints(cfg.stateDir)).sort()).toEqual(
      [endpoint("phone"), endpoint("tablet")].sort(),
    );
    expect(await push.removeSubscription(
      endpoint("phone"),
      { kind: "device", device: "phone" },
    )).toBe("removed");
    expect(await push.removeSubscription(endpoint("tablet"), { kind: "local" })).toBe("removed");
    expect(await fileEndpoints(cfg.stateDir)).toEqual([]);
  });
});

describe("Push — optional VAPID initialization", () => {
  test("first run generates and persists owner-only VAPID keys", async () => {
    const cfg = await tempCfg();
    let configured: [string, string, string] | undefined;
    const push = new Push(cfg, undefined, async () => ({
      generateVAPIDKeys: () => ({ publicKey: "generated-public", privateKey: "generated-private" }),
      setVapidDetails: (subject, publicKey, privateKey) => {
        configured = [subject, publicKey, privateKey];
      },
      sendNotification: () => Promise.resolve(),
    }));

    await push.init();

    expect(push.enabled).toBe(true);
    expect(push.publicKey).toBe("generated-public");
    expect(configured).toEqual([
      "mailto:admin@example.com",
      "generated-public",
      "generated-private",
    ]);
    expect(JSON.parse(await readFile(join(cfg.stateDir, "push-vapid.json"), "utf8"))).toEqual({
      publicKey: "generated-public",
      privateKey: "generated-private",
    });
    expect((await stat(join(cfg.stateDir, "push-vapid.json"))).mode & 0o777).toBe(0o600);
  });

  test("restart reuses automatically provisioned VAPID keys", async () => {
    const cfg = await tempCfg();
    await writeFile(
      join(cfg.stateDir, "push-vapid.json"),
      JSON.stringify({ publicKey: "saved-public", privateKey: "saved-private" }),
      { mode: 0o600 },
    );
    let generated = false;
    let configured: [string, string, string] | undefined;
    const push = new Push(cfg, undefined, async () => ({
      generateVAPIDKeys: () => {
        generated = true;
        return { publicKey: "new-public", privateKey: "new-private" };
      },
      setVapidDetails: (subject, publicKey, privateKey) => {
        configured = [subject, publicKey, privateKey];
      },
      sendNotification: () => Promise.resolve(),
    }));

    await push.init();

    expect(generated).toBe(false);
    expect(push.publicKey).toBe("saved-public");
    expect(configured).toEqual(["mailto:admin@example.com", "saved-public", "saved-private"]);
  });

  test("malformed optional VAPID configuration disables push without aborting startup", async () => {
    const cfg = {
      ...(await tempCfg()),
      vapidPublic: "bad-public-key",
      vapidPrivate: "bad-private-key",
      vapidSubject: "not-a-vapid-subject",
    };
    const push = new Push(cfg, undefined, async () => ({
      generateVAPIDKeys: () => ({ publicKey: "generated-public", privateKey: "generated-private" }),
      setVapidDetails: () => {
        throw new Error("invalid VAPID subject");
      },
      sendNotification: () => Promise.resolve(),
    }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => warnings.push(args.map(String).join(" "))) as typeof console.warn;
    try {
      await expect(push.init()).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }

    expect(push.enabled).toBe(false);
    expect(warnings.some((warning) => warning.includes("invalid VAPID subject"))).toBe(true);
  });

  test("loads durable subscriptions while disabled so opt-out still removes them", async () => {
    const cfg = await tempCfg();
    await writeFile(
      join(cfg.stateDir, "push-subscriptions.json"),
      JSON.stringify([stored(sub("opt-out"))]),
    );
    const push = new Push(
      cfg,
      () => Promise.resolve(),
      async () => { throw new Error("web-push unavailable"); },
    );

    await push.init();
    expect(push.enabled).toBe(false);
    expect(push.subscriptionCount).toBe(1);
    await push.removeSubscription(endpoint("opt-out"), { kind: "unrestricted" });

    expect(await fileEndpoints(cfg.stateDir)).toEqual([]);
  });
});

describe("trusted push subscription validation", () => {
  test("accepts the mainstream Web Push service origins", () => {
    expect(isTrustedPushSubscription(sub("fcm"))).toBe(true);
    expect(isTrustedPushSubscription({ ...sub("mozilla"), endpoint: "https://updates.push.services.mozilla.com/wpush/v2/id" })).toBe(true);
    expect(isTrustedPushSubscription({ ...sub("apple"), endpoint: "https://web.push.apple.com/QH123" })).toBe(true);
    expect(isTrustedPushSubscription({ ...sub("edge"), endpoint: "https://wns2-bl2p.notify.windows.com/w/?token=abc" })).toBe(true);
  });

  test("rejects arbitrary, local, credentialed, or malformed endpoints", () => {
    expect(isTrustedPushSubscription({ ...sub("x"), endpoint: "https://example.com/push" })).toBe(false);
    expect(isTrustedPushSubscription({ ...sub("x"), endpoint: "https://127.0.0.1/push" })).toBe(false);
    expect(isTrustedPushSubscription({ ...sub("x"), endpoint: "http://fcm.googleapis.com/push" })).toBe(false);
    expect(isTrustedPushSubscription({ ...sub("x"), endpoint: "https://user@fcm.googleapis.com/push" })).toBe(false);
    expect(isTrustedPushSubscription({ ...sub("x"), endpoint: "https://wns2-bl2p.notify.windows.com.evil.test/w" })).toBe(false);
    expect(isTrustedPushSubscription(null)).toBe(false);
  });
});

describe("Push — per-message collapse topic (update must not share the herd slot)", () => {
  // The `topic` is the push service's collapse key: sharing it would let an offline device's queued
  // herd summary and an update push silently overwrite each other. Capture the options + payload the
  // sender receives to pin the seam the update feature must never regress.
  function capturing() {
    const sends: { payload: string; options: SendOptions }[] = [];
    const sender: PushSender = (_s, payload, options) => {
      sends.push({ payload, options });
      return Promise.resolve();
    };
    return { sender, sends };
  }

  test("an update push rides its OWN topic + longer TTL, and carries the settings target", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [stored(sub("a"))]);

    await push.send({ type: "update", tag: "herdr-control:update", title: "t", body: "b", target: "settings" });

    expect(sends[0]!.options).toEqual({
      topic: collapseTopic("herdr-control:update"),
      TTL: 259_200,
      timeout: 10_000,
    });
    expect(JSON.parse(sends[0]!.payload).data.target).toBe("settings");
  });

  test("an agent send keeps the herd topic/TTL and carries NO target (byte-identical path)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [stored(sub("a"))]);

    await push.send({ title: "claude needs you", body: "…", tag: "herdr-control:herd", paneId: "w1:p1" });

    expect(sends[0]!.options).toEqual({
      topic: collapseTopic("herdr-control:herd"),
      TTL: 21_600,
      timeout: 10_000,
    });
    expect("target" in JSON.parse(sends[0]!.payload).data).toBe(false);
  });

  test("a clear stays on the herd topic (it closes the herd slot)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [stored(sub("a"))]);

    await push.send({ type: "clear", tag: "herdr-control:herd" });
    expect(sends[0]!.options.topic).toBe(collapseTopic("herdr-control:herd"));
  });

  test("an update clear shares the update render topic and long TTL", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [stored(sub("a"))]);

    await push.send({ type: "clear", tag: "herdr-control:update" });

    expect(sends[0]!.options).toEqual({
      topic: collapseTopic("herdr-control:update"),
      TTL: 259_200,
      timeout: 10_000,
    });
  });

  test("different sessions keep independent bounded push-service topics", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [stored(sub("a"))]);

    await push.send({ title: "a", tag: "herdr-control:herd:buildbox" });
    await push.send({ title: "b", tag: "herdr-control:herd:another-very-long-session-name" });

    expect(sends[0]!.options.topic).not.toBe(sends[1]!.options.topic);
    expect(sends[0]!.options.topic.length).toBeLessThanOrEqual(32);
    expect(sends[1]!.options.topic.length).toBeLessThanOrEqual(32);
    expect(sends[0]!.options.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("collapseTopic", () => {
  test("uses a 32-character base64url digest accepted by Apple Web Push", () => {
    expect(collapseTopic("herdr-control:herd")).toBe("DpvUQ8ICYBeietZtCx4Hhm7OR7ejJA1E");
    expect(collapseTopic("already-safe")).toHaveLength(32);
  });

  test("is stable, valid, and collision-resistant for long session tags", () => {
    const first = collapseTopic("herdr-control:herd:a-very-long-session-name-alpha");
    const second = collapseTopic("herdr-control:herd:a-very-long-session-name-beta");
    expect(first).toBe(collapseTopic("herdr-control:herd:a-very-long-session-name-alpha"));
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("hashes short tags whenever sanitization could otherwise collide", () => {
    const dotted = collapseTopic("herdr:foo.bar");
    const dashed = collapseTopic("herdr:foo-bar");
    expect(dotted).not.toBe(dashed);
    expect(dotted.length).toBeLessThanOrEqual(32);
    expect(dashed.length).toBeLessThanOrEqual(32);
  });
});

describe("PushDeliveryQueue", () => {
  test("serializes a render before its clear and flushes both", async () => {
    const delivered: string[] = [];
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const queue = new PushDeliveryQueue({
      async send(message) {
        delivered.push(message.type ?? "render");
        if (message.type !== "clear") await renderGate;
      },
    });

    queue.enqueue({ type: "update", title: "Update" });
    queue.enqueue({ type: "clear", tag: "herdr-control:update" });
    await Promise.resolve();
    expect(delivered).toEqual(["update"]);
    releaseRender();
    await queue.flush();
    expect(delivered).toEqual(["update", "clear"]);
  });
});
