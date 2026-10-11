/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeReceiver } from "../lib/receiver";
import type { TranscriptRecord, TranscriptResponse } from "../lib/transcript-types";
import type { AgentView } from "../lib/types";
import { TranscriptView } from "./TranscriptView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
afterEach(() => { for (const { container, root } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); } });
type ToolRecord = Extract<TranscriptRecord, { kind: "tool" }>;
const pane: AgentView = { paneId: "pane", workspaceId: "w", workspaceLabel: "Work", workspaceNumber: 1, tabId: "tab", agent: "omp", status: "working", cwd: "/tmp", focused: true };
function expand(overrides: Partial<ToolRecord>) {
  const record: ToolRecord = { id: "tool", ts: "now", kind: "tool", name: "read", subject: "/tmp/source.ts", args: {}, status: "ok", ...overrides };
  const data: TranscriptResponse = { paneId: "pane", sessionId: "s", revision: "1", total: 1, records: [record], hasEarlier: false, agentStatus: "working", truncatedFile: false };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ container, root });
  act(() => root.render(<TranscriptView pane={pane} data={data} receiver={new BridgeReceiver({ id: "local", label: "Local", baseUrl: "http://localhost:8787" })} reconnecting={false} loading={false} output={null} onEarlier={() => {}} demo={false} readOnly={false} onSendKeys={() => {}} />));
  act(() => container.querySelector<HTMLButtonElement>(".tool-header")?.click());
  return container;
}

describe("expanded tool evidence", () => {
  it("presents a read path rather than raw argument JSON before file evidence", () => {
    const container = expand({ args: { path: "/tmp/source.ts", offset: 10 }, output: { text: "export const answer = 42;", truncated: false } });
    expect(container.querySelector('[aria-label="File path"]')?.textContent).toBe("/tmp/source.ts");
    expect(container.querySelector(".tool-args")).toBeNull();
    expect(container.querySelector('[aria-label="Tool output"]')?.textContent).toBe("export const answer = 42;");
  });
  it("separates the shell command from its result", () => {
    const container = expand({ name: "bash", args: { command: "printf 'hello\\n'" }, output: { text: "hello\n", truncated: false } });
    const command = container.querySelector('[aria-label="Command"]');
    const result = container.querySelector('[aria-label="Tool output"]');
    expect(command?.textContent).toBe("$ printf 'hello\\n'");
    expect(result?.textContent).toBe("hello\n");
    expect(command?.contains(result)).toBe(false);
  });
  it("preserves unified diff text with distinct added and removed lines", () => {
    const diff = "--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-const old = '<script>';\n+const next = '<img onerror=alert(1)>';\n";
    const container = expand({ name: "edit", args: { path: "/tmp/source.ts" }, output: { text: diff, truncated: false } });
    expect(container.querySelector('[aria-label="Diff"]')?.textContent).toBe(diff);
    expect(container.querySelector(".tool-diff-removed")?.textContent).toBe("-const old = '<script>';\n");
    expect(container.querySelector(".tool-diff-added")?.textContent).toBe("+const next = '<img onerror=alert(1)>';\n");
    expect(container.querySelector("script, img")).toBeNull();
  });
  it.each([
    { name: "READ_FILE", args: { file_path: "/tmp/read.ts" }, path: "/tmp/read.ts" },
    { name: "write_file", args: { filename: "/tmp/write.ts" }, path: "/tmp/write.ts" },
    { name: "write", args: { path: 17, file_path: "", filename: "/tmp/fallback.ts" }, path: "/tmp/fallback.ts" },
    { name: "read", args: {}, path: "/tmp/source.ts" },
  ])("supports file aliases and path fallbacks for $name", ({ name, args, path }) => {
    const container = expand({ name, args, output: { text: "file evidence", truncated: false } });
    expect(container.querySelector('[aria-label="File path"]')?.textContent).toBe(path);
    expect(container.querySelector('[aria-label="Tool output"]')?.textContent).toBe("file evidence");
    expect(container.querySelector(".tool-args")).toBeNull();
  });
  it.each([
    { name: "SHELL", args: { cmd: "pwd" }, command: "pwd" },
    { name: "exec", args: {}, command: "/tmp/source.ts" },
  ])("supports command aliases and subject fallback for $name", ({ name, args, command }) => {
    const container = expand({ name, args });
    expect(container.querySelector('[aria-label="Command"]')?.textContent).toBe(`$ ${command}`);
    expect(container.querySelector('[aria-label="Tool output"]')).toBeNull();
  });
  it.each(["patch", "diff"])("shows an argument %s alongside separate non-diff output", (key) => {
    const diff = "@@ -1 +1 @@\n-before\n+after";
    const container = expand({ name: "edit_file", args: { filename: "/tmp/change.ts", [key]: diff }, output: { text: "File updated", truncated: false } });
    expect(container.querySelector('[aria-label="File path"]')?.textContent).toBe("/tmp/change.ts");
    expect(container.querySelector('[aria-label="Diff"]')?.textContent).toBe(diff);
    expect(container.querySelector('[aria-label="Tool output"]')?.textContent).toBe("File updated");
  });
  it("does not mistake ordinary edit output for a unified diff", () => {
    const container = expand({ name: "edit", args: { patch: "replace this text" }, output: { text: "- permission denied", truncated: false } });
    expect(container.querySelector('[aria-label="Diff"]')).toBeNull();
    expect(container.querySelector('[aria-label="Tool output"]')?.textContent).toBe("- permission denied");
  });
  it("retains unknown-tool argument evidence and renders agent HTML inertly", () => {
    const args = { selector: "<script>alert(1)</script>", nested: { count: 2 } };
    const container = expand({ name: "custom_tool", args, output: { text: "<img src=x onerror=alert(1)>", truncated: false } });
    expect(JSON.parse(container.querySelector(".tool-args")?.textContent ?? "null")).toEqual(args);
    expect(container.querySelector('[aria-label="Tool output"]')?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("script, img, [onerror]")).toBeNull();
  });
});
