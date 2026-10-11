/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { LiveActivityBar } from "./LiveActivityBar";
import { VibeCard } from "./VibeCard";
import { WorkSheet } from "./WorkSheet";
import { WorkDetails } from "./WorkDetails";
import { SubagentTree } from "./SubagentTree";
import { todoCounts } from "./TodoPanel";
import type { TranscriptRecord, TranscriptResponse, TranscriptStatus } from "../lib/transcript-types";
import { contextLevel, disclosureId } from "../lib/workState";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(node: React.ReactNode) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); act(() => root?.render(node)); return container; }
const status: TranscriptStatus = { model: { id: "model", name: "Long model", provider: "demo" }, context: { tokens: 206000, percent: 20.6, window: 1000000, level: "warn", source: "estimate" }, freshness: { fileUpdatedAt: "2026-10-11T00:00:00Z" } };
it("uses earliest absolute or percentage context pressure", () => { expect(contextLevel(206000, 20.6)).toBe("warn"); expect(contextLevel(1,70)).toBe("high"); expect(contextLevel(500000,20)).toBe("critical"); expect(contextLevel(149999,49)).toBe("ok"); });
it("keeps disclosure identity independent of revision and disambiguates pane and call", () => { expect(disclosureId("a:b","c")).not.toBe(disclosureId("a","b:c")); expect(disclosureId("bridge","s","p","o","call")).not.toBe(disclosureId("bridge","s","p2","o","call")); });
it("opens status with focus and closes Escape before runtime controls", () => { const node = mount(<StatusBar status={status} id="status" />); const launcher = node.querySelector<HTMLButtonElement>("button")!; launcher.focus(); act(() => launcher.click()); expect(document.activeElement).toBe(node.querySelector(".work-sheet header button")); const runtime = vi.fn(); document.addEventListener("keydown", runtime); act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); document.removeEventListener("keydown", runtime); expect(runtime).not.toHaveBeenCalled(); expect(node.querySelector("[role=dialog]")).toBeNull(); expect(document.activeElement).toBe(launcher); });
it("ticks only active current turns and clears clock on settlement", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:10Z"));
  const node = mount(<LiveActivityBar status={{ ...status, turnStartedAt: "2026-10-11T00:00:00Z" }} paneStatus="working" onStop={vi.fn()} readOnly={false} />);
  expect(Number(node.querySelector(".activity-clock")?.textContent?.match(/\d+/)?.[0])).toBe(10);
  act(() => vi.advanceTimersByTime(2000));
  expect(Number(node.querySelector(".activity-clock")?.textContent?.match(/\d+/)?.[0])).toBe(12);
  act(() => root?.render(<LiveActivityBar status={status} paneStatus="idle" onStop={vi.fn()} readOnly={false} />));
  expect(node.querySelector(".activity-clock")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps settled turns separate from reusable idle and running follow-up", () => { const node = mount(<VibeCard scope="v" record={{ kind: "vibe", id: "v", ts: "now", op: "wait", workers: [{ id: "reuse", state: "idle", turns: 2, queued: 0 }, { id: "followup", state: "running", turns: 3, queued: 1, elapsedMs: 5000 }], wait: { settled: 1, stillRunning: 1, timedOut: false, waiting: false } }} />); expect(node.querySelector(".state-idle summary")?.textContent).toContain("idle"); expect(node.querySelector(".state-running summary")?.textContent).toContain("running"); expect(node.querySelector(".spinner")).toBeNull(); });
it("includes abandoned in closed todo count without treating blocked as closed", () => { expect(todoCounts([{ name: "Phase", tasks: [{ content: "a", status: "abandoned" }, { content: "b", status: "completed" }, { content: "c", status: "blocked" }] }])).toEqual({ total: 3, closed: 2, blocked: 1 }); });
it("freezes historical running worker snapshots while the page clock advances", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:10Z"));
  const node = mount(<VibeCard scope="historical" record={{ kind: "vibe", id: "v", ts: "now", op: "list", workers: [{ id: "old", state: "running", turns: 1, queued: 0, elapsedMs: 5000, turnStartedAt: "2026-10-11T00:00:00Z" }] }} />);
  const frozen = node.textContent;
  act(() => vi.advanceTimersByTime(120000));
  expect(node.textContent).toBe(frozen);
  expect(vi.getTimerCount()).toBe(0);
});

it("wraps focus around visible worker summaries and ignores hidden folded controls", () => {
  const node = mount(<WorkSheet id="workers" title="Workers" close={vi.fn()}><details><summary>Worker one</summary><button>Hidden closed detail</button></details><select aria-label="Worker filter"><option>All</option></select><textarea aria-label="Worker note" /><div tabIndex={0}>Evidence link</div><details><summary id="last-worker">Worker two</summary></details><div style={{ display: "none" }}><button>Folded status</button></div><button disabled>Disabled</button></WorkSheet>);
  const first = node.querySelector<HTMLButtonElement>(".work-sheet header button")!;
  const last = node.querySelector<HTMLElement>("#last-worker")!;
  last.focus();
  const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => last.dispatchEvent(forward));
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);
  const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => first.dispatchEvent(backward));
  expect(backward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);
});

