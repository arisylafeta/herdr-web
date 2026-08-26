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
    const lightRuleBodies = [...styles.matchAll(/html\[data-theme="light"\][^{]*\{([^}]*)\}/g)]
      .map((match) => match[1])
      .join("\n");
    const terminalSession = styles.match(/\.terminal-session\s*\{([^}]*)\}/)?.[1];

    expect(lightRuleBodies).not.toMatch(/--terminal-[\w-]+\s*:/);
    expect(terminalSession).toMatch(/color-scheme:\s*dark;/);
    expect(terminalSession).toMatch(/--scrollbar:\s*rgba\(255, 255, 255, 0\.14\);/);
    expect(terminalSession).toMatch(/--scrollbar-hover:\s*rgba\(255, 255, 255, 0\.24\);/);
  });
});
