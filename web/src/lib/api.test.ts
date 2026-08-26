import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPaneReadCache,
  combineAbortSignals,
  createTab,
  createWorkspace,
  fetchPane,
  sendPushTest,
  sendReply,
} from "./api";

describe("combineAbortSignals", () => {
  it("aborts when either input aborts without relying on AbortSignal.any", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals([first.signal, second.signal]);

    expect(combined.aborted).toBe(false);
    second.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe("fetchPane conditional reads", () => {
  beforeEach(() => {
    clearPaneReadCache();
    vi.restoreAllMocks();
  });

  it("reuses a cached pane body when the bridge returns 304", async () => {
    const pane = {
      paneId: "w1:p1",
      text: "unchanged terminal output",
      truncated: false,
      revision: 7,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pane), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"pane-v7"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"pane-v7"' } }));

    expect(await fetchPane("w1:p1", "default")).toEqual(pane);
    expect(await fetchPane("w1:p1", "default")).toEqual({ ...pane, notModified: true });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "if-none-match": '"pane-v7"' });
  });

  it("does not share validators between sessions or panes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ paneId: "p", text: "x", truncated: false, revision: 1 }),
          { status: 200, headers: { "content-type": "application/json", etag: '"v1"' } },
        ),
      ),
    );

    await fetchPane("p1", "one");
    await fetchPane("p1", "two");
    await fetchPane("p2", "one");
    expect(fetchMock.mock.calls.map((call) => call[1]?.headers)).toEqual([undefined, undefined, undefined]);
  });

  it("lets the bridge apply its configured scrollback limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ paneId: "p1", text: "x", truncated: false, revision: 1 }),
        { status: 200 },
      ),
    );

    await fetchPane("p1", "default");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/pane/p1?session=default");
  });
});

describe("sendReply", () => {
  it("includes the logical draft request ID for bridge deduplication", async () => {
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await sendReply("p1", "deploy", "draft-123", "default");
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/pane/p1/reply?session=default",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "deploy", submit: true, requestId: "draft-123" }),
      }),
    ]);
  });
});

describe("sendPushTest", () => {
  it("requests a diagnostic notification from the bridge", async () => {
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, subscribers: 1 }), { status: 200 }),
    );

    await expect(sendPushTest()).resolves.toEqual({ ok: true, subscribers: 1 });
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/push-test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Herdr Web test",
          body: "Push notifications are working on this device.",
        }),
      }),
    ]);
  });
});

describe("structural creates", () => {
  it("sends stable operation IDs for bridge deduplication", async () => {
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false, error: "test" }), { status: 200 })),
    );

    await createTab("w1", "shell", "create-tab-1", "default");
    await createWorkspace({ label: "work", cwd: "/tmp" }, "create-workspace-1", "default");

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ workspaceId: "w1", label: "shell", requestId: "create-tab-1" }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ label: "work", cwd: "/tmp", requestId: "create-workspace-1" }),
    });
  });
});
