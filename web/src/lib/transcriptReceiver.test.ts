import { describe, expect, it, vi } from "vitest";
import { BridgeReceiver, type FetchAdapter } from "./receiver";
import { demoTranscript } from "./mock";

describe("transcript receiver", () => {
  it("holds completed records on 304 and isolates history windows, sessions, and panes", async () => {
    const data = demoTranscript("p1", 60, "working");
    const fetcher = vi.fn<FetchAdapter>().mockImplementation((_url, init) => Promise.resolve(
      init?.headers ? new Response(null, { status: 304 }) : new Response(JSON.stringify(data), { headers: { etag: '"t1"' } }),
    ));
    const receiver = new BridgeReceiver({ id: "one", label: "One", baseUrl: "https://one.example" }, fetcher);
    expect(await receiver.transcript("p1", 60, "a")).toEqual(data);
    expect(await receiver.transcript("p1", 60, "a")).toEqual(data);
    await receiver.transcript("p1", 120, "a");
    await receiver.transcript("p1", 60, "b");
    await receiver.transcript("p2", 60, "a");
    expect(fetcher.mock.calls.map((call) => call[1]?.headers)).toEqual([undefined, { "if-none-match": '"t1"' }, undefined, undefined, undefined]);
    receiver.clearPaneCache();
    await receiver.transcript("p1", 60, "a");
    expect(fetcher.mock.lastCall?.[1]?.headers).toBeUndefined();
  });
  it("encodes scoped record/image URLs and caps the history request", async () => {
    const fetcher = vi.fn<FetchAdapter>().mockResolvedValue(new Response(JSON.stringify({ recordId: "r/1", text: "complete", truncated: false })));
    const receiver = new BridgeReceiver({ id: "one", label: "One", baseUrl: "https://one.example" }, fetcher);
    await receiver.transcriptRecord("p/1", "r/1", "s & 1");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://one.example/api/pane/p%2F1/transcript/record/r%2F1?session=s%20%26%201");
    expect(receiver.transcriptImageUrl("p/1", "r/1", 0, "s & 1")).toBe("https://one.example/api/pane/p%2F1/transcript/image/r%2F1/0?session=s%20%26%201");
    fetcher.mockResolvedValue(new Response(JSON.stringify(demoTranscript("p1", 60, "idle"))));
    await receiver.transcript("p1", 500);
    expect(fetcher.mock.lastCall?.[0]).toBe("https://one.example/api/pane/p1/transcript?limit=400");
  });
});
