import type { TodoPhase, TodoStatus } from "../lib/transcript-types";
const marks: Record<TodoStatus, string> = { pending: "□", active: "◷", completed: "✓", abandoned: "■", blocked: "!" };
export function todoCounts(phases: TodoPhase[]) { const tasks = phases.flatMap(phase => phase.tasks); return { total: tasks.length, closed: tasks.filter(task => task.status === "completed" || task.status === "abandoned").length, blocked: tasks.filter(task => task.status === "blocked").length }; }
export function TodoPanel({ phases }: { phases: TodoPhase[] }) {
  return <div className="todo-panel">{phases.map(phase => <details key={phase.name} open={phase.tasks.some(task => task.status === "active" || task.status === "blocked")}><summary>{phase.name} · {todoCounts([phase]).closed}/{phase.tasks.length} closed</summary><ul>{phase.tasks.map((task, index) => <li className={`todo-${task.status}`} key={`${task.content}-${index}`}><span aria-hidden="true">{marks[task.status]}</span><div><span>{task.content}</span><small>{task.status}</small>{task.blocker && <p>{task.blocker}</p>}</div></li>)}</ul></details>)}</div>;
}
