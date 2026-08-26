/** @vitest-environment jsdom */

import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../lib/mock";
import { Composer, specialKeys } from "./Composer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("Composer special keys", () => {
  it("uses Herdr's logical Esc key name", () => {
    expect(specialKeys.find((key) => key.label === "Esc")?.keys).toEqual(["Esc"]);
  });

  it("keeps steering and Stop independently usable while running", async () => {
    const pane = { ...demoSnapshot.agents[0]!, status: "working" as const };
    const onSend = vi.fn(() => Promise.resolve(true));
    const onStop = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    await act(async () => {
      root.render(createElement(Composer, {
        pane,
        tab: demoSnapshot.tabs.find((tab) => tab.tabId === pane.tabId),
        session: "default",
        busy: false,
        running: true,
        readOnly: false,
        onSend,
        onStop,
        onSendKeys: vi.fn(),
        onUpload: vi.fn(() => Promise.resolve(undefined)),
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to pane"]')!;
    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="Stop agent"]')!;
    const sendButton = container.querySelector<HTMLButtonElement>('button[title="Send reply"]')!;

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "Please check the failing test");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(textarea.disabled).toBe(false);
    expect(stopButton.disabled).toBe(false);
    expect(stopButton.classList).toContain("stop-control");
    expect(sendButton.disabled).toBe(false);
    expect(stopButton.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => sendButton.click());
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("Please check the failing test");

    act(() => stopButton.click());
    expect(onStop).toHaveBeenCalledOnce();
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
