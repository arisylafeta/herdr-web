import { describe, expect, test } from "bun:test";

import {
  checkAccess,
  closeScopePaneIds,
  CreateDeduplicator,
  deviceAuth,
  isHostAllowed,
  paneReadResponse,
  parseCreateTabBody,
  parseCreateWorktreeBody,
  parseCreateWorkspaceBody,
  parseInputBody,
  parseKeysBody,
  parseLiveWatchMessage,
  parseLiveScrollMessage,
  parsePushTestBody,
  parseRenameTabBody,
  parseReplyBody,
  parseRemoveWorktreeBody,
  PaneMutationQueue,
  ReplyDeduplicator,
  replyWasSubmitted,
  resolveStaticPath,
  mutationFailureResponse,
  notificationKindsReenabled,
  makePaneAnsiViewportAdaptive,
  sendReplySteps,
  serveStatic,
  startServer,
  type ReplySender,
} from "./server.ts";
import type { Config } from "./config.ts";
import { HerdrRequestError, type PaneRead } from "./herdr-client.ts";

// checkAccess is the API security gate (same-origin/CSRF + optional Tailscale identity). A
// regression here silently opens remote shell access, so it gets the most direct coverage.

function req(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

function authedReq(headers: Record<string, string>): Request {
  return req({ ...headers, "tailscale-user-login": "me@example.com" });
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    submitKeys: ["Enter"],
    trustedUser: "me@example.com",
    trustedUserHeader: "tailscale-user-login",
    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    publicScheme: "https",
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    multiSession: true,
    ...overrides,
  };
}

describe("notificationKindsReenabled", () => {
  test("detects newly enabled agent kinds but ignores disables and update-only changes", () => {
    expect(
      notificationKindsReenabled(
        { blocked: false, done: false, updates: true },
        { blocked: true, done: false, updates: true },
      ),
    ).toBe(true);
    expect(
      notificationKindsReenabled(
        { blocked: true, done: false, updates: true },
        { blocked: false, done: false, updates: true },
      ),
    ).toBe(false);
    expect(
      notificationKindsReenabled(
        { blocked: true, done: false, updates: false },
        { blocked: true, done: false, updates: true },
      ),
    ).toBe(false);
  });
});

describe("closeScopePaneIds", () => {
  const snapshot = {
    agents: [
      { paneId: "agent-a", tabId: "tab-a", workspaceId: "space-a" },
      { paneId: "agent-b", tabId: "tab-b", workspaceId: "space-a" },
    ],
    shellPanes: [{ paneId: "shell-c", tabId: "tab-c", workspaceId: "space-b" }],
  } as Pick<import("./types.ts").SnapshotResponse, "agents" | "shellPanes">;

  test("selects every pane in a tab", () => {
    expect(closeScopePaneIds(snapshot, { tabId: "tab-a" })).toEqual(["agent-a"]);
  });

  test("selects every agent and shell pane in a space", () => {
    expect(closeScopePaneIds(snapshot, { workspaceId: "space-a" })).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });
});

