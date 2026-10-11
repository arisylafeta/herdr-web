export interface PushPayload {
  type?: "clear";
  title?: string;
  body?: string;
  tag?: string;
  renotify?: boolean;
  silent?: boolean;
  data?: { paneId?: string; session?: string; target?: string };
}

export type PushDecision =
  | { kind: "clear"; tag: string }
  | { kind: "suppress" }
  | {
      kind: "show";
      title: string;
      body: string;
      tag: string;
      paneId?: string;
      session?: string;
      target?: string;
      renotify: boolean;
      silent: boolean;
    };

export const tagFor = (paneId?: string): string =>
  paneId ? `herdr-control:${paneId}` : "herdr-control";

export function visibleClientShowsSession(clientUrl: string, session?: string): boolean {
  try {
    const selected = new URL(clientUrl).searchParams.get("session") || undefined;
    return selected === session;
  } catch {
    return false;
  }
}

export function visibleClientMatchesPush(clientUrl: string, payload: PushPayload): boolean {
  if (payload.data?.target === "settings" && payload.data.session === undefined) return true;
  return visibleClientShowsSession(clientUrl, payload.data?.session);
}

export function notificationClickPath(data: {
  paneId?: string;
  session?: string;
  target?: string;
}): string {
  const params = new URLSearchParams();
  if (data.paneId && data.paneId !== "test") params.set("pane", data.paneId);
  if (data.session) params.set("session", data.session);
  if (data.target === "settings") params.set("settings", "1");
  const query = params.toString();
  return `/${query ? `?${query}` : ""}`;
}

const NAVIGATION_PARAMS = ["session", "pane", "settings"] as const;

/** Compare the SPA route and notification deep-link state without depending on query ordering. */
export function sameNavigationTarget(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      current.origin === target.origin &&
      current.pathname === target.pathname &&
      (current.searchParams.get("demo") === "1") ===
        (target.searchParams.get("demo") === "1") &&
      NAVIGATION_PARAMS.every(
        (parameter) => current.searchParams.get(parameter) === target.searchParams.get(parameter),
      )
    );
  } catch {
    return false;
  }
}

/** Pick the exact deep-link window first, then one already showing the target session, then any. */
export function preferredClientIndex(clientUrls: string[], targetUrl: string): number {
  const exact = clientUrls.findIndex((clientUrl) => sameNavigationTarget(clientUrl, targetUrl));
  if (exact >= 0) return exact;
  let session: string | undefined;
  try {
    session = new URL(targetUrl).searchParams.get("session") || undefined;
  } catch {
    return clientUrls.length > 0 ? 0 : -1;
  }
  const sameSession = clientUrls.findIndex((url) => visibleClientShowsSession(url, session));
  if (sameSession >= 0) return sameSession;
  return clientUrls.length > 0 ? 0 : -1;
}

export function decidePush(payload: PushPayload, _hasVisibleClient: boolean): PushDecision {
  const paneId = payload.data?.paneId;
  const session = payload.data?.session;
  const target = payload.data?.target;
  const tag = payload.tag ?? tagFor(paneId);
  if (payload.type === "clear") return { kind: "clear", tag };
  return {
    kind: "show",
    title: payload.title ?? "Herdr Web",
    body: payload.body ?? "",
    tag,
    paneId,
    session,
    target,
    renotify: payload.renotify ?? false,
    silent: payload.silent ?? false,
  };
}
