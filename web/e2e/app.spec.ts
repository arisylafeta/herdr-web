import { expect, test } from "@playwright/test";
import { demoPaneById, demoSnapshot } from "../src/lib/mock";

test("desktop control plane is interactive and stable", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${JSON.stringify(message.location())}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) responseErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => requestFailures.push(`${request.failure()?.errorText} ${request.url()}`));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?demo=1");
  await expect(page.getByText("Herdr", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Terminal output")).toBeVisible();
  await expect(page.getByText("Preview transport.")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(0);
  expect(overflow.root).toBeLessThanOrEqual(0);

  const composer = page.getByLabel("Reply to pane");
  await composer.fill("Continue with the Herdr adapter boundary");
  await composer.press("Enter");
  await expect(page.getByText("Demo reply sent to the pane.")).toBeVisible();
  await expect(page.getByText("Continue with the Herdr adapter boundary", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Jump to pane" })).toBeVisible();
  await page.getByPlaceholder("Search workspaces and panes").fill("collie");
  await expect(page.getByRole("dialog", { name: "Jump to pane" }).getByRole("button", { name: /opencode/i })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.screenshot({ path: "artifacts/herdr-control-desktop.png", fullPage: true });
  expect({ consoleErrors, responseErrors, requestFailures }).toEqual({ consoleErrors: [], responseErrors: [], requestFailures: [] });
  expect(pageErrors).toEqual([]);
});

test("mobile layout exposes the complete primary workflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demo=1");
  await expect(page.getByText("Terminal output")).toBeVisible();

  await page.getByTitle("Open sidebar").click();
  const sidebar = page.getByRole("complementary", { name: "Herdr workspaces" });
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.x ?? -1000).toBeGreaterThanOrEqual(-1);
  await sidebar.getByRole("button", { name: /Opencode/i }).click();
  await expect(page.getByRole("heading", { name: "Opencode" })).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.x ?? 0).toBeLessThanOrEqual(-300);

  const composer = page.getByLabel("Reply to pane");
  await expect(composer).toBeVisible();
  const composerBox = await composer.boundingBox();
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(844);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "artifacts/herdr-control-mobile.png", fullPage: true });
});

test("live bridge snapshot renders without falling back to demo data", async ({ page, request }) => {
  test.skip(process.env.LIVE_BRIDGE !== "1", "Run explicitly when a local Herdr bridge is available");
  const response = await request.get("http://127.0.0.1:8787/api/snapshot");
  expect(response.ok()).toBe(true);
  const snapshot = (await response.json()) as { bridge: string; workspaces: Array<{ label: string }> };
  expect(snapshot.bridge).toBe("connected");
  expect(snapshot.workspaces.length).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText(snapshot.workspaces[0]!.label, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Preview transport.")).toHaveCount(0);
  await expect(page.getByText("Terminal output")).toBeVisible();
  await page.screenshot({ path: "artifacts/herdr-control-live.png", fullPage: true });
});

test("production PWA installs the custom push-capable worker", async ({ page }) => {
  test.skip(process.env.LIVE_BRIDGE !== "1", "Run explicitly when the production bridge is available");
  await page.goto("http://127.0.0.1:8787/");
  const workerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? "";
  });
  expect(workerUrl).toMatch(/\/sw\.js$/);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Push notifications")).toBeVisible();
  await expect(page.getByText("Add VAPID keys to the bridge")).toBeVisible();
});

