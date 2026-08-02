import { existsSync } from "node:fs";
import { homedir } from "node:os";

export interface TerminalFrame {
  paneId: string;
  seq: number;
  full: boolean;
  width: number;
  height: number;
  bytes: string;
}

interface TerminalObserverProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  write?(line: string): void;
  kill(): void;
}

export type TerminalObserverSpawner = (argv: string[]) => TerminalObserverProcess;

export interface ObserveTerminalOptions {
  paneId: string;
  session: string;
  cols: number;
  rows: number;
  control?: boolean;
  onUp: () => void;
  onFrame: (frame: TerminalFrame) => void;
  onDown: (reason: string) => void;
  spawn?: TerminalObserverSpawner;
  herdrExecutable?: string;
}

export interface TerminalFrameStream {
  resize(cols: number, rows: number): boolean;
  scroll(direction: "up" | "down", lines: number): boolean;
  close(): void;
}

/** Resolve the CLI once per observer without depending on launchd's intentionally small PATH. */
export function resolveHerdrExecutable(): string {
  const configured = process.env.HERDR_BIN?.trim() || process.env.HERDR_CONTROL_HERDR?.trim();
  if (configured) return configured;
  const fromPath = Bun.which("herdr");
  if (fromPath) return fromPath;
  const candidates = [
    `${homedir()}/.local/bin/herdr`,
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "herdr";
}

export function terminalObserverArgs(input: {
  herdrExecutable: string;
  session: string;
  paneId: string;
  cols: number;
  rows: number;
  control?: boolean;
}): string[] {
  return [
    input.herdrExecutable,
    ...(input.session === "default" ? [] : ["--session", input.session]),
    "terminal",
    "session",
    input.control ? "control" : "observe",
    input.paneId,
    ...(input.control ? ["--takeover"] : []),
    "--cols",
    String(input.cols),
    "--rows",
    String(input.rows),
  ];
}

/** Decode one JSONL frame produced by Herdr's terminal observe/control stream. */
export function parseTerminalFrameLine(line: string, paneId: string): TerminalFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.type !== "terminal.frame" ||
    frame.encoding !== "ansi" ||
    typeof frame.seq !== "number" ||
    !Number.isSafeInteger(frame.seq) ||
    frame.seq < 0 ||
    typeof frame.full !== "boolean" ||
    typeof frame.width !== "number" ||
    !Number.isSafeInteger(frame.width) ||
    frame.width <= 0 ||
    typeof frame.height !== "number" ||
    !Number.isSafeInteger(frame.height) ||
    frame.height <= 0 ||
    typeof frame.bytes !== "string"
  ) return null;
  return {
    paneId,
    seq: frame.seq,
    full: frame.full,
    width: frame.width,
    height: frame.height,
    bytes: frame.bytes,
  };
}

function spawnObserver(argv: string[]): TerminalObserverProcess {
  const child = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited: child.exited,
    write(line: string) {
      child.stdin.write(line);
      child.stdin.flush();
    },
    kill: () => child.kill(),
  };
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) onLine(pending);
  } finally {
    reader.releaseLock();
  }
}

async function collectError(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (output.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output.trim().slice(0, 4096);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Follow Herdr's native terminal-frame stream. Authorized clients use the controller form so
 * resize and scroll are interpreted by Herdr itself; read-only clients keep the observer form.
 * Both use the same bounded, droppable render queue as Herdr's own attached TUI clients.
 */
export function observeTerminalFrames(opts: ObserveTerminalOptions): TerminalFrameStream {
  const argv = terminalObserverArgs({
    herdrExecutable: opts.herdrExecutable ?? resolveHerdrExecutable(),
    session: opts.session,
    paneId: opts.paneId,
    cols: opts.cols,
    rows: opts.rows,
    control: opts.control,
  });
  let process: TerminalObserverProcess;
  let closed = false;
  let down = false;
  let up = false;
  let stderr = "";

  const fireDown = (reason: string) => {
    if (down) return;
    down = true;
    opts.onDown(reason);
  };

  try {
    process = (opts.spawn ?? spawnObserver)(argv);
  } catch (error) {
    queueMicrotask(() => fireDown(error instanceof Error ? error.message : String(error)));
    return {
      resize: () => false,
      scroll: () => false,
      close: () => {},
    };
  }

  void collectError(process.stderr).then((value) => {
    stderr = value;
  }).catch(() => {});

  void consumeLines(process.stdout, (line) => {
    if (closed || line.length === 0) return;
    const frame = parseTerminalFrameLine(line, opts.paneId);
    if (!frame) {
      let reason = "invalid terminal frame from Herdr";
      try {
        const value = JSON.parse(line) as { type?: unknown; reason?: unknown };
        if (value.type === "terminal.closed" && typeof value.reason === "string") {
          reason = value.reason;
        }
      } catch {
        /* use the protocol error above */
      }
      fireDown(reason);
      try {
        process.kill();
      } catch {
        /* ignore */
      }
      return;
    }
    if (!up) {
      up = true;
      opts.onUp();
    }
    opts.onFrame(frame);
  }).catch((error) => {
    fireDown(error instanceof Error ? error.message : String(error));
  });

  void process.exited.then((code) => {
    if (closed) return;
    fireDown(stderr || `Herdr terminal stream exited with code ${code}`);
  }).catch((error) => {
    if (!closed) fireDown(error instanceof Error ? error.message : String(error));
  });

  const sendControl = (value: Record<string, unknown>): boolean => {
    if (closed || !opts.control || !process.write) return false;
    try {
      process.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch (error) {
      fireDown(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  return {
    resize(cols: number, rows: number) {
      return sendControl({ type: "terminal.resize", cols, rows });
    },
    scroll(direction: "up" | "down", lines: number) {
      return sendControl({ type: "terminal.scroll", direction, lines });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        process.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
