import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("uses the app theme variables for inverse video without explicit colors", () => {
    expect(parseAnsi("\u001b[7mselected\u001b[27m")[0]).toMatchObject({
      text: "selected",
      fg: "var(--bg)",
      bg: "var(--text)",
      style: { color: "var(--bg)", backgroundColor: "var(--text)" },
    });
  });
});