test("read-only devices cannot initiate mutations and still see update guidance", async ({ page }) => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.device = { enforced: true, device: "phone", authorized: false };
  snapshot.update = {
    enabled: true,
    lastCheckSucceeded: true,
    current: "1.0.0",
    latest: "1.1.0",
    latestUrl: "https://github.com/example/herdr-control/releases/tag/v1.1.0",
    releaseAvailable: true,
    bridgeStale: false,
    checkedAt: Date.now(),
  };

  await page.route("**/api/snapshot*", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/pane/**", (route) => route.fulfill({ json: demoPaneById["w1:p1"] }));

  await page.goto("/");
  await expect(page.getByText("Herdr Control 1.1.0 is available.")).toBeVisible();
  await expect(page.getByRole("link", { name: "View release" })).toHaveAttribute(
    "href",
    snapshot.update.latestUrl!,
  );
  await expect(page.getByRole("button", { name: "New workspace" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /New tab in/ }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "New pane" })).toBeDisabled();
  await expect(page.locator(".terminate-button")).toBeDisabled();
  await expect(page.getByLabel("Reply to pane")).toBeDisabled();

  await page.getByRole("button", { name: "Search" }).click();
  const palette = page.getByRole("dialog", { name: "Jump to pane" });
  await expect(palette.getByRole("button", { name: /New workspace/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog", { name: "New pane" })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("1.1.0 available · running 1.0.0")).toBeVisible();
  await expect(page.getByText("Read-only access", { exact: true })).toBeVisible();
});

test("slow pane reads are serialized", async ({ page }) => {
  let activeReads = 0;
  let startedReads = 0;
  let maxActiveReads = 0;
  await page.route("**/api/snapshot*", (route) => route.fulfill({ json: demoSnapshot }));
  await page.route("**/api/pane/**", async (route) => {
    activeReads++;
    startedReads++;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await route.fulfill({ json: demoPaneById["w1:p1"] });
    activeReads--;
  });

  await page.goto("/");
  await page.waitForTimeout(3_450);
  expect(startedReads).toBeGreaterThanOrEqual(2);
  expect(maxActiveReads).toBe(1);
});

test("pane switches clear terminal output and composer drafts", async ({ page }) => {
  await page.route("**/api/snapshot*", (route) => route.fulfill({ json: demoSnapshot }));
  await page.route("**/api/pane/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/upload")) {
      await route.fulfill({ json: { ok: true, path: "/tmp/private-diagram.png" } });
      return;
    }
    const paneId = decodeURIComponent(pathname.split("/").at(-1) ?? "");
    if (paneId === "w2:p1") await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      json: {
        paneId,
        text: paneId === "w1:p1" ? "private output from pane one" : "pane two output",
        truncated: false,
        revision: 1,
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText("private output from pane one", { exact: true })).toBeVisible();
  const composer = page.getByLabel("Reply to pane");
  await composer.fill("draft for pane one");
  await page.locator('input[type="file"]').setInputFiles({
    name: "private-diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from("image"),
  });
  await expect(page.getByText("private-diagram.png", { exact: true })).toBeVisible();

  await page.locator(".pane-row").nth(1).click();
  await expect(page.getByText("private output from pane one", { exact: true })).toHaveCount(0);
  await expect(page.getByText("private-diagram.png", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("pane two output", { exact: true })).toBeVisible();
});

test("async attachments cannot cross sessions that reuse a pane ID", async ({ page }) => {
  const buildbox = structuredClone(demoSnapshot);
  buildbox.workspaces = [{ ...buildbox.workspaces[0]!, label: "buildbox" }];
  buildbox.tabs = [buildbox.tabs[0]!];
  buildbox.agents = [{ ...buildbox.agents[0]!, workspaceLabel: "buildbox" }];
  buildbox.shellPanes = [];

  await page.route("**/api/snapshot*", (route) => {
    const session = new URL(route.request().url()).searchParams.get("session");
    return route.fulfill({ json: session === "buildbox" ? buildbox : demoSnapshot });
  });
  await page.route("**/api/pane/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/upload")) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: { ok: true, path: "/tmp/from-default-session.png" } });
      return;
    }
    const paneId = decodeURIComponent(pathname.split("/").at(-1) ?? "");
    await route.fulfill({ json: { paneId, text: "output", truncated: false, revision: 1 } });
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "from-default-session.png",
    mimeType: "image/png",
    buffer: Buffer.from("image"),
  });
  await page.getByTitle("Switch Herdr session").locator("select").selectOption("buildbox");
  await expect(page.getByText("buildbox", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(450);
  await expect(page.getByText("from-default-session.png", { exact: true })).toHaveCount(0);
});

