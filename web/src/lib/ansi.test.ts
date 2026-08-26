import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("maps the base ANSI palette to terminal-scoped CSS variables", () => {
    const segments = parseAnsi(
      "\u001b[31mred\u001b[44mblue background\u001b[97mbright white",
    );

    expect(segments[0]).toMatchObject({
      fg: "var(--terminal-ansi-red)",
      style: { color: "var(--terminal-ansi-red)" },
    });
    expect(segments[1]).toMatchObject({
      fg: "var(--terminal-ansi-red)",
      bg: "var(--terminal-ansi-blue)",
      style: {
        color: "var(--terminal-ansi-red)",
        backgroundColor: "var(--terminal-ansi-blue)",
      },
    });
    expect(segments[2]).toMatchObject({
      fg: "var(--terminal-ansi-bright-white)",
      bg: "var(--terminal-ansi-blue)",
    });
  });

  it("keeps explicit 256-color and truecolor output independent of the app theme", () => {
    const segments = parseAnsi("\u001b[38;5;196mindexed\u001b[38;2;12;34;56mrgb");

    expect(segments[0]?.fg).toBe("rgb(255,0,0)");
    expect(segments[1]?.fg).toBe("rgb(12,34,56)");
  });

  it("uses the terminal palette variables for inverse video without explicit colors", () => {
    expect(parseAnsi("\u001b[7mselected\u001b[27m")[0]).toMatchObject({
      text: "selected",
      fg: "var(--bg)",
      bg: "var(--text)",
      style: { color: "var(--bg)", backgroundColor: "var(--text)" },
    });
  });
});
