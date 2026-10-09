import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const screenshots = "/tmp/omp-mobile-probes/shots-herdr";
for (const viewport of [{ width: 390, height: 844, name: "phone" }, { width: 768, height: 1024, name: "tablet" }, { width: 1440, height: 900, name: "desktop" }]) {
  for (const theme of ["dark", "light"] as const) {
    test(`chat ${theme} ${viewport.name}: disclosures, navigation, and bounded history`, async ({ page }) => {
      await mkdir(screenshots, { recursive: true });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize(viewport);
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.addInitScript(preference => localStorage.setItem("herdr-web:theme", preference), theme);
      await page.goto("/?demo=1&pane=w2:p1");
      await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".tool-running")).toBeVisible();
      await expect(page.locator(".transcript-status[role=status]")).toHaveText("Working…");
      await expect(page.locator(".approval-card")).toHaveCount(0);
      const suffix = `${theme}-${viewport.name}`;
      await page.screenshot({ path: `${screenshots}/01-chat-${suffix}.png` });
      const request = page.locator('[data-record-id="request"]');
      await request.scrollIntoViewIfNeeded();
      const read = page.locator('[data-record-id="read"] .tool-header');
      await expect(read).toHaveAttribute("aria-expanded", "false");
      await page.screenshot({ path: `${screenshots}/02-tools-collapsed-${suffix}.png` });
      await read.click();
      await expect(page.locator('[data-record-id="read"] .tool-output')).toContainText("BridgeReceiver owns");
      await page.screenshot({ path: `${screenshots}/03-tool-expanded-${suffix}.png` });
      await read.click();
      const thought = page.locator('[data-record-id="thought"] .thought-header');
      await thought.click();
      await expect(page.locator(".thought-body")).toContainText("receiver seam");
      await page.screenshot({ path: `${screenshots}/04-thought-${suffix}.png` });
      await thought.click();
      const long = page.locator('[data-record-id="test"] .tool-header');
      await long.click();
      await page.getByRole("button", { name: "Load everything", exact: true }).click();
      await expect(page.locator('[data-record-id="test"] .tool-output')).toContainText("PASS 092");
      await long.click();
      await page.locator('[data-record-id="error"] .tool-header').click();
      await expect(page.locator('[data-record-id="error"] .tool-output')).toContainText("Connection refused");
      await page.screenshot({ path: `${screenshots}/05-error-compaction-${suffix}.png` });
      await page.locator('[data-record-id="error"] .tool-header').click();
      await page.locator('[data-record-id="image"]').scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: "View image 1" }).click();
      await expect(page.getByRole("dialog", { name: "Image viewer" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(0);
      await page.screenshot({ path: `${screenshots}/06-image-running-${suffix}.png` });
      const composer = page.getByLabel("Reply to pane");
      await composer.fill("Keep the receiver boundary explicit.\nReview the mobile result before changing the live pane.");
      await expect(page.getByTitle("Send reply")).toBeEnabled();
      await page.screenshot({ path: `${screenshots}/07-composer-draft-${suffix}.png` });
      const sendBox = await page.getByTitle("Send reply").boundingBox();
      expect(sendBox?.width).toBeGreaterThanOrEqual(44);
      expect(sendBox?.height).toBeGreaterThanOrEqual(44);
      const composerBox = await composer.boundingBox();
      expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
      await page.locator(".transcript-scroll").evaluate(node => { node.scrollTop = 0; });
      await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
      const before = await page.locator(".transcript-scroll").evaluate(node => ({ height: node.scrollHeight, top: node.scrollTop }));
      await page.getByRole("button", { name: "Show earlier", exact: true }).click();
      await expect(page.locator('[data-record-id="history-49"]')).toHaveCount(1);
      const after = await page.locator(".transcript-scroll").evaluate(node => ({ height: node.scrollHeight, top: node.scrollTop }));
      expect(Math.abs(after.top - (before.top + after.height - before.height))).toBeLessThan(3);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(page.getByText("Terminal output")).toBeVisible();
      await page.screenshot({ path: `${screenshots}/08-terminal-${suffix}.png` });
      await page.reload();
      await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      if (viewport.width < 960) {
        await page.getByTitle("Open sidebar").click();
        await expect.poll(async () => (await page.getByRole("complementary", { name: "Herdr workspaces" }).boundingBox())?.x ?? -1000).toBeGreaterThanOrEqual(-1);
      }
      await page.screenshot({ path: `${screenshots}/09-sidebar-${suffix}.png` });
      await page.getByRole("button", { name: /Settings/ }).click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await page.screenshot({ path: `${screenshots}/10-settings-${suffix}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

test("blocked chat exposes prompt and key actions, not a hidden disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1&pane=w1:p1");
  const approval = page.getByRole("region", { name: "Agent needs input" });
  await expect(approval).toBeVisible();
  await expect(approval.locator("pre")).toContainText("Before I continue");
  for (const key of ["Enter", "Esc", "Up", "Down", "Tab"]) await expect(approval.getByRole("button", { name: key, exact: true })).toBeEnabled();
  await page.screenshot({ path: `${screenshots}/11-approval-dark-phone.png` });
  await approval.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByText("Sent Enter in demo mode.")).toBeVisible();
});
