import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("resolveTheme", () => {
  it("honours explicit light and dark preferences", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the operating system when preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("keeps the mirrored terminal on its native dark palette in light app mode", () => {
    const lightTheme = styles.match(/html\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1];

    expect(lightTheme).toBeDefined();
    expect(lightTheme).not.toContain("--terminal-");
    expect(styles).toMatch(/\.terminal-session\s*\{[^}]*color-scheme:\s*dark;/);
  });
});
