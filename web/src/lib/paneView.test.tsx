/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { demoSnapshot } from "./mock";
import { initialPaneView, paneViewKey, usePaneView } from "./paneView";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => sessionStorage.clear());
it("defaults only transcript-capable panes to chat", () => {
  expect(initialPaneView(true, null)).toBe("chat");
  expect(initialPaneView(true, "terminal")).toBe("terminal");
  expect(initialPaneView(false, "chat")).toBe("terminal");
});
it("persists a pane choice independently across pane and session switches", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const first = demoSnapshot.agents[0]!;
  const second = demoSnapshot.agents[1]!;
  function Probe({ pane = first, session = "one" }) {
    const view = usePaneView("bridge", session, pane);
    return <button onClick={() => view.setView("terminal")}>{view.value}</button>;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("chat");
    await act(async () => container.querySelector("button")!.click());
    expect(sessionStorage.getItem(paneViewKey("bridge", "one", first.paneId))).toBe("terminal");
    await act(async () => root.render(<Probe pane={second} />));
    expect(container.textContent).toBe("chat");
    await act(async () => root.render(<Probe session="two" />));
    expect(container.textContent).toBe("chat");
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("terminal");
  } finally { await act(async () => root.unmount()); }
});
