import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

// Optional Web Push (VAPID). Zero hard dependency: if `web-push` isn't installed or VAPID keys
// aren't configured, push is silently disabled and the rest of the bridge works unchanged.
// Subscriptions are persisted to the state dir so they survive restarts.

export interface WebPushLibrary {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: PushSubscription,
    payload: string,
    options: SendOptions,
  ): Promise<unknown>;
}
export type WebPushLibraryLoader = () => Promise<WebPushLibrary>;
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushSubscriptionOwner =
  | { kind: "device"; device: string }
  | { kind: "local" }
  | { kind: "unrestricted" };
export type StoredPushSubscription = {
  subscription: PushSubscription;
  owner: PushSubscriptionOwner;
};
export type AddSubscriptionResult = "stored" | "disabled" | "invalid" | "full";
export type RemoveSubscriptionResult = "removed" | "not-found" | "forbidden";

const MAX_PUSH_SUBSCRIPTIONS = 64;
const PUSH_ENDPOINT_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
const WNS_PUSH_ENDPOINT_HOST = /^wns2-[a-z0-9-]+\.notify\.windows\.com$/;

export function isTrustedPushSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const subscription = value as Record<string, unknown>;
  const keys = subscription.keys;
  if (typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2_048) return false;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return false;
  const keyRecord = keys as Record<string, unknown>;
  if (
    typeof keyRecord.p256dh !== "string" ||
    typeof keyRecord.auth !== "string" ||
    keyRecord.p256dh.length > 512 ||
    keyRecord.auth.length > 512
  ) return false;
  try {
    const endpoint = new URL(subscription.endpoint);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === "" &&
      (PUSH_ENDPOINT_HOSTS.has(endpoint.hostname) ||
        WNS_PUSH_ENDPOINT_HOST.test(endpoint.hostname))
    );
  } catch {
    return false;
  }
}

function isPushSubscriptionOwner(value: unknown): value is PushSubscriptionOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  if (owner.kind === "local" || owner.kind === "unrestricted") return true;
  return owner.kind === "device" && typeof owner.device === "string" && owner.device.length > 0;
}

function isStoredPushSubscription(value: unknown): value is StoredPushSubscription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return isTrustedPushSubscription(entry.subscription) && isPushSubscriptionOwner(entry.owner);
}

// Delivery options passed to web-push on every send. Without them a message gets web-push's 4-week
// default TTL and NO collapse key, so an offline device replays every queued herd update on reconnect.
//   • `topic` is a collapse key — the push service keeps only the LATEST message per device with this
//     topic, so a reconnecting phone gets one current summary instead of a burst of stale ones. Must
//     match [A-Za-z0-9_-] and be ≤32 chars.
//   • `TTL` (seconds) bounds how long the service holds an undelivered message: 6h is long enough to
//     reach a briefly-offline phone but short enough that a day-old "needs you" doesn't resurface.
const SEND_TTL = 21_600;
const PUSH_DELIVERY_TIMEOUT_MS = 10_000;
// Update-available pushes ride their OWN collapse topic (and a longer TTL). The `topic` — NOT the
// client-side `tag` — is the push service's collapse key: sharing "collie-herd" would make an offline
// device's queued herd summary and an update push silently overwrite each other. 3-day TTL, since an
// update stays relevant far longer than a transient "needs you".
const UPDATE_SEND_OPTIONS = {
  TTL: 259_200,
  topic: "herdr-control-update",
  timeout: PUSH_DELIVERY_TIMEOUT_MS,
} as const;

/** web-push delivery options (collapse topic + TTL), derived per message from its `type`. */
export type SendOptions = { TTL: number; topic: string; timeout: number };
export interface PushDeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  pruned: number;
}

/** Stable bounded topic for one notification slot. Different Herdr sessions use different tags,
 * so their queued messages cannot overwrite each other while a device is offline. */
export function collapseTopic(tag: string | undefined): string {
  const source = tag || "herdr-control-herd";
  const safe = source.replace(/[^A-Za-z0-9_-]/g, "-");
  // Even a short normalized topic needs a source hash when replacement changed it: otherwise
  // distinct session names such as `foo.bar` and `foo-bar` collapse into one offline queue slot.
  if (safe === source && safe.length <= 32) return safe;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36);
  return `${safe.slice(0, 31 - suffix.length)}-${suffix}`;
}

/** Delivers one payload to one subscription with the given options. Injectable so the prune/log
 *  logic is testable. */
export type PushSender = (
  sub: PushSubscription,
  payload: string,
  options: SendOptions,
) => Promise<unknown>;

/**
 * A notification instruction for the service worker (see web/src/sw.ts). `type:"clear"` closes the
 * notification on `tag` instead of showing one; `type:"update"` is an update-available alert (its own
 * collapse topic; taps open Settings); otherwise the SW renders `{ title, body }` into the `tag` slot,
 * deep-links to `paneId` on tap, and re-alerts when `renotify` is set.
 */