it.each(["select", "textarea", "tabindex"])("includes enabled %s controls in the sheet focus boundary", kind => {
  const control = kind === "select" ? <select id="last"><option>All</option></select> : kind === "textarea" ? <textarea id="last" /> : <div id="last" tabIndex={0}>Evidence</div>;
  const node = mount(<WorkSheet id="sheet" title="Worker" close={vi.fn()}>{control}<button hidden>Hidden</button></WorkSheet>);
  const first = node.querySelector<HTMLButtonElement>("button")!;
  const last = node.querySelector<HTMLElement>("#last")!;
  last.focus();
  act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(first);
});

it("observes a clock arriving after initial loading and pauses it offscreen", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:10Z"));
  let callback: IntersectionObserverCallback | undefined;
  const observe = vi.fn(); const disconnect = vi.fn();
  const observer = { observe, disconnect, unobserve: vi.fn(), takeRecords: () => [], root: null, rootMargin: "", scrollMargin: "", thresholds: [] };
  vi.stubGlobal("IntersectionObserver", class { constructor(next: IntersectionObserverCallback) { callback = next; } observe = observe; disconnect = disconnect; });
  const node = mount(<LiveActivityBar paneStatus="working" onStop={vi.fn()} readOnly={false} />);
  expect(observe).not.toHaveBeenCalled();
  act(() => root?.render(<LiveActivityBar status={{ ...status, turnStartedAt: "2026-10-11T00:00:00Z" }} paneStatus="working" onStop={vi.fn()} readOnly={false} />));
  const clock = node.querySelector(".activity-clock")!;
  expect(observe).toHaveBeenCalledWith(clock);
  act(() => callback?.([{ target: clock, isIntersecting: false } as IntersectionObserverEntry], observer));
  const frozen = clock.textContent;
  act(() => vi.advanceTimersByTime(4000));
  expect(clock.textContent).toBe(frozen);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the canonical dock plan after more than 65 later records and respects HUD dismissal", () => {
  const plan: Extract<TranscriptRecord, { kind: "todo" }> = { kind: "todo", id: "plan", ts: "now", phases: [{ name: "Current phase", tasks: [{ content: "Persist canonical plan", status: "pending" }] }] };
  const response: TranscriptResponse = { paneId: "p", sessionId: "s", revision: "1", records: [plan], total: 1, hasEarlier: false, agentStatus: "working", truncatedFile: false, status: { ...status, todo: { ...plan, visibility: "visible" } } };
  const node = mount(<WorkDetails data={response} id="details" />);
  act(() => node.querySelector<HTMLButtonElement>(".work-details-row")!.click());
  const later: TranscriptRecord[] = Array.from({ length: 66 }, (_, index) => ({ kind: "assistant", id: `later-${index}`, ts: "now", text: "Later work" }));
  act(() => root?.render(<WorkDetails data={{ ...response, revision: "2", records: later.slice(-60), total: 67, hasEarlier: true }} id="details" />));
  expect(node.querySelector(".todo-panel")?.textContent).toContain("Persist canonical plan");
  act(() => root?.render(<WorkDetails data={{ ...response, status: { ...status, todo: { ...plan, visibility: "dismissed" } } }} id="details" />));
  expect(node.querySelector(".todo-panel")).toBeNull();
  act(() => root?.render(<WorkDetails data={{ ...response, status }} id="details" />));
  expect(node.querySelector(".todo-panel")?.textContent).toContain("Persist canonical plan");
});