describe("config route access", () => {
  test("rejects a remote config read when remote identity is not configured", async () => {
    const server = startServer({
      cfg: cfg({ port: 0, trustedUser: "", publicHosts: ["collie.example.ts.net"] }),
      registry: {} as never,
      push: { enabled: true, publicKey: "AQ" } as never,
      snooze: {} as never,
      notifyPrefs: {} as never,
      updateMonitor: {} as never,
      audit: {} as never,
      liveUpdates: {} as never,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: { host: "collie.example.ts.net" },
      });
      expect(response.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});

describe("static frontend recovery", () => {
  test("returns the documented build hint when the root index is absent", async () => {
    const response = await serveStatic("/", `/tmp/herdr-control-missing-${crypto.randomUUID()}`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("frontend not built");
  });
});

describe("checkAccess — same-origin / CSRF gate", () => {
  const remote = cfg({ publicHosts: ["collie.example.ts.net"] });

  test("allows a request with no Origin header (same-origin GET)", () => {
    expect(checkAccess(authedReq({ host: "collie.example.ts.net" }), remote)).toEqual({ ok: true });
  });

  test("allows when the Origin host equals the Host header", () => {
    const r = checkAccess(
      authedReq({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
      remote,
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects a cross-scheme origin on the same public Host", () => {
    expect(
      checkAccess(
        req({ origin: "http://collie.example.ts.net", host: "collie.example.ts.net" }),
        remote,
        "write",
      ),
    ).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("accepts HTTP same-origin only when public HTTP serve mode is configured", () => {
    const http = cfg({ publicHosts: ["collie.example.ts.net:8787"], publicScheme: "http" });
    expect(
      checkAccess(
        authedReq({ origin: "http://collie.example.ts.net:8787", host: "collie.example.ts.net:8787" }),
        http,
        "write",
      ),
    ).toEqual({ ok: true });
    expect(
      checkAccess(
        req({ origin: "https://collie.example.ts.net:8787", host: "collie.example.ts.net:8787" }),
        http,
        "write",
      ),
    ).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("rejects a genuine cross-origin request", () => {
    const r = checkAccess(
      req({ origin: "https://evil.example.com", host: "collie.example.ts.net" }),
      remote,
    );
    expect(r).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("allows only the exact loopback origin, not another local port", () => {
    expect(
      checkAccess(req({ origin: "http://localhost:8787", host: "collie.example.ts.net" }), remote),
    ).toEqual({ ok: false, reason: "cross-origin rejected" });
    expect(checkAccess(req({ origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787" }), cfg())).toEqual({
      ok: true,
    });
    expect(checkAccess(
      req({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:8787" }),
      cfg(),
      "write",
    )).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("allows an explicitly-configured extra origin (COLLIE_ALLOWED_ORIGINS)", () => {
    const c = cfg({ allowedOrigins: ["https://collie.example.com"] });
    const r = checkAccess(
      authedReq({ origin: "https://collie.example.com", host: "collie.example.com" }),
      c,
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects an unparseable Origin", () => {
    expect(checkAccess(req({ origin: "notaurl", host: "127.0.0.1:8787" }), cfg())).toEqual({
      ok: false,
      reason: "bad origin",
    });
  });
});

describe("checkAccess — Tailscale identity gate", () => {
  test("with no trusted user, direct loopback passes but every remote identity fails closed", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), cfg({ trustedUser: "" }))).toEqual({ ok: true });
    expect(
      checkAccess(
        req({ host: "collie.example.ts.net", "tailscale-user-login": "anyone@example.com" }),
        cfg({ trustedUser: "", publicHosts: ["collie.example.ts.net"] }),
      ),
    ).toEqual({ ok: false, reason: "remote identity not configured" });
  });

  test("with a trusted user set, a matching login passes", () => {
    const c = cfg({ trustedUser: "me@example.com", publicHosts: ["collie.example.ts.net"] });
    expect(
      checkAccess(req({ host: "collie.example.ts.net", "tailscale-user-login": "me@example.com" }), c),
    ).toEqual({ ok: true });
  });

  test("with a trusted user set, a mismatching login is rejected", () => {
    const c = cfg({ trustedUser: "me@example.com", publicHosts: ["collie.example.ts.net"] });
    expect(
      checkAccess(req({ host: "collie.example.ts.net", "tailscale-user-login": "intruder@example.com" }), c),
    ).toEqual({ ok: false, reason: "identity not trusted" });
  });

  test("with a trusted user set, a missing header still passes (documented loopback tolerance)", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), c)).toEqual({ ok: true });
  });

  test("with a trusted user set, a remote request missing the identity is rejected", () => {
    const c = cfg({ trustedUser: "me@example.com", publicHosts: ["collie.example.ts.net"] });
    expect(checkAccess(req({ host: "collie.example.ts.net" }), c)).toEqual({
      ok: false,
      reason: "identity required",
    });
  });
});

describe("checkAccess — Host-header validation (COLLIE_PUBLIC_HOSTS)", () => {
  const c = cfg({ publicHosts: ["collie.example.ts.net"] });

  test("DNS-rebinding: Origin==Host==evil host is rejected once publicHosts is set", () => {
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c),
    ).toEqual({ ok: false, reason: "host not allowed" });
    // Fails closed even for a write with a matching evil Origin.
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c, "write"),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });

  test("a legit MagicDNS host with a matching Origin passes", () => {
    expect(
      checkAccess(
        authedReq({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
        c,
      ),
    ).toEqual({ ok: true });
  });

  test("loopback Host always passes even with publicHosts set (read and write)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), c)).toEqual({ ok: true });
    expect(checkAccess(req({ host: "localhost:8787" }), c, "write")).toEqual({ ok: true });
  });

  test("a Host derived from an allowed origin passes", () => {
    const c2 = cfg({
      publicHosts: ["collie.example.ts.net"],
      allowedOrigins: ["https://collie.example.com"],
    });
    expect(
      checkAccess(authedReq({ origin: "https://collie.example.com", host: "collie.example.com" }), c2),
    ).toEqual({ ok: true });
  });

  test("empty publicHosts rejects every non-loopback Host even when Origin matches", () => {
    expect(
      checkAccess(req({ origin: "https://evil.example.com", host: "evil.example.com" }), cfg()),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });
});

describe("checkAccess — Origin required for writes", () => {
  test("allows an explicit native client write on a configured public Host", () => {
    expect(
      checkAccess(
        authedReq({ host: "collie.example.ts.net", "x-herdr-client": "herdr-mobile-v1" }),
        cfg({ publicHosts: ["collie.example.ts.net"] }),
        "write",
      ),
    ).toEqual({ ok: true });
  });

  test("write with no Origin from a non-loopback Host is rejected", () => {
    expect(checkAccess(req({ host: "collie.example.ts.net" }), cfg(), "write")).toEqual({
      ok: false,
      reason: "host not allowed",
    });
  });

  test("write with no Origin from loopback is allowed (curl on the host)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), cfg(), "write")).toEqual({ ok: true });
  });

  test("read with no Origin from a configured public Host passes", () => {
    expect(
      checkAccess(
        authedReq({ host: "collie.example.ts.net" }),
        cfg({ publicHosts: ["collie.example.ts.net"] }),
        "read",
      ),
    ).toEqual({ ok: true });
  });

  test("write WITH a matching Origin passes (normal browser POST)", () => {
    expect(
      checkAccess(
        authedReq({ origin: "https://collie.example.ts.net", host: "collie.example.ts.net" }),
        cfg({ publicHosts: ["collie.example.ts.net"] }),
        "write",
      ),
    ).toEqual({ ok: true });
  });
});

describe("checkAccess — reverse-proxy provenance", () => {
  test("a forwarded request cannot forge a loopback Host", () => {
    const c = cfg({ publicHosts: ["collie.example.ts.net"] });
    const forged = req({ host: "127.0.0.1:8787", "x-forwarded-for": "100.64.0.8" });
    expect(checkAccess(forged, c, "write")).toEqual({ ok: false, reason: "host not allowed" });
    expect(deviceAuth(forged, { ...c, deviceHeader: "x-device-id" })).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
  });

  test("validates the forwarded public Host when a proxy rewrites upstream Host", () => {
    const c = cfg({ publicHosts: ["collie.example.ts.net"] });
    expect(
      checkAccess(
        authedReq({
          host: "127.0.0.1:8787",
          origin: "https://collie.example.ts.net",
          "x-forwarded-for": "100.64.0.8",
          "x-forwarded-host": "collie.example.ts.net",
        }),
        c,
        "write",
      ),
    ).toEqual({ ok: true });
  });

  test("ignores a forged forwarded Host when the immutable Host is not loopback", () => {
    expect(
      checkAccess(
        req({ host: "attacker.example", "x-forwarded-host": "collie.example.ts.net" }),
        cfg({ publicHosts: ["collie.example.ts.net"] }),
      ),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });
});

describe("isHostAllowed", () => {
  test("loopback forms are always allowed", () => {
    const c = cfg({ publicHosts: ["a.ts.net"] });
    expect(isHostAllowed("127.0.0.1:8787", c)).toBe(true);
    expect(isHostAllowed("localhost", c)).toBe(true);
    expect(isHostAllowed("[::1]:8787", c)).toBe(true);
  });

  test("configured public host and allowed-origin host pass; anything else fails", () => {
    const c = cfg({ publicHosts: ["a.ts.net"], allowedOrigins: ["https://b.example.com"] });
    expect(isHostAllowed("a.ts.net", c)).toBe(true);
    expect(isHostAllowed("b.example.com", c)).toBe(true);
    expect(isHostAllowed("evil.com", c)).toBe(false);
    expect(isHostAllowed("", c)).toBe(false);
  });

  test("a forged loopback Host is not trusted when the bridge binds a public interface", () => {
    const c = cfg({ host: "0.0.0.0", publicHosts: ["collie.example.ts.net"] });
    expect(isHostAllowed("127.0.0.1:8787", c)).toBe(false);
    expect(isHostAllowed("collie.example.ts.net", c)).toBe(false);
    expect(
      checkAccess(req({ host: "127.0.0.1:8787" }), c, "write"),
    ).toEqual({ ok: false, reason: "host not allowed" });
    expect(deviceAuth(req({ host: "127.0.0.1:8787" }), { ...c, deviceHeader: "x-device-id" })).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
    expect(deviceAuth(req({ host: "collie.example.ts.net", "x-device-id": "phone" }), {
      ...c,
      deviceHeader: "x-device-id",
      deviceAllowlist: ["phone"],
    })).toEqual({ enforced: true, device: "phone", authorized: false });
  });
});

describe("resolveStaticPath — static path traversal guard", () => {
  const WEB = "/srv/collie/web/dist";

  test("resolves a normal file under the web dir", () => {
    expect(resolveStaticPath("/assets/app.js", WEB)).toEqual({
      rel: "assets/app.js",
      full: "/srv/collie/web/dist/assets/app.js",
    });
  });

  test("maps / to index.html", () => {
    expect(resolveStaticPath("/", WEB)).toEqual({
      rel: "index.html",
      full: "/srv/collie/web/dist/index.html",
    });
  });

  test("rejects a .. traversal attempt", () => {
    expect(resolveStaticPath("/../../etc/passwd", WEB)).toBeNull();
  });

  test("rejects a sibling dir that merely shares the prefix (web/dist-x)", () => {
    // normalize(join(WEB, "../dist-x/evil.js")) === "/srv/collie/web/dist-x/evil.js" — a bare
    // startsWith(WEB) would accept it; the `+ sep` boundary is what rejects it.
    expect(resolveStaticPath("/../dist-x/evil.js", WEB)).toBeNull();
  });
});

describe("sendReplySteps — two-step send & partial-failure clarity", () => {
  // A fake client that records calls and can be told to fail either step.
  class FakeClient implements ReplySender {
    readonly calls: string[] = [];
    constructor(private readonly failOn?: "text" | "keys") {}
    sendPaneText(_paneId: string, _text: string): Promise<void> {
      this.calls.push("text");
      return this.failOn === "text" ? Promise.reject(new Error("text rejected")) : Promise.resolve();
    }
    sendPaneKeys(_paneId: string, _keys: string[]): Promise<void> {
      this.calls.push("keys");
      return this.failOn === "keys" ? Promise.reject(new Error("keys rejected")) : Promise.resolve();
    }
  }

  const noSleep = async () => {};

  test("types then submits on the happy path", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands but submit fails → distinguishable error + textDelivered:true (don't resend)", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({
      ok: false,
      textDelivered: true,
      error: "typed into the pane but not submitted — check the pane before resending",
    });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands and the submit acknowledgement is lost → inspect, never offer Enter retry", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.resolve(),
      sendPaneKeys: () => Promise.reject(
        new HerdrRequestError("connection closed", true),
      ),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: true,
      deliveryAmbiguous: true,
      error: "typed into the pane, but submission could not be confirmed — inspect the pane before sending another key",
    });
  });

  test("text step fails → nothing delivered, surfaces Herdr's message (safe to resend)", async () => {
    const client = new FakeClient("text");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "text rejected" });
    expect(client.calls).toEqual(["text"]); // never reached the keys step
  });

  test("a post-write transport failure is ambiguous and must not invite a text resend", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.reject(
        new HerdrRequestError("herdr pane.send_text: connection closed before reply", true),
      ),
      sendPaneKeys: () => Promise.resolve(),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: true,
      deliveryAmbiguous: true,
      error: "reply delivery could not be confirmed — check the pane before resending",
    });
  });

  test("a pre-write transport failure remains safe to resend", async () => {
    const client: ReplySender = {
      sendPaneText: () => Promise.reject(
        new HerdrRequestError("herdr pane.send_text: connection failed", false),
      ),
      sendPaneKeys: () => Promise.resolve(),
    };

    await expect(
      sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep),
    ).resolves.toEqual({
      ok: false,
      textDelivered: false,
      error: "herdr pane.send_text: connection failed",
    });
  });

  test("submit-only (empty text) failure is a plain failure, not the partial-delivery message", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "keys rejected" });
    expect(client.calls).toEqual(["keys"]); // no text typed
  });

  test("no-submit reply just types the text", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", false, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text"]);
  });
});

