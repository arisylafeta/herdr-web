import { describe, expect, it } from "vitest";
import { demoPaneById, demoSnapshot } from "./mock";

describe("demo transport", () => {
  it("provides output for every demo pane", () => {
    const panes = [...demoSnapshot.agents, ...demoSnapshot.shellPanes];
    expect(panes.length).toBeGreaterThan(0);
    expect(new Set(panes.map((pane) => pane.paneId)).size).toBe(panes.length);
    for (const pane of panes) expect(demoPaneById[pane.paneId]?.text.length).toBeGreaterThan(0);
  });

  it("keeps panes attached to known workspaces and tabs", () => {
    const workspaceIds = new Set(demoSnapshot.workspaces.map((workspace) => workspace.workspaceId));
    const tabIds = new Set(demoSnapshot.tabs.map((tab) => tab.tabId));
    for (const pane of [...demoSnapshot.agents, ...demoSnapshot.shellPanes]) {
      expect(workspaceIds.has(pane.workspaceId)).toBe(true);
      expect(tabIds.has(pane.tabId)).toBe(true);
    }
  });

  it("advertises only the demo session whose dataset it implements", () => {
    expect(demoSnapshot.sessions?.map((session) => session.name)).toEqual(["default"]);
  });
});
