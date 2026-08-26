import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Composer } from "./components/Composer";
import {
  CommandPalette,
  ConfirmCloseModal,
  CreateTabModal,
  CreateWorkspaceModal,
  SettingsModal,
} from "./components/Modals";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useHerdr } from "./hooks/useHerdr";
import { usePushSetup } from "./hooks/usePush";
import { useTheme } from "./lib/theme";
import { isReadOnly, type AgentView } from "./lib/types";

export default function App() {
  usePushSetup();
  const theme = useTheme();
  const herdr = useHerdr();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [compactSidebar, setCompactSidebar] = useState(() =>
    window.matchMedia("(max-width: 820px)").matches,
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [newTabWorkspaceId, setNewTabWorkspaceId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(window.location.search).has("settings"));
  const [confirmCloseTarget, setConfirmCloseTarget] = useState<{
    pane: AgentView;
    session: string | undefined;
  } | null>(null);

  const selectedTab = herdr.snapshot.tabs.find((tab) => tab.tabId === herdr.selectedPane?.tabId);
  const sessions = herdr.snapshot.sessions?.length
    ? herdr.snapshot.sessions
    : [
        {
          name: "default",
          isPrimary: true,
          reachable: herdr.snapshot.bridge === "connected",
          agents: herdr.snapshot.agents.length,
          working: herdr.snapshot.agents.filter((agent) => agent.status === "working").length,
          blocked: herdr.snapshot.agents.filter((agent) => agent.status === "blocked").length,
        },
      ];
  const newTabWorkspace = herdr.snapshot.workspaces.find(
    (workspace) => workspace.workspaceId === newTabWorkspaceId,
  );
  const readOnly = isReadOnly(herdr.snapshot.device);
  const update = herdr.snapshot.update;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => setCompactSidebar(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!compactSidebar) setMobileSidebarOpen(false);
  }, [compactSidebar]);

  const openNewWorkspace = useCallback(() => {
    if (!readOnly) setWorkspaceModalOpen(true);
  }, [readOnly]);

  const openNewTab = useCallback(
    (workspaceId?: string) => {
      if (!readOnly && workspaceId) setNewTabWorkspaceId(workspaceId);
    },
    [readOnly],
  );

  useEffect(() => {
    if (!readOnly) return;
    setWorkspaceModalOpen(false);
    setNewTabWorkspaceId(null);
    setConfirmCloseTarget(null);
  }, [readOnly]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!readOnly && herdr.selectedPane) setNewTabWorkspaceId(herdr.selectedPane.workspaceId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [herdr.selectedPane, readOnly]);

  const appClassName = useMemo(
    () => `app-shell mode-${herdr.mode}${mobileSidebarOpen ? " sidebar-mobile-open" : ""}`,
    [herdr.mode, mobileSidebarOpen],
  );

  return (
    <div className={appClassName}>
      <Sidebar
        snapshot={herdr.snapshot}
        selectedPaneId={herdr.selectedPaneId}
        mode={herdr.mode}
        readOnly={readOnly}
        compact={compactSidebar}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        onSelectPane={herdr.selectPane}
        onSearch={() => setCommandOpen(true)}
        onNewWorkspace={openNewWorkspace}
        onNewTab={openNewTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <section className="workspace-surface">
        <Topbar
          pane={herdr.selectedPane}
          tab={selectedTab}
          sessions={sessions}
          session={herdr.session}
          bridgeConnected={herdr.snapshot.bridge === "connected"}
          readOnly={readOnly}
          onSessionChange={herdr.setSession}
          onOpenSidebar={() => setMobileSidebarOpen(true)}
          onNewTab={() => openNewTab(herdr.selectedPane?.workspaceId)}
          onRefresh={() => void herdr.refreshSnapshot()}
          onClosePane={() => {
            if (!readOnly && herdr.selectedPane) {
              setConfirmCloseTarget({ pane: herdr.selectedPane, session: herdr.session });
            }
          }}
        />

        {update?.bridgeStale ? (
          <div className="update-banner update-banner-restart" role="status">
            <RefreshCw />
            <span>The bridge changed on disk and needs a restart.</span>
            <button onClick={() => setSettingsOpen(true)}>Review</button>
          </div>
        ) : update?.releaseAvailable ? (
          <div className="update-banner" role="status">
            <RefreshCw />
            <span>Herdr Web {update.latest} is available.</span>
            {update.latestUrl && (
              <a href={update.latestUrl} target="_blank" rel="noreferrer">
                View release
                <ExternalLink />
              </a>
            )}
          </div>
        ) : null}

        <SessionView
          pane={herdr.selectedPane}
          output={herdr.paneOutput}
          loading={herdr.paneLoading}
          bridgeConnected={herdr.snapshot.bridge === "connected"}
          mode={herdr.mode}
        />

        <Composer
          pane={herdr.selectedPane}
          tab={selectedTab}
          session={herdr.session}
          busy={herdr.actionBusy}
          readOnly={readOnly}
          onSend={herdr.send}
          onStop={() => void herdr.interrupt()}
          onSendKeys={(keys) => void herdr.sendKeys(keys)}
          onUpload={herdr.uploadImage}
        />
      </section>

      {herdr.notice && <div className={`toast toast-${herdr.notice.tone}`}>{herdr.notice.message}</div>}

      <CommandPalette
        open={commandOpen}
        snapshot={herdr.snapshot}
        readOnly={readOnly}
        onClose={() => setCommandOpen(false)}
        onSelect={herdr.selectPane}
        onNewWorkspace={openNewWorkspace}
      />
      <CreateWorkspaceModal
        open={workspaceModalOpen}
        onClose={() => setWorkspaceModalOpen(false)}
        onCreate={(label, cwd) => void herdr.createWorkspace(label, cwd)}
      />
      <CreateTabModal
        open={Boolean(newTabWorkspace)}
        workspaceLabel={newTabWorkspace?.label ?? "workspace"}
        onClose={() => setNewTabWorkspaceId(null)}
        onCreate={(label) => newTabWorkspace && void herdr.createTab(newTabWorkspace.workspaceId, label)}
      />
      <ConfirmCloseModal
        open={Boolean(confirmCloseTarget)}
        pane={confirmCloseTarget?.pane ?? null}
        onClose={() => setConfirmCloseTarget(null)}
        onConfirm={() => {
          const target = confirmCloseTarget;
          setConfirmCloseTarget(null);
          if (target) void herdr.closePane(target.pane.paneId, target.session);
        }}
      />
      <SettingsModal
        open={settingsOpen}
        themePreference={theme.preference}
        update={update}
        updateBusy={herdr.actionBusy}
        readOnly={readOnly}
        onThemeChange={theme.setPreference}
        onCheckUpdates={() => void herdr.checkForUpdates()}
        onClose={() => {
          setSettingsOpen(false);
          const url = new URL(window.location.href);
          url.searchParams.delete("settings");
          window.history.replaceState(null, "", url);
        }}
      />
    </div>
  );
}
