import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const styles = ["./index.css", "./components/tool-details.css"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");
const variableNames = (value: string): string[] => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);

type Color = readonly [number, number, number];
type Theme = "dark" | "light";

function themeDefinitions(theme: Theme): Map<string, string> {
  const definitions = new Map<string, string>();
  parse(tokens).walkRules(rule => {
    if (rule.selector !== ":root" && !(theme === "light" && rule.selector === 'html[data-theme="light"]')) return;
    rule.walkDecls(declaration => {
      if (declaration.prop.startsWith("--")) definitions.set(declaration.prop, declaration.value);
    });
  });
  return definitions;
}

// CSS color-mix interpolates gamma-encoded channels in sRGB, but converts to
// linear-light RGB before the OKLab transform. Do not round to 8-bit channels.
const linearize = (channel: number): number => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
const encode = (channel: number): number => channel <= .0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - .055;

function toOklab([r, g, b]: Color): Color {
  const red = linearize(r), green = linearize(g), blue = linearize(b);
  const l = Math.cbrt(.4122214708 * red + .5363325363 * green + .0514459929 * blue);
  const m = Math.cbrt(.2119034982 * red + .6806995451 * green + .1073969566 * blue);
  const s = Math.cbrt(.0883024619 * red + .2817188376 * green + .6299787005 * blue);
  return [
    .2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: Color): Color {
  const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s),
    encode(-.0041960863 * l - .7034186147 * m + 1.707614701 * s),
  ];
}

function resolveColor(definitions: Map<string, string>, expression: string, chain: string[] = [], backdrop?: Color): Color {
  const value = expression.trim();
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) {
    const name = variable[1];
    if (chain.includes(name)) throw new Error(`Cyclic color: ${[...chain, name].join(" → ")}`);
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Missing color: ${name}`);
    return resolveColor(definitions, definition, [...chain, name], backdrop);
  }
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex) return [
    parseInt(hex[1].slice(0, 2), 16) / 255,
    parseInt(hex[1].slice(2, 4), 16) / 255,
    parseInt(hex[1].slice(4, 6), 16) / 255,
  ];
  // Premultiplied interpolation with transparent preserves the opaque input's
  // color and scales its alpha; browser compositing is in encoded sRGB.
  const overlay = /^color-mix\(in (srgb|oklab), (var\(--[\w-]+\)) ([\d.]+)%, transparent\)$/.exec(value);
  if (overlay) {
    if (!backdrop) throw new Error(`Transparent color requires a backdrop: ${value}`);
    const foreground = resolveColor(definitions, overlay[2], chain);
    const alpha = Number(overlay[3]) / 100;
    if (alpha < 0 || alpha > 1) throw new Error(`Invalid overlay weight: ${value}`);
    return [
      foreground[0] * alpha + backdrop[0] * (1 - alpha),
      foreground[1] * alpha + backdrop[1] * (1 - alpha),
      foreground[2] * alpha + backdrop[2] * (1 - alpha),
    ];
  }
  const mix = /^color-mix\(in (srgb|oklab), (var\(--[\w-]+\)) ([\d.]+)%, (var\(--[\w-]+\))\)$/.exec(value);
  if (!mix) throw new Error(`Unsupported color expression: ${value}`);
  const weight = Number(mix[3]) / 100;
  if (weight < 0 || weight > 1) throw new Error(`Invalid mix weight: ${value}`);
  const first = resolveColor(definitions, mix[2], chain);
  const second = resolveColor(definitions, mix[4], chain);
  const left = mix[1] === "oklab" ? toOklab(first) : first;
  const right = mix[1] === "oklab" ? toOklab(second) : second;
  const blended: Color = [
    left[0] * weight + right[0] * (1 - weight),
    left[1] * weight + right[1] * (1 - weight),
    left[2] * weight + right[2] * (1 - weight),
  ];
  return mix[1] === "oklab" ? fromOklab(blended) : blended;
}

function contrast(first: Color, second: Color): number {
  const luminance = ([r, g, b]: Color): number => .2126 * linearize(r) + .7152 * linearize(g) + .0722 * linearize(b);
  const left = luminance(first), right = luminance(second);
  return (Math.max(left, right) + .05) / (Math.min(left, right) + .05);
}

const surfaces = ["--bg", "--panel", "--card", "--card-2", "--raised", "--code-bg", "--chrome", "--surface", "--surface-raised", "--surface-hover", "--input-bg", "--composer-bg", "--active-overlay", "--subtle-overlay"];
const textRoles = [
  { token: "--muted", minimum: 4.5 },
  { token: "--faint", minimum: 3 },
  { token: "--muted-dim", minimum: 3 },
  { token: "--terminal-muted-dim", minimum: 3 },
];

describe("secondary text contrast", () => {
  for (const theme of ["dark", "light"] as const) {
    const definitions = themeDefinitions(theme);
    for (const { token, minimum } of textRoles) {
      for (const surface of surfaces) {
        const backdrop = surface.endsWith("-overlay") ? resolveColor(definitions, "var(--chrome)") : undefined;
        const ratio = contrast(resolveColor(definitions, `var(${token})`), resolveColor(definitions, `var(${surface})`, [], backdrop));
        it(`${theme} ${token} on ${surface}${backdrop ? " over --chrome" : ""}: ${ratio.toFixed(4)}:1`, () => {
          expect(ratio).toBeGreaterThanOrEqual(minimum);
        });
      }
    }
  }
});

// A missing/cyclic semantic dependency silently invalidates consumer declarations in browsers.
// Exercise both cascades, including root semantics inherited by the light theme.
describe("theme token contract", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`resolves every stylesheet variable in ${theme} mode`, () => {
      const definitions = themeDefinitions(theme);
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
