import type { AgentStatus } from "./types";

export function shouldMarkPaneSeen(
  status: AgentStatus | undefined,
  visibility: DocumentVisibilityState,
): boolean {
  return status === "done" && visibility === "visible";
}
