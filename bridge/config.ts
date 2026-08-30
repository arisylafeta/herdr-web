import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_READ_LINES = 10_000;
const DEFAULT_TRUSTED_USER_HEADER = "tailscale-user-login";
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// All bridge configuration, resolved once at startup. Env-driven so the systemd unit and the
// plugin launcher can configure it without code changes. Defaults are safe for a single-user,
// tailnet-only deployment.

/**
 * Read an integer env var, falling back to `fallback` (with one warning line) on anything invalid:
 * an empty/unset value, non-integer garbage (`parseInt("123abc")` used to sneak `123` through — a
 * strict regex rejects it), or a value outside the optional `[min, max]` bounds. Keeping bad config
 * from silently becoming a nonsense number (a negative poll interval, port 0) is the whole point.
 */
function envInt(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    console.warn(`[config] ${name}="${raw}" is not an integer — using default ${fallback}`);
    return fallback;
  }
  const n = Number(trimmed);
  const { min, max } = opts;
  if (!Number.isSafeInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    console.warn(`[config] ${name}=${n} is out of the allowed range — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function trustedUserHeader(): string {
  const raw = process.env.COLLIE_TRUSTED_USER_HEADER;
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) return DEFAULT_TRUSTED_USER_HEADER;
  if (HTTP_HEADER_NAME.test(value)) return value;
  console.warn(
    `[config] COLLIE_TRUSTED_USER_HEADER=${JSON.stringify(raw)} is not a valid HTTP header name — using ${DEFAULT_TRUSTED_USER_HEADER}`,
  );
  return DEFAULT_TRUSTED_USER_HEADER;
}

function deviceHeader(): string {
  const raw = process.env.COLLIE_DEVICE_HEADER;
  const value = raw?.trim() ?? "";
  if (!value || HTTP_HEADER_NAME.test(value)) return value;
  const fallback = "x-herdr-invalid-device-header";
  console.warn(
    `[config] COLLIE_DEVICE_HEADER=${JSON.stringify(raw)} is not a valid HTTP header name — using fail-closed ${fallback}`,
  );
  return fallback;
}

export function isLoopbackBindHost(host: string): boolean {
  // The launcher readiness probe and Tailscale shorthand both target IPv4 loopback.
  return /^(localhost|127\.0\.0\.1)$/.test(host);
}

/**
 * Read a boolean env var. Empty/unset → `fallback`. `off`/`0`/`false`/`no` → false; `on`/`1`/`true`/
 * `yes` → true (case-insensitive); anything else falls back with a warning. Used for feature toggles
 * that default on, where a typo silently flipping the feature would be surprising.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return false;
  if (["on", "1", "true", "yes"].includes(v)) return true;
  console.warn(`[config] ${name}="${raw}" is not a boolean — using default ${fallback}`);
  return fallback;
}

export interface Config {
  /** Path to Herdr's control socket. A non-Herdr-launched daemon must discover this itself. */
  socketPath: string;
  /** TCP port the bridge listens on (loopback only). `tailscale serve` proxies to it. */
  port: number;
  /**
   * Bind host. ALWAYS loopback by default — binding 0.0.0.0 would make the Tailscale identity
   * check meaningless (see ARCHITECTURE.md §6). Override only if you know exactly why.
   */
  host: string;
  /** Poll cadence for the state engine, ms. Also the fast fallback cadence when the event stream is down. */
  pollMs: number;
  /**
   * Relaxed safety-net poll cadence, ms, used while the events.subscribe stream is healthy. Events
   * poke immediate re-polls, so this interval only backstops a missed poke — a miss costs at most
   * one of these, never correctness. Falls back to {@link pollMs} the moment the stream drops.
   */
  pollIdleMs: number;
  /**
   * Debounce window before a blocked transition becomes a push, ms. An agent that resolves within
   * this window never notifies. See NotificationCoordinator. 0 = notify on the next tick.
   */
  notifyDelayMs: number;
  /** Delay before an unseen completed agent becomes a push, ms. */
  doneNotifyDelayMs: number;
  /** How many lines of scrollback to pull for the agent detail view. */
  readLines: number;
  /** Key sequence sent to submit a reply after the text (agent-dependent; see HERDR_API.md). */
  submitKeys: string[];
  /**
   * Tailscale identity gate. If set, every non-loopback request must carry a matching
   * `Tailscale-User-Login` header injected by `tailscale serve`; missing or mismatching identities
   * are rejected. Direct-loopback callers may omit it. Empty = remote API access disabled.
   */
  trustedUser: string;
  /** Header carrying the trusted proxy identity; defaults to Tailscale-User-Login. */
  trustedUserHeader: string;
  /**
   * Per-device authorisation. Name of a request header carrying an opaque device identifier,
   * injected by a trusted upstream reverse proxy. Remote authorization also requires the matching
   * {@link trustedUser} identity header; the device value alone is never trusted. Empty = off, but
   * remote access still requires the trusted-user identity above.
   * When set, devices whose header value isn't in {@link deviceAllowlist} are read-only. See
   * `deviceAuth()` in server.ts for the full matrix. The header is trusted only because the bridge
   * binds loopback behind the proxy — a direct client can't set it (same trust basis as trustedUser).
   */
  deviceHeader: string;
  /**
   * Device identifiers permitted to perform sensitive actions (typing into agent terminals,
   * structural creates). Everything else carrying the header is read-only. To revoke a device,
   * drop its value from this list and restart. Ignored when {@link deviceHeader} is empty.
   */
  deviceAllowlist: string[];
  /** Extra allowed request origins beyond localhost (e.g. your MagicDNS https origin). */
  allowedOrigins: string[];
  /**
   * Host-header allowlist (`host` or `host:port` values). Any non-loopback request must match one
   * of these or a host parsed from {@link allowedOrigins}. Empty therefore means loopback-only.
   */
  publicHosts: string[];
  /** Public proxy scheme used for same-origin checks. HTTPS by default; HTTP only in serve HTTP mode. */
  publicScheme: "http" | "https";
  /** Optional VAPID overrides. When absent, Push provisions a persistent private key pair. */
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  /** Where to persist push subscriptions and other runtime state. */
  stateDir: string;
  /** Serve the bundled PWA from this bridge. Off makes this an API-only bridge. */
  servePwa: boolean;
  /**
   * Multi-session support. When on (default), the bridge fronts every running herdr session it
   * discovers under the config root, not just {@link socketPath}, and the UI gains a session
   * switcher. Off (`off`/`0`/`false`) pins the bridge to the primary session only — no discovery,
   * exactly the pre-feature behaviour. Client-supplied session names only ever select an
   * already-discovered session; they never build a filesystem path.
   */
  multiSession: boolean;
}

export function loadConfig(): Config {
  const stateDir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    process.env.COLLIE_STATE_DIR ??
    join(homedir(), ".local", "state", "herdr-control");

  const submitKeys = envList("COLLIE_SUBMIT_KEYS");
  const requestedHost = (process.env.COLLIE_HOST ?? "127.0.0.1").trim();
  const host = isLoopbackBindHost(requestedHost) ? requestedHost : "127.0.0.1";
  if (host !== requestedHost) {
    console.warn(`[config] COLLIE_HOST=${JSON.stringify(requestedHost)} is not loopback — using 127.0.0.1`);
  }

  const port = process.env.HERDR_CONTROL_EFFECTIVE_PORT !== undefined
    ? envInt("HERDR_CONTROL_EFFECTIVE_PORT", 8787, { min: 1, max: 65535 })
    : envInt("COLLIE_PORT", 8787, { min: 1, max: 65535 });
  const publicHosts = process.env.HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS !== undefined
    ? envList("HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS")
    : envList("COLLIE_PUBLIC_HOSTS");

  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock"),
    port,
    host,
    pollMs: envInt("COLLIE_POLL_MS", 1500, { min: 250, max: 2_147_483_647 }),
    pollIdleMs: envInt("COLLIE_POLL_IDLE_MS", 12_000, { min: 1000, max: 2_147_483_647 }),
    notifyDelayMs: envInt("COLLIE_NOTIFY_DELAY_MS", 30_000, { min: 0, max: 2_147_483_647 }),
    doneNotifyDelayMs: envInt("COLLIE_DONE_NOTIFY_DELAY_MS", 600_000, { min: 0, max: 2_147_483_647 }),
    readLines: envInt("COLLIE_READ_LINES", 200, { min: 1, max: MAX_READ_LINES }),
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    trustedUser: process.env.COLLIE_TRUSTED_USER ?? "",
    trustedUserHeader: trustedUserHeader(),
    deviceHeader: deviceHeader(),
    deviceAllowlist: envList("COLLIE_DEVICE_ALLOWLIST"),
    allowedOrigins: envList("COLLIE_ALLOWED_ORIGINS"),
    publicHosts,
    publicScheme: process.env.COLLIE_SERVE_MODE?.trim().toLowerCase() === "http" ? "http" : "https",
    vapidPublic: process.env.COLLIE_VAPID_PUBLIC ?? "",
    vapidPrivate: process.env.COLLIE_VAPID_PRIVATE ?? "",
    vapidSubject: process.env.COLLIE_VAPID_SUBJECT ?? "mailto:admin@example.com",
    stateDir,
    servePwa: envBool("COLLIE_SERVE_PWA", true),
    multiSession: envBool("COLLIE_MULTI_SESSION", true),
  };
}