describe("replyWasSubmitted", () => {
  test("distinguishes successful type-only replies from submitted replies", () => {
    expect(replyWasSubmitted(false, { ok: true, textDelivered: true })).toBe(false);
    expect(replyWasSubmitted(true, { ok: true, textDelivered: true })).toBe(true);
    expect(replyWasSubmitted(true, { ok: false, textDelivered: true, error: "failed" })).toBe(false);
  });
});

describe("mutationFailureResponse — post-write ambiguity", () => {
  test("marks a post-write transport failure as delivery-unconfirmed", () => {
    expect(mutationFailureResponse(
      new HerdrRequestError("connection closed", true),
      "terminal key",
    )).toEqual({
      ok: false,
      error: "terminal key delivery could not be confirmed — refresh and check state before retrying",
      deliveryAmbiguous: true,
    });
  });

  test("keeps a pre-write or definitive failure ordinary", () => {
    expect(mutationFailureResponse(new Error("rejected"), "tab creation")).toEqual({
      ok: false,
      error: "rejected",
    });
  });
});

describe("mutation request body parsing", () => {
  test("rejects non-object JSON and wrong reply field types", () => {
    expect(parseReplyBody(null)).toBeNull();
    expect(parseReplyBody([])).toBeNull();
    expect(parseReplyBody({ text: 42 })).toBeNull();
    expect(parseReplyBody({ submit: "yes" })).toBeNull();
    expect(parseReplyBody({ text: "hello", submit: false, requestId: "mobile:123" })).toEqual({
      text: "hello",
      submit: false,
      requestId: "mobile:123",
    });
    expect(parseReplyBody({ text: "hello", requestId: "" })).toBeNull();
    expect(parseReplyBody({ text: "hello", requestId: "contains spaces" })).toBeNull();
    expect(parseReplyBody({ text: "hello", requestId: "x".repeat(129) })).toBeNull();
  });

  test("requires a non-empty all-string key list", () => {
    expect(parseKeysBody(null)).toBeNull();
    expect(parseKeysBody({ keys: [] })).toBeNull();
    expect(parseKeysBody({ keys: ["Enter", 1] })).toBeNull();
    expect(parseKeysBody({ keys: ["C-c", "Enter"] })).toEqual(["C-c", "Enter"]);
  });

  test("accepts bounded raw terminal input including control bytes", () => {
    expect(parseInputBody({ data: "a\r\u0003" })).toBe("a\r\u0003");
    expect(parseInputBody({ data: "" })).toBeNull();
    expect(parseInputBody({ data: 1 })).toBeNull();
    expect(parseInputBody({ data: "x".repeat(65_537) })).toBeNull();
  });

  test("validates bounded manual push-test fields", () => {
    expect(parsePushTestBody({ title: "Hi", body: "There", paneId: "p1" })).toEqual({
      title: "Hi",
      body: "There",
      paneId: "p1",
    });
    expect(parsePushTestBody({ title: "", body: "There" })).toBeNull();
    expect(parsePushTestBody({ title: "Hi", body: "" })).toBeNull();
    expect(parsePushTestBody({ title: "x".repeat(129), body: "There" })).toBeNull();
    expect(parsePushTestBody({ title: "Hi", body: "x".repeat(513) })).toBeNull();
    expect(parsePushTestBody({ title: "Hi", body: "There", paneId: 2 })).toBeNull();
  });

  test("validates tab and workspace fields before trimming them", () => {
    expect(parseCreateTabBody(null)).toBeNull();
    expect(parseCreateTabBody({ workspaceId: 1 })).toBeNull();
    expect(parseCreateTabBody({ workspaceId: "  " })).toBeNull();
    expect(parseCreateTabBody({ workspaceId: " w1 ", label: "shell", requestId: "create-1" })).toEqual({
      workspaceId: "w1",
      label: "shell",
      requestId: "create-1",
    });
    expect(parseCreateTabBody({ workspaceId: "w1", requestId: "contains spaces" })).toBeNull();
    expect(parseCreateWorkspaceBody(null)).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: 7 })).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: "/tmp", label: false })).toBeNull();
    expect(parseCreateWorkspaceBody({ cwd: " /tmp ", label: "work", requestId: "create-2" })).toEqual({
      cwd: "/tmp",
      label: "work",
      requestId: "create-2",
    });
    expect(parseCreateWorkspaceBody({ cwd: "/tmp", requestId: "x".repeat(129) })).toBeNull();
    expect(parseRenameTabBody(null)).toBeNull();
    expect(parseRenameTabBody({ label: 3 })).toBeNull();
    expect(parseRenameTabBody({ label: "  " })).toBeNull();
    expect(parseRenameTabBody({ label: ` ${"x".repeat(129)} ` })).toBeNull();
    expect(parseRenameTabBody({ label: " Review " })).toEqual({ label: "Review" });
  });

  test("normalizes worktree create and remove requests", () => {
    expect(parseCreateWorktreeBody({
      workspaceId: " w1 ",
      branch: " feature/mobile ",
      base: " main ",
      label: " Mobile ",
      requestId: "worktree-1",
    })).toEqual({
      workspaceId: "w1",
      branch: "feature/mobile",
      base: "main",
      label: "Mobile",
      requestId: "worktree-1",
    });
    expect(parseCreateWorktreeBody({ workspaceId: "" })).toBeNull();
    expect(parseCreateWorktreeBody({ workspaceId: "w1", branch: 1 })).toBeNull();
    expect(parseRemoveWorktreeBody({ force: true, requestId: "remove-1" })).toEqual({
      force: true,
      requestId: "remove-1",
    });
    expect(parseRemoveWorktreeBody({ force: "yes" })).toBeNull();
  });
});

