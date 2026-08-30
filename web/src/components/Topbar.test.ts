import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../lib/mock";
import type { BridgeProfile } from "../lib/receiver";
import { Topbar } from "./Topbar";

const defaultBridge: BridgeProfile = {
  id: "default",
  label: "home",
  baseUrl: "https://laptop.example.ts.net",
  builtIn: true,
};

function renderTopbar(
  bridges: BridgeProfile[] = [defaultBridge],
  bridgeId = "default",
): string {
  const pane = demoSnapshot.agents[0]!;
  return renderToStaticMarkup(
    createElement(Topbar, {
      pane,
      tab: demoSnapshot.tabs.find((tab) => tab.tabId === pane.tabId),
      bridges,
      bridgeId,
      bridgeConnected: true,
      readOnly: false,
      onBridgeChange: vi.fn(),
      onOpenSidebar: vi.fn(),
      onNewTab: vi.fn(),
      onRefresh: vi.fn(),
      onClosePane: vi.fn(),
    }),
  );
}

describe("Topbar device selector", () => {
  it("appears only when another device is configured", () => {
    expect(renderTopbar()).not.toContain("device-select");
    const crm = {
      id: "crm",
      label: "crm",
      baseUrl: "https://crm.example.ts.net",
    };
    const html = renderTopbar([defaultBridge, crm], "crm");
    expect(html).toContain("device-select");
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain(">home</option>");
    expect(html).toContain('value="crm" selected="">crm</option>');
    expect(html).not.toContain("Herdr session");
  });
});
