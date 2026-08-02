import { describe, expect, it } from "vitest";
import { isTerminalNearBottom } from "./outputFollow";

describe("isTerminalNearBottom", () => {
  it("keeps following at the tail or within the follow threshold", () => {
    expect(isTerminalNearBottom(700, 300, 1_000)).toBe(true);
    expect(isTerminalNearBottom(550, 300, 1_000)).toBe(true);
  });

  it("stops following while the operator reads older output", () => {
    expect(isTerminalNearBottom(400, 300, 1_000)).toBe(false);
  });
});
