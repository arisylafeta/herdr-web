import { afterEach, describe, expect, it, vi } from "vitest";
import { disablePush, enablePush, getPushState } from "./push";

describe("getPushState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not report a browser-local subscription as enabled when bridge reconciliation fails", async () => {
    const subscription = {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      options: { applicationServerKey: new Uint8Array([1]).buffer, userVisibleOnly: true },
      getKey: vi.fn(() => null),
      toJSON: vi.fn(() => ({ endpoint: "https://push.example/subscription" })),
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    } as unknown as PushSubscription;
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null) });
    vi.stubGlobal("window", {
      isSecureContext: true,
      PushManager: function PushManager() {},
      Notification: function Notification() {},
    });
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(() => Promise.resolve({
          pushManager: { getSubscription: vi.fn(() => Promise.resolve(subscription)) },
        })),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ push: true, vapidPublicKey: "AQ" }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("registration refused", { status: 503 })),
    );

    await expect(getPushState()).resolves.toMatchObject({
      availability: "ready",
      subscribed: false,
      localSubscribed: true,
    });
  });
});

describe("enablePush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rolls back a subscription created before bridge registration fails", async () => {
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    const subscription = {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      options: { applicationServerKey: null, userVisibleOnly: true },
      getKey: vi.fn(() => null),
      toJSON: vi.fn(() => ({ endpoint: "https://push.example/subscription" })),
      unsubscribe,
    } as unknown as PushSubscription;
    const subscribe = vi.fn(() => Promise.resolve(subscription));
    const serviceWorker = {
      register: vi.fn(() =>
        Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(() => Promise.resolve(null)),
            subscribe,
          },
        }),
      ),
    };

    vi.stubGlobal("window", {
      isSecureContext: true,
      PushManager: function PushManager() {},
      Notification: function Notification() {},
    });
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ push: true, vapidPublicKey: "AQ" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("registration refused", { status: 503 })),
    );

    await expect(enablePush()).rejects.toThrow("registration refused");
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("disablePush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("still unsubscribes locally and persists opt-out when bridge deregistration fails", async () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem, removeItem });
    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      Notification: function Notification() {},
    });
    vi.stubGlobal("Notification", function Notification() {});
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(() => Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(() => Promise.resolve({
              endpoint: "https://push.example/subscription",
              unsubscribe,
            })),
          },
        })),
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("failed", { status: 503 }))));

    await expect(disablePush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith("herdr-control:push-disabled", "1");
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("disables after bridge deregistration even when browser unsubscribe returns false", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      Notification: function Notification() {},
    });
    vi.stubGlobal("Notification", function Notification() {});
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(() => Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(() => Promise.resolve({
              endpoint: "https://push.example/subscription",
              unsubscribe: vi.fn(() => Promise.resolve(false)),
            })),
          },
        })),
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));

    await expect(disablePush()).resolves.toBeUndefined();
    expect(setItem).toHaveBeenCalledWith("herdr-control:push-disabled", "1");
  });

  it("does not claim opt-out when both bridge deletion and local unsubscribe fail", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      Notification: function Notification() {},
    });
    vi.stubGlobal("Notification", function Notification() {});
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(() => Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(() => Promise.resolve({
              endpoint: "https://push.example/subscription",
              unsubscribe: vi.fn(() => Promise.resolve(false)),
            })),
          },
        })),
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("failed", { status: 503 }))));

    await expect(disablePush()).rejects.toThrow(/could not disable push notifications/i);
    expect(setItem).not.toHaveBeenCalled();
  });
});
