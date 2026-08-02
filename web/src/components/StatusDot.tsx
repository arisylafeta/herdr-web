import type { AgentStatus } from "../lib/types";

export function StatusDot({ status, pulse = false }: { status: AgentStatus; pulse?: boolean }) {
  return <span className={`status-dot status-${status}${pulse ? " status-pulse" : ""}`} aria-hidden="true" />;
}
