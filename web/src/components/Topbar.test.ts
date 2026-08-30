import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../lib/mock";
import type { SessionSummary } from "../lib/types";
import type { BridgeProfile } from "../lib/receiver";
import { Topbar } from "./Topbar";

const primarySession: SessionSummary = {
  name: "default",
  isPrimary: true,
  reachable: true,
  agents: 1,
  working: 0,
  blocked: 0,
};

const defaultBridge: BridgeProfile = {
  id: "default",
  label: "laptop",
  baseUrl: "https://laptop.example.ts.net",
  builtIn: true,
};

function renderTopbar(
  sessions: SessionSummary[],
  session?: string,
  bridges: BridgeProfile[] = [defaultBridge],
  bridgeId = "default",
): string {
  const pane = demoSnapshot.agents[0]!;
  return renderToStaticMarkup(
    createElement(Topbar, {
      pane,
      tab: demoSnapshot.tabs.find((tab) => tab.tabId === pane.tabId),
      sessions,
      session,
      bridges,
      bridgeId,
      bridgeConnected: true,
      readOnly: false,
      onSessionChange: vi.fn(),
      onBridgeChange: vi.fn(),
      onOpenSidebar: vi.fn(),
      onNewTab: vi.fn(),
      onRefresh: vi.fn(),
      onClosePane: vi.fn(),
    }),
  );
}

describe("Topbar session selector", () => {
  it("hides the default selector when only the primary session exists", () => {
    expect(renderTopbar([primarySession])).not.toContain("session-select");
  });

  it("shows the selector when there is another session to switch to", () => {
    const reviewSession = { ...primarySession, name: "review", isPrimary: false };
    const html = renderTopbar([primarySession, reviewSession], "review");

    expect(html).toContain("session-select");
    expect(html).toContain(">default</option>");
    expect(html).toContain('value="review" selected="">review</option>');
  });
});

describe("Topbar bridge selector", () => {
  it("appears only when another machine receiver is configured", () => {
    expect(renderTopbar([primarySession])).not.toContain("bridge-select");
    const desktop = {
      id: "desktop",
      label: "desktop",
      baseUrl: "https://desktop.example.ts.net",
    };
    const html = renderTopbar([primarySession], undefined, [defaultBridge, desktop], "desktop");
    expect(html).toContain("bridge-select");
    expect(html).toContain('value="desktop" selected="">desktop</option>');
  });
});
