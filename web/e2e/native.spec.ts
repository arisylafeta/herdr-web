import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const shots = "/tmp/omp-mobile-probes/shots-native";
for (const viewport of [{ width: 390, height: 844, name: "phone" }, { width: 768, height: 1024, name: "tablet" }, { width: 1440, height: 900, name: "desktop" }]) for (const theme of ["dark", "light"]) {
  test(`native work ${viewport.name} ${theme}`, async ({ page }) => {
    await mkdir(shots, { recursive: true });
    await page.route("**/api/config", route => route.fulfill({ json: { push: false, vapidPublicKey: "" } }));
    await page.addInitScript(value => localStorage.setItem("herdr-web:theme", value), theme);
    await page.setViewportSize(viewport);
    await page.goto("/?demo=1&pane=w2:p1");
    await expect(page.locator(".native-status-row")).toContainText("20.6%/1M");
    await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(1);
    await expect(page.locator(".native-work-dock")).toBeVisible();
    await page.screenshot({ path: `${shots}/${theme}-${viewport.name}-overview.png` });
    await page.locator('[data-record-id="vibe-wait"] .tool-header').click();
    await page.locator('[data-record-id="vibe-wait"] .worker-row').first().locator("summary").click();
    await expect(page.locator('[data-record-id="vibe-wait"]')).toContainText("1 settled · 1 still running");
    await page.screenshot({ path: `${shots}/${theme}-${viewport.name}-vibe.png` });
    await page.locator(".work-details-row").click();
    await expect(page.getByRole("dialog", { name: "Work details" })).toContainText("Waiting for the owner's decision");
    const lastSummary = page.locator(".work-sheet .todo-panel summary").last();
    await lastSummary.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close Work details", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(lastSummary).toBeFocused();
    await page.locator(".work-sheet .subagent-tree summary").filter({ hasText: "ScopeReview" }).click();
    await expect(page.locator('.work-sheet [data-evidence-source="child"]')).toBeVisible();
    await page.screenshot({ path: `${shots}/${theme}-${viewport.name}-work.png` });
    await page.keyboard.press("Escape");
    await expect(page.locator(".work-details-row")).toBeFocused();
    await page.locator(".native-status-row").click();
    await expect(page.getByRole("dialog", { name: "Session status" })).toContainText("Stale disk observation");
    await page.screenshot({ path: `${shots}/${theme}-${viewport.name}-status.png` });
    await page.keyboard.press("Escape");
    await page.locator('[data-record-id="irc"] .tool-header').click();
    await page.screenshot({ path: `${shots}/${theme}-${viewport.name}-irc.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
test("old bridge, pressure levels, narrow reduced motion and short viewport", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { push: false } }));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const level of ["ok", "high", "critical"]) { await page.goto(`/?demo=1&pane=w2:p1&context=${level}`); await expect(page.locator(`.context-${level}`)).toBeVisible(); await page.screenshot({ path: `${shots}/narrow-${level}.png` }); }
  await page.goto("/?demo=1&pane=w2:p1&oldBridge=1");
  await expect(page.locator(".native-status-row")).toHaveCount(0);
  await expect(page.locator(".transcript-content")).toBeVisible();
  await page.screenshot({ path: `${shots}/old-bridge.png` });
  await page.goto("/?demo=1&pane=w2:p1"); await page.setViewportSize({ width: 390, height: 500 });
  await expect(page.locator(".native-status-row")).not.toBeVisible();
  await page.screenshot({ path: `${shots}/short-viewport.png` });
  await page.locator(".work-details-row").click();
  await page.locator('.work-sheet .worker-row summary').filter({ hasText: "booting" }).click();
  await expect(page.locator('.work-sheet [aria-label="Queue unknown"]')).toBeVisible();
  await page.screenshot({ path: `${shots}/review-unknown-counters.png` });
  await page.locator(".folded-status .native-status-row").click();
  await expect(page.getByRole("dialog", { name: "Session status" })).toBeVisible();
  await page.screenshot({ path: `${shots}/review-nested-status.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Session status" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Work details" })).toBeVisible();
  await page.keyboard.press("Escape");
});
test("operation acknowledgements, timeout, deep worker evidence and unknown context", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { push: false } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1&pane=w2:p1");
  for (const id of ["vibe-spawn", "vibe-send", "vibe-steer", "vibe-timeout", "vibe-kill", "interrupted"]) {
    const row = page.locator(`[data-record-id="${id}"]`);
    await row.locator(".tool-header").click();
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/operation-${id}.png` });
    await row.locator(".tool-header").click();
  }
  await page.goto("/?demo=1&pane=w2:p1&context=unknown");
  await expect(page.locator(".native-status-row")).toContainText("Context ?");
  await page.locator(".native-status-row").click();
  await page.screenshot({ path: `${shots}/unknown-context.png` });
});
