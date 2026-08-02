/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
  decidePush,
  notificationClickPath,
  preferredClientIndex,
  sameNavigationTarget,
  type PushPayload,
  visibleClientMatchesPush,
} from "./lib/push-decision";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }));
self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("push", (event: PushEvent) => event.waitUntil(handlePush(event)));

async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const decision = decidePush(
    payload,
    windows.some(
      (client) =>
        client.visibilityState === "visible" &&
        visibleClientMatchesPush(client.url, payload),
    ),
  );
  if (decision.kind === "suppress") return;
  if (decision.kind === "clear") {
    // Web Push subscriptions are userVisibleOnly. Satisfy that contract even for a retraction, then
    // immediately close the replacement tagged slot so stale agent/update alerts disappear without
    // Chromium generating a generic fallback notification or penalizing future deliveries.
    await self.registration.showNotification("Herdr Control", {
      body: "Notification resolved",
      tag: decision.tag,
      silent: true,
    });
    const notifications = await self.registration.getNotifications({ tag: decision.tag });
    for (const notification of notifications) notification.close();
    return;
  }
  const options: NotificationOptions & { renotify?: boolean } = {
    body: decision.body,
    data: { paneId: decision.paneId, session: decision.session, target: decision.target },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: decision.tag,
    renotify: decision.renotify,
    silent: decision.silent,
  };
  await self.registration.showNotification(decision.title, options);
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data as {
    paneId?: string;
    session?: string;
    target?: string;
  } | null) ?? {};
  event.waitUntil(openPath(notificationClickPath(data)));
});

async function openPath(path: string): Promise<void> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const preferred = preferredClientIndex(windows.map((client) => client.url), url);
  if (preferred >= 0) {
    const client = windows[preferred]!;
    await client.focus();
    if (!sameNavigationTarget(client.url, url)) await client.navigate(url).catch(() => null);
    return;
  }
  await self.clients.openWindow(url);
}
