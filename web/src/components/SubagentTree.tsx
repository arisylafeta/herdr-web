import type { SubagentRow } from "../lib/transcript-types";
import { useId } from "react";
import { disclosureId } from "../lib/workState";
const sources: Record<NonNullable<SubagentRow["source"]>, string> = { child: "Child JSONL", "task-result": "Task result", "task-call": "Task call", lifecycle: "Lifecycle snapshot" };
export function SubagentTree({ agents, scope }: { agents: SubagentRow[]; scope?: string }) {
  const generated = useId();
  const identity = scope ?? generated;
  const handles = new Map(agents.map(agent => [agent.id, agent.handle ?? agent.id]));
  const ids = new Set(agents.map(agent => agent.id));
  const children = new Map<string, SubagentRow[]>();
  for (const agent of agents) {
    const parent = agent.parentId && ids.has(agent.parentId) && agent.parentId !== agent.id ? agent.parentId : "";
    const rows = children.get(parent) ?? []; rows.push(agent); children.set(parent, rows);
  }
  const render = (rows: SubagentRow[], seen: Set<string>, depth: number): React.ReactNode => <ul className="subagent-tree">{rows.filter(agent => !seen.has(agent.id)).map(agent => {
    const next = new Set(seen); next.add(agent.id);
    return <li key={agent.id}>
      <details id={disclosureId(identity, agent.id)}><summary><span aria-hidden="true">└</span><strong>{agent.handle ?? agent.id}</strong><span>{agent.status || "unknown"}</span></summary>
        <div className="worker-evidence"><p>⟨{agent.agentType}⟩</p><p>{agent.description}</p>
          {agent.parentId && <p>Parent: {handles.get(agent.parentId) ?? agent.parentId}</p>}
          {agent.model && <p>{agent.model}</p>}
          {agent.currentTool && <p>Recent tool: {agent.currentTool}</p>}
          {agent.toolCount !== undefined && <p>{agent.toolCount} observed tools</p>}
          <p className="evidence-note" data-evidence-source={agent.source ?? "unknown"}>{agent.childAvailable === false && <span aria-label="Child transcript unavailable">Child transcript unavailable · </span>}{agent.source ? `Source: ${sources[agent.source]}` : agent.childAvailable === true ? "Child evidence available · source unspecified" : "Evidence source unspecified"}</p>
        </div>
      </details>
      {children.has(agent.id) && <div className={depth >= 1 ? "subagent-deep" : ""}>{render(children.get(agent.id) ?? [], next, depth + 1)}</div>}
    </li>;
  })}</ul>;
  return render(children.get("") ?? agents, new Set(), 0);
}
