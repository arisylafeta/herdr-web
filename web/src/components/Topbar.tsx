import {
  ChevronDown,
  Menu,
  MoreHorizontal,
  Network,
  PanelRight,
  Plus,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AgentView, TabView } from "../lib/types";
import type { BridgeProfile } from "../lib/receiver";
import { STATUS_LABEL } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface TopbarProps {
  pane: AgentView | null;
  tab: TabView | undefined;
  bridges: BridgeProfile[];
  bridgeId: string;
  bridgeConnected: boolean;
  readOnly: boolean;
  onBridgeChange: (bridgeId: string) => void;
  onOpenSidebar: () => void;
  onNewTab: () => void;
  onRefresh: () => void;
  onClosePane: () => void;
}

export function Topbar({
  pane,
  tab,
  bridges,
  bridgeId,
  bridgeConnected,
  readOnly,
  onBridgeChange,
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
          <h1>{pane ? `${pane.agent === "shell" ? "Shell" : pane.agent} · ${pane.workspaceLabel}` : "Herd overview"}</h1>
          {pane && <StatusDot status={pane.status} pulse={pane.status === "working"} />}
        </div>
        <span>
          {pane
            ? tab?.label
              ? `${tab.label} · ${STATUS_LABEL[pane.status]}`
              : STATUS_LABEL[pane.status]
            : "Select a pane to begin"}
        </span>
      </div>

      <div className="topbar-actions">
        {bridges.length > 1 && (
          <label className="device-select" title="Switch Herdr device">
            <Network />
            <select value={bridgeId} onChange={(event) => onBridgeChange(event.target.value)}>
              {bridges.map((bridge) => (
                <option key={bridge.id} value={bridge.id}>{bridge.label}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
        )}

        <button
          className="topbar-button"
          onClick={onNewTab}
          disabled={!pane || readOnly}
          title={readOnly ? "Read-only access" : "Open a new pane"}
        >
          <Plus />
          <span>New pane</span>
        </button>

        <button className="icon-button" onClick={onRefresh} title="Refresh device">
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
