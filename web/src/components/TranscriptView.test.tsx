/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeReceiver } from "../lib/receiver";
import type { TranscriptRecord, TranscriptResponse } from "../lib/transcript-types";
import type { AgentView } from "../lib/types";
import { TranscriptView, type TranscriptViewProps } from "./TranscriptView";
import { Markdown } from "./Markdown";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
afterEach(() => { for (const { container, root } of mounted.splice(0)) { act(() => root.unmount()); container.remove(); } vi.restoreAllMocks(); });
const pane: AgentView = { paneId: "pane", workspaceId: "w", workspaceLabel: "Work", workspaceNumber: 1, tabId: "tab", agent: "omp", status: "working", cwd: "/tmp", focused: true };
const tool: Extract<TranscriptRecord, { kind: "tool" }> = { id: "tool", ts: "now", kind: "tool", name: "bash", subject: "echo hello", args: { command: "echo hello" }, status: "running", output: { text: "hello", truncated: false } };
function mount(records: TranscriptRecord[], overrides: Partial<TranscriptViewProps> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ container, root });
  const data: TranscriptResponse = { paneId: "pane", sessionId: "s", revision: "1", total: records.length, records, hasEarlier: false, agentStatus: "working", truncatedFile: false };
  const props: TranscriptViewProps = { pane, data, receiver: new BridgeReceiver({ id: "local", label: "Local", baseUrl: "http://localhost:8787" }), reconnecting: false, loading: false, output: null, onEarlier: vi.fn(), demo: false, readOnly: false, onSendKeys: vi.fn(), ...overrides };
  const render = (next: Partial<TranscriptViewProps> = {}) => act(() => root.render(<TranscriptView {...props} {...next} />));
  render(); return { container, props, render, data };
}
function click(node: Element | null) { if (!(node instanceof HTMLElement)) throw new Error("Missing clickable element"); act(() => node.click()); }

