/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { LiveActivityBar } from "./LiveActivityBar";
import { VibeCard } from "./VibeCard";
import { todoCounts } from "./TodoPanel";
import { contextLevel, disclosureId } from "../lib/workState";
import type { TranscriptStatus } from "../lib/transcript-types";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.useRealTimers(); });
function mount(node: React.ReactNode) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); act(() => root?.render(node)); return container; }
const status: TranscriptStatus = { model: { id: "model", name: "Long model", provider: "demo" }, context: { tokens: 206000, percent: 20.6, window: 1000000, level: "warn", source: "estimate" }, freshness: { fileUpdatedAt: "2026-10-11T00:00:00Z" } };
it("uses earliest absolute or percentage context pressure", () => { expect(contextLevel(206000, 20.6)).toBe("warn"); expect(contextLevel(1,70)).toBe("high"); expect(contextLevel(500000,20)).toBe("critical"); expect(contextLevel(149999,49)).toBe("ok"); });
it("keeps disclosure identity independent of revision and disambiguates pane and call", () => { expect(disclosureId("a:b","c")).not.toBe(disclosureId("a","b:c")); expect(disclosureId("bridge","s","p","o","call")).not.toBe(disclosureId("bridge","s","p2","o","call")); });
it("opens status with focus, labels inference and closes Escape before runtime controls", () => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:05:00Z")); const node = mount(<StatusBar status={status} id="status" />); const launcher = node.querySelector<HTMLButtonElement>("button")!; launcher.focus(); act(() => launcher.click()); expect(document.activeElement?.getAttribute("aria-label")).toBe("Close Session status"); expect(node.textContent).toContain("Stale disk observation"); expect(node.textContent).toContain("estimated"); const runtime = vi.fn(); document.addEventListener("keydown", runtime); act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); document.removeEventListener("keydown", runtime); expect(runtime).not.toHaveBeenCalled(); expect(node.querySelector("[role=dialog]")).toBeNull(); expect(document.activeElement).toBe(launcher); });
it("ticks only active current turns and clears clock on settlement", () => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:10Z")); const node = mount(<LiveActivityBar status={{ ...status, turnStartedAt: "2026-10-11T00:00:00Z" }} paneStatus="working" onStop={vi.fn()} readOnly={false} />); expect(node.textContent).toContain("~10s"); act(() => vi.advanceTimersByTime(2000)); expect(node.textContent).toContain("~12s"); act(() => root?.render(<LiveActivityBar status={status} paneStatus="idle" onStop={vi.fn()} readOnly={false} />)); expect(node.textContent).toBe(""); expect(vi.getTimerCount()).toBe(0); });
it("keeps settled turns separate from reusable idle and running follow-up", () => { const node = mount(<VibeCard scope="v" record={{ kind: "vibe", id: "v", ts: "now", op: "wait", workers: [{ id: "reuse", state: "idle", turns: 2, queued: 0 }, { id: "followup", state: "running", turns: 3, queued: 1, elapsedMs: 5000 }], wait: { settled: 1, stillRunning: 1, timedOut: false, waiting: false } }} />); expect(node.textContent).toContain("Reusable worker · not a completed task"); expect(node.textContent).toContain("1 settled · 1 still running at observation"); expect(node.querySelector(".spinner")).toBeNull(); });
it("includes abandoned in closed todo count without treating blocked as closed", () => { expect(todoCounts([{ name: "Phase", tasks: [{ content: "a", status: "abandoned" }, { content: "b", status: "completed" }, { content: "c", status: "blocked" }] }])).toEqual({ total: 3, closed: 2, blocked: 1 }); });
