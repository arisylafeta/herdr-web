import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../lib/mock";
import { Composer, specialKeys } from "./Composer";

describe("Composer special keys", () => {
  it("uses Herdr's logical Esc key name", () => {
    expect(specialKeys.find((key) => key.label === "Esc")?.keys).toEqual(["Esc"]);
  });

  it("disables input and enables the stop control while the agent is running", () => {
    const pane = { ...demoSnapshot.agents[0]!, status: "working" as const };
    const html = renderToStaticMarkup(
      createElement(Composer, {
        pane,
        tab: demoSnapshot.tabs.find((tab) => tab.tabId === pane.tabId),
        session: "default",
        busy: false,
        running: true,
        readOnly: false,
        onSend: vi.fn(() => Promise.resolve(true)),
        onStop: vi.fn(),
        onSendKeys: vi.fn(),
        onUpload: vi.fn(() => Promise.resolve(undefined)),
      }),
    );
    const stopButton = html.match(/<button[^>]*aria-label="Stop agent"[^>]*>/)?.[0];

    expect(stopButton).toBeDefined();
    expect(stopButton).not.toContain("disabled");
    expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("does not expose Stop for an unrelated pending action", () => {
    const pane = { ...demoSnapshot.agents[0]!, status: "idle" as const };
    const html = renderToStaticMarkup(
      createElement(Composer, {
        pane,
        tab: demoSnapshot.tabs.find((tab) => tab.tabId === pane.tabId),
        session: "default",
        busy: true,
        running: false,
        readOnly: false,
        onSend: vi.fn(() => Promise.resolve(true)),
        onStop: vi.fn(),
        onSendKeys: vi.fn(),
        onUpload: vi.fn(() => Promise.resolve(undefined)),
      }),
    );

    expect(html).not.toContain('aria-label="Stop agent"');
    expect(html).toContain('title="Action in progress" disabled=""');
  });
});
