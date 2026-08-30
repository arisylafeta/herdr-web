import type { BridgeReceiver } from "./receiver";
import type { BridgeConfig } from "./types";

const PREF_KEY = "herdr-control:push-disabled";

export type PushAvailability = "unsupported" | "insecure" | "server-off" | "denied" | "ready";
export interface PushState {
  availability: PushAvailability;
  /** Confirmed registered with the bridge during this status check. */
  subscribed: boolean;
  /** Present in this browser even if bridge registration needs repair or authorization. */
  localSubscribed: boolean;
  userDisabled: boolean;
}
export interface EnableResult {
  ok: boolean;
  reason?: Exclude<PushAvailability, "ready">;
}

export function isPushDisabledByUser(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function setUserDisabled(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(PREF_KEY, "1");
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // Storage may be unavailable in private contexts.
  }
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) output[index] = raw.charCodeAt(index);
  return output;
}

function keysMatch(existing: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!existing) return false;
  const current = new Uint8Array(existing);
  return current.length === serverKey.length && current.every((value, index) => value === serverKey[index]);
}

export async function enablePush(
  receiver: BridgeReceiver,
  requestPermission = true,
): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  const registration = await navigator.serviceWorker.register("/sw.js");
  const config = await receiver.config();
  if (!config.push || !config.vapidPublicKey) return { ok: false, reason: "server-off" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission !== "granted") {
    if (!requestPermission) return { ok: false, reason: "denied" };
    if ((await Notification.requestPermission()) !== "granted") return { ok: false, reason: "denied" };
  }

  const serverKey = urlB64ToUint8Array(config.vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  let createdSubscription = false;
  if (subscription && !keysMatch(subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey,
    });
    createdSubscription = true;
  }
  try {
    await receiver.registerPushSubscription(subscription);
  } catch (error) {
    // A local subscription is not useful until the bridge accepts it. Roll back only subscriptions
    // created by this attempt; a transient re-registration failure must not discard an older one.
    if (createdSubscription) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  setUserDisabled(false);
  return { ok: true };
}

export async function disablePush(receiver: BridgeReceiver): Promise<void> {
  if (!pushSupported()) {
    setUserDisabled(true);
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    setUserDisabled(true);
    return;
  }

  let bridgeRemoved = false;
  let localRemoved = false;
  try {
    await receiver.unregisterPushSubscription(subscription.endpoint);
    bridgeRemoved = true;
  } catch {
    // Local unsubscribe still invalidates the endpoint; the bridge prunes its stale entry on 410.
  }
  try {
    localRemoved = await subscription.unsubscribe();
  } catch {
    // Server deletion may already have removed every outbound path.
  }
  if (!bridgeRemoved && !localRemoved) {
    throw new Error("Could not disable push notifications; cleanup will be retried next time.");
  }
  setUserDisabled(true);
}

export async function getPushState(
  receiver: BridgeReceiver,
): Promise<PushState> {
  const userDisabled = isPushDisabledByUser();
  if (!pushSupported()) {
    return { availability: "unsupported", subscribed: false, localSubscribed: false, userDisabled };
  }
  if (!window.isSecureContext) {
    return { availability: "insecure", subscribed: false, localSubscribed: false, userDisabled };
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  const localSubscribed = Boolean(subscription);
  if (Notification.permission === "denied") {
    return { availability: "denied", subscribed: false, localSubscribed, userDisabled };
  }
  let config: BridgeConfig;
  try {
    config = await receiver.config();
  } catch {
    config = { push: false, vapidPublicKey: "" };
  }
  if (!config.push || !config.vapidPublicKey) {
    return { availability: "server-off", subscribed: false, localSubscribed, userDisabled };
  }
  let subscribed = false;
  if (subscription && !userDisabled) {
    const serverKey = urlB64ToUint8Array(config.vapidPublicKey);
    if (keysMatch(subscription.options.applicationServerKey, serverKey)) {
      try {
        await receiver.registerPushSubscription(subscription);
        subscribed = true;
      } catch {
        // Keep the local state visible so a revoked/read-only device can still use DELETE to clean
        // up its subscription. It must not be labelled enabled until registration succeeds.
      }
    }
  }
  return { availability: "ready", subscribed, localSubscribed, userDisabled };
}
