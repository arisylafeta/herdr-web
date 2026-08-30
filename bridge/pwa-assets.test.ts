import { describe, expect, test } from "bun:test";
import { BundledPwaAssets, resolvePwaPath } from "./pwa-assets.ts";

describe("BundledPwaAssets", () => {
  test("returns a build hint when the root index is absent", async () => {
    const assets = new BundledPwaAssets(`/tmp/herdr-web-missing-${crypto.randomUUID()}`);
    const response = await assets.serve("/");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("frontend not built");
  });

  test("reports an unknown build when no bundle is installed", async () => {
    const assets = new BundledPwaAssets(`/tmp/herdr-web-missing-${crypto.randomUUID()}`);
    expect(await assets.buildId()).toBe("unknown");
  });
});

describe("resolvePwaPath", () => {
  const WEB = "/srv/herdr-web/web/dist";

  test("resolves normal assets and the root beneath the configured directory", () => {
    expect(resolvePwaPath("/assets/app.js", WEB)).toEqual({
      rel: "assets/app.js",
      full: "/srv/herdr-web/web/dist/assets/app.js",
    });
    expect(resolvePwaPath("/", WEB)).toEqual({
      rel: "index.html",
      full: "/srv/herdr-web/web/dist/index.html",
    });
  });

  test("rejects traversal and a sibling directory sharing the same prefix", () => {
    expect(resolvePwaPath("/../../etc/passwd", WEB)).toBeNull();
    expect(resolvePwaPath("/../dist-x/evil.js", WEB)).toBeNull();
  });
});
