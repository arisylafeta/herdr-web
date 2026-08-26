import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  PaneReadResponse,
  SnapshotResponse,
  UpdateStatus,
  UploadResponse,
} from "./types";

const GET_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 20_000;
const MAX_PANE_CACHE_ENTRIES = 128;

interface PaneCacheEntry {
  etag: string;
  data: PaneReadResponse;
}

const paneCache = new Map<string, PaneCacheEntry>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function withSession(path: string, session?: string): string {
  if (!session) return path;
  return `${path}${path.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
}

/** Portable replacement for AbortSignal.any (missing on Safari before 17.4). */
export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    for (const signal of signals) signal.removeEventListener("abort", abort);
    controller.abort();
  };
  if (signals.some((signal) => signal.aborted)) abort();
  else for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const timeout = AbortSignal.timeout(method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
  const signal = init.signal ? combineAbortSignals([init.signal, timeout]) : timeout;
  const response = await fetch(path, {
    ...init,
    signal,
    headers: init.body instanceof FormData ? init.headers : { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new ApiError(`${response.status} ${detail || response.statusText}`, response.status);
  }
  return (await response.json()) as T;
}

export function fetchSnapshot(session?: string, signal?: AbortSignal): Promise<SnapshotResponse> {
  return request(withSession("/api/snapshot", session), { signal });
}

export async function fetchPane(
  paneId: string,
  session?: string,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const key = `${session ?? ""}\n${paneId}`;
  const cached = paneCache.get(key);
  const timeout = AbortSignal.timeout(GET_TIMEOUT_MS);
  const response = await fetch(withSession(`/api/pane/${encodeURIComponent(paneId)}`, session), {
    signal: signal ? combineAbortSignals([signal, timeout]) : timeout,
    headers: cached ? { "if-none-match": cached.etag } : undefined,
  });
  if (response.status === 304) {
    if (!cached) throw new ApiError("304 pane cache miss", 304);
    return { ...cached.data, notModified: true };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new ApiError(`${response.status} ${detail || response.statusText}`, response.status);
  }
  const data = (await response.json()) as PaneReadResponse;
  const etag = response.headers.get("etag");
  if (etag) {
    paneCache.delete(key);
    paneCache.set(key, { etag, data });
    if (paneCache.size > MAX_PANE_CACHE_ENTRIES) {
      const oldest = paneCache.keys().next().value as string | undefined;
      if (oldest !== undefined) paneCache.delete(oldest);
    }
  }
  return data;
}

export function clearPaneReadCache(): void {
  paneCache.clear();
}

export function sendReply(
  paneId: string,
  text: string,
  requestId: string,
  session?: string,
): Promise<ActionResponse> {
  return request(withSession(`/api/pane/${encodeURIComponent(paneId)}/reply`, session), {
    method: "POST",
    body: JSON.stringify({ text, submit: true, requestId }),
  });
}

export function sendKeys(
  paneId: string,
  keys: string[],
  session?: string,
): Promise<ActionResponse> {
  return request(withSession(`/api/pane/${encodeURIComponent(paneId)}/keys`, session), {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
}

export function closePane(paneId: string, session?: string): Promise<ActionResponse> {
  return request(withSession(`/api/pane/${encodeURIComponent(paneId)}/close`, session), {
    method: "POST",
  });
}

export function createTab(
  workspaceId: string,
  label: string,
  requestId: string,
  session?: string,
): Promise<CreateResponse> {
  return request(withSession("/api/tab", session), {
    method: "POST",
    body: JSON.stringify({ workspaceId, label: label || undefined, requestId }),
  });
}

export function createWorkspace(
  input: { label: string; cwd: string },
  requestId: string,
  session?: string,
): Promise<CreateResponse> {
  return request(withSession("/api/workspace", session), {
    method: "POST",
    body: JSON.stringify({ label: input.label || undefined, cwd: input.cwd || undefined, requestId }),
  });
}

export async function uploadImage(
  paneId: string,
  file: File,
  session?: string,
): Promise<UploadResponse> {
  const data = new FormData();
  data.append("file", file);
  const response = await fetch(withSession(`/api/pane/${encodeURIComponent(paneId)}/upload`, session), {
    method: "POST",
    body: data,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new ApiError(await response.text(), response.status);
  return (await response.json()) as UploadResponse;
}

export function fetchConfig(): Promise<BridgeConfig> {
  return request("/api/config");
}

export function checkForUpdates(): Promise<UpdateStatus> {
  return request("/api/update/check", { method: "POST" });
}

export function sendPushTest(): Promise<{ ok: true; subscribers: number }> {
  return request("/api/push-test", {
    method: "POST",
    body: JSON.stringify({
      title: "Herdr Web test",
      body: "Push notifications are working on this device.",
    }),
  });
}

export async function registerPushSubscription(subscription: PushSubscription): Promise<void> {
  const response = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
    signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
  });
  if (!response.ok) throw new ApiError(await response.text(), response.status);
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  const response = await fetch("/api/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
    signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
  });
  if (!response.ok) throw new ApiError(await response.text(), response.status);
}