test("session switching ignores an older snapshot that resolves late", async ({ page }) => {
  let defaultRequests = 0;
  const buildbox = structuredClone(demoSnapshot);
  buildbox.workspaces = [
    { workspaceId: "bw1", number: 1, label: "buildbox-only", focused: true, activeTabId: "bw1:t1", tabCount: 1, paneCount: 1 },
  ];
  buildbox.tabs = [{ tabId: "bw1:t1", workspaceId: "bw1", number: 1, label: "remote", focused: true, paneCount: 1 }];
  buildbox.agents = [
    { paneId: "bw1:p1", workspaceId: "bw1", workspaceLabel: "buildbox-only", workspaceNumber: 1, tabId: "bw1:t1", agent: "codex", status: "working", cwd: "/remote/buildbox", focused: true },
  ];
  buildbox.shellPanes = [];

  await page.route("**/api/snapshot*", async (route) => {
    const session = new URL(route.request().url()).searchParams.get("session");
    if (session === "buildbox") {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await route.fulfill({ json: buildbox });
      return;
    }
    defaultRequests++;
    if (defaultRequests > 1) await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({ json: demoSnapshot });
  });
  await page.route("**/api/pane/**", (route) =>
    route.fulfill({ json: demoPaneById["w1:p1"] }),
  );

  await page.goto("/");
  await expect(page.getByText("t3-herdr", { exact: true }).first()).toBeVisible();
  await page.getByTitle("Refresh session").click();
  await page.getByTitle("Switch Herdr session").locator("select").selectOption("buildbox");
  await expect(page.getByText("buildbox-only", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(550);
  await expect(page.getByText("buildbox-only", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("t3-herdr", { exact: true })).toHaveCount(0);
});

test("a live outage stays offline and never simulates terminal writes", async ({ page }) => {
  let snapshots = 0;
  await page.route("**/api/snapshot*", async (route) => {
    snapshots++;
    if (snapshots <= 2) await route.fulfill({ json: demoSnapshot });
    else await route.fulfill({ status: 503, body: "bridge unavailable" });
  });
  await page.route("**/api/pane/**", (route) =>
    route.fulfill({ json: demoPaneById["w1:p1"] }),
  );
  await page.route("**/api/pane/*/reply*", (route) =>
    route.fulfill({ status: 503, body: "bridge unavailable" }),
  );

  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible({ timeout: 8_000 });
  const composer = page.getByLabel("Reply to pane");
  await composer.fill("This must not be simulated");
  await composer.press("Enter");
  await expect(page.getByText(/503 bridge unavailable/)).toBeVisible();
  await expect(page.getByText("Demo reply sent to the pane.")).toHaveCount(0);
});

test("an initial bridge failure stays offline without synthetic sessions", async ({ page }) => {
  await page.route("**/api/snapshot*", (route) => route.fulfill({ status: 503, body: "bridge unavailable" }));

  await page.goto("/");
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Herdr is offline" })).toBeVisible();
  await expect(page.getByText("Preview transport.")).toHaveCount(0);
  await expect(page.getByText("t3-herdr", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reply to pane")).toBeDisabled();
});

test("partial reply delivery clears text to prevent duplicate terminal input", async ({ page }) => {
  await page.route("**/api/snapshot*", (route) => route.fulfill({ json: demoSnapshot }));
  await page.route("**/api/pane/**", (route) => route.fulfill({ json: demoPaneById["w1:p1"] }));
  await page.route("**/api/pane/*/reply*", (route) =>
    route.fulfill({
      json: {
        ok: false,
        textDelivered: true,
        error: "typed into the pane but not submitted — check the pane before resending",
      },
    }),
  );

  await page.goto("/");
  const composer = page.getByLabel("Reply to pane");
  await composer.fill("Do not duplicate this text");
  await composer.press("Enter");
  await expect(page.getByText(/typed into the pane but not submitted/)).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("rapid duplicate submits start only one terminal mutation", async ({ page }) => {
  let replies = 0;
  await page.route("**/api/snapshot*", (route) => route.fulfill({ json: demoSnapshot }));
  await page.route("**/api/pane/**", (route) => route.fulfill({ json: demoPaneById["w1:p1"] }));
  await page.route("**/api/pane/*/reply*", async (route) => {
    replies++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  const composer = page.getByLabel("Reply to pane");
  await composer.fill("send exactly once");
  await composer.evaluate((element) => {
    const options = { key: "Enter", bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", options));
    element.dispatchEvent(new KeyboardEvent("keydown", options));
  });
  await expect(page.getByText("Reply delivered to Herdr.")).toBeVisible();
  expect(replies).toBe(1);
});