describe("CreateDeduplicator", () => {
  test("replays a completed structural create and rejects id reuse with new input", async () => {
    const dedupe = new CreateDeduplicator();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return {
        ok: true as const,
        pane: { paneId: "p1", workspaceId: "w1", workspaceLabel: "work", tabId: "t1", cwd: "/tmp" },
      };
    };

    await expect(dedupe.run("default\ncreate-1", "tab\nw1", operation)).resolves.toMatchObject({ ok: true });
    await expect(dedupe.run("default\ncreate-1", "tab\nw1", operation)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(1);
    await expect(
      dedupe.run("default\ncreate-1", "workspace\n/tmp", operation),
    ).resolves.toEqual({ ok: false, error: "requestId was already used with a different create" });
  });
});

describe("ReplyDeduplicator", () => {
  test("returns the cached response for a completed duplicate request", async () => {
    const dedupe = new ReplyDeduplicator();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return { ok: true as const };
    };

    await expect(dedupe.run("primary\np1\nrequest-1", "hello\ntrue", operation)).resolves.toEqual({ ok: true });
    await expect(dedupe.run("primary\np1\nrequest-1", "hello\ntrue", operation)).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("shares one in-flight operation across concurrent duplicates", async () => {
    const dedupe = new ReplyDeduplicator();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = async () => {
      calls += 1;
      await gate;
      return { ok: true as const };
    };

    const first = dedupe.run("primary\np1\nrequest-2", "hello\ntrue", operation);
    const second = dedupe.run("primary\np1\nrequest-2", "hello\ntrue", operation);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(calls).toBe(1);
  });

  test("rejects request-id reuse with a different payload", async () => {
    const dedupe = new ReplyDeduplicator();
    await dedupe.run("primary\np1\nrequest-3", "hello\ntrue", async () => ({ ok: true }));
    await expect(
      dedupe.run("primary\np1\nrequest-3", "different\ntrue", async () => ({ ok: true })),
    ).resolves.toEqual({ ok: false, error: "requestId was already used with a different reply" });
  });
});

describe("PaneMutationQueue", () => {
  test("does not interleave two mutations for the same pane", async () => {
    const queue = new PaneMutationQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("default\np1", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = queue.run("default\np1", async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});

describe("paneReadResponse — pane read → REST body", () => {
  test("passes text, truncated, and the monotonic revision through", () => {
    const read: PaneRead = { pane_id: "w1:p1", text: "hello", truncated: true, revision: 42 };
    expect(paneReadResponse("w1:p1", read)).toEqual({
      paneId: "w1:p1",
      text: "hello",
      truncated: true,
      revision: 42,
    });
  });

  test("carries a zero revision unchanged (fresh pane) rather than dropping the field", () => {
    const read: PaneRead = { pane_id: "w2:p1", text: "", truncated: false, revision: 0 };
    expect(paneReadResponse("w2:p1", read)).toEqual({
      paneId: "w2:p1",
      text: "",
      truncated: false,
      revision: 0,
    });
  });
});

describe("makePaneAnsiViewportAdaptive", () => {
  test("replaces remote-width styled padding with erase-to-device-edge", () => {
    const background = "\u001b[48;2;52;52;52m";
    const reset = "\u001b[0m";
    expect(
      makePaneAnsiViewportAdaptive(
        `${background}          ${reset}\r\n${background}› prompt      ${reset}`,
      ),
    ).toBe(
      `${background}\u001b[K${reset}\r\n${background}› prompt\u001b[K${reset}`,
    );
  });

  test("preserves meaningful interior spaces and unstyled text", () => {
    expect(makePaneAnsiViewportAdaptive("one  two\r\nplain")).toBe("one  two\r\nplain");
  });
});

describe("parseLiveWatchMessage", () => {
  test("accepts a selected pane with device dimensions and supplies compatible defaults", () => {
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":"w1:p1"}'))
      .toEqual({ paneId: "w1:p1", cols: 120, rows: 40 });
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"w1:p1","cols":177,"rows":57}',
    )).toEqual({ paneId: "w1:p1", cols: 177, rows: 57 });
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":null}'))
      .toEqual({ paneId: null, cols: 120, rows: 40 });
  });

  test("rejects malformed watches", () => {
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":3}')).toBeNull();
    expect(parseLiveWatchMessage('{"type":"watch_pane","paneId":"p","minRevision":1}'))
      .toBeNull();
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"p","cols":0,"rows":40}',
    )).toBeNull();
    expect(parseLiveWatchMessage(
      '{"type":"watch_pane","paneId":"p","cols":120,"rows":201}',
    )).toBeNull();
  });
});