export interface PushMessage {
  type?: "clear" | "update";
  title?: string;
  body?: string;
  /** Notification slot. Same tag replaces (rather than stacks) the previous notification. */
  tag?: string;
  paneId?: string;
  /**
   * The herdr session this alert belongs to (registry name). Threaded into the payload `data` so the
   * service worker deep-links to the right session. Absent for the primary session, whose payload
   * then stays byte-identical to the single-session case (an older cached SW keeps working).
   */
  session?: string;
  /** Where a tap should land instead of the default pane deep-link. `"settings"` for update alerts;
   *  absent = today's pane deep-link (so the agent-alert payload is unchanged). */
  target?: "settings";
  renotify?: boolean;
  /** Suppress sound/vibration even when this tag does not already exist (restart reconciliation). */
  silent?: boolean;
}

export interface PushMessageTransport {
  send(message: PushMessage): Promise<unknown>;
}

/** Ordered, fail-soft delivery for one logical notification slot. */
export class PushDeliveryQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly transport: PushMessageTransport) {}

  enqueue(message: PushMessage): void {
    this.chain = this.chain
      .then(async () => {
        await this.transport.send(message);
      })
      .catch((error) => {
        console.warn(
          `[push] queued delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export class Push {
  private lib: WebPushLibrary | null = null;
  private subs = new Map<string, StoredPushSubscription>();
  private readonly file: string;
  private readonly sender: PushSender;
  private _enabled = false;
  // Subscription mutations and their writes are one serial transaction. The live map changes only
  // after its owner-only file is durable, and a failed write cannot poison later mutations.
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: Config,
    sender?: PushSender,
    private readonly loadLibrary: WebPushLibraryLoader = async () => import("web-push"),
  ) {
    this.file = join(cfg.stateDir, "push-subscriptions.json");
    this.sender = sender ?? ((sub, payload, options) => this.lib!.sendNotification(sub, payload, options));
  }

  /** Whether push is live (VAPID keys configured and `web-push` installed). Set once in init(). */
  get enabled(): boolean {
    return this._enabled;
  }

  get publicKey(): string {
    return this.enabled ? this.cfg.vapidPublic : "";
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  async init(): Promise<void> {
    // Persistence ownership is independent of delivery availability: a client must be able to
    // durably opt out even while VAPID is absent/malformed, or the endpoint would resurrect when
    // push is configured again.
    await this.load();
    if (!this.cfg.vapidPublic || !this.cfg.vapidPrivate) {
      console.log("[push] disabled (no VAPID keys configured)");
      return;
    }
    try {
      const lib = await this.loadLibrary();
      // web-push validates the subject and key material synchronously here. Push is optional, so a
      // bad operator value must disable this feature rather than abort the entire bridge startup.
      lib.setVapidDetails(this.cfg.vapidSubject, this.cfg.vapidPublic, this.cfg.vapidPrivate);
      this.lib = lib;
    } catch (error) {
      this.lib = null;
      console.warn(
        `[push] disabled (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    this._enabled = true;
    console.log(`[push] enabled (${this.subs.size} saved subscription(s))`);
  }

  async addSubscription(
    sub: PushSubscription,
    owner: PushSubscriptionOwner,
  ): Promise<AddSubscriptionResult> {
    if (!this.enabled) return "disabled";
    if (!isTrustedPushSubscription(sub)) return "invalid";
    return this.mutateSubscriptions((next) => {
      if (!next.has(sub.endpoint) && next.size >= MAX_PUSH_SUBSCRIPTIONS) {
        return { changed: false, result: "full" as const };
      }
      next.set(sub.endpoint, { subscription: sub, owner });
      return { changed: true, result: "stored" as const };
    });
  }

  async removeSubscription(
    endpoint: string,
    actor: PushSubscriptionOwner | null,
  ): Promise<RemoveSubscriptionResult> {
    if (actor === null) return "forbidden";
    return this.mutateSubscriptions((next) => {
      const entry = next.get(endpoint);
      if (!entry) return { changed: false, result: "not-found" as const };
      const permitted =
        actor.kind === "local" ||
        actor.kind === "unrestricted" ||
        (actor.kind === "device" &&
          entry.owner.kind === "device" &&
          actor.device === entry.owner.device);
      if (!permitted) return { changed: false, result: "forbidden" as const };
      next.delete(endpoint);
      return { changed: true, result: "removed" as const };
    });
  }

  /** Send a notification instruction (render, clear, or update) to every subscribed device. */
  async send(msg: PushMessage): Promise<PushDeliverySummary> {
    // The SW reads deep-link fields from `data`. `session` is omitted for the primary (absent on the
    // message), keeping that payload identical to the pre-multi-session shape.
    const data: { paneId?: string; session?: string; target?: "settings" } = { paneId: msg.paneId };
    if (msg.session !== undefined) data.session = msg.session;
    if (msg.target !== undefined) data.target = msg.target;
    // Push-service collapse topics mirror notification tags. A clear and render for one session
    // share a topic, while different sessions remain independent in the offline queue.
    const options =
      msg.type === "update" ||
      (msg.type === "clear" && msg.tag === "herdr-control:update")
        ? UPDATE_SEND_OPTIONS
        : {
            TTL: SEND_TTL,
            topic: collapseTopic(msg.tag),
            timeout: PUSH_DELIVERY_TIMEOUT_MS,
          };
    return this.broadcast(JSON.stringify({ ...msg, data }), options);
  }

  /** Convenience for a one-off render (used by the manual push-test script). */
  async notify(
    title: string,
    body: string,
    data: { paneId?: string } = {},
  ): Promise<PushDeliverySummary> {
    return this.send({ title, body, paneId: data.paneId });
  }

  private async broadcast(
    payload: string,
    options: SendOptions,
  ): Promise<PushDeliverySummary> {
    if (!this.enabled) return { attempted: 0, succeeded: 0, failed: 0, pruned: 0 };
    // Device removal must revoke outbound delivery as well as terminal writes. Re-check the live
    // allowlist on every broadcast so a long-running process also fails closed if its Config is
    // updated in place; normal deployments load the new list on restart and prune during load().
    let pruned = 0;
    await this.mutateSubscriptions((next) => {
      let changed = false;
      for (const entry of next.values()) {
        if (this.ownerIsActive(entry.owner)) continue;
        next.delete(entry.subscription.endpoint);
        pruned++;
        changed = true;
      }
      return { changed, result: undefined };
    });
    const dead: string[] = [];
    let succeeded = 0;
    let failed = 0;
    const subscriptions = [...this.subs.values()];
    await Promise.all(
      subscriptions.map(async ({ subscription: sub }) => {
        try {
          await this.sender(sub, payload, options);
          succeeded++;
        } catch (err) {
          failed++;
          // 404/410 mean the subscription is gone — prune it. Anything else (network, 5xx) is a
          // real failure worth a log line rather than vanishing silently.
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            dead.push(sub.endpoint);
          } else {
            console.warn(
              `[push] send failed for ${sub.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );
    if (dead.length) {
      await this.mutateSubscriptions((next) => {
        let changed = false;
        for (const endpoint of dead) changed = next.delete(endpoint) || changed;
        return { changed, result: undefined };
      });
      pruned += dead.length;
    }
    return { attempted: subscriptions.length, succeeded, failed, pruned };
  }

  private async load(): Promise<void> {
    try {
      const raw = await Bun.file(this.file).json();
      if (Array.isArray(raw)) {
        const loaded = new Map<string, StoredPushSubscription>();
        let needsRewrite = false;
        for (const value of raw) {
          if (loaded.size >= MAX_PUSH_SUBSCRIPTIONS) {
            needsRewrite = true;
            break;
          }
          let entry: StoredPushSubscription | null = null;
          if (isStoredPushSubscription(value)) {
            entry = value;
          } else if (isTrustedPushSubscription(value)) {
            // Pre-ownership files are compatible while per-device auth is disabled. Once the
            // operator enables device auth they are unattributable, so discard them rather than
            // continue delivering notifications to a possibly revoked device.
            needsRewrite = true;
            if (!this.cfg.deviceHeader) {
              entry = { subscription: value, owner: { kind: "unrestricted" } };
            }
          } else {
            needsRewrite = true;
          }
          if (!entry) continue;
          if (this.ownerIsActive(entry.owner)) {
            loaded.set(entry.subscription.endpoint, entry);
          } else {
            needsRewrite = true;
          }
        }
        this.replaceSubscriptions(loaded);
        if (needsRewrite) await this.writeState(this.serializedSubscriptions(loaded));
      }
    } catch {
      /* no saved subs yet */
    }
  }

  private ownerIsActive(owner: PushSubscriptionOwner): boolean {
    if (!this.cfg.deviceHeader) return true;
    if (owner.kind === "local") return true;
    if (owner.kind === "unrestricted") return false;
    return this.cfg.deviceAllowlist.includes(owner.device);
  }

  private mutateSubscriptions<T>(
    mutate: (
      next: Map<string, StoredPushSubscription>,
    ) => { changed: boolean; result: T },
  ): Promise<T> {
    let result!: T;
    const apply = async (): Promise<void> => {
      const next = new Map(this.subs);
      const mutation = mutate(next);
      result = mutation.result;
      if (!mutation.changed) return;
      await this.writeState(this.serializedSubscriptions(next));
      this.replaceSubscriptions(next);
    };
    const run = this.mutationChain.then(apply, apply);
    this.mutationChain = run.catch(() => {});
    return run.then(() => result);
  }

  private replaceSubscriptions(next: Map<string, StoredPushSubscription>): void {
    this.subs.clear();
    for (const [endpoint, entry] of next) this.subs.set(endpoint, entry);
  }

  private serializedSubscriptions(
    subscriptions: Map<string, StoredPushSubscription>,
  ): string {
    return JSON.stringify([...subscriptions.values()], null, 2);
  }

  /** Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target. */
  private async writeState(data: string): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
