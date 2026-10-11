import { LoaderCircle, Square } from "lucide-react";
import { useElapsed } from "../hooks/useElapsed";
import { elapsedLabel } from "../lib/workState";
import type { AgentStatus } from "../lib/types";
import type { TranscriptStatus } from "../lib/transcript-types";
export function LiveActivityBar({ status, paneStatus, onStop, readOnly }: { status?: TranscriptStatus; paneStatus: AgentStatus; onStop: () => void; readOnly: boolean }) {
  const active = paneStatus === "working";
  const clock = useElapsed(status?.turnStartedAt, active);
  if (!active && paneStatus !== "blocked") return null;
  return <div className="live-activity-bar"><span aria-hidden="true">{active ? <LoaderCircle className="spinner" /> : "!"}</span><span className="activity-label" title={status?.activity?.label}>{paneStatus === "blocked" ? "Needs input" : status?.activity?.label ? `Observed: ${status.activity.label}` : "Working"}</span>{status?.turnStartedAt && <span ref={clock.element} title="Estimated current-turn elapsed" className="activity-clock">~{elapsedLabel(clock.elapsed)}</span>}{active && <button type="button" className="stop-control" aria-label="Stop agent" title="Send Esc to stop agent" disabled={readOnly} onClick={onStop}><Square aria-hidden="true" />Stop</button>}<span className="sr-only" role="status" aria-live="polite">{paneStatus === "blocked" ? "Needs input" : "Agent working"}</span></div>;
}
