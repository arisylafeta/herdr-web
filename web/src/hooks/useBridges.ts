import { useCallback, useMemo, useState } from "react";
import {
  createBridgeProfile,
  DEFAULT_BRIDGE_ID,
  loadBridgeProfiles,
  saveBridgeProfiles,
} from "../lib/bridges";
import { BridgeReceiver, type BridgeProfile } from "../lib/receiver";

function initialBridgeId(profiles: BridgeProfile[]): string {
  const requested = new URLSearchParams(window.location.search).get("bridge");
  return profiles.some((profile) => profile.id === requested) ? requested! : DEFAULT_BRIDGE_ID;
}

function nextBridgeId(): string {
  return window.crypto.randomUUID();
}

export function useBridges() {
  const [profiles, setProfiles] = useState<BridgeProfile[]>(() => loadBridgeProfiles());
  const [activeId, setActiveId] = useState(() => initialBridgeId(profiles));
  const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0]!;
  const receiver = useMemo(
    () => new BridgeReceiver(active),
    [active.baseUrl, active.id, active.label],
  );
  const defaultProfile = profiles[0]!;
  const defaultReceiver = useMemo(
    () => new BridgeReceiver(defaultProfile),
    [defaultProfile.baseUrl, defaultProfile.id, defaultProfile.label],
  );

  const select = useCallback((id: string) => {
    if (!profiles.some((profile) => profile.id === id)) return;
    setActiveId(id);
    const url = new URL(window.location.href);
    if (id === DEFAULT_BRIDGE_ID) url.searchParams.delete("bridge");
    else url.searchParams.set("bridge", id);
    url.searchParams.delete("session");
    url.searchParams.delete("pane");
    window.history.replaceState(null, "", url);
  }, [profiles]);

  const add = useCallback((label: string, baseUrl: string): { ok: true } | { ok: false; error: string } => {
    try {
      const profile = createBridgeProfile(nextBridgeId(), label, baseUrl);
      if (profiles.some((candidate) => candidate.baseUrl === profile.baseUrl)) {
        return { ok: false, error: "That bridge is already configured." };
      }
      const next = [...profiles, profile];
      saveBridgeProfiles(next);
      setProfiles(next);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid bridge" };
    }
  }, [profiles]);

  const remove = useCallback((id: string) => {
    if (id === DEFAULT_BRIDGE_ID) return;
    const next = profiles.filter((profile) => profile.id !== id);
    saveBridgeProfiles(next);
    setProfiles(next);
    if (activeId === id) {
      setActiveId(DEFAULT_BRIDGE_ID);
      const url = new URL(window.location.href);
      url.searchParams.delete("bridge");
      url.searchParams.delete("session");
      url.searchParams.delete("pane");
      window.history.replaceState(null, "", url);
    }
  }, [activeId, profiles]);

  return { profiles, active, activeId, receiver, defaultReceiver, select, add, remove };
}
