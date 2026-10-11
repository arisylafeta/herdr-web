import { useState } from "react";
import type { TranscriptResponse } from "../lib/transcript-types";
import { WorkerRows } from "./VibeCard";
import { SubagentTree } from "./SubagentTree";
import { TodoPanel, todoCounts } from "./TodoPanel";
import { StatusBar } from "./StatusBar";
import { WorkSheet } from "./WorkSheet";
export function WorkDetails({ data, id }: { data: TranscriptResponse; id: string }) {
  const [open, setOpen] = useState(false);
  const todo = [...data.records].reverse().find(record => record.kind === "todo");
  const agents = [...data.records].reverse().find(record => record.kind === "subagents");
  const workers = data.status?.workers ?? [];
  const phases = todo?.kind === "todo" && todo.visibility !== "dismissed" ? todo.phases : [];
  const counts = todoCounts(phases);
  const hasWork = Boolean(workers.length || phases.length || agents);
  if (!hasWork && !data.status) return null;
  return <>
    <button type="button" className={`work-details-row${hasWork ? "" : " status-only"}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(true)}>
      <span>{hasWork ? `Workers ${workers.length || (agents?.kind === "subagents" ? agents.children.length : 0)} observed${counts.total ? ` · Todo ${counts.closed}/${counts.total}` : ""}` : "Session details"}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <WorkSheet id={id} title="Work details" close={() => setOpen(false)}>
      <p className="evidence-note">Disk-backed observations · not a live registry</p>
      {workers.length > 0 && <section><h3>Workers</h3><WorkerRows workers={workers} scope={id} /></section>}
      {agents?.kind === "subagents" && <section><h3>Subagents</h3><SubagentTree agents={agents.children} /></section>}
      {phases.length > 0 && <section><h3>Todo · {counts.closed}/{counts.total} closed</h3><TodoPanel phases={phases} /></section>}
      {data.status && <div className="folded-status"><StatusBar status={data.status} id={`${id}-status`} /></div>}
    </WorkSheet>}
  </>;
}
