import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
test("disk-backed native panes are read-only through staging", async ({ page }) => {
  test.skip(process.env.HERDR_NATIVE_LIVE !== "1", "Explicit staging bridge only");
  await mkdir("/tmp/omp-mobile-probes/shots-native", { recursive: true });
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { if (route.request().method() !== "GET") { blocked.push(`${route.request().method()} ${route.request().url()}`); return route.abort(); } return route.continue(); });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const pane of ["wA1:p7", "w9H:pC", "wA4:p5"]) {
    await page.goto(`/?pane=${encodeURIComponent(pane)}`);
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".transcript-content")).toBeVisible();
    await expect(page.locator(".transcript-empty")).toHaveCount(0);
    const response = await page.request.get(`/api/pane/${encodeURIComponent(pane)}/transcript?limit=60`);
    expect(response.ok()).toBe(true);
    await writeFile(`/tmp/omp-mobile-probes/shots-native/live-${pane.replace(":", "-")}.json`, await response.text());
    await page.screenshot({ path: `/tmp/omp-mobile-probes/shots-native/live-${pane.replace(":", "-")}.png` });
  }
  expect(errors).toEqual([]);
  expect(blocked.every(request => /^POST .*\/api\/pane\/[^/]+\/seen$/.test(request))).toBe(true);
});
