import { normalizeBridgeUrl, type BridgeProfile } from "./receiver";

export const DEFAULT_BRIDGE_ID = "default";
export const BRIDGE_STORAGE_KEY = "herdr-web:bridges:v1";

interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DefaultBridgeOptions {
  /** Origin serving the PWA; used by the combined deployment. */
  pwaOrigin?: string;
  /** Optional independently-hosted bridge configured at PWA build time. */
  bridgeUrl?: string;
  label?: string;
}

function deviceLabel(baseUrl: string, label?: string): string {
  const hostname = new URL(baseUrl).hostname;
  const configured = label?.trim();
  if (configured && configured !== hostname) return configured;
  return hostname.split(".")[0] || "device";
}

export function defaultBridgeProfile(options: DefaultBridgeOptions = {}): BridgeProfile {
  const pwaOrigin = options.pwaOrigin ?? window.location.origin;
  const configuredUrl = options.bridgeUrl ?? import.meta.env.VITE_HERDR_BRIDGE_URL;
  const configuredLabel = options.label ?? import.meta.env.VITE_HERDR_BRIDGE_LABEL;
  const baseUrl = normalizeBridgeUrl(configuredUrl?.trim() || pwaOrigin);
  return {
    id: DEFAULT_BRIDGE_ID,
    label: deviceLabel(baseUrl, configuredLabel),
    baseUrl,
    builtIn: true,
  };
}

export function createBridgeProfile(
  id: string,
  label: string,
  baseUrl: string,
): BridgeProfile {
  if (!id || id === DEFAULT_BRIDGE_ID) throw new Error("Invalid bridge identity");
  const normalized = normalizeBridgeUrl(baseUrl);
  return {
    id,
    label: deviceLabel(normalized, label),
    baseUrl: normalized,
  };
}

export function loadBridgeProfiles(
  defaultProfile = defaultBridgeProfile(),
  storage: Pick<StorageAdapter, "getItem"> = window.localStorage,
): BridgeProfile[] {
  let value: unknown;
  try {
    const raw = storage.getItem(BRIDGE_STORAGE_KEY);
    value = raw ? JSON.parse(raw) : [];
  } catch {
    return [defaultProfile];
  }
  if (!Array.isArray(value)) return [defaultProfile];

  const profiles: BridgeProfile[] = [defaultProfile];
  const origins = new Set([defaultProfile.baseUrl]);
  const ids = new Set([defaultProfile.id]);
  for (const item of value) {
    if (!isStoredProfile(item) || ids.has(item.id)) continue;
    try {
      const profile = createBridgeProfile(item.id, item.label, item.baseUrl);
      if (origins.has(profile.baseUrl)) continue;
      profiles.push(profile);
      origins.add(profile.baseUrl);
      ids.add(profile.id);
    } catch {
      // Ignore malformed or obsolete entries without losing the deployment default.
    }
  }
  return profiles;
}

export function saveBridgeProfiles(
  profiles: BridgeProfile[],
  storage: Pick<StorageAdapter, "setItem"> = window.localStorage,
): void {
  const remote = profiles
    .filter((profile) => !profile.builtIn && profile.id !== DEFAULT_BRIDGE_ID)
    .map(({ id, label, baseUrl }) => ({ id, label, baseUrl }));
  storage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify(remote));
}

function isStoredProfile(value: unknown): value is Pick<BridgeProfile, "id" | "label" | "baseUrl"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.baseUrl === "string"
  );
}
