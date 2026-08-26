/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CreateTabModal } from "./Modals";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("CreateTabModal", () => {
  it("centers without focusing the name input and restores launcher focus on close", () => {
    const launcher = document.createElement("button");
    launcher.textContent = "New pane";
    document.body.append(launcher);
    launcher.focus();

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    const render = (open: boolean) => {
      act(() => {
        root.render(
          <CreateTabModal
            open={open}
            workspaceLabel="control-plane"
            onClose={() => undefined}
            onCreate={() => undefined}
          />,
        );
      });
    };

    render(true);
    const dialog = container.querySelector<HTMLElement>("[role=dialog]");
    const input = container.querySelector<HTMLInputElement>("input");

    expect(container.querySelector(".modal-layer-centered")).not.toBeNull();
    expect(input?.hasAttribute("autofocus")).toBe(false);
    expect(document.activeElement).toBe(dialog);

    render(false);
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });
});
