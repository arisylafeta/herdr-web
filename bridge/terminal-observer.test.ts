import { describe, expect, test } from "bun:test";

import {
  observeTerminalFrames,
  parseTerminalFrameLine,
  terminalObserverArgs,
  type TerminalObserverSpawner,
} from "./terminal-observer.ts";

function encodedFrame(seq: number, full: boolean, text: string): string {
  return JSON.stringify({
    type: "terminal.frame",
    seq,
    encoding: "ansi",
    width: 80,
    height: 24,
    full,
    bytes: Buffer.from(text).toString("base64"),
  });
}

describe("terminal observer protocol", () => {
  test("builds the native Herdr observer command for default and named sessions", () => {
    expect(terminalObserverArgs({
      herdrExecutable: "/bin/herdr",
      session: "default",
      paneId: "w1:p1",
      cols: 101,
      rows: 37,
    })).toEqual([
      "/bin/herdr", "terminal", "session", "observe", "w1:p1", "--cols", "101", "--rows", "37",
    ]);
    expect(terminalObserverArgs({
      herdrExecutable: "/bin/herdr",
      session: "review",
      paneId: "w2:p3",
      cols: 80,
      rows: 24,
    })).toEqual([
      "/bin/herdr", "--session", "review", "terminal", "session", "observe", "w2:p3",
      "--cols", "80", "--rows", "24",
    ]);
    expect(terminalObserverArgs({
      herdrExecutable: "/bin/herdr",
      session: "default",
      paneId: "w1:p1",
      cols: 101,
      rows: 37,
      control: true,
    })).toEqual([
      "/bin/herdr", "terminal", "session", "control", "w1:p1", "--takeover",
      "--cols", "101", "--rows", "37",
    ]);
  });

  test("accepts ANSI terminal frames and rejects unrelated JSON", () => {
    expect(parseTerminalFrameLine(encodedFrame(2, false, "\u001b[2J"), "w1:p1"))
      .toEqual({
        paneId: "w1:p1",
        seq: 2,
        full: false,
        width: 80,
        height: 24,
        bytes: "G1sySg==",
      });
    expect(parseTerminalFrameLine('{"type":"snapshot_changed"}', "w1:p1")).toBeNull();
    expect(parseTerminalFrameLine("not json", "w1:p1")).toBeNull();
  });

  test("forwards consecutive redraw frames instead of stopping after the first match", async () => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    let killed = false;
    const spawn: TerminalObserverSpawner = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `${encodedFrame(1, true, "full")}\n${encodedFrame(2, false, "diff")}\n`,
          ));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited,
      kill() {
        killed = true;
        exit(0);
      },
    });
    const frames: number[] = [];
    let up = 0;
    const observer = observeTerminalFrames({
      paneId: "w1:p1",
      session: "default",
      cols: 80,
      rows: 24,
      herdrExecutable: "/bin/herdr",
      spawn,
      onUp: () => up += 1,
      onFrame: (frame) => frames.push(frame.seq),
      onDown: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(up).toBe(1);
    expect(frames).toEqual([1, 2]);
    observer.close();
    expect(killed).toBe(true);
  });

  test("writes native resize and scroll commands to a controlling stream", () => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const writes: string[] = [];
    const spawn: TerminalObserverSpawner = () => ({
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exited,
      write(line) {
        writes.push(line);
      },
      kill() {
        exit(0);
      },
    });
    const observer = observeTerminalFrames({
      paneId: "w1:p1",
      session: "default",
      cols: 80,
      rows: 24,
      control: true,
      herdrExecutable: "/bin/herdr",
      spawn,
      onUp: () => {},
      onFrame: () => {},
      onDown: () => {},
    });

    expect(observer.resize(96, 31)).toBe(true);
    expect(observer.scroll("down", 8)).toBe(true);
    expect(writes).toEqual([
      '{"type":"terminal.resize","cols":96,"rows":31}\n',
      '{"type":"terminal.scroll","direction":"down","lines":8}\n',
    ]);
    observer.close();
  });
});
