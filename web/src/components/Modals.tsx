import { AlertTriangle, Bell, BellRing, ExternalLink, FolderPlus, LoaderCircle, Monitor, Moon, RefreshCw, Search, SquarePen, Sun, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePushControl } from "../hooks/usePush";
import { sendPushTest } from "../lib/api";
import type { ThemePreference } from "../lib/theme";
import type { AgentView, SnapshotResponse, UpdateStatus } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface BaseModalProps {
  open: boolean;
  title: string;
  description?: string;
  centered?: boolean;
  focusDialog?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

function BaseModal({ open, title, description, centered = false, focusDialog = false, onClose, children }: BaseModalProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !focusDialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => previousFocus?.focus({ preventScroll: true });
  }, [focusDialog, open]);

  if (!open) return null;
  return (
    <div
      className={`modal-layer${centered ? " modal-layer-centered" : ""}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={focusDialog ? -1 : undefined}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function CreateWorkspaceModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (label: string, cwd: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  return (
    <BaseModal open={open} onClose={onClose} title="New workspace" description="Create a durable Herdr workspace with a shell pane.">
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(label.trim(), cwd.trim());
          setLabel("");
          setCwd("");
          onClose();
        }}
      >
        <label>
          <span>Name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="control-plane" autoFocus />
        </label>
        <label>
          <span>Working directory</span>
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Defaults to the host home directory" />
        </label>
        <footer className="modal-footer">
          <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="button-primary">
            <FolderPlus />
            Create workspace
          </button>
        </footer>
      </form>
    </BaseModal>
  );
}

export function CreateTabModal({
  open,
  workspaceLabel,
  onClose,
  onCreate,
}: {
  open: boolean;
  workspaceLabel: string;
  onClose: () => void;
  onCreate: (label: string) => void;
}) {
  const [label, setLabel] = useState("");
  return (
    <BaseModal
      open={open}
      centered
      focusDialog
      onClose={onClose}
      title="New pane"
      description={`Open a new shell tab in ${workspaceLabel}.`}
    >
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(label.trim());
          setLabel("");
          onClose();
        }}
      >
        <label>
          <span>Tab name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="agent" />
        </label>
        <footer className="modal-footer">
          <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="button-primary">
            <SquarePen />
            Create pane
          </button>
        </footer>
      </form>
    </BaseModal>
  );
}

export function ConfirmCloseModal({
  open,
  pane,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pane: AgentView | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <BaseModal open={open} onClose={onClose} title="Terminate pane" description="This stops the process running in the selected Herdr pane.">
      <div className="confirm-body">
        <AlertTriangle />
        <p>
          Terminate <strong>{pane?.agent ?? "this pane"}</strong> in <strong>{pane?.workspaceLabel ?? "the workspace"}</strong>?
        </p>
      </div>
      <footer className="modal-footer modal-footer-padded">
        <button className="button-secondary" onClick={onClose}>Cancel</button>
        <button
          className="button-danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          Terminate
        </button>
      </footer>
    </BaseModal>
  );
}

export function CommandPalette({
  open,
  snapshot,
  onClose,
  onSelect,
  onNewWorkspace,
  readOnly,
}: {
  open: boolean;
  snapshot: SnapshotResponse;
  onClose: () => void;
  onSelect: (paneId: string) => void;
  onNewWorkspace: () => void;
  readOnly: boolean;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panes = useMemo(
    () =>
      [...snapshot.agents, ...snapshot.shellPanes].filter((pane) =>
        `${pane.agent} ${pane.workspaceLabel} ${pane.cwd}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, snapshot],
  );

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
    else setQuery("");
  }, [open]);

  return (
    <BaseModal open={open} onClose={onClose} title="Jump to pane">
      <div className="command-search">
        <Search />
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspaces and panes" />
        <kbd>Esc</kbd>
      </div>
      <div className="command-results">
        <div className="command-section-label">Panes</div>
        {panes.map((pane) => (
          <button
            key={pane.paneId}
            onClick={() => {
              onSelect(pane.paneId);
              onClose();
            }}
          >
            <StatusDot status={pane.status} pulse={pane.status === "working"} />
            <span>
              <strong>{pane.agent}</strong>
              <small>{pane.workspaceLabel} · {pane.cwd}</small>
            </span>
          </button>
        ))}
        {panes.length === 0 && <div className="command-empty">No matching panes</div>}
        <div className="command-section-label">Actions</div>
        <button
          disabled={readOnly}
          title={readOnly ? "Read-only access" : "Create a Herdr workspace"}
          onClick={() => {
            onClose();
            onNewWorkspace();
          }}
        >
          <FolderPlus />
          <span>
            <strong>New workspace</strong>
            <small>Create a Herdr workspace and shell</small>
          </span>
        </button>
      </div>
    </BaseModal>
  );
}