describe("parseLiveScrollMessage", () => {
  test("accepts bounded scroll commands for the watched pane", () => {
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":8}',
    )).toEqual({ paneId: "w1:p1", direction: "down", lines: 8 });
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"up","lines":1}',
    )).toEqual({ paneId: "w1:p1", direction: "up", lines: 1 });
  });

  test("rejects malformed or unbounded scroll commands", () => {
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"left","lines":8}',
    )).toBeNull();
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":0}',
    )).toBeNull();
    expect(parseLiveScrollMessage(
      '{"type":"scroll_pane","paneId":"w1:p1","direction":"down","lines":201}',
    )).toBeNull();
  });
});

describe("deviceAuth — per-device authorisation", () => {
  const HDR = "x-device-id";

  test("feature off: not enforced, fully authorised regardless of any header", () => {
    expect(deviceAuth(req({ host: "h" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
    // A stray header value is ignored entirely when the feature is off.
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
  });

  test("feature on, header absent: authorised and unchanged (on-host loopback operator)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "127.0.0.1:8787" }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: true,
    });
    // A blank/whitespace header value is treated as absent, not as a device named "".
    expect(deviceAuth(req({ host: "localhost:8787", "x-device-id": "  " }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: true,
    });
  });

  test("feature on, header absent or blank on a public Host: read-only (fail-closed proxy path)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "collie.example.ts.net" }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
    expect(deviceAuth(req({ host: "collie.example.ts.net", "x-device-id": "  " }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
  });

  test("feature on, allowlisted device: authorised and attributed (header is trimmed)", () => {
    const c = cfg({
      trustedUser: "owner@example.com",
      deviceHeader: HDR,
      deviceAllowlist: ["phone", "laptop"],
    });
    expect(deviceAuth(req({
      host: "collie.example.ts.net",
      "tailscale-user-login": "owner@example.com",
      "x-device-id": " phone ",
    }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: true,
    });
  });

  test("an allowlisted device header without verified proxy identity is read-only", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "collie.example.ts.net", "x-device-id": "phone" }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: false,
    });
  });

  test("feature on, non-allowlisted device: read-only (attributed but not authorised)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "intruder" }), c)).toEqual({
      enforced: true,
      device: "intruder",
      authorized: false,
    });
  });

  test("the 'unknown' sentinel is never authorised, even if it appears in the allowlist", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["unknown"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "unknown" }), c)).toEqual({
      enforced: true,
      device: "unknown",
      authorized: false,
    });
  });

  test("feature on with an empty allowlist: every header-carrying device is read-only (fail-closed)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: [] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: false,
    });
  });
});
