import {
  ChevronDown,
  Menu,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AgentView, SessionSummary, TabView } from "../lib/types";
import { STATUS_LABEL } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface TopbarProps {
  pane: AgentView | null;
  tab: TabView | undefined;
  sessions: SessionSummary[];
  session: string | undefined;
  bridgeConnected: boolean;
  readOnly: boolean;
  onSessionChange: (session: string | undefined) => void;
  onOpenSidebar: () => void;
  onNewTab: () => void;
  onRefresh: () => void;
  onClosePane: () => void;
}

export function Topbar({
  pane,
  tab,
  sessions,
  session,
  bridgeConnected,
  readOnly,
  onSessionChange,
  onOpenSidebar,
  onNewTab,
  onRefresh,
  onClosePane,
}: TopbarProps) {
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onOpenSidebar} title="Open sidebar">
        <Menu />
      </button>

      <div className="topbar-title">
        <div className="topbar-title-row">
          <strong>{pane ? `${pane.agent === "shell" ? "Shell" : pane.agent} · ${pane.workspaceLabel}` : "Herd overview"}</strong>
          {pane && <StatusDot status={pane.status} pulse={pane.status === "working"} />}
        </div>
        <span>{tab?.label ?? (pane ? STATUS_LABEL[pane.status] : "Select a pane to begin")}</span>
      </div>

      <div className="topbar-actions">
        <label className="session-select" title="Switch Herdr session">
          <Server />
          <select value={session ?? ""} onChange={(event) => onSessionChange(event.target.value || undefined)}>
            {sessions.map((item) => (
              <option key={item.name} value={item.isPrimary ? "" : item.name} disabled={!item.reachable}>
                {item.name}{item.blocked ? ` · ${item.blocked} blocked` : ""}
              </option>
            ))}
          </select>
          <ChevronDown />
        </label>

        <button
          className="topbar-button"
          onClick={onNewTab}
          disabled={!pane || readOnly}
          title={readOnly ? "Read-only access" : "Open a new pane"}
        >
          <Plus />
          <span>New pane</span>
        </button>

        <button className="icon-button" onClick={onRefresh} title="Refresh session">
          <RefreshCw />
        </button>
        <button className="icon-button desktop-only" title="Open terminal controls">
          <SquareTerminal />
        </button>
        <button className="icon-button desktop-only" title="Toggle details panel">
          <PanelRight />
        </button>
        <div className={`connection-indicator${bridgeConnected ? " is-connected" : ""}`} title={bridgeConnected ? "Herdr bridge connected" : "Herdr bridge disconnected"}>
          <span />
        </div>
        <div className="topbar-more-wrap">
          <button className="icon-button" title="Pane actions">
            <MoreHorizontal />
          </button>
          <button
            className="terminate-button"
            onClick={onClosePane}
            disabled={!pane || readOnly}
            title={readOnly ? "Read-only access" : "Terminate pane"}
          >
            <X />
          </button>
        </div>
      </div>
    </header>
  );
}
