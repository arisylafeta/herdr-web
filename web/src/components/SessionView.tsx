import { AlertTriangle, TerminalSquare, WifiOff } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { parseAnsi } from "../lib/ansi";
import { isTerminalNearBottom } from "../lib/outputFollow";
import type { AgentView, PaneReadResponse } from "../lib/types";

interface SessionViewProps {
  pane: AgentView | null;
  output: PaneReadResponse | null;
  loading: boolean;
  bridgeConnected: boolean;
  mode: "connecting" | "live" | "offline" | "demo";
}

export function SessionView({ pane, output, loading, bridgeConnected, mode }: SessionViewProps) {
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
      className="session-main terminal-session"
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
    </main>
  );
}
