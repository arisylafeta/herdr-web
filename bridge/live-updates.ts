export type LiveUpdateMessage =
  | { type: "connected" }
  | { type: "source_status"; live: boolean }
  | { type: "snapshot_changed" }
  | { type: "pane_output_changed"; paneId: string; revision: number }
  | { type: "pane_stream_status"; paneId: string; live: boolean; reason?: string }
  | {
      type: "pane_frame";
      paneId: string;
      seq: number;
      full: boolean;
      width: number;
      height: number;
      bytes: string;
    };

export interface LiveUpdateSocket {
  send(data: string): unknown;
  close?(code?: number, reason?: string): unknown;
}

/** Fans small Herdr event notifications to session-scoped WebSocket clients. */
export class LiveUpdateHub {
  private readonly sockets = new Map<string, Set<LiveUpdateSocket>>();
  private readonly sourceHealth = new Map<string, boolean>();

  add(session: string, socket: LiveUpdateSocket): void {
    const current = this.sockets.get(session) ?? new Set<LiveUpdateSocket>();
    current.add(socket);
    this.sockets.set(session, current);
    this.send(socket, { type: "connected" });
    this.send(socket, { type: "source_status", live: this.sourceHealth.get(session) === true });
  }

  remove(session: string, socket: LiveUpdateSocket): void {
    const current = this.sockets.get(session);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) this.sockets.delete(session);
  }

  setSourceHealthy(session: string, live: boolean): void {
    if (this.sourceHealth.get(session) === live) return;
    this.sourceHealth.set(session, live);
    this.publish(session, { type: "source_status", live });
  }

  snapshotChanged(session: string): void {
    this.publish(session, { type: "snapshot_changed" });
  }

  paneOutputChanged(session: string, data: unknown): void {
    if (!isRecord(data)) return;
    const pane = isRecord(data.pane) ? data.pane : data;
    const paneId = pane.pane_id;
    const revision = pane.revision;
    if (typeof paneId !== "string" || typeof revision !== "number" || !Number.isFinite(revision)) {
      return;
    }
    this.publish(session, { type: "pane_output_changed", paneId, revision });
  }

  closeAll(): void {
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) socket.close?.(1001, "bridge shutting down");
    }
    this.sockets.clear();
  }

  private publish(session: string, message: LiveUpdateMessage): void {
    const sockets = this.sockets.get(session);
    if (!sockets) return;
    const encoded = JSON.stringify(message);
    for (const socket of [...sockets]) {
      try {
        socket.send(encoded);
      } catch {
        this.remove(session, socket);
      }
    }
  }

  private send(socket: LiveUpdateSocket, message: LiveUpdateMessage): void {
    socket.send(JSON.stringify(message));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
