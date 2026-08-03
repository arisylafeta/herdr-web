import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import type { AuditLog } from "./audit.ts";
import { isLoopbackBindHost, MAX_READ_LINES, type Config } from "./config.ts";
import { HerdrRequestError, type HerdrClient, type PaneRead } from "./herdr-client.ts";
import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import type { LiveUpdateHub } from "./live-updates.ts";
import type { NotifyPrefs, NotifyPrefsStore } from "./notify-prefs.ts";
import { ensurePrivateDirectory, writePrivateFile } from "./private-fs.ts";
import {
  isTrustedPushSubscription,
  type Push,
  type PushSubscriptionOwner,
} from "./push.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { Snooze } from "./snooze.ts";
import { observeTerminalFrames } from "./terminal-observer.ts";
import type { UpdateMonitor } from "./update.ts";
import type { StateEngine } from "./state-engine.ts";
import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  DeviceAuth,
  PaneReadResponse,
  SnapshotResponse,
  UploadResponse,
  WorktreeCreateResponse,
} from "./types.ts";

// Image upload limits. Herdr's socket only carries text/keys, so we can't paste an image into the
// terminal — instead we save it to a host file and the client references its path in the message
// (the agent reads images by path). See uploadPane().
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
// Multipart wraps the file in a boundary + part headers, so a legitimately-sized image arrives a
// little over MAX_UPLOAD_BYTES on the wire. Allow a small slack for the Content-Length pre-check.
const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB
// Hard cap the runtime enforces on ANY request body (Bun.serve maxRequestBodySize). Bigger than the
// upload cap + overhead so the handler's own 413 fires first for honest clients; this cuts off a
// chunked or lying client that never sends an accurate Content-Length.
const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024; // 12 MB
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// The built PWA lives in web/dist (Vite output). If it's missing, the bridge still runs the API
// — only the static UI 503s with a hint to build.
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Strict CSP. Scripts are external, hashed bundles (script-src 'self'); pane text is rendered by
// React as text nodes, never markup, so terminal output can't inject. 'unsafe-inline' is allowed
// for styles only (the toast library injects a <style> tag) — it can't execute code.
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// Hardening headers set on EVERY response (static + API), applied centrally in the fetch wrapper.
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-herdr-control": "herdr-control-v1",
  "referrer-policy": "no-referrer",
};

// Loopback Host/Origin forms (with an optional port). Loopback is always trusted — only tailscaled
// (or a co-located proxy) can reach the bridge's port, so a loopback caller is the on-host operator.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const NATIVE_CLIENT_HEADER = "x-herdr-client";
const NATIVE_CLIENT_VALUE = "herdr-mobile-v1";
const MUTATION_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REPLY_DEDUPE_TTL_MS = 10 * 60 * 1000;
const REPLY_DEDUPE_MAX_ENTRIES = 512;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 40;
const MIN_TERMINAL_COLS = 20;
const MAX_TERMINAL_COLS = 400;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_ROWS = 200;

const PANE_ROUTE = /^\/api\/pane\/([^/]+)(?:\/(reply|input|keys|upload|close))?$/;
const TAB_ROUTE = /^\/api\/tab\/([^/]+)$/;
const WORKTREE_ROUTE = /^\/api\/worktree\/([^/]+)$/;
const PANE_FOCUS_ROUTE = /^\/api\/focus\/([^/]+)$/;

interface LiveSocketData {
  session: string;
  canControl: boolean;
  paneWatch?: {
    paneId: string;
    cols: number;
    rows: number;
    resize(cols: number, rows: number): boolean;
    scroll(direction: "up" | "down", lines: number): boolean;
    close(): void;
  };
}

/** Whether an agent-status preference change made a previously muted kind eligible. */
export function notificationKindsReenabled(previous: NotifyPrefs, updated: NotifyPrefs): boolean {
  return (!previous.blocked && updated.blocked) || (!previous.done && updated.done);
}

interface DedupeEntry<T> {
  signature: string;
  promise: Promise<T>;
  completedAt?: number;
}

class RequestDeduplicator<T> {
  private readonly entries = new Map<string, DedupeEntry<T>>();

  constructor(
    private readonly conflictResponse: () => T,
    private readonly capacityResponse: () => T,
    private readonly maxEntries = REPLY_DEDUPE_MAX_ENTRIES,
    private readonly ttlMs = REPLY_DEDUPE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  run(
    key: string,
    signature: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.signature !== signature) {
        return Promise.resolve(this.conflictResponse());
      }
      return existing.promise;
    }

    if (this.entries.size >= this.maxEntries) {
      const completed = [...this.entries].find(([, entry]) => entry.completedAt !== undefined);
      if (completed) this.entries.delete(completed[0]);
      else {
        return Promise.resolve(this.capacityResponse());
      }
    }

    const entry: DedupeEntry<T> = {
      signature,
      promise: Promise.resolve(undefined as T),
    };
    try {
      entry.promise = operation();
    } catch (error) {
      entry.promise = Promise.reject(error);
    }
    entry.promise = entry.promise.finally(() => {
      entry.completedAt = this.now();
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.completedAt !== undefined && entry.completedAt <= cutoff) this.entries.delete(key);
    }
  }
}

/** Bounds reply idempotency state while preserving the existing reply-specific errors. */
export class ReplyDeduplicator extends RequestDeduplicator<ActionResponse> {
  constructor(
    maxEntries = REPLY_DEDUPE_MAX_ENTRIES,
    ttlMs = REPLY_DEDUPE_TTL_MS,
    now: () => number = Date.now,
  ) {
    super(
      () => ({ ok: false, error: "requestId was already used with a different reply" }),
      () => ({ ok: false, error: "too many reply requests are currently in flight" }),
      maxEntries,
      ttlMs,
      now,
    );
  }
}

/** Deduplicates tab/workspace creates whose HTTP response may be lost after the mutation commits. */
export class CreateDeduplicator extends RequestDeduplicator<CreateResponse> {
  constructor(
    maxEntries = REPLY_DEDUPE_MAX_ENTRIES,
    ttlMs = REPLY_DEDUPE_TTL_MS,
    now: () => number = Date.now,
  ) {
    super(
      () => ({ ok: false, error: "requestId was already used with a different create" }),
      () => ({ ok: false, error: "too many create requests are currently in flight" }),
      maxEntries,
      ttlMs,
      now,
    );
  }
}

export class WorktreeCreateDeduplicator extends RequestDeduplicator<WorktreeCreateResponse> {
  constructor(
    maxEntries = REPLY_DEDUPE_MAX_ENTRIES,
    ttlMs = REPLY_DEDUPE_TTL_MS,
    now: () => number = Date.now,
  ) {
    super(
      () => ({ ok: false, error: "requestId was already used with a different worktree create" }),
      () => ({ ok: false, error: "too many worktree creates are currently in flight" }),
      maxEntries,
      ttlMs,
      now,
    );
  }
}

