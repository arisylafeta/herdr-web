import { describe, expect, test } from "bun:test";

import { LiveUpdateHub } from "./live-updates.ts";

class FakeSocket {
  readonly messages: unknown[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
}

describe("LiveUpdateHub", () => {
  test("scopes snapshot and pane events to one Herdr session", () => {
    const hub = new LiveUpdateHub();
    const primary = new FakeSocket();
    const named = new FakeSocket();
    hub.setSourceHealthy("default", true);
    hub.add("default", primary);
    hub.add("work", named);

    hub.snapshotChanged("default");
    hub.paneOutputChanged("default", { pane: { pane_id: "w1:p1", revision: 9 } });

    expect(primary.messages).toEqual([
      { type: "connected" },
      { type: "source_status", live: true },
      { type: "snapshot_changed" },
      { type: "pane_output_changed", paneId: "w1:p1", revision: 9 },
    ]);
    expect(named.messages).toEqual([
      { type: "connected" },
      { type: "source_status", live: false },
    ]);
  });

  test("ignores malformed pane event data", () => {
    const hub = new LiveUpdateHub();
    const socket = new FakeSocket();
    hub.add("default", socket);
    hub.paneOutputChanged("default", { pane_id: 4, revision: "9" });
    expect(socket.messages).toHaveLength(2);
  });
});
