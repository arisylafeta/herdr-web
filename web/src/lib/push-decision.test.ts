import { describe, expect, it } from "vitest";
import {
  decidePush,
  notificationClickPath,
  sameNavigationTarget,
  preferredClientIndex,
  tagFor,
  visibleClientMatchesPush,
  visibleClientShowsSession,
} from "./push-decision";

describe("push decisions", () => {
  it("clears notification slots even while the app is visible", () => {
    expect(decidePush({ type: "clear", tag: "herdr-control:herd" }, true)).toEqual({
      kind: "clear",
      tag: "herdr-control:herd",
    });
  });

  it("keeps agent alerts visible until the app provides a foreground alert surface", () => {
    expect(decidePush({ title: "Codex needs input" }, true)).toMatchObject({
      kind: "show",
      title: "Codex needs input",
    });
  });

  it("preserves pane, session, and target deep-link data", () => {
    expect(
      decidePush(
        {
          title: "Codex needs input",
          data: { paneId: "p1", session: "buildbox", target: "settings" },
          renotify: true,
        },
        false,
      ),
    ).toMatchObject({
      kind: "show",
      tag: "herdr-control:p1",
      paneId: "p1",
      session: "buildbox",
      target: "settings",
      renotify: true,
    });
  });

  it("preserves explicit silent restoration independently of renotify", () => {
    expect(
      decidePush({ title: "Codex needs input", renotify: false, silent: true }, false),
    ).toMatchObject({ kind: "show", renotify: false, silent: true });
  });

  it("uses Herdr Web notification tags", () => {
    expect(tagFor("p1")).toBe("herdr-control:p1");
    expect(tagFor()).toBe("herdr-control");
  });

  it("matches visible windows only to their selected Herdr session", () => {
    expect(visibleClientShowsSession("https://herdr.test/", undefined)).toBe(true);
    expect(visibleClientShowsSession("https://herdr.test/?session=buildbox", "buildbox")).toBe(true);
    expect(visibleClientShowsSession("https://herdr.test/?session=default", undefined)).toBe(false);
    expect(visibleClientShowsSession("https://herdr.test/", "buildbox")).toBe(false);
  });

  it("matches global settings pushes to a visible window in any session", () => {
    expect(
      visibleClientMatchesPush("https://herdr.test/?session=buildbox", {
        data: { target: "settings" },
      }),
    ).toBe(true);
    expect(
      visibleClientMatchesPush("https://herdr.test/?session=buildbox", {
        data: { paneId: "primary-agent" },
      }),
    ).toBe(false);
  });

  it("prefers the exact target window, then the matching session, before another window", () => {
    const clients = [
      "https://herdr.test/?session=other",
      "https://herdr.test/?session=buildbox",
      "https://herdr.test/?session=buildbox&pane=p1",
    ];
    expect(
      preferredClientIndex(clients, "https://herdr.test/?session=buildbox&pane=p1"),
    ).toBe(2);
    expect(
      preferredClientIndex(clients.slice(0, 2), "https://herdr.test/?session=buildbox&pane=p1"),
    ).toBe(1);
    expect(
      preferredClientIndex(clients.slice(0, 1), "https://herdr.test/?session=buildbox&pane=p1"),
    ).toBe(0);
    expect(preferredClientIndex([], "https://herdr.test/")).toBe(-1);
  });

  it("builds notification deep links without URLSearchParams.size", () => {
    expect(notificationClickPath({ paneId: "p1", session: "buildbox" })).toBe(
      "/?pane=p1&session=buildbox",
    );
    expect(notificationClickPath({ target: "settings" })).toBe("/?settings=1");
    expect(notificationClickPath({})).toBe("/");
  });

  it("treats reordered notification query parameters as the same navigation target", () => {
    expect(
      sameNavigationTarget(
        "https://herdr.test/?session=buildbox&pane=p1",
        "https://herdr.test/?pane=p1&session=buildbox",
      ),
    ).toBe(true);
    expect(
      sameNavigationTarget(
        "https://herdr.test/?session=buildbox&pane=p2",
        "https://herdr.test/?pane=p1&session=buildbox",
      ),
    ).toBe(false);
    expect(
      preferredClientIndex(
        [
          "https://herdr.test/?session=buildbox&pane=other",
          "https://herdr.test/?pane=p1&session=buildbox",
        ],
        "https://herdr.test/?session=buildbox&pane=p1",
      ),
    ).toBe(1);
    expect(sameNavigationTarget("https://herdr.test/?demo=1", "https://herdr.test/")).toBe(
      false,
    );
  });
});