describe("TranscriptView mounted behavior", () => {
  it("preserves exact record order and assistant-side grouping", () => {
    const records: TranscriptRecord[] = [
      { kind: "user", id: "u", ts: "now", text: "Question" },
      { kind: "thinking", id: "t", ts: "now", text: "Think" }, tool,
      { kind: "assistant", id: "a", ts: "now", text: "Answer" },
      { kind: "divider", id: "d", ts: "now", label: "New context", variant: "reset" },
      { kind: "assistant", id: "a2", ts: "now", text: "Next answer" },
    ];
    const { container } = mount(records);
    expect(Array.from(container.querySelectorAll("[data-record-id]"), row => row.getAttribute("data-record-id"))).toEqual(["u", "t", "tool", "a", "d", "a2"]);
    expect(Array.from(container.querySelectorAll(".transcript-assistant"), row => Array.from(row.querySelectorAll("[data-record-id]"), child => child.getAttribute("data-record-id")))).toEqual([["t", "tool", "a"], ["a2"]]);
  });
  it("starts tools closed and preserves expansion when running becomes successful", () => {
    const { container, render, data } = mount([tool]);
    expect(container.querySelector(".tool-body")).toBeNull();
    click(container.querySelector(".tool-header"));
    expect(container.querySelector(".tool-output")?.textContent).toBe("hello");
    render({ data: { ...data, revision: "2", records: [{ ...tool, status: "ok", output: { text: "completed output", truncated: false } }] } });
    expect(container.querySelector(".tool-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".tool-output")?.textContent).toBe("completed output");
    expect(container.querySelector(".tool-status")?.getAttribute("aria-label")).toBe("Completed");
  });
  it("loads clipped full output on demand and exposes fetch errors without losing details", async () => {
    const { container, props } = mount([{ ...tool, output: { text: "preview", truncated: true } }]);
    const fetchRecord = vi.spyOn(props.receiver, "transcriptRecord").mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ recordId: tool.id, text: "complete evidence", truncated: false });
    click(container.querySelector(".tool-header"));
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Offline");
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    expect(container.querySelector(".tool-output")?.textContent).toBe("complete evidence");
    expect(fetchRecord).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".tool-body button")).toBeNull();
  });
  it("isolates full evidence for a reused call id when the omp session changes", async () => {
    const { container, props, render, data } = mount([{ ...tool, output: { text: "old preview", truncated: true } }]);
    vi.spyOn(props.receiver, "transcriptRecord").mockResolvedValue({ recordId: tool.id, text: "old full evidence", truncated: false });
    click(container.querySelector(".tool-header"));
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    render({ data: { ...data, sessionId: "new-session", records: [{ ...tool, output: { text: "new evidence", truncated: false } }] } });
    click(container.querySelector(".tool-header"));
    expect(container.querySelector(".tool-output")?.textContent).toBe("new evidence");
  });
  it("aborts old-session full reads and discards their late responses", async () => {
    const { container, props, render, data } = mount([{ ...tool, output: { text: "old preview", truncated: true } }]);
    const pending = Promise.withResolvers<{ recordId: string; text: string; truncated: boolean }>();
    const read = vi.spyOn(props.receiver, "transcriptRecord").mockReturnValue(pending.promise);
    click(container.querySelector(".tool-header"));
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    const signal = read.mock.calls[0]?.[3];
    render({ data: { ...data, sessionId: "new-session", records: [{ ...tool, output: { text: "new evidence", truncated: false } }] } });
    click(container.querySelector(".tool-header"));
    await act(async () => pending.resolve({ recordId: tool.id, text: "late old evidence", truncated: false }));
    expect(container.querySelector(".tool-output")?.textContent).toBe("new evidence");
    expect(signal?.aborted).toBe(true);
  });
  it("clears previous-session fetch errors for a reused call id", async () => {
    const { container, props, render, data } = mount([{ ...tool, output: { text: "preview", truncated: true } }]);
    vi.spyOn(props.receiver, "transcriptRecord").mockRejectedValue(new Error("Old session offline"));
    click(container.querySelector(".tool-header"));
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    render({ data: { ...data, sessionId: "new-session", records: [{ ...tool, output: { text: "new evidence", truncated: false } }] } });
    click(container.querySelector(".tool-header"));
    expect(container.querySelector("[role=alert]")).toBeNull();
  });
  it("shows approval only while blocked, with the last twelve lines and real keys", () => {
    const lines = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n");
    const { container, render, data, props } = mount([], { output: { paneId: "pane", text: `\u001b[31m${lines}\u001b[0m`, truncated: false, revision: 1 } });
    expect(container.querySelector(".approval-card")).toBeNull();
    render({ pane: { ...pane, status: "blocked" }, data });
    expect(container.querySelector(".approval-output")?.textContent).toBe(lines.split("\n").slice(-12).join("\n"));
    click(container.querySelector(".approval-actions button")); expect(props.onSendKeys).toHaveBeenCalledWith(["Enter"]);
    render({ pane: { ...pane, status: "done" }, data: { ...data, agentStatus: "blocked" } }); expect(container.querySelector(".approval-card")).toBeNull();
  });
  it("keeps redacted thinking inert and opens routed images with Escape dismissal", () => {
    const { container, props } = mount([{ kind: "thinking", id: "t", ts: "now", text: "secret", redacted: true }, { kind: "user", id: "u", ts: "now", text: "Look", images: [{ index: 0, mediaType: "image/png", bytes: 12 }] }]);
    expect(container.textContent).not.toContain("secret"); expect(container.querySelector<HTMLButtonElement>(".thought-header")?.disabled).toBe(true);
    expect(container.querySelector(".transcript-image img")?.getAttribute("src")).toBe(props.receiver.transcriptImageUrl("pane", "u", 0));
    click(container.querySelector(".transcript-image")); expect(container.querySelector("[role=dialog]")).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); expect(container.querySelector("[role=dialog]")).toBeNull();
  });
  it("anchors earlier rows and never drags an upward reader to new content", () => {
    const { container, data, render, props } = mount([tool], { data: { paneId: "pane", sessionId: "s", revision: "1", total: 2, records: [tool], hasEarlier: true, agentStatus: "working", truncatedFile: false } });
    const node = container.querySelector<HTMLDivElement>(".transcript-scroll"); if (!node) throw new Error("Missing scroll surface");
    let height = 1000; Object.defineProperty(node, "scrollHeight", { get: () => height }); Object.defineProperty(node, "clientHeight", { value: 300 });
    node.scrollTop = 120; act(() => node.dispatchEvent(new Event("scroll", { bubbles: true })));
    click(container.querySelector(".transcript-earlier")); expect(props.onEarlier).toHaveBeenCalledOnce();
    height = 1400; render({ data: { ...data, records: [{ kind: "user", id: "earlier", ts: "now", text: "Earlier" }, tool] } }); expect(node.scrollTop).toBe(520);
    height = 1600; render({ data: { ...data, revision: "3", records: [{ kind: "user", id: "earlier", ts: "now", text: "Earlier" }, tool, { kind: "assistant", id: "a", ts: "now", text: "New" }] } }); expect(node.scrollTop).toBe(520);
    click(container.querySelector(".transcript-jump")); expect(node.scrollTop).toBe(1300);
  });
  it("releases an unsuccessful earlier-load anchor on reconnect", () => {
    const { container, data, render } = mount([tool]);
    const withEarlier = { ...data, hasEarlier: true };
    render({ data: withEarlier });
    const node = container.querySelector<HTMLDivElement>(".transcript-scroll"); if (!node) throw new Error("Missing scroll surface");
    let height = 1000; Object.defineProperty(node, "scrollHeight", { get: () => height }); Object.defineProperty(node, "clientHeight", { value: 300 });
    node.scrollTop = 120; act(() => node.dispatchEvent(new Event("scroll", { bubbles: true })));
    click(container.querySelector(".transcript-earlier"));
    render({ data: withEarlier, reconnecting: true });
    click(container.querySelector(".transcript-jump"));
    height = 1400; render({ data: { ...withEarlier, revision: "next" }, reconnecting: false });
    expect(node.scrollTop).toBe(1100);
  });
  it("does not offer an unusable history action at the bridge window cap", () => {
    const records: TranscriptRecord[] = Array.from({ length: 400 }, (_, index) => ({ kind: "user", id: `u-${index}`, ts: "now", text: `Question ${index}` }));
    const data: TranscriptResponse = { paneId: "pane", sessionId: "s", revision: "cap", total: 500, records, hasEarlier: true, agentStatus: "idle", truncatedFile: false };
    const { container } = mount(records, { data });
    expect(container.querySelector(".transcript-earlier")).toBeNull();
    expect(container.querySelector('.transcript-content [role="status"]')).not.toBeNull();
  });
  it("explains the full-record bound instead of offering the same clipped fetch forever", async () => {
    const { container, props } = mount([{ ...tool, output: { text: "preview", truncated: true } }]);
    vi.spyOn(props.receiver, "transcriptRecord").mockResolvedValue({ recordId: tool.id, text: "bounded full record", truncated: true });
    click(container.querySelector(".tool-header"));
    await act(async () => { container.querySelector<HTMLButtonElement>(".tool-body button")?.click(); });
    expect(container.querySelector(".tool-output")?.textContent).toBe("bounded full record");
    expect(container.querySelector(".tool-body button")).toBeNull();
    expect(container.querySelector('.tool-body [role="status"]')).not.toBeNull();
  });
  it.each(["error", "aborted"] as const)("exposes a %s turn's reason and details without a collapsed disclosure", (variant) => {
    const { container } = mount([{ kind: "divider", id: "stopped", ts: "now", variant, label: "Turn stopped", detail: "Provider response <script>unsafe()</script>" }]);
    const row = container.querySelector(`[data-record-id="stopped"][role="${variant === "error" ? "alert" : "status"}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector("details")).toBeNull();
    expect(row?.textContent).toContain("Provider response");
    expect(row?.querySelector("script")).toBeNull();
  });
});

describe("Markdown safety and code", () => {
  it("sanitizes raw HTML scripts, event handlers and javascript links while retaining GFM", () => {
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); mounted.push({ container, root });
    act(() => root.render(<Markdown text={'<script>alert(1)</script><img src="x" onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n| A | B |\n| - | - |\n| one | two |'} />));
    expect(container.querySelector("script")).toBeNull(); expect(container.querySelector("[onerror]")).toBeNull(); expect(container.querySelector("a")?.hasAttribute("href")).toBe(false); expect(container.querySelector("td")?.textContent).toBe("one");
  });
  it("folds long code and copies the complete original source", async () => {
    const code = Array.from({ length: 42 }, (_, i) => `line ${i}`).join("\n");
    const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const { container } = mount([{ kind: "assistant", id: "a", ts: "now", text: `\`\`\`text\n${code}\n\`\`\`` }]);
    expect(container.querySelector(".code-content")?.textContent).not.toContain("line 41");
    await act(async () => { container.querySelector<HTMLButtonElement>(".code-copy")?.click(); }); expect(copy).toHaveBeenCalledWith(`${code}\n`);
    click(container.querySelector(".code-fold")); expect(container.querySelector(".code-content")?.textContent).toContain("line 41");
  });
});
