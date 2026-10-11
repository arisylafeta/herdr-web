import type { TranscriptRecord, TodoPhase, TodoStatus, WorkerRow, SubagentRow } from "./transcript-types";
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, cap = 2048): string => typeof v === "string" ? v.slice(0, cap) : "";
const rows = (v: unknown, cap = 64): unknown[] => Array.isArray(v) ? v.slice(0, cap) : [];
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
export function workerRows(value: unknown, ts: string): WorkerRow[] {
  return rows(value).flatMap(v => {
    const r = obj(v), id = text(r.id, 128), state = r.state;
    if (!id || !["starting", "running", "idle", "dead"].includes(String(state))) return [];
    const started = typeof r.turnStartedAt === "number" ? r.turnStartedAt : Date.parse(text(r.turnStartedAt));
    const elapsed = Date.parse(ts) - started;
    return [{ id, state: state as WorkerRow["state"], turns: num(r.turns), queued: num(r.queued), observedAt: ts,
      ...(r.cli === "good" || r.cli === "fast" ? { cli: r.cli } : {}),
      ...(Number.isFinite(elapsed) && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
      ...(Number.isFinite(started) && Math.abs(started) <= 8.64e15 ? { turnStartedAt: new Date(started).toISOString() } : {}),
      ...(text(r.turnMessage) ? { prompt: text(r.turnMessage, 4096) } : {}), trace: rows(r.trace, 6).map(v => text(v, 256)),
      ...(text(r.model) ? { model: text(r.model) } : {}), ...(text(r.lastActivity ?? r.lastIntent) ? { lastActivity: text(r.lastActivity ?? r.lastIntent) } : {}),
      ...(text(r.currentTool) ? { currentTool: text(r.currentTool) } : {}), outputTail: rows(r.outputTail, 3).map(v => text(v, 1024)) }];
  });
}
export function todoPhases(value: unknown): TodoPhase[] {
  const statuses: Record<string, TodoStatus> = { pending: "pending", in_progress: "active", active: "active", completed: "completed", abandoned: "abandoned", blocked: "blocked" };
  let budget = 128;
  return rows(value, 24).map(v => { const p = obj(v); return { name: text(p.name, 256), tasks: rows(p.tasks, Math.max(0, budget)).map(v => { budget--; const t = obj(v); return { content: text(t.content), status: statuses[String(t.status)] ?? "pending", ...(text(t.blocker) ? { blocker: text(t.blocker) } : {}), ...(text(t.details) ? { details: text(t.details) } : {}), ...(text(t.notes) ? { notes: text(t.notes) } : {}) }; }) }; });
}
export function subagentRows(value: unknown): SubagentRow[] {
  return rows(value).flatMap(v => { const r = obj(v), id = text(r.id ?? r.name, 128); return id ? [{ id, agentType: text(r.agent ?? r.agentType, 128) || "task", description: text(r.assignment ?? r.task ?? r.description), status: text(r.status, 64) || "unknown", nesting: Math.min(6, id.split(".").length - 1), ...(typeof r.toolCount === "number" ? { toolCount: num(r.toolCount) } : {}) }] : []; });
}
export function nativeResultRecords(name: string, detailsValue: unknown, id: string, ts: string): TranscriptRecord[] {
  const d = obj(detailsValue);
  if (name.startsWith("vibe_") && typeof d.op === "string") {
    const ack = obj(d.send ?? d.spawned), mode = ack.mode, w = obj(d.wait);
    return [{ kind: "vibe", id: `${id}:vibe`, ts, callId: id, op: text(d.op, 32), workers: workerRows(d.screens, ts),
      ...(text(ack.id) ? { ack: { id: text(ack.id, 128), ...(mode === "turn" || mode === "steered" || mode === "queued" ? { mode } : {}), ...(text(ack.jobId) ? { jobId: text(ack.jobId, 128) } : {}), ...(ack.cli === "good" || ack.cli === "fast" ? { cli: ack.cli } : {}) } } : {}),
      ...(text(obj(d.killed).id) ? { killed: { id: text(obj(d.killed).id, 128), cancelledTurn: obj(d.killed).cancelledTurn === true } } : {}),
      ...(d.wait ? { wait: { settled: rows(w.settled).length, stillRunning: rows(w.stillRunning).length, timedOut: w.timedOut === true, waiting: w.waiting === true } } : {}) }];
  }
  if (name === "todo" && Array.isArray(d.phases)) return [{ kind: "todo", id: `${id}:todo`, ts, phases: todoPhases(d.phases), visibility: "visible" }];
  if (name === "task" && Array.isArray(d.progress)) return [{ kind: "subagents", id: `${id}:subagents`, callId: id, ts, children: subagentRows(d.progress) }];
  return [];
}
export function nativeCustomRecord(entry: Record<string, unknown>): TranscriptRecord | undefined {
  const id = text(entry.id, 128), ts = text(entry.timestamp), d = obj(entry.details ?? entry.data);
  if (entry.type === "custom_message" && entry.customType === "irc:incoming" && entry.display === true) return { kind: "irc", id, ts, from: text(d.from, 128), body: text(d.message ?? d.body ?? entry.content, 8192), ...(text(d.to) ? { to: text(d.to, 128) } : {}), ...(text(d.replyTo) ? { replyTo: text(d.replyTo, 128) } : {}) };
  if (entry.type === "custom" && entry.customType === "user_todo_edit" && Array.isArray(d.phases)) return { kind: "todo", id, ts, phases: todoPhases(d.phases), visibility: "visible" };
  return undefined;
}