export function SettingsModal({
  open,
  themePreference,
  update,
  updateBusy,
  readOnly,
  onThemeChange,
  onClose,
  onCheckUpdates,
}: {
  open: boolean;
  themePreference: ThemePreference;
  update: UpdateStatus | undefined;
  updateBusy: boolean;
  readOnly: boolean;
  onThemeChange: (preference: ThemePreference) => void;
  onClose: () => void;
  onCheckUpdates: () => void;
}) {
  const { state, busy, error: pushError, setEnabled } = usePushControl(open);
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [pushTestStatus, setPushTestStatus] = useState<string | null>(null);
  const pushEnabled = Boolean(state?.subscribed && !state.userDisabled);
  const localPushEnabled = Boolean(state?.localSubscribed && !state.userDisabled);
  const pushToggleOn = pushEnabled || localPushEnabled;
  const pushStatus = pushError
    ? `Could not update: ${pushError}`
    : readOnly && !pushEnabled
    ? "Read-only access"
    : !state
    ? "Checking…"
    : state.availability === "ready"
      ? pushEnabled
        ? "Enabled on this device"
        : localPushEnabled
          ? "Local subscription needs repair"
        : "Available"
      : state.availability === "server-off"
        ? "Unavailable on this bridge"
        : state.availability === "insecure"
          ? "Requires HTTPS"
          : state.availability === "denied"
            ? "Blocked by the browser"
            : "Not supported";
  const updateStatus = !update
    ? "Waiting for bridge status"
    : !update.enabled
      ? "Set COLLIE_UPDATE_REPO to enable release checks"
    : update.lastCheckSucceeded === false
      ? "Last release check failed"
    : update.bridgeStale
      ? "Restart required to load the installed build"
      : update.releaseAvailable
        ? `${update.latest} available · running ${update.current}`
        : `Running ${update.current}`;
  return (
    <BaseModal open={open} onClose={onClose} title="Connection settings" description="The bridge remains loopback-only; Tailscale provides remote ingress.">
      <div className="settings-list">
        <div>
          <span>Bridge endpoint</span>
          <code>{window.location.origin}</code>
        </div>
        <div>
          <span>Remote access</span>
          <strong>tailscale serve</strong>
        </div>
        <div>
          <span>Session discovery</span>
          <strong>All named Herdr sessions</strong>
        </div>
        <div>
          <span>Client build</span>
          <code>{__BUILD_INFO__.version}+{__BUILD_INFO__.sha}</code>
        </div>
        <div className="settings-update-row">
          <span className="settings-notification-copy">
            <RefreshCw />
            <span>
              <strong>Bridge update</strong>
              <small>{updateStatus}</small>
            </span>
          </span>
          <span className="settings-update-actions">
            {update?.releaseAvailable && update.latestUrl && (
              <a href={update.latestUrl} target="_blank" rel="noreferrer" title={`Open Herdr Web ${update.latest} release`}>
                <ExternalLink />
              </a>
            )}
            <button className="icon-button" disabled={updateBusy || update?.enabled === false} onClick={onCheckUpdates} title={update?.enabled === false ? "Update repository is not configured" : "Check for updates"}>
              {updateBusy ? <LoaderCircle className="is-spinning" /> : <RefreshCw />}
            </button>
          </span>
        </div>
        <div className="settings-theme-row">
          <span className="settings-notification-copy">
            <Sun />
            <span>
              <strong>Appearance</strong>
              <small>Choose how Herdr Web looks</small>
            </span>
          </span>
          <span className="theme-control" aria-label="Color theme">
            {([
              ["system", Monitor, "System"],
              ["light", Sun, "Light"],
              ["dark", Moon, "Dark"],
            ] as const).map(([value, Icon, label]) => (
              <button
                key={value}
                className={themePreference === value ? "is-active" : ""}
                aria-label={label}
                aria-pressed={themePreference === value}
                onClick={() => onThemeChange(value)}
                title={`${label} theme`}
              >
                <Icon />
              </button>
            ))}
          </span>
        </div>
        <div className="settings-notification-row">
          <span className="settings-notification-copy">
            <Bell />
            <span>
              <strong>Push notifications</strong>
              <small>{pushStatus}</small>
            </span>
          </span>
          <span className="settings-push-actions">
            {pushToggleOn && (
              <button
                className="push-test-button"
                disabled={readOnly || pushTestBusy || !pushEnabled}
                onClick={() => {
                  setPushTestBusy(true);
                  setPushTestStatus(null);
                  void sendPushTest()
                    .then((result) => setPushTestStatus(`Sent to ${result.subscribers} device${result.subscribers === 1 ? "" : "s"}`))
                    .catch((reason: unknown) => setPushTestStatus(reason instanceof Error ? reason.message : "Test failed"))
                    .finally(() => setPushTestBusy(false));
                }}
                title={readOnly ? "Read-only access" : "Send a test notification"}
              >
                {pushTestBusy ? <LoaderCircle className="is-spinning" /> : <BellRing />}
                <span>{pushTestStatus ?? "Test"}</span>
              </button>
            )}
            <button
              className={`notification-toggle${pushToggleOn ? " is-on" : ""}`}
              aria-pressed={pushToggleOn}
              disabled={busy || !state || (readOnly && !pushToggleOn) || (!pushToggleOn && state.availability !== "ready")}
              onClick={() => {
                setPushTestStatus(null);
                void setEnabled(!pushToggleOn);
              }}
              title={readOnly && !pushToggleOn ? "Read-only access" : pushToggleOn ? "Disable push notifications" : "Enable push notifications"}
            >
              {busy ? <LoaderCircle /> : <span />}
            </button>
          </span>
        </div>
      </div>
    </BaseModal>
  );
}
