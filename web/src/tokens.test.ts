import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const variableNames = (value: string): string[] => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);

// A missing/cyclic semantic dependency silently invalidates consumer declarations in browsers.
// Exercise both cascades, including root semantics inherited by the light theme.
describe("theme token contract", () => {
  for (const theme of ["dark", "light"]) {
    it(`resolves every stylesheet variable in ${theme} mode`, () => {
      const definitions = new Map<string, string>();
      const root = parse(tokens);
      root.walkRules(rule => {
        if (rule.selector !== ":root" && !(theme === "light" && rule.selector === 'html[data-theme="light"]')) return;
        rule.walkDecls(declaration => {
          if (declaration.prop.startsWith("--")) definitions.set(declaration.prop, declaration.value);
        });
      });
      const resolve = (name: string, chain: string[] = []): void => {
        expect(chain, `Circular token dependency: ${[...chain, name].join(" → ")}`).not.toContain(name);
        const value = definitions.get(name);
        expect(value, `Undefined ${name} in ${theme} theme`).toBeDefined();
        for (const dependency of variableNames(value ?? "")) resolve(dependency, [...chain, name]);
      };
      const stylesheet = parse(styles + "\n" + tokens);
      stylesheet.walkDecls(declaration => {
        for (const name of variableNames(declaration.value)) resolve(name);
      });
    });
  }
});
