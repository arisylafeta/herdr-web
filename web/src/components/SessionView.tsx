import { AlertTriangle, Check, ChevronRight, Clock3, TerminalSquare, WifiOff } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { parseAnsi } from "../lib/ansi";
import { isTerminalNearBottom } from "../lib/outputFollow";
import type { AgentView, PaneReadResponse, TabView } from "../lib/types";
import { STATUS_LABEL } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface SessionViewProps {
  pane: AgentView | null;
  tab: TabView | undefined;
  output: PaneReadResponse | null;
  loading: boolean;
  bridgeConnected: boolean;
  mode: "connecting" | "live" | "offline" | "demo";
}

function displayAgent(agent: string): string {
  if (agent === "shell") return "Shell";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

export function SessionView({ pane, tab, output, loading, bridgeConnected, mode }: SessionViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingOutput = useRef(true);
  const renderedPaneId = useRef<string | null>(null);
  if (renderedPaneId.current !== pane?.paneId) {
    renderedPaneId.current = pane?.paneId ?? null;
    followingOutput.current = true;
  }
  const segments = useMemo(() => parseAnsi(output?.text ?? ""), [output?.text]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && followingOutput.current) node.scrollTop = node.scrollHeight;
  }, [output?.revision, output?.text]);

  if (!pane) {
    return (
      <main className="session-main empty-session">
        <div className="empty-session-mark" aria-hidden="true">
          <TerminalSquare />
        </div>
        <h1>{mode === "offline" ? "Herdr is offline" : mode === "connecting" ? "Connecting to Herdr" : "Select a Herdr pane"}</h1>
        <p>{mode === "offline" ? "The bridge is retrying. No actions will be simulated." : "Workspaces and durable agent sessions appear in the sidebar."}</p>
      </main>
    );
  }

  return (
    <main
      className="session-main"
      ref={scrollRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        followingOutput.current = isTerminalNearBottom(
          node.scrollTop,
          node.clientHeight,
          node.scrollHeight,
        );
      }}
    >
      {!bridgeConnected && mode === "offline" && (
        <div className="connection-banner">
          <WifiOff />
          <span>Herdr is offline. The bridge is retrying without interrupting the browser.</span>
        </div>
      )}
      {mode === "demo" && (
        <div className="demo-banner">
          <AlertTriangle />
          <span>Preview transport. Start the bridge to replace this data with live Herdr sessions.</span>
        </div>
      )}

      <div className="session-content">
        <section className="session-intro">
          <div className="agent-orb" data-agent={pane.agent} aria-hidden="true">
            {pane.agent === "shell" ? ">_" : pane.agent.slice(0, 2).toUpperCase()}
          </div>
          <div className="session-intro-copy">
            <div className="session-intro-heading">
              <h1>{displayAgent(pane.agent)}</h1>
              <span className={`status-badge badge-${pane.status}`}>
                <StatusDot status={pane.status} pulse={pane.status === "working"} />
                {STATUS_LABEL[pane.status]}
              </span>
            </div>
            <p>{pane.cwd}</p>
          </div>
        </section>

        <div className="timeline-event">
          <span className="timeline-event-icon">
            {pane.status === "done" ? <Check /> : pane.status === "working" ? <Clock3 /> : <ChevronRight />}
          </span>
          <div>
            <strong>{tab?.label ?? "Herdr pane"}</strong>
            <span>Durable terminal session · {pane.workspaceLabel}</span>
          </div>
          <time>live</time>
        </div>

        <section className="terminal-block" aria-label="Live terminal output">
          <header className="terminal-block-header">
            <div>
              <TerminalSquare />
              <span>Terminal output</span>
            </div>
            <div className="terminal-meta">
              {output?.truncated && <span>Earlier lines omitted</span>}
              <span>{loading ? "Refreshing" : `rev ${output?.revision ?? 0}`}</span>
            </div>
          </header>
          <pre className={loading && !output ? "is-loading" : ""}>
            {segments.length > 0 ? (
              segments.map((segment, index) => (
                <span key={`${index}-${segment.text.length}`} style={segment.style} className={segment.muted ? "ansi-muted" : undefined}>
                  {segment.text}
                </span>
              ))
            ) : (
              <span className="terminal-placeholder">Waiting for pane output…</span>
            )}
          </pre>
        </section>

        <div className="session-tail-meta">
          <span>{new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <span>·</span>
          <span>{pane.status}</span>
        </div>
      </div>
    </main>
  );
}
