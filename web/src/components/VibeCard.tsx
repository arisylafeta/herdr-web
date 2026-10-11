import type { TranscriptRecord, WorkerRow } from "../lib/transcript-types";
import { elapsedLabel } from "../lib/workState";
const glyphs: Record<WorkerRow["state"], string> = { running: "◷", starting: "◇", idle: "•", dead: "■" };
export function WorkerRows({ workers, scope }: { workers: WorkerRow[]; scope: string }) {
  return <ul className="worker-list">{workers.map(worker => <li key={worker.id}><details className={`worker-row state-${worker.state}`}><summary id={`${scope}-${encodeURIComponent(worker.id)}`}><span aria-hidden="true">{glyphs[worker.state]}</span><strong>{worker.id}</strong><span>{worker.state}</span></summary><div className="worker-evidence"><p>{worker.cli && <span title={worker.cli === "fast" ? "Low-latency / mechanical" : "Stronger / hard work"}>⟨{worker.cli}⟩ · </span>}{worker.turns}t{worker.queued ? ` +${worker.queued}q` : ""}{worker.elapsedMs !== undefined ? ` · ${elapsedLabel(worker.elapsedMs)} (observed)` : ""}</p>{worker.model && <p>{worker.model}</p>}{worker.state === "idle" && <p>Reusable worker · not a completed task</p>}{worker.currentTool && <p>Recent tool: {worker.currentTool}</p>}{worker.lastActivity && <p>{worker.lastActivity}</p>}{worker.outputTail?.length ? <pre aria-label="Recent activity excerpt">{worker.outputTail.join("\n")}</pre> : null}<p className="evidence-note">Disk snapshot{worker.observedAt ? ` · ${new Date(worker.observedAt).toLocaleTimeString()}` : " · observation time unavailable"}</p></div></details></li>)}</ul>;
}
export function vibeSummary(record: Extract<TranscriptRecord, { kind: "vibe" }>) {
  const ack: Record<string, string> = { turn: "turn started", steered: "steered", queued: "queued" };
  if (record.ack) return `${record.op} → ${record.ack.id} · ${ack[record.ack.mode ?? ""] ?? "acknowledged"}`;
  const running = record.workers.filter(worker => worker.state === "running").length;
  return `${record.op} · ${running} observed running${record.wait?.timedOut ? " · timed out" : ""}`;
}
export function VibeCard({ record, scope }: { record: Extract<TranscriptRecord, { kind: "vibe" }>; scope: string }) {
  return <><p className="evidence-note">Saved {record.op} snapshot · not a live worker wall</p>{record.ack && <p>{vibeSummary(record)}</p>}<WorkerRows workers={record.workers} scope={scope} />{record.wait && <p>{record.wait.settled} settled · {record.wait.stillRunning} still running at observation{record.wait.timedOut ? " · timeout, not task failure" : ""}</p>}{!record.workers.length && <p>No workers in this snapshot.</p>}</>;
}