it("uses opaque worker identity while displaying colliding handles and honest unknown counters", () => {
  const workers = [{ id: "opaque-one", handle: "crew.Review", state: "idle" as const }, { id: "opaque-two", handle: "crew.Review", state: "idle" as const }];
  const node = mount(<VibeCard scope="wall" record={{ kind: "vibe", id: "wall", ts: "now", op: "list", workers }} />);
  expect([...node.querySelectorAll("summary strong")].map(row => row.textContent)).toEqual(["crew.Review", "crew.Review"]);
  const row = node.querySelectorAll("details")[1];
  row.open = true;
  const identity = row.querySelector("summary")!.id;
  act(() => root?.render(<VibeCard scope="wall" record={{ kind: "vibe", id: "wall", ts: "now", op: "list", workers: [{ ...workers[1], handle: "renamed" }, workers[0]] }} />));
  expect(node.querySelectorAll("details")[0].open).toBe(true);
  expect(node.querySelectorAll("summary")[0].id).toBe(identity);
  expect(node.querySelectorAll('[aria-label="Turns unknown"]')).toHaveLength(2);
  expect(node.querySelectorAll('[aria-label="Queue unknown"]')).toHaveLength(2);
});

it("reports child evidence only when available and never invents old-bridge availability", () => {
  const descriptor = { id: "child-one", handle: "Review", agentType: "reviewer", description: "Review evidence", status: "idle", nesting: 0, source: "child" as const, childAvailable: true };
  const node = mount(<SubagentTree agents={[descriptor]} />);
  expect(node.querySelector("summary strong")?.textContent).toBe("Review");
  expect(node.querySelector('[aria-label="Child transcript unavailable"]')).toBeNull();
  expect(node.querySelector('[data-evidence-source="child"]')).not.toBeNull();
  act(() => root?.render(<SubagentTree agents={[{ ...descriptor, childAvailable: false }]} />));
  expect(node.querySelector('[aria-label="Child transcript unavailable"]')).not.toBeNull();
  act(() => root?.render(<SubagentTree agents={[{ ...descriptor, source: undefined, childAvailable: undefined }]} />));
  expect(node.querySelector('[aria-label="Child transcript unavailable"]')).toBeNull();
});

it("never substitutes zero for unavailable turn or queue counters", () => {
  const node = mount(<VibeCard scope="unknown" record={{ kind: "vibe", id: "unknown", ts: "now", op: "list", workers: [{ id: "worker", state: "idle" }] }} />);
  expect(node.querySelector('[aria-label="Turns unknown"]')?.textContent).toBe("—t");
  expect(node.querySelector('[aria-label="Queue unknown"]')?.textContent).toBe("—q");
  act(() => root?.render(<VibeCard scope="unknown" record={{ kind: "vibe", id: "unknown", ts: "now", op: "list", workers: [{ id: "worker", state: "idle", turns: 0, queued: 0 }] }} />));
  expect(node.querySelector('[aria-label="0 observed turns"]')?.textContent).toBe("0t");
  expect(node.querySelector('[aria-label="0 observed queued turns"]')?.textContent).toBe("0q");
});

it("does not contradict successfully available child evidence with an unavailable notice", () => {
  const node = mount(<SubagentTree agents={[{ id: "child", agentType: "reviewer", description: "Review", status: "idle", nesting: 0, source: "child", childAvailable: true }]} />);
  expect(node.querySelector(".evidence-note")?.textContent).not.toMatch(/unavailable/i);
  expect(node.querySelector('[data-evidence-source="child"]')).not.toBeNull();
});

it("closes only the topmost sheet on Escape and restores its launcher", () => {
  const outerClose = vi.fn();
  function NestedSheets() {
    const [child, setChild] = useState(false);
    return <WorkSheet id="outer" title="Workers" close={outerClose}><button id="launch-child" onClick={() => setChild(true)}>Session details</button>{child && <WorkSheet id="child" title="Session" close={() => setChild(false)}><details><summary>Evidence</summary></details></WorkSheet>}</WorkSheet>;
  }
  const node = mount(<NestedSheets />);
  const launcher = node.querySelector<HTMLButtonElement>("#launch-child")!;
  launcher.focus(); act(() => launcher.click());
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(node.querySelector("#child")).toBeNull();
  expect(node.querySelector("#outer")).not.toBeNull();
  expect(outerClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(launcher);
});
