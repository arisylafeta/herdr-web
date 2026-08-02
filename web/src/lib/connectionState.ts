export type TransportMode = "connecting" | "live" | "offline" | "demo";

export function demoModeFromSearch(search: string): boolean {
  return new URLSearchParams(search).get("demo") === "1";
}

export function paneLoadingAfterModeChange(mode: TransportMode, current: boolean): boolean {
  return mode === "live" ? current : false;
}

export function shouldApplySnapshot(
  requestedSession: string | undefined,
  currentSession: string | undefined,
  generation: number,
  currentGeneration: number,
): boolean {
  return requestedSession === currentSession && generation === currentGeneration;
}

export function modeAfterSnapshotFailure(): TransportMode {
  return "offline";
}

export function modeForSnapshotBridge(
  bridge: "connected" | "disconnected",
): Extract<TransportMode, "live" | "offline"> {
  return bridge === "connected" ? "live" : "offline";
}
