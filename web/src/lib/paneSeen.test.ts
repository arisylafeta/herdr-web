import { describe, expect, it } from "vitest";

import { shouldMarkPaneSeen } from "./paneSeen";

describe("shouldMarkPaneSeen", () => {
  it("marks only a visible completed pane as seen", () => {
    expect(shouldMarkPaneSeen("done", "visible")).toBe(true);
    expect(shouldMarkPaneSeen("done", "hidden")).toBe(false);
    expect(shouldMarkPaneSeen("working", "visible")).toBe(false);
    expect(shouldMarkPaneSeen(undefined, "visible")).toBe(false);
  });
});