export class ActionDeduplicator extends RequestDeduplicator<ActionResponse> {
  constructor(
    maxEntries = REPLY_DEDUPE_MAX_ENTRIES,
    ttlMs = REPLY_DEDUPE_TTL_MS,
    now: () => number = Date.now,
  ) {
    super(
      () => ({ ok: false, error: "requestId was already used with a different action" }),
      () => ({ ok: false, error: "too many structural actions are currently in flight" }),
      maxEntries,
      ttlMs,
      now,
    );
  }
}

/** Serializes terminal mutations per session/pane while allowing unrelated panes to proceed. */
export class PaneMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export function startServer(opts: {
  cfg: Config;
  registry: SessionRegistry;
  push: Push;
  snooze: Snooze;
  notifyPrefs: NotifyPrefsStore;
  updateMonitor: UpdateMonitor;
  audit: AuditLog;
  liveUpdates: LiveUpdateHub;
}) {
  const { cfg, registry, push, snooze, notifyPrefs, updateMonitor, audit, liveUpdates } = opts;
  const replyDeduplicator = new ReplyDeduplicator();
  const createDeduplicator = new CreateDeduplicator();
  const worktreeCreateDeduplicator = new WorktreeCreateDeduplicator();
  const actionDeduplicator = new ActionDeduplicator();
  const paneMutations = new PaneMutationQueue();
  if (!isLoopbackBindHost(cfg.host)) {
    throw new Error(`refusing non-loopback COLLIE_HOST: ${cfg.host}`);
  }
  // Per-session background notifications live in each session's runtime (built by the factory in
  // index.ts, wired to its StateEngine transitions). The routes here only fan preference changes and
  // snooze-clears across every live session's coordinator.

  const server = Bun.serve<LiveSocketData>({
    hostname: cfg.host,
    port: cfg.port,
    // Runtime cap on any request body — a chunked/lying client is cut off here even if its
    // Content-Length is absent or false. The upload handler still does its own precise check.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req, bunServer) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Session-scoped routes accept an optional `?session=<name>`; absent → the primary session
      // (identical to pre-multi-session behaviour). The name is only ever a registry Map lookup — it
      // never builds a path. An unknown name is a 404. Global routes below ignore the param entirely.
      const sessionName = url.searchParams.get("session") ?? undefined;
      const unknownSession = () =>
        jsonError(`unknown session: ${sessionName ?? ""}`, 404, req.headers.get("accept-encoding"));

      if (pathname === "/api/live") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        const device = deviceAuth(req, cfg);
        const canControl = !device.enforced || device.authorized;
        if (bunServer.upgrade(req, { data: { session: rt.name, canControl } })) return;
        return text("websocket upgrade required", 426);
      }

      // ── Live state (polled by the client) ────────────────────────────────
      if (pathname === "/api/snapshot") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        const { agents, shellPanes, workspaces, tabs, bridge } = rt.engine.current();
        const device = deviceAuth(req, cfg);
        return json({
          bridge,
          // Only report device state when the feature is on, so an off deployment sends nothing new.
          ...(device.enforced ? { device } : {}),
          agents,
          shellPanes,
          workspaces,
          tabs,
          sessions: registry.list(),
          notifications: { snoozedUntil: snooze.until() },
          update: updateMonitor.status(),
          ts: Date.now(),
        } satisfies SnapshotResponse, req.headers.get("accept-encoding"));
      }

      // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
      if (pathname === "/api/tab" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return createTab(rt.herdr, rt.engine, req, audit, deviceAuth(req, cfg).device, rt.name, createDeduplicator);
      }
      const tabMatch = pathname.match(TAB_ROUTE);
      if (tabMatch && req.method === "PATCH") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return renameTab(
          rt.herdr,
          decodeURIComponent(tabMatch[1]!),
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
        );
      }
      if (tabMatch && req.method === "DELETE") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return closeScope(
          rt.herdr,
          rt.engine,
          { tabId: decodeURIComponent(tabMatch[1]!) },
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
          actionDeduplicator,
        );
      }
      if (pathname === "/api/workspace" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return createWorkspace(rt.herdr, req, audit, deviceAuth(req, cfg).device, rt.name, createDeduplicator);
      }
      const workspaceMatch = pathname.match(/^\/api\/workspace\/([^/]+)$/);
      if (workspaceMatch && req.method === "DELETE") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return closeScope(
          rt.herdr,
          rt.engine,
          { workspaceId: decodeURIComponent(workspaceMatch[1]!) },
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
          actionDeduplicator,
        );
      }

      if (pathname === "/api/worktree" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return createWorktree(
          rt.herdr,
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
          worktreeCreateDeduplicator,
        );
      }
      const worktreeMatch = pathname.match(WORKTREE_ROUTE);
      if (worktreeMatch && req.method === "DELETE") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return removeWorktree(
          rt.herdr,
          decodeURIComponent(worktreeMatch[1]!),
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
          actionDeduplicator,
        );
      }

      const focusMatch = pathname.match(PANE_FOCUS_ROUTE);
      if (focusMatch && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return focusPane(
          rt.herdr,
          decodeURIComponent(focusMatch[1]!),
          req,
          audit,
          deviceAuth(req, cfg).device,
          rt.name,
        );
      }

      // ── Per-pane read / send ─────────────────────────────────────────────
      const paneMatch = pathname.match(PANE_ROUTE);
      if (paneMatch) {
        const paneId = decodeURIComponent(paneMatch[1]!);
        const action = paneMatch[2];
        // Reading a pane is allowed for any access-gated client; every action (reply/keys/upload/
        // close) types into or restructures a terminal, so it additionally needs an authorised device.
        const denied = guard(req, cfg, action ? "write" : "read");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        const { herdr, name: session } = rt;
        // Every action is a write; attribute it to the authorised device for the audit trail.
        const device = action ? deviceAuth(req, cfg).device : null;

        if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
        if (action === "reply" && req.method === "POST") {
          return replyPane(
            herdr, cfg, paneId, req, audit, device, session, replyDeduplicator, paneMutations,
          );
        }
        if (action === "input" && req.method === "POST") {
          return inputPane(herdr, paneId, req, audit, device, session, paneMutations);
        }
        if (action === "keys" && req.method === "POST") {
          return keysPane(herdr, paneId, req, audit, device, session, paneMutations);
        }
        if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req, audit, device, session);
        if (action === "close" && req.method === "POST") {
          return closePane(herdr, paneId, req, audit, device, session, paneMutations);
        }
        return text("method not allowed", 405);
      }

      // ── Misc API ─────────────────────────────────────────────────────────
      if (pathname === "/api/config") {
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        return json({
          push: push.enabled,
          vapidPublicKey: push.publicKey,
          build: await buildId(),
        } satisfies BridgeConfig, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/push-test" && req.method === "POST") {
        // The CLI routes its manual delivery through the live bridge so subscription state has one
        // process owner. This is a write-level operation because it alerts every registered device.
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          return text("bad push test", 400);
        }
        const body = parsePushTestBody(raw);
        if (!body) return text("bad push test", 400);
        if (!push.enabled) return text("push is disabled", 409);
        if (push.subscriptionCount === 0) return text("no subscribed devices", 409);
        try {
          const delivery = await push.notify(body.title, body.body, { paneId: body.paneId });
          if (delivery.succeeded === 0) {
            return text(
              `push test failed: no delivery succeeded (${delivery.failed}/${delivery.attempted} failed)`,
              502,
            );
          }
          return json(
            { ok: true, subscribers: delivery.succeeded },
            req.headers.get("accept-encoding"),
          );
        } catch (error) {
          return text(
            `push test failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
          );
        }
      }
      if (pathname === "/api/subscribe" && req.method === "POST") {
        // Registration creates a persistent outbound-delivery target, so it requires an authorised
        // device even though receiving a notification is not terminal-driving.
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return text("bad subscription", 400);
        }
        if (!isTrustedPushSubscription(body)) return text("bad subscription", 400);
        const auth = deviceAuth(req, cfg);
        const owner: PushSubscriptionOwner = !auth.enforced
          ? { kind: "unrestricted" }
          : auth.device
            ? { kind: "device", device: auth.device }
            : { kind: "local" };
        const added = await push.addSubscription(body, owner);
        if (added === "disabled") return text("push is disabled", 409);
        if (added === "full") return text("subscription limit reached", 429);
        if (added === "invalid") return text("bad subscription", 400);
        return secure(new Response(null, { status: 204 }));
      }
      if (pathname === "/api/subscribe" && req.method === "DELETE") {
        // Self-revocation must remain available after a device is removed from the write allowlist.
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return text("bad subscription", 400);
        }
        if (!isJsonObject(body) || typeof body.endpoint !== "string" || !body.endpoint) {
          return text("bad subscription", 400);
        }
        const auth = deviceAuth(req, cfg);
        const actor: PushSubscriptionOwner | null = !auth.enforced
          ? { kind: "unrestricted" }
          : auth.device
            ? { kind: "device", device: auth.device }
            : auth.authorized
              ? { kind: "local" }
              : null;
        const removed = await push.removeSubscription(body.endpoint, actor);
        if (removed === "forbidden") return text("subscription owner mismatch", 403);
        return secure(new Response(null, { status: 204 }));
      }
      if (pathname === "/api/notifications/snooze" && req.method === "POST") {
        // Snooze is bridge-wide across every session and subscriber, so only an authorised device
        // may change it. Read-only devices can still subscribe and inspect snapshot state.
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return text("bad request", 400);
        }
        if (!isJsonObject(body)) return text("bad request", 400);
        const until = body.snoozedUntil;
        if (until !== null && (typeof until !== "number" || !Number.isFinite(until))) {
          return text("bad snoozedUntil", 400);
        }
        await snooze.set(until);
        // Snoozing should also clear whatever's already on the lock screen — across every session,
        // since snooze is bridge-wide. Each session owns its own notification slot (tag).
        if (snooze.isMuted()) {
          await Promise.all(registry.all().map((rt) => rt.notifications.clearAll()));
        }
        return json({ snoozedUntil: snooze.until() }, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/notifications/prefs") {
        // Which agent statuses push (bridge-wide). Reading is available to every access-gated
        // client; changing the shared policy requires an authorised device.
        if (req.method === "GET") {
          const denied = guard(req, cfg, "read");
          if (denied) return denied;
          return json(notifyPrefs.current(), req.headers.get("accept-encoding"));
        }
        if (req.method === "POST") {
          const denied = guard(req, cfg, "write");
          if (denied) return denied;
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return text("bad request", 400);
          }
          const patch = parseNotifyPrefsPatch(body);
          if (!patch) return text("bad prefs", 400);
          const { previous, updated } = await notifyPrefs.setWithPrevious(patch);
          // Prefs may have just disabled a kind — retract any pending/outstanding alerts of it, in
          // every live session (prefs are bridge-wide; each session has its own coordinator).
          for (const rt of registry.all()) rt.notifications.applyPrefs();
          // A newly enabled kind needs an authoritative rebuild: an agent may have remained in that
          // state while muted, so no future transition would restore it. The existing reconciler
          // applies immediately for a connected session and defers across an outage.
          if (notificationKindsReenabled(previous, updated)) {
            for (const rt of registry.all()) rt.resumeNotifications();
          }
          if (!updated.updates) updateMonitor.clearNotification();
          return json(updated, req.headers.get("accept-encoding"));
        }
        return text("method not allowed", 405);
      }
      if (pathname === "/api/update/check" && req.method === "POST") {
        // Force an immediate upstream check (the "check for updates" button), instead of waiting for
        // the periodic timer. Read-level — checking a version isn't terminal-driving — and idempotent
        // (the monitor de-dupes concurrent checks). Returns the fresh status the client revalidates on.
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        await updateMonitor.checkRelease();
        return json(updateMonitor.status(), req.headers.get("accept-encoding"));
      }

      // API typos and unsupported methods must never look like a successful SPA navigation.
      if (pathname === "/api" || pathname.startsWith("/api/")) return text("not found", 404);

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname);
    },
    websocket: {
      open(socket) {
        liveUpdates.add(socket.data.session, socket);
      },
      close(socket) {
        socket.data.paneWatch?.close();
        liveUpdates.remove(socket.data.session, socket);
      },
      message(socket, rawMessage) {
        const raw = String(rawMessage);
        const scroll = parseLiveScrollMessage(raw);
        if (scroll) {
          if (
            socket.data.canControl &&
            socket.data.paneWatch?.paneId === scroll.paneId
          ) {
            socket.data.paneWatch.scroll(scroll.direction, scroll.lines);
          }
          return;
        }
        const watch = parseLiveWatchMessage(raw);
        if (!watch) return;
        if (watch.paneId === null) {
          socket.data.paneWatch?.close();
          socket.data.paneWatch = undefined;
          return;
        }
        if (socket.data.paneWatch?.paneId === watch.paneId) {
          if (
            socket.data.paneWatch.cols === watch.cols &&
            socket.data.paneWatch.rows === watch.rows
          ) return;
          if (socket.data.paneWatch.resize(watch.cols, watch.rows)) return;
        }
        socket.data.paneWatch?.close();
        socket.data.paneWatch = undefined;
        const rt = registry.get(socket.data.session);
        if (!rt) return;
        let intentionalClose = false;
        const paneWatch = observeTerminalFrames({
          paneId: watch.paneId,
          session: rt.name,
          cols: watch.cols,
          rows: watch.rows,
          control: socket.data.canControl,
          onUp: () => {
            socket.send(JSON.stringify({
              type: "pane_stream_status",
              paneId: watch.paneId,
              live: true,
            }));
          },
          onFrame: (frame) => {
            socket.send(JSON.stringify({
              type: "pane_frame",
              ...frame,
            }));
          },
          onDown: (reason) => {
            if (!intentionalClose) {
              socket.send(JSON.stringify({
                type: "pane_stream_status",
                paneId: watch.paneId,
                live: false,
                reason,
              }));
            }
          },
        });
        socket.data.paneWatch = {
          paneId: watch.paneId,
          cols: watch.cols,
          rows: watch.rows,
          resize(cols, rows) {
            const resized = paneWatch.resize(cols, rows);
            if (resized && socket.data.paneWatch) {
              socket.data.paneWatch.cols = cols;
              socket.data.paneWatch.rows = rows;
            }
            return resized;
          },
          scroll(direction, lines) {
            return paneWatch.scroll(direction, lines);
          },
          close() {
            intentionalClose = true;
            paneWatch.close();
          },
        };
      },
    },
  });

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    console.warn(`[bridge] WARNING: bound to ${cfg.host}, not loopback — identity checks may be bypassable`);
  }
  if (cfg.deviceHeader) {
    console.log(
      `[bridge] per-device auth ON: trusting '${cfg.deviceHeader}', ${cfg.deviceAllowlist.length} device(s) allowlisted`,
    );
    if (cfg.deviceAllowlist.length === 0) {
      console.warn(
        `[bridge] WARNING: COLLIE_DEVICE_HEADER set but COLLIE_DEVICE_ALLOWLIST is empty — every device is read-only`,
      );
    }
  }
  if (!cfg.trustedUser) {
    console.warn(
      `[bridge] remote API access is disabled until COLLIE_TRUSTED_USER is set; direct loopback remains available.`,
    );
  }
  if (cfg.publicHosts.length === 0 && cfg.allowedOrigins.length === 0) {
    console.warn(
      `[bridge] remote Hosts are denied until COLLIE_PUBLIC_HOSTS or COLLIE_ALLOWED_ORIGINS is configured; loopback remains available.`,
    );
  }

  return server;
}

export function parseLiveWatchMessage(raw: string): {
  paneId: string | null;
  cols: number;
  rows: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(value) || value.type !== "watch_pane") return null;
  if (value.paneId !== null && typeof value.paneId !== "string") return null;
  if (value.minRevision !== undefined) return null;
  const cols = value.cols ?? DEFAULT_TERMINAL_COLS;
  const rows = value.rows ?? DEFAULT_TERMINAL_ROWS;
  if (
    typeof cols !== "number" ||
    !Number.isInteger(cols) ||
    cols < MIN_TERMINAL_COLS ||
    cols > MAX_TERMINAL_COLS ||
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows < MIN_TERMINAL_ROWS ||
    rows > MAX_TERMINAL_ROWS
  ) return null;
  return { paneId: value.paneId, cols, rows };
}

export function parseLiveScrollMessage(raw: string): {
  paneId: string;
  direction: "up" | "down";
  lines: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isJsonObject(value) ||
    value.type !== "scroll_pane" ||
    typeof value.paneId !== "string" ||
    (value.direction !== "up" && value.direction !== "down") ||
    typeof value.lines !== "number" ||
    !Number.isInteger(value.lines) ||
    value.lines < 1 ||
    value.lines > MAX_TERMINAL_ROWS
  ) return null;
  return {
    paneId: value.paneId,
    direction: value.direction,
    lines: value.lines,
  };
}

async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  // Clamp to a sane ceiling — don't trust the client (or Herdr) to bound an enormous read.
  const lines =
    Number.isFinite(linesParam) && linesParam > 0
      ? Math.min(linesParam, MAX_READ_LINES)
      : Math.min(cfg.readLines, MAX_READ_LINES);
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror.
    const read = await herdr.readPane(paneId, "recent_unwrapped", lines, "ansi");
    read.text = makePaneAnsiViewportAdaptive(read.text);
    const data = paneReadResponse(paneId, read);
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const bodyStr = JSON.stringify(data);
    const etag = computeEtag(bodyStr);
    if (notModified(req.headers.get("if-none-match"), etag)) {
      // RFC 7232 §4.1: 304 MUST echo the ETag; body MUST be empty.
      return secure(
        new Response(null, {
          status: 304,
          headers: { etag, "cache-control": "no-store" },
        }),
      );
    }
    return secure(gzipJsonResponse(data, req.headers.get("accept-encoding"), { etag }));
  } catch (err) {
    return text(`herdr read failed: ${(err as Error).message}`, 502);
  }
}

/**
 * Herdr's ANSI pane read pads TUI rows to the host pane width. Literal styled spaces wrap into
 * extra gray rows on narrower devices. EL keeps the active background but fills to the receiving
 * terminal's own right edge, so Ghostty can reflow the same buffer for every device width.
 */
export function makePaneAnsiViewportAdaptive(text: string): string {
  let backgroundActive = false;
  return text.split("\n").map((rawLine) => {
    const hasCarriageReturn = rawLine.endsWith("\r");
    const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
    const match = / +((?:\u001b\[[0-9;]*m)*)$/.exec(line);
    if (!match || match.index === undefined) {
      backgroundActive = scanBackgroundState(line, backgroundActive);
      return rawLine;
    }

    const prefix = line.slice(0, match.index);
    const suffix = match[1] ?? "";
    const paddingHasBackground = scanBackgroundState(prefix, backgroundActive);
    backgroundActive = scanBackgroundState(suffix, paddingHasBackground);
    if (!paddingHasBackground) return rawLine;
    return `${prefix}\u001b[K${suffix}${hasCarriageReturn ? "\r" : ""}`;
  }).join("\n");
}

function scanBackgroundState(text: string, initial: boolean): boolean {
  let active = initial;
  const sgr = /\u001b\[([0-9;]*)m/g;
  for (const match of text.matchAll(sgr)) {
    const codes = match[1] === "" ? [0] : match[1]!.split(";").map(Number);
    for (const code of codes) {
      if (code === 0 || code === 49) active = false;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48) {
        active = true;
      }
    }
  }
  return active;
}

/**
 * Map a Herdr pane read to the REST response body. Pure + exported so the `revision` passthrough
 * (the client's prompt-select race guard depends on it) is covered by the bridge unit tests without
 * standing up Bun.serve / the socket client.
 */
export function paneReadResponse(paneId: string, read: PaneRead): PaneReadResponse {
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

/** Just the two one-shot RPCs a reply needs — real HerdrClient in the bridge, fake in tests. */
export interface ReplySender {
  sendPaneText(paneId: string, text: string): Promise<void>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
}

/** Outcome of the two-step send. `textDelivered` is only meaningful on the failure branch. */
export type ReplyOutcome =
  | { ok: true; textDelivered: boolean }
  | {
      ok: false;
      error: string;
      textDelivered: boolean;
      deliveryAmbiguous?: boolean;
    };

export function mutationFailureResponse(
  error: unknown,
  action: string,
): { ok: false; error: string; deliveryAmbiguous?: boolean } {
  if (error instanceof HerdrRequestError && error.requestWritten) {
    return {
      ok: false,
      error: `${action} delivery could not be confirmed — refresh and check state before retrying`,
      deliveryAmbiguous: true,
    };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The reply's two one-shot RPCs — type the text, then send the submit key(s) — as a pure function so
 * the partial-failure branch is unit-testable with a fake client. The important case: if the text
 * lands but the submit keypress fails, we surface a distinct, actionable error and `textDelivered:
 * true` so the client knows NOT to resend (which would duplicate the already-typed text). Pure +
 * exported.
 */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pause between typing and Enter so the TUI accepts the submit key (preview-action polls ~350ms). */
const REPLY_SETTLE_MS = 350;

export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  try {
    if (txt) {
      await client.sendPaneText(paneId, txt);
      textDelivered = true;
    }
    if (submit) {
      if (txt) await sleep(REPLY_SETTLE_MS);
      await client.sendPaneKeys(paneId, submitKeys);
    }
    return { ok: true, textDelivered };
  } catch (err) {
    if (
      txt &&
      !textDelivered &&
      err instanceof HerdrRequestError &&
      err.requestWritten
    ) {
      // The request reached the socket but its acknowledgement did not reach us. Treat the safety
      // flag as "do not resend text": the terminal may already contain it, so clients clear the
      // composer and direct the operator to inspect the pane rather than risk a duplicate.
      return {
        ok: false,
        textDelivered: true,
        deliveryAmbiguous: true,
        error: "reply delivery could not be confirmed — check the pane before resending",
      };
    }
    if (submit && err instanceof HerdrRequestError && err.requestWritten) {
      return {
        ok: false,
        textDelivered,
        deliveryAmbiguous: true,
        error: textDelivered
          ? "typed into the pane, but submission could not be confirmed — inspect the pane before sending another key"
          : "submission could not be confirmed — inspect the pane before sending another key",
      };
    }
    if (textDelivered && submit) {
      // Text is already in the pane — only the submit failed. Tell the operator to check/submit it
      // by hand rather than resend, and flag textDelivered so a resend-on-error UI can hold off.
      return {
        ok: false,
        textDelivered: true,
        error: "typed into the pane but not submitted — check the pane before resending",
      };
    }
    return { ok: false, textDelivered, error: (err as Error).message };
  }
}

export function replyWasSubmitted(submit: boolean, outcome: ReplyOutcome): boolean {
  return submit && outcome.ok;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReplyBody(
  value: unknown,
): { text: string; submit: boolean; requestId?: string } | null {
  if (!isJsonObject(value)) return null;
  if (value.text !== undefined && typeof value.text !== "string") return null;
  if (value.submit !== undefined && typeof value.submit !== "boolean") return null;
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !MUTATION_REQUEST_ID.test(value.requestId))
  ) return null;
  return {
    text: value.text ?? "",
    submit: value.submit ?? true,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  };
}

export function parseKeysBody(value: unknown): string[] | null {
  if (!isJsonObject(value) || !Array.isArray(value.keys) || value.keys.length === 0) return null;
  if (!value.keys.every((key): key is string => typeof key === "string")) return null;
  return value.keys;
}

export function parseInputBody(value: unknown): string | null {
  if (!isJsonObject(value) || typeof value.data !== "string") return null;
  if (value.data.length === 0 || value.data.length > 65_536) return null;
  return value.data;
}

export function parsePushTestBody(
  value: unknown,
): { title: string; body: string; paneId?: string } | null {
  if (!isJsonObject(value)) return null;
  if (
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    value.title.length > 128 ||
    typeof value.body !== "string" ||
    value.body.length === 0 ||
    value.body.length > 512 ||
    (value.paneId !== undefined &&
      (typeof value.paneId !== "string" || value.paneId.length > 128))
  ) return null;
  return {
    title: value.title,
    body: value.body,
    ...(value.paneId !== undefined ? { paneId: value.paneId } : {}),
  };
}

export function parseCreateTabBody(
  value: unknown,
): { workspaceId: string; label?: string; cwd?: string; requestId?: string } | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  if (value.label !== undefined && typeof value.label !== "string") return null;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return null;
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !MUTATION_REQUEST_ID.test(value.requestId))
  ) return null;
  return {
    workspaceId: value.workspaceId.trim(),
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  };
}

export function parseRenameTabBody(value: unknown): { label: string } | null {
  if (!isJsonObject(value) || typeof value.label !== "string") return null;
  const label = value.label.trim();
  if (!label || label.length > 128) return null;
  return { label };
}

export function parseCreateWorkspaceBody(
  value: unknown,
): { cwd: string; label?: string; requestId?: string } | null {
  if (!isJsonObject(value)) return null;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return null;
  if (value.label !== undefined && typeof value.label !== "string") return null;
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !MUTATION_REQUEST_ID.test(value.requestId))
  ) return null;
  return {
    cwd: value.cwd?.trim() || homedir(),
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  };
}

export function parseCreateWorktreeBody(
  value: unknown,
): {
  workspaceId: string;
  branch?: string;
  base?: string;
  label?: string;
  requestId?: string;
} | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  for (const key of ["branch", "base", "label"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !MUTATION_REQUEST_ID.test(value.requestId))
  ) return null;
  const optional = (key: "branch" | "base" | "label") => {
    const normalized = (value[key] as string | undefined)?.trim();
    return normalized ? { [key]: normalized } : {};
  };
  return {
    workspaceId: value.workspaceId.trim(),
    ...optional("branch"),
    ...optional("base"),
    ...optional("label"),
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  };
}

export function parseRemoveWorktreeBody(
  value: unknown,
): { force: boolean; requestId?: string } | null {
  if (!isJsonObject(value)) return null;
  if (value.force !== undefined && typeof value.force !== "boolean") return null;
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !MUTATION_REQUEST_ID.test(value.requestId))
  ) return null;
  return {
    force: value.force ?? false,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  };
}

async function replyPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: ReplyDeduplicator,
  mutations: PaneMutationQueue,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const body = parseReplyBody(raw);
  if (!body) return text("bad body", 400);
  const { text: txt, submit, requestId } = body;
  const ae = req.headers.get("accept-encoding");
  const execute = async (): Promise<ActionResponse> => {
    const outcome = await sendReplySteps(herdr, paneId, txt, submit, cfg.submitKeys);
    // Audit the operation once. Duplicates sharing a requestId return this operation's cached result.
    audit.record({
      action: "reply",
      paneId,
      session,
      device,
      detail: {
        text: txt,
        submit,
        requestId,
        submitted: replyWasSubmitted(submit, outcome),
        textDelivered: outcome.textDelivered,
      },
    });
    if (outcome.ok) return { ok: true };
    return {
      ok: false,
      error: outcome.error,
      textDelivered: outcome.textDelivered,
      ...(outcome.deliveryAmbiguous ? { deliveryAmbiguous: true } : {}),
    };
  };
  const queuedExecute = () => mutations.run(`${session}\n${paneId}`, execute);
  const result = requestId
    ? await deduplicator.run(
        `${session}\n${paneId}\n${requestId}`,
        JSON.stringify([txt, submit]),
        queuedExecute,
      )
    : await queuedExecute();
  return json(result, ae);
}

async function keysPane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  mutations: PaneMutationQueue,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const keys = parseKeysBody(raw);
  if (!keys) return text("no keys", 400);
  const ae = req.headers.get("accept-encoding");
  try {
    await mutations.run(`${session}\n${paneId}`, () => herdr.sendPaneKeys(paneId, keys));
    audit.record({ action: "keys", paneId, session, device, detail: { keys, outcome: "confirmed" } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: { keys, outcome: "failed-or-ambiguous", error: (err as Error).message },
    });
    return json(mutationFailureResponse(err, "terminal key") satisfies ActionResponse, ae);
  }
}

async function inputPane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  mutations: PaneMutationQueue,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const data = parseInputBody(raw);
  if (data === null) return text("bad terminal input", 400);
  const ae = req.headers.get("accept-encoding");
  try {
    await mutations.run(`${session}\n${paneId}`, () => herdr.sendPaneInput(paneId, data));
    audit.record({
      action: "pane.input",
      paneId,
      session,
      device,
      detail: { bytes: new TextEncoder().encode(data).length, outcome: "confirmed" },
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "pane.input",
      paneId,
      session,
      device,
      detail: { bytes: new TextEncoder().encode(data).length, outcome: "failed-or-ambiguous" },
    });
    return json(mutationFailureResponse(err, "terminal input") satisfies ActionResponse, ae);
  }
}

async function closeScope(
  herdr: HerdrClient,
  engine: StateEngine,
  scope: { readonly tabId?: string; readonly workspaceId?: string },
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: ActionDeduplicator,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  if (
    !isJsonObject(raw) ||
    typeof raw.requestId !== "string" ||
    !MUTATION_REQUEST_ID.test(raw.requestId)
  ) {
    return text("invalid requestId", 400);
  }
  const paneIds = closeScopePaneIds(engine.current(), scope);
  const action = scope.tabId ? "tab.close" : "workspace.close";
  const result = await deduplicator.run(
    `${session}\n${raw.requestId}`,
    JSON.stringify({ action, ...scope }),
    async () => {
      try {
        await Promise.all(paneIds.map((paneId) => herdr.closePane(paneId)));
        audit.record({
          action,
          session,
          device,
          detail: { ...scope, paneCount: paneIds.length, outcome: "confirmed" },
        });
        return { ok: true } satisfies ActionResponse;
      } catch (err) {
        audit.record({
          action,
          session,
          device,
          detail: {
            ...scope,
            outcome: "failed-or-ambiguous",
            error: (err as Error).message,
          },
        });
        return mutationFailureResponse(err, action);
      }
    },
  );
  return json(result, req.headers.get("accept-encoding"));
}

export function closeScopePaneIds(
  snapshot: Pick<SnapshotResponse, "agents" | "shellPanes">,
  scope: { readonly tabId?: string; readonly workspaceId?: string },
): string[] {
  return [...snapshot.agents, ...snapshot.shellPanes]
    .filter((pane) => pane.tabId === scope.tabId || pane.workspaceId === scope.workspaceId)
    .map((pane) => pane.paneId);
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  mutations: PaneMutationQueue,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await mutations.run(`${session}\n${paneId}`, () => herdr.closePane(paneId));
    audit.record({ action: "pane.close", paneId, session, device, detail: { outcome: "confirmed" } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "pane.close",
      paneId,
      session,
      device,
      detail: { outcome: "failed-or-ambiguous", error: (err as Error).message },
    });
    return json(mutationFailureResponse(err, "pane close") satisfies ActionResponse, ae);
  }
}

async function focusPane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.focusPane(paneId);
    audit.record({ action: "pane.focus", paneId, session, device, detail: { outcome: "confirmed" } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "pane.focus",
      paneId,
      session,
      device,
      detail: { outcome: "failed-or-ambiguous", error: (err as Error).message },
    });
    return json(mutationFailureResponse(err, "pane focus") satisfies ActionResponse, ae);
  }
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
async function createTab(
  herdr: HerdrClient,
  engine: StateEngine,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: CreateDeduplicator,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const body = parseCreateTabBody(raw);
  if (!body) return json({ ok: false, error: "invalid tab request" } satisfies CreateResponse, ae);
  const { workspaceId } = body;
  const execute = async (): Promise<CreateResponse> => {
    try {
      const created = await herdr.createTab(workspaceId, { label: body.label, cwd: body.cwd });
      const label =
        engine.current().workspaces.find((w) => w.workspaceId === created.workspaceId)?.label ??
        created.workspaceId;
      audit.record({
        action: "tab.create",
        paneId: created.paneId,
        session,
        device,
        detail: { workspaceId, label: body.label, cwd: body.cwd, outcome: "confirmed" },
      });
      return { ok: true, pane: { ...created, workspaceLabel: label } };
    } catch (err) {
      audit.record({
        action: "tab.create",
        session,
        device,
        detail: {
          workspaceId,
          label: body.label,
          cwd: body.cwd,
          outcome: "failed-or-ambiguous",
          error: (err as Error).message,
        },
      });
      return mutationFailureResponse(err, "tab creation");
    }
  };
  const result = body.requestId
    ? await deduplicator.run(
      `${session}\n${body.requestId}`,
      JSON.stringify({ action: "tab", workspaceId, label: body.label, cwd: body.cwd }),
      execute,
    )
    : await execute();
  return json(result, ae);
}

async function renameTab(
  herdr: HerdrClient,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const body = parseRenameTabBody(raw);
  if (!body) return json({ ok: false, error: "invalid tab rename request" } satisfies ActionResponse, ae);
  try {
    await herdr.renameTab(tabId, body.label);
    audit.record({
      action: "tab.rename",
      session,
      device,
      detail: { tabId, label: body.label, outcome: "confirmed" },
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "tab.rename",
      session,
      device,
      detail: {
        tabId,
        label: body.label,
        outcome: "failed-or-ambiguous",
        error: (err as Error).message,
      },
    });
    return json(mutationFailureResponse(err, "tab rename") satisfies ActionResponse, ae);
  }
}

// Create a new workspace ("space") with a fresh shell pane. `cwd` defaults to the user's home dir
// when the client doesn't specify one (typing a path on a phone is painful) — it's a shell, so you
// can cd from there. Same structural-only threat model as createTab.
async function createWorkspace(
  herdr: HerdrClient,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: CreateDeduplicator,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const body = parseCreateWorkspaceBody(raw);
  if (!body) return json({ ok: false, error: "invalid workspace request" } satisfies CreateResponse, ae);
  const { cwd } = body;
  const execute = async (): Promise<CreateResponse> => {
    try {
      const created = await herdr.createWorkspace({ cwd, label: body.label });
      audit.record({
        action: "workspace.create",
        paneId: created.paneId,
        session,
        device,
        detail: { label: body.label, cwd, outcome: "confirmed" },
      });
      return {
        ok: true,
        pane: {
          paneId: created.paneId,
          workspaceId: created.workspaceId,
          workspaceLabel: created.workspaceLabel ?? created.workspaceId,
          tabId: created.tabId,
          cwd: created.cwd,
        },
      };
    } catch (err) {
      audit.record({
        action: "workspace.create",
        session,
        device,
        detail: {
          label: body.label,
          cwd,
          outcome: "failed-or-ambiguous",
          error: (err as Error).message,
        },
      });
      return mutationFailureResponse(err, "workspace creation");
    }
  };
  const result = body.requestId
    ? await deduplicator.run(
      `${session}\n${body.requestId}`,
      JSON.stringify({ action: "workspace", label: body.label, cwd }),
      execute,
    )
    : await execute();
  return json(result, ae);
}

async function createWorktree(
  herdr: HerdrClient,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: WorktreeCreateDeduplicator,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const body = parseCreateWorktreeBody(raw);
  if (!body) {
    return json(
      { ok: false, error: "invalid worktree request" } satisfies WorktreeCreateResponse,
      ae,
    );
  }
  const execute = async (): Promise<WorktreeCreateResponse> => {
    try {
      const created = await herdr.createWorktree(body);
      audit.record({
        action: "worktree.create",
        paneId: created.paneId,
        session,
        device,
        detail: {
          workspaceId: body.workspaceId,
          branch: body.branch,
          base: body.base,
          label: body.label,
          outcome: "confirmed",
        },
      });
      return {
        ok: true,
        workspace: created.workspace,
        tab: created.tab,
        pane: {
          paneId: created.paneId,
          workspaceId: created.workspaceId,
          workspaceLabel: created.workspaceLabel ?? created.workspaceId,
          tabId: created.tabId,
          cwd: created.cwd,
        },
      };
    } catch (err) {
      audit.record({
        action: "worktree.create",
        session,
        device,
        detail: {
          workspaceId: body.workspaceId,
          branch: body.branch,
          base: body.base,
          label: body.label,
          outcome: "failed-or-ambiguous",
          error: (err as Error).message,
        },
      });
      return mutationFailureResponse(err, "worktree creation");
    }
  };
  const result = body.requestId
    ? await deduplicator.run(
        `${session}\n${body.requestId}`,
        JSON.stringify({
          action: "worktree.create",
          workspaceId: body.workspaceId,
          branch: body.branch,
          base: body.base,
          label: body.label,
        }),
        execute,
      )
    : await execute();
  return json(result, ae);
}

async function removeWorktree(
  herdr: HerdrClient,
  workspaceId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
  deduplicator: ActionDeduplicator,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const body = parseRemoveWorktreeBody(raw);
  if (!body) return json({ ok: false, error: "invalid worktree removal" } satisfies ActionResponse, ae);
  const execute = async (): Promise<ActionResponse> => {
    try {
      await herdr.removeWorktree(workspaceId, body.force);
      audit.record({
        action: "worktree.remove",
        session,
        device,
        detail: { workspaceId, force: body.force, outcome: "confirmed" },
      });
      return { ok: true };
    } catch (err) {
      audit.record({
        action: "worktree.remove",
        session,
        device,
        detail: {
          workspaceId,
          force: body.force,
          outcome: "failed-or-ambiguous",
          error: (err as Error).message,
        },
      });
      return mutationFailureResponse(err, "worktree removal");
    }
  };
  const result = body.requestId
    ? await deduplicator.run(
        `${session}\n${body.requestId}`,
        JSON.stringify({ action: "worktree.remove", workspaceId, force: body.force }),
        execute,
      )
    : await execute();
  return json(result, ae);
}

// Save an uploaded image to a host file and return its absolute path. The client then references
// that path in a message; Claude Code / Codex read images by path (the terminal can't take a
// pasted image over the socket). Validated by MIME and size; the filename is server-generated.
async function uploadPane(
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  // Reject an oversize upload by its declared Content-Length BEFORE buffering — req.formData()
  // reads the whole body into memory first, so a 100 MB "image" would be materialised just to fail
  // the size check below. Multipart adds a boundary + part headers, so allow a small slack.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD) {
    return secure(
      new Response(
        JSON.stringify({
          ok: false,
          error: "image too large (max 10 MB)",
        } satisfies UploadResponse),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "no file" } satisfies UploadResponse, ae);
  }
  const ext = IMAGE_EXT[file.type];
  if (!ext) {
    return json({ ok: false, error: `unsupported type: ${file.type || "unknown"}` } satisfies UploadResponse, ae);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "image too large (max 10 MB)" } satisfies UploadResponse, ae);
  }
  try {
    const dir = join(cfg.stateDir, "uploads");
    // 0700 — uploads (and the state dir they live under) may hold sensitive images; keep them
    // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
    await ensurePrivateDirectory(dir);
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await writePrivateFile(fullPath, new Uint8Array(await file.arrayBuffer()));
    audit.record({
      action: "upload",
      paneId,
      session,
      device,
      detail: { filename: file.name, size: file.size, saved: filename },
    });
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse, ae);
  }
}

/**
 * Access gate for the API:
 *  - Host allowlist (mandatory for non-loopback): a loopback Host is trusted only when the server
 *    itself binds loopback; otherwise the Host must be in COLLIE_PUBLIC_HOSTS or an allowed origin.
 *    This runs BEFORE Origin checks and defeats DNS rebinding.
 *  - Same-origin only (Origin host must equal Host) — defeats cross-site requests/CSRF. Browsers
 *    omit Origin on same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *    localhost and explicitly-configured origins are also allowed.
 *  - Origin required for browser writes. Native clients instead send `X-Herdr-Client:
 *    herdr-mobile-v1`, a non-simple header that cross-origin browsers cannot deliver without a CORS
 *    preflight (which this bridge never grants).
 *  - Reverse-proxy provenance: forwarding/Tailscale headers prevent a forged loopback Host from
 *    receiving direct-on-host exemptions.
 *  - Required remote identity: every non-loopback request needs a configured trusted user and the
 *    matching proxy-injected identity header. Loopback callers remain available without one.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
  level: "read" | "write" = "read",
): { ok: true } | { ok: false; reason: string } {
  const host = effectiveRequestHost(req);
  // Deliberate threat boundary: Herdr Control is an owner-scoped, single-user workstation service.
  // TCP loopback is not an OS-user authentication mechanism; multi-user hosts need an isolating VM
  // or user namespace rather than treating this local-operator exemption as cross-user security.
  const trustedLoopback = isDirectLoopbackRequest(req, cfg);

  // A reverse proxy reaches this loopback-only server from localhost too. Its forwarding headers
  // are the provenance boundary that distinguishes that hop from a direct on-host operator; a
  // forwarded request must never gain local privileges merely by forging Host: 127.0.0.1.
  if (LOOPBACK_HOST.test(host) && !trustedLoopback) {
    return { ok: false, reason: "host not allowed" };
  }

  // Fail closed for every non-loopback Host. The launcher derives the normal Tailscale MagicDNS
  // hostname automatically; custom proxies must configure PUBLIC_HOSTS or ALLOWED_ORIGINS.
  if (!isHostAllowed(host, cfg)) {
    return { ok: false, reason: "host not allowed" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    const expectedProtocol = trustedLoopback ? "http:" : `${cfg.publicScheme}:`;
    const explicitOrigin = cfg.allowedOrigins.some((allowedOrigin) => {
      try {
        return new URL(allowedOrigin).origin === originUrl.origin;
      } catch {
        return false;
      }
    });
    const allowed =
      (originUrl.host === host && originUrl.protocol === expectedProtocol) ||
      explicitOrigin;
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  } else if (
    level === "write" &&
    !trustedLoopback &&
    req.headers.get(NATIVE_CLIENT_HEADER) !== NATIVE_CLIENT_VALUE
  ) {
    // Native fetch has no browser Origin. Its explicit non-simple header is the CSRF boundary:
    // cross-origin browsers must preflight it, and this bridge never grants cross-origin CORS.
    return { ok: false, reason: "origin required" };
  }

  if (!trustedLoopback && !cfg.trustedUser) {
    return { ok: false, reason: "remote identity not configured" };
  }
  const login = req.headers.get(cfg.trustedUserHeader);
  if (!login && !trustedLoopback) {
    return { ok: false, reason: "identity required" };
  }
  if (login && cfg.trustedUser && login !== cfg.trustedUser) {
    return { ok: false, reason: "identity not trusted" };
  }
  return { ok: true };
}

/**
 * Whether a Host header is one the bridge will answer to: a loopback form while bound to loopback,
 * an explicit COLLIE_PUBLIC_HOSTS entry, or the host of a configured allowed origin. Pure + exported
 * for tests.
 */
export function isHostAllowed(host: string, cfg: Config): boolean {
  if (!host || !isLoopbackBindHost(cfg.host)) return false;
  if (isTrustedLoopbackHost(host, cfg)) return true;
  if (cfg.publicHosts.includes(host)) return true;
  return cfg.allowedOrigins.some((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
}

function isTrustedLoopbackHost(host: string, cfg: Config): boolean {
  return isLoopbackBindHost(cfg.host) && LOOPBACK_HOST.test(host);
}

function isDirectLoopbackRequest(req: Request, cfg: Config): boolean {
  if (!isTrustedLoopbackHost(req.headers.get("host") ?? "", cfg)) return false;
  return !isProxiedRequest(req);
}

function effectiveRequestHost(req: Request): string {
  const rawHost = req.headers.get("host") ?? "";
  // Forwarded host metadata is meaningful only when the immutable HTTP Host says the upstream hop
  // reached loopback. A direct request to any other Host can forge X-Forwarded-Host in browser JS.
  if (!LOOPBACK_HOST.test(rawHost)) return rawHost;
  if (!isProxiedRequest(req)) return rawHost;
  return req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() || rawHost;
}

function isProxiedRequest(req: Request): boolean {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "tailscale-user-login",
  ].some((header) => Boolean(req.headers.get(header)?.trim()));
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 */
function guard(req: Request, cfg: Config, level: "read" | "write"): Response | null {
  const gate = checkAccess(req, cfg, level);
  if (!gate.ok) return text(gate.reason, 403);
  if (level === "write" && !deviceAuth(req, cfg).authorized) {
    return text("device not authorised", 403);
  }
  return null;
}

/**
 * Optional per-device authorisation, layered on top of {@link checkAccess}. Off by default; enabled
 * by setting COLLIE_DEVICE_HEADER to the header a trusted upstream proxy injects, carrying an opaque
 * device identifier. The header is trusted only because the bridge binds loopback behind the proxy,
 * so a direct client can't forge it (the same trust basis as the Tailscale identity header). Matrix:
 *
 *   - feature off (no header configured) → not enforced, fully authorised (today's behaviour).
 *   - header absent on direct loopback   → authorised on-host operator.
 *   - header absent on a forwarded hop   → read-only, even with a forged loopback Host.
 *   - header absent on a public Host     → read-only; a proxy omission must fail closed.
 *   - header present, value allowlisted  → authorised; the session is attributed to that device.
 *   - header present, value not listed   → read-only. The "unknown" sentinel is never authorised,
 *                                          and an empty allowlist makes every device read-only — a
 *                                          fail-closed default for a security toggle you turned on.
 */
export function deviceAuth(req: Request, cfg: Config): DeviceAuth {
  if (!cfg.deviceHeader) return { enforced: false, device: null, authorized: true };
  const raw = req.headers.get(cfg.deviceHeader);
  const device = raw?.trim() ? raw.trim() : null;
  if (!isLoopbackBindHost(cfg.host)) return { enforced: true, device, authorized: false };
  const directLoopback = isDirectLoopbackRequest(req, cfg);
  if (!device) {
    return { enforced: true, device: null, authorized: directLoopback };
  }
  // A proxy-forwarded device header is not identity by itself: clients can often supply arbitrary
  // request headers to a proxy. Remote device authorization therefore also requires the matching
  // Tailscale identity configured by the operator. Direct loopback remains the local-operator path.
  const proxyIdentityVerified = Boolean(
    cfg.trustedUser && req.headers.get(cfg.trustedUserHeader) === cfg.trustedUser,
  );
  const authorized =
    device !== "unknown" &&
    cfg.deviceAllowlist.includes(device) &&
    (directLoopback || proxyIdentityVerified);
  return { enforced: true, device, authorized };
}

// Apply the shared hardening headers (nosniff / no-referrer) to any response. Every response the
// bridge emits funnels through json(), text(), serveStatic(), or a handful of inline responses —
// all of which pass through here — so the headers are set exactly once, consistently.
function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(data: unknown, acceptEncoding: string | null): Response {
  return secure(gzipJsonResponse(data, acceptEncoding));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 */
function jsonError(message: string, status: number, _acceptEncoding: string | null): Response {
  return secure(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}

/**
 * Validate an untrusted /api/notifications/prefs body into a partial patch. Only the known keys are
 * considered and each, if present, must be a boolean — a non-boolean value is rejected (null return
 * → 400). Unknown keys are ignored. An empty patch is valid (a no-op that echoes current prefs).
 * Pure + exported so the validation is unit-testable without Bun.serve.
 */
export function parseNotifyPrefsPatch(v: unknown): Partial<NotifyPrefs> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const patch: Partial<NotifyPrefs> = {};
  for (const key of ["blocked", "done", "updates"] as const) {
    if (!(key in o)) continue;
    if (typeof o[key] !== "boolean") return null;
    patch[key] = o[key] as boolean;
  }
  return patch;
}

// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json).
// Surfaced via the X-Herdr-Control-Build header and /api/config so a stale cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
let buildCache: { id: string; mtime: number } | null = null;
async function buildId(): Promise<string> {
  try {
    const f = Bun.file(join(WEB_DIR, "build-info.json"));
    const mtime = f.lastModified;
    if (!buildCache || buildCache.mtime !== mtime) {
      const data = (await f.json()) as { id?: string };
      buildCache = { id: data.id ?? "unknown", mtime };
    }
    return buildCache.id;
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a request pathname to an absolute path under `webDir`, or null if it escapes. Pure +
 * exported for tests. The `full === webDir || full.startsWith(webDir + sep)` check rejects both
 * `..` traversal AND a sibling dir that merely shares the prefix (e.g. `web/dist-x` vs `web/dist`) —
 * a bare `startsWith(webDir)` would let the latter through.
 */
export function resolveStaticPath(
  pathname: string,
  webDir: string = WEB_DIR,
): { rel: string; full: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return { rel, full };
}

export async function serveStatic(pathname: string, webDir: string = WEB_DIR): Promise<Response> {
  const resolved = resolveStaticPath(pathname, webDir);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

  let file = Bun.file(full);
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (rel === "index.html") {
      return text("frontend not built — run `bun run build` in web/", 503);
    }
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(webDir, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text("frontend not built — run `bun run build` in web/", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "x-herdr-control-build": await buildId(),
  };
  if (ext === ".html") {
    headers["content-security-policy"] = CSP;
    headers["cache-control"] = "no-cache";
  } else if (rel.startsWith("assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable"; // hashed → cache hard
  }
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
  return secure(new Response(file, { headers }));
}
