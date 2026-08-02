import { describe, expect, test } from "bun:test";
import { SocketWriteBuffer } from "./herdr-client.ts";

describe("SocketWriteBuffer", () => {
  test("retains unwritten bytes across backpressure and flushes only when complete", () => {
    const chunks: Uint8Array[] = [];
    const writes = [3, 0, 100];
    let flushes = 0;
    const socket = {
      write(bytes: Uint8Array): number {
        const count = Math.min(writes.shift() ?? bytes.length, bytes.length);
        chunks.push(bytes.slice(0, count));
        return count;
      },
      flush(): void { flushes += 1; },
    };
    const pending = new SocketWriteBuffer("hello\n");

    expect(pending.writeTo(socket)).toBe(3);
    expect(pending.complete).toBe(false);
    expect(flushes).toBe(0);
    expect(pending.writeTo(socket)).toBe(3);
    expect(pending.complete).toBe(true);
    expect(flushes).toBe(1);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("hello\n");
  });

  test("slices UTF-8 payloads by bytes rather than JavaScript code units", () => {
    const chunks: Uint8Array[] = [];
    const socket = {
      write(bytes: Uint8Array): number {
        const count = Math.min(2, bytes.length);
        chunks.push(bytes.slice(0, count));
        return count;
      },
      flush(): void {},
    };
    const pending = new SocketWriteBuffer("🐕\n");
    pending.writeTo(socket);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("🐕\n");
  });
});
