/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeReceiver } from "../lib/receiver";
import { demoSnapshot, demoTranscript } from "../lib/mock";
import type { AgentView } from "../lib/types";
import { useTranscript } from "./useTranscript";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

it("retains the previous completed window while reconnecting, then refreshes tool state", async () => {
  const receiver = new BridgeReceiver({ id: "test", label: "Test", baseUrl: "https://test.example" });
  const pane = demoSnapshot.agents[1]!;
  const data = demoTranscript(pane.paneId, 60, "working");
  const read = vi.spyOn(receiver, "transcript").mockResolvedValueOnce(data).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...data, revision: "finished", agentStatus: "done", records: data.records.map((row) => row.kind === "tool" ? { ...row, status: "ok" } : row) });
  function Probe() { const result = useTranscript(receiver, "one", pane, true, false); return <span>{result.data?.revision}:{String(result.reconnecting)}</span>; }
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe(`${data.revision}:false`);
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(container.textContent).toBe(`${data.revision}:true`);
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(container.textContent).toBe("finished:false");
  expect(read).toHaveBeenCalledTimes(3);
});
it("aborts the old pane request and opens each pane at its latest sixty rows", async () => {
  const receiver = new BridgeReceiver({ id: "test", label: "Test", baseUrl: "https://test.example" });
  const read = vi.spyOn(receiver, "transcript").mockImplementation(async (id, limit = 60) => demoTranscript(id, limit, "idle"));
  function Probe({ pane }: { pane: AgentView }) {
    const result = useTranscript(receiver, "one", pane, true, false);
    return <button onClick={result.showEarlier}>{result.data?.paneId}:{result.data?.records.length}</button>;
  }
  await act(async () => root.render(<Probe pane={demoSnapshot.agents[0]!} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("w1:p1:120");
  const oldSignal = read.mock.lastCall?.[3];
  await act(async () => root.render(<Probe pane={demoSnapshot.agents[1]!} />));
  expect(oldSignal?.aborted).toBe(true);
  expect(container.textContent).toBe("w2:p1:60");
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(6000);
  expect(read).toHaveBeenCalledTimes(3);
});
