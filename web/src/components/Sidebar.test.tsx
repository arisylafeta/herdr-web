import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../lib/mock";
import { paneTitle, Sidebar } from "./Sidebar";

const noop = vi.fn();
const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("Sidebar agent identity and status", () => {
  it("keeps each workspace add-pane control visible without hover", () => {
    const workspaceAddRule = styles.match(/\.workspace-add\s*\{([^}]*)\}/)?.[1];

    expect(workspaceAddRule).toMatch(/opacity:\s*1;/);
  });

  it("prefers the managed agent name over the implementation kind", () => {
    expect(paneTitle(demoSnapshot.agents[0]!)).toBe("api-review");
    expect(paneTitle({ ...demoSnapshot.agents[0]!, name: undefined }, "review-tab")).toBe("review-tab");
    expect(paneTitle({ ...demoSnapshot.agents[0]!, name: undefined }, "1")).toBe("t3-herdr");
  });

  it("renders static working and checked done badges without sidebar status dots", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        snapshot={demoSnapshot}
        selectedPaneId={demoSnapshot.agents[0]!.paneId}
        mode="demo"
        readOnly={false}
        compact={false}
        mobileOpen={false}
        onMobileClose={noop}
        onSelectPane={noop}
        onSearch={noop}
        onNewWorkspace={noop}
        onNewTab={noop}
        onOpenSettings={noop}
      />,
    );

    expect(html).toContain("api-review");
    expect(html).toContain("sidebar-status-badge sidebar-status-working");
    expect(html).toContain("sidebar-status-badge sidebar-status-done");
    expect(html).toContain("lucide-square-check");
    expect(html).not.toContain("status-pulse");
    expect(html).not.toContain("pane-row-icon");
  });
});
