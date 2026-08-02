import { describe, expect, it } from "vitest";
import { specialKeys } from "./Composer";

describe("Composer special keys", () => {
  it("uses Herdr's logical Esc key name", () => {
    expect(specialKeys.find((key) => key.label === "Esc")?.keys).toEqual(["Esc"]);
  });
});
