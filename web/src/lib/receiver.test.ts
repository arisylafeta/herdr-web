import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeReceiver,
  combineAbortSignals,
  normalizeBridgeUrl,
  type BridgeProfile,
} from "./receiver";

const laptop: BridgeProfile = {
  id: "laptop",
  label: "Laptop",
  baseUrl: "https://laptop.example.ts.net:8787",
};

function receiver(profile = laptop): BridgeReceiver {
  return new BridgeReceiver(profile);
}

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

describe("BridgeReceiver pane reads", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reuses a cached pane body when its bridge returns 304", async () => {
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
    const target = receiver();

    expect(await target.pane("w1:p1", "default")).toEqual(pane);
    expect(await target.pane("w1:p1", "default")).toEqual({ ...pane, notModified: true });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "if-none-match": '"pane-v7"' });
  });

  it("does not share validators between receivers, sessions, or panes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ paneId: "p", text: "x", truncated: false, revision: 1 }),
          { status: 200, headers: { "content-type": "application/json", etag: '"v1"' } },
        ),
      ),
    );
    const first = receiver();
    const second = receiver({ id: "desktop", label: "Desktop", baseUrl: "https://desktop.example" });

    await first.pane("p1", "one");
    await first.pane("p1", "two");
    await first.pane("p2", "one");
    await second.pane("p1", "one");
    expect(fetchMock.mock.calls.map((call) => call[1]?.headers)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("targets the receiver origin and lets the bridge apply its scrollback limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ paneId: "p1", text: "x", truncated: false, revision: 1 }),
        { status: 200 },
      ),
    );

    await receiver().pane("p1", "default");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://laptop.example.ts.net:8787/api/pane/p1?session=default",
    );
  });
});

describe("BridgeReceiver mutations", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("includes the logical draft request ID for bridge deduplication", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await receiver().reply("p1", "deploy", "draft-123", "default");
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://laptop.example.ts.net:8787/api/pane/p1/reply?session=default",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "deploy", submit: true, requestId: "draft-123" }),
      }),
    ]);
  });

  it("marks the visible completed pane in its Herdr session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await receiver().markPaneSeen("p1", "default");

    expect(fetchMock.mock.calls[0]).toEqual([
      "https://laptop.example.ts.net:8787/api/pane/p1/seen?session=default",
      expect.objectContaining({ method: "POST" }),
    ]);
  });

  it("sends stable operation IDs for structural creates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false, error: "test" }), { status: 200 })),
    );
    const target = receiver();

    await target.createTab("w1", "shell", "create-tab-1", "default");
    await target.createWorkspace(
      { label: "work", cwd: "/tmp" },
      "create-workspace-1",
      "default",
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ workspaceId: "w1", label: "shell", requestId: "create-tab-1" }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ label: "work", cwd: "/tmp", requestId: "create-workspace-1" }),
    });
  });

  it("requests a diagnostic notification from the selected bridge", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, subscribers: 1 }), { status: 200 }),
    );

    await expect(receiver().sendPushTest()).resolves.toEqual({ ok: true, subscribers: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://laptop.example.ts.net:8787/api/push-test",
    );
  });
});

describe("normalizeBridgeUrl", () => {
  it("keeps only an HTTP(S) origin", () => {
    expect(normalizeBridgeUrl("https://host.example:8787/path?query=1")).toBe(
      "https://host.example:8787",
    );
  });

  it("rejects non-network and credential-bearing endpoints", () => {
    expect(() => normalizeBridgeUrl("file:///tmp/socket")).toThrow(/http/);
    expect(() => normalizeBridgeUrl("https://user:secret@host.example")).toThrow(/credentials/);
  });
});
