import type { SubagentRow } from "../lib/transcript-types";
export function SubagentTree({ agents }: { agents: SubagentRow[] }) {
  const ids = new Set(agents.map(agent => agent.id));
  const children = new Map<string, SubagentRow[]>();
  for (const agent of agents) { const parent = agent.parentId && ids.has(agent.parentId) && agent.parentId !== agent.id ? agent.parentId : ""; const rows = children.get(parent) ?? []; rows.push(agent); children.set(parent, rows); }
  const render = (rows: SubagentRow[], seen: Set<string>, depth: number): React.ReactNode => <ul className="subagent-tree">{rows.filter(agent => !seen.has(agent.id)).map(agent => { const next = new Set(seen); next.add(agent.id); return <li key={agent.id}><details><summary><span aria-hidden="true">└</span><strong>{agent.id}</strong><span>{agent.status || "unknown"}</span></summary><div className="worker-evidence"><p>⟨{agent.agentType}⟩</p><p>{agent.description}</p>{agent.parentId && <p>Parent: {agent.parentId}</p>}{agent.toolCount !== undefined && <p>{agent.toolCount} observed tools</p>}<p className="evidence-note">Details unavailable · saved task snapshot</p></div></details>{children.has(agent.id) && <div className={depth >= 1 ? "subagent-deep" : ""}>{render(children.get(agent.id) ?? [], next, depth + 1)}</div>}</li>; })}</ul>;
  return render(children.get("") ?? [], new Set(), 0);
}
