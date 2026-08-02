import { describe, expect, it } from "vitest";
import {
  demoModeFromSearch,
  modeAfterSnapshotFailure,
  modeForSnapshotBridge,
  paneLoadingAfterModeChange,
  shouldApplySnapshot,
} from "./connectionState";

describe("connection state", () => {
  it("enables the simulated transport only for demo=1", () => {
    expect(demoModeFromSearch("?demo=1")).toBe(true);
    expect(demoModeFromSearch("?demo=0")).toBe(false);
    expect(demoModeFromSearch("?demo=false")).toBe(false);
    expect(demoModeFromSearch("")).toBe(false);
  });

  it("clears pane loading whenever live polling stops", () => {
    expect(paneLoadingAfterModeChange("offline", true)).toBe(false);
    expect(paneLoadingAfterModeChange("connecting", true)).toBe(false);
    expect(paneLoadingAfterModeChange("demo", true)).toBe(false);
    expect(paneLoadingAfterModeChange("live", true)).toBe(true);
  });

  it("rejects stale responses from a previous session or request generation", () => {
    expect(shouldApplySnapshot("default", "buildbox", 2, 2)).toBe(false);
    expect(shouldApplySnapshot("default", "default", 1, 2)).toBe(false);
    expect(shouldApplySnapshot("buildbox", "buildbox", 2, 2)).toBe(true);
  });

  it("never falls back to simulated actions after a snapshot failure", () => {
    expect(modeAfterSnapshotFailure()).toBe("offline");
  });

  it("keeps successful HTTP snapshots offline when Herdr itself is disconnected", () => {
    expect(modeForSnapshotBridge("disconnected")).toBe("offline");
    expect(modeForSnapshotBridge("connected")).toBe("live");
  });
});
