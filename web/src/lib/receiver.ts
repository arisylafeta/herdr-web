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

export interface BridgeProfile {
  /** Stable browser-local identity used in deep links and cache keys. */
  id: string;
  /** Human-readable machine name. */
  label: string;
  /** Exact HTTP(S) origin of the host-local Herdr Web bridge. */
  baseUrl: string;
  /** Built-in deployment default. It is always present and cannot be removed. */
  builtIn?: boolean;
}

interface PaneCacheEntry {
  etag: string;
  data: PaneReadResponse;
}

export type FetchAdapter = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
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

/**
 * The browser-side receiver for exactly one host bridge. React and other callers never construct
 * URLs, own validators, or remember which requests are global versus Herdr-session scoped.
 */
export class BridgeReceiver {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  private readonly paneCache = new Map<string, PaneCacheEntry>();

  constructor(
    readonly profile: BridgeProfile,
    private readonly fetchAdapter: FetchAdapter = globalThis.fetch.bind(globalThis),
  ) {
    this.id = profile.id;
    this.label = profile.label;
    this.baseUrl = normalizeBridgeUrl(profile.baseUrl);
  }

  async snapshot(session?: string, signal?: AbortSignal): Promise<SnapshotResponse> {
    return await this.request(this.withSession("/api/snapshot", session), { signal });
  }

  async pane(
    paneId: string,
    session?: string,
    signal?: AbortSignal,
  ): Promise<PaneReadResponse> {
    const key = `${session ?? ""}\n${paneId}`;
    const cached = this.paneCache.get(key);
    const timeout = AbortSignal.timeout(GET_TIMEOUT_MS);
    const response = await this.fetchAdapter(
      this.endpoint(this.withSession(`/api/pane/${encodeURIComponent(paneId)}`, session)),
      {
        signal: signal ? combineAbortSignals([signal, timeout]) : timeout,
        headers: cached ? { "if-none-match": cached.etag } : undefined,
      },
    );
    if (response.status === 304) {
      if (!cached) throw new ApiError("304 pane cache miss", 304);
      return { ...cached.data, notModified: true };
    }
    if (!response.ok) throw new ApiError(await responseDetail(response), response.status);
    const data = (await response.json()) as PaneReadResponse;
    const etag = response.headers.get("etag");
    if (etag) {
      this.paneCache.delete(key);
      this.paneCache.set(key, { etag, data });
      if (this.paneCache.size > MAX_PANE_CACHE_ENTRIES) {
        const oldest = this.paneCache.keys().next().value as string | undefined;
        if (oldest !== undefined) this.paneCache.delete(oldest);
      }
    }
    return data;
  }

  clearPaneCache(): void {
    this.paneCache.clear();
  }

  async reply(
    paneId: string,
    text: string,
    requestId: string,
    session?: string,
  ): Promise<ActionResponse> {
    return await this.request(
      this.withSession(`/api/pane/${encodeURIComponent(paneId)}/reply`, session),
      {
        method: "POST",
        body: JSON.stringify({ text, submit: true, requestId }),
      },
    );
  }

  async keys(paneId: string, keys: string[], session?: string): Promise<ActionResponse> {
    return await this.request(
      this.withSession(`/api/pane/${encodeURIComponent(paneId)}/keys`, session),
      { method: "POST", body: JSON.stringify({ keys }) },
    );
  }

  async markPaneSeen(paneId: string, session?: string): Promise<ActionResponse> {
    return await this.request(
      this.withSession(`/api/pane/${encodeURIComponent(paneId)}/seen`, session),
      { method: "POST" },
    );
  }

  async closePane(paneId: string, session?: string): Promise<ActionResponse> {
    return await this.request(
      this.withSession(`/api/pane/${encodeURIComponent(paneId)}/close`, session),
      { method: "POST" },
    );
  }

  async createTab(
    workspaceId: string,
    label: string,
    requestId: string,
    session?: string,
  ): Promise<CreateResponse> {
    return await this.request(this.withSession("/api/tab", session), {
      method: "POST",
      body: JSON.stringify({ workspaceId, label: label || undefined, requestId }),
    });
  }

  async createWorkspace(
    input: { label: string; cwd: string },
    requestId: string,
    session?: string,
  ): Promise<CreateResponse> {
    return await this.request(this.withSession("/api/workspace", session), {
      method: "POST",
      body: JSON.stringify({
        label: input.label || undefined,
        cwd: input.cwd || undefined,
        requestId,
      }),
    });
  }

  async uploadImage(paneId: string, file: File, session?: string): Promise<UploadResponse> {
    const data = new FormData();
    data.append("file", file);
    const response = await this.fetchAdapter(
      this.endpoint(this.withSession(`/api/pane/${encodeURIComponent(paneId)}/upload`, session)),
      { method: "POST", body: data, signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new ApiError(await responseDetail(response), response.status);
    return (await response.json()) as UploadResponse;
  }

  async config(): Promise<BridgeConfig> {
    return await this.request("/api/config");
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    return await this.request("/api/update/check", { method: "POST" });
  }

  async sendPushTest(): Promise<{ ok: true; subscribers: number }> {
    return await this.request("/api/push-test", {
      method: "POST",
      body: JSON.stringify({
        title: "Herdr Web test",
        body: "Push notifications are working on this device.",
      }),
    });
  }

  async registerPushSubscription(subscription: PushSubscription): Promise<void> {
    await this.request("/api/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription),
    });
  }

  async unregisterPushSubscription(endpoint: string): Promise<void> {
    const response = await this.fetchAdapter(this.endpoint("/api/subscribe"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
      signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
    });
    if (!response.ok) throw new ApiError(await responseDetail(response), response.status);
  }

  private endpoint(path: string): string {
    return new URL(path, `${this.baseUrl}/`).href;
  }

  private withSession(path: string, session?: string): string {
    if (!session) return path;
    return `${path}${path.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method?.toUpperCase() ?? "GET";
    const timeout = AbortSignal.timeout(method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
    const signal = init.signal ? combineAbortSignals([init.signal, timeout]) : timeout;
    const response = await this.fetchAdapter(this.endpoint(path), {
      ...init,
      signal,
      headers:
        init.body === undefined || init.body instanceof FormData
          ? init.headers
          : { "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new ApiError(await responseDetail(response), response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export function normalizeBridgeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a complete bridge URL, including https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Bridge URLs must use https:// or http://");
  }
  if (url.username || url.password) throw new Error("Bridge URLs cannot contain credentials");
  return url.origin;
}

async function responseDetail(response: Response): Promise<string> {
  const detail = await response.text().catch(() => response.statusText);
  return `${response.status} ${detail || response.statusText}`;
}
