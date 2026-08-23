import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  PanelLeftClose,
  Search,
  Settings,
  SquareCheck,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentView, SnapshotResponse } from "../lib/types";
import { STATUS_LABEL } from "../lib/types";

interface SidebarProps {
  snapshot: SnapshotResponse;
  selectedPaneId: string;
  mode: "connecting" | "live" | "offline" | "demo";
  readOnly: boolean;
  compact: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onSelectPane: (paneId: string) => void;
  onSearch: () => void;
  onNewWorkspace: () => void;
  onNewTab: (workspaceId: string) => void;
  onOpenSettings: () => void;
}

export function paneTitle(pane: AgentView, tabLabel = ""): string {
  if (pane.kind === "shell") return "Shell";
  const name = pane.name?.trim();
  if (name) return name;
  const tab = tabLabel.trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const workspace = pane.workspaceLabel.trim();
  if (workspace) return workspace;
  return pane.agent.charAt(0).toUpperCase() + pane.agent.slice(1);
}

function relativePath(pane: AgentView): string {
  const parts = pane.cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || pane.cwd;
}

export function Sidebar({
  snapshot,
  selectedPaneId,
  mode,
  readOnly,
  compact,
  mobileOpen,
  onMobileClose,
  onSelectPane,
  onSearch,
  onNewWorkspace,
  onNewTab,
  onOpenSettings,
}: SidebarProps) {
  const allPanes = useMemo(() => [...snapshot.agents, ...snapshot.shellPanes], [snapshot]);
  const tabLabels = useMemo(
    () => new Map(snapshot.tabs.map((tab) => [tab.tabId, tab.label])),
    [snapshot.tabs],
  );
  const selectedPane = allPanes.find((pane) => pane.paneId === selectedPaneId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedPane) return;
    setCollapsed((current) => {
      if (!current.has(selectedPane.workspaceId)) return current;
      const next = new Set(current);
      next.delete(selectedPane.workspaceId);
      return next;
    });
  }, [selectedPane]);

  const toggleWorkspace = (workspaceId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  return (
    <>
      <button
        className={`sidebar-scrim${mobileOpen ? " is-visible" : ""}`}
        aria-label="Close sidebar"
        aria-hidden={!mobileOpen}
        tabIndex={mobileOpen ? 0 : -1}
        onClick={onMobileClose}
      />
      <aside
        className={`sidebar${mobileOpen ? " is-open" : ""}`}
        aria-label="Herdr workspaces"
        aria-hidden={compact && !mobileOpen}
        inert={compact && !mobileOpen}
      >
        <header className="sidebar-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              <span>H</span>
              <i />
            </span>
            <span className="brand-name">Herdr</span>
            <span className="brand-stage">CONTROL</span>
          </div>
          <button className="icon-button sidebar-close" onClick={onMobileClose} title="Close sidebar">
            <PanelLeftClose />
          </button>
        </header>

        <div className="sidebar-search-row">
          <button className="search-button" onClick={onSearch}>
            <Search />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
        </div>

        <div className="sidebar-section-heading">
          <span>Workspaces</span>
          <div className="sidebar-heading-actions">
            <button
              className="mini-icon-button"
              onClick={onNewWorkspace}
              disabled={readOnly}
              aria-label="New workspace"
              title={readOnly ? "Read-only access" : "New workspace"}
            >
              <FolderPlus />
            </button>
          </div>
        </div>

        <div className="workspace-list">
          {snapshot.workspaces.map((workspace) => {
            const workspacePanes = allPanes.filter((pane) => pane.workspaceId === workspace.workspaceId);
            const isCollapsed = collapsed.has(workspace.workspaceId);
            return (
              <section className="workspace-group" key={workspace.workspaceId}>
                <div className="workspace-row">
                  <button
                    className="workspace-toggle"
                    onClick={() => toggleWorkspace(workspace.workspaceId)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                    <span className="workspace-symbol" aria-hidden="true">
                      <Folder />
                    </span>
                    <span className="workspace-label">{workspace.label}</span>
                  </button>
                  <button
                    className="mini-icon-button workspace-add"
                    onClick={() => onNewTab(workspace.workspaceId)}
                    disabled={readOnly}
                    aria-label={`New tab in ${workspace.label}`}
                    title={readOnly ? "Read-only access" : `New tab in ${workspace.label}`}
                  >
                    <SquarePen />
                  </button>
                </div>

                {!isCollapsed && (
                  <div className="pane-list">
                    {workspacePanes.length === 0 && <div className="empty-workspace-row">No panes</div>}
                    {workspacePanes.map((pane) => (
                      <button
                        className={`pane-row${pane.paneId === selectedPaneId ? " is-active" : ""}`}
                        key={pane.paneId}
                        onClick={() => {
                          onSelectPane(pane.paneId);
                          onMobileClose();
                        }}
                      >
                        <span className="pane-row-copy">
                          <span className="pane-row-title">
                            <strong>{paneTitle(pane, tabLabels.get(pane.tabId))}</strong>
                            {pane.kind === "shell" ? (
                              <span className="pane-shell-icon" aria-label="Shell"><TerminalSquare /></span>
                            ) : (
                              <span className={`sidebar-status-badge sidebar-status-${pane.status}`}>
                                {pane.status === "done" && <SquareCheck aria-hidden="true" />}
                                {STATUS_LABEL[pane.status]}
                              </span>
                            )}
                          </span>
                          <span className="pane-row-path">{relativePath(pane)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <footer className="sidebar-footer">
          <button className="settings-button" onClick={onOpenSettings}>
            <Settings />
            <span>Settings</span>
          </button>
          <div className="bridge-mode" title={mode === "demo" ? "Using the built-in demo transport" : "Connected to the Herdr bridge"}>
            <span className={`bridge-mode-dot mode-${mode}`} />
            <span>{mode === "demo" ? "Demo" : mode === "live" ? "Live" : mode === "offline" ? "Offline" : "Connecting"}</span>
          </div>
        </footer>
      </aside>
    </>
  );
}
