import { useState } from "react";
import type { AgentView } from "./types";

export type PaneView = "chat" | "terminal";
export function initialPaneView(transcript: boolean, saved: string | null): PaneView {
  return transcript && saved !== "terminal" ? "chat" : "terminal";
}
export function paneViewKey(bridgeId: string, session: string | undefined, paneId: string) {
  return `herdr:pane-view:${bridgeId}\n${session ?? ""}\n${paneId}`;
}
export function usePaneView(bridgeId: string, session: string | undefined, pane: AgentView | null) {
  const key = paneViewKey(bridgeId, session, pane?.paneId ?? "");
  const [preference, setPreference] = useState<{ key: string; value: PaneView } | null>(null);
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(key); } catch { /* Storage can be unavailable in private webviews. */ }
  const value = pane?.transcript && preference?.key === key ? preference.value : initialPaneView(Boolean(pane?.transcript), saved);
  const setView = (next: PaneView) => {
    setPreference({ key, value: next });
    try { sessionStorage.setItem(key, next); } catch { /* The in-memory preference still works. */ }
  };
  return { value, setView };
}
