import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkForUpdates as checkForUpdatesRequest,
  closePane as closePaneRequest,
  createTab as createTabRequest,
  createWorkspace as createWorkspaceRequest,
  fetchPane,
  fetchSnapshot,
  sendKeys as sendKeysRequest,
  sendReply,
  uploadImage as uploadImageRequest,
  ApiError,
} from "../lib/api";
import { demoPaneById, demoSnapshot } from "../lib/mock";
import {
  demoModeFromSearch,
  modeAfterSnapshotFailure,
  modeForSnapshotBridge,
  paneLoadingAfterModeChange,
  shouldApplySnapshot,
  type TransportMode,
} from "../lib/connectionState";
import type { AgentView, PaneReadResponse, SnapshotResponse } from "../lib/types";

const INITIAL_PARAMS = new URLSearchParams(window.location.search);
const FORCE_DEMO = demoModeFromSearch(window.location.search);
const INITIAL_SESSION = INITIAL_PARAMS.get("session") || undefined;
const INITIAL_PANE = INITIAL_PARAMS.get("pane") || undefined;

export interface Notice {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
}

function cloneDemoSnapshot(): SnapshotResponse {
  return structuredClone(demoSnapshot);
}

function emptySnapshot(): SnapshotResponse {
  return {
    bridge: "disconnected",
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    ts: Date.now(),
  };
}

function defaultPane(snapshot: SnapshotResponse): AgentView | undefined {
  return (
    snapshot.agents.find((agent) => agent.status === "blocked") ??
    snapshot.agents.find((agent) => agent.status === "working") ??
    snapshot.agents[0] ??
    snapshot.shellPanes[0]
  );
}

export function useHerdr() {
  const [snapshot, setSnapshot] = useState<SnapshotResponse>(() =>
    FORCE_DEMO ? cloneDemoSnapshot() : emptySnapshot(),
  );
  const [mode, setMode] = useState<TransportMode>(FORCE_DEMO ? "demo" : "connecting");
  const [session, setSessionState] = useState<string | undefined>(INITIAL_SESSION);
  const [selectedPaneId, setSelectedPaneId] = useState(() =>
    INITIAL_PANE ?? (FORCE_DEMO ? defaultPane(demoSnapshot)?.paneId : undefined) ?? "",
  );
  const [paneOutput, setPaneOutput] = useState<PaneReadResponse | null>(() =>
    FORCE_DEMO ? demoPaneById[defaultPane(demoSnapshot)?.paneId ?? ""] ?? null : null,
  );
  const [paneLoading, setPaneLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeId = useRef(0);
  const demoOutput = useRef<Record<string, PaneReadResponse>>(structuredClone(demoPaneById));
  const sessionRef = useRef(session);
  const selectedPaneIdRef = useRef(selectedPaneId);
  selectedPaneIdRef.current = selectedPaneId;
  const snapshotRequestRef = useRef<{
    session: string | undefined;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const snapshotGenerationRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const replyRequestsRef = useRef(new Map<string, { text: string; requestId: string }>());
  const tabCreateRequestRef = useRef<{ signature: string; requestId: string } | null>(null);
  const workspaceCreateRequestRef = useRef<{ signature: string; requestId: string } | null>(null);
  const pendingCreatedPanesRef = useRef(
    new Map<string, { pane: AgentView; expiresAt: number }>(),
  );

  const pushNotice = useCallback((tone: Notice["tone"], message: string) => {
    const next = { id: ++noticeId.current, tone, message };
    setNotice(next);
    window.setTimeout(() => setNotice((current) => (current?.id === next.id ? null : current)), 3600);
  }, []);

  const refreshSnapshot = useCallback((): Promise<void> => {
    if (FORCE_DEMO) {
      setMode("demo");
      if (!selectedPaneIdRef.current) setSelectedPaneId(defaultPane(demoSnapshot)?.paneId ?? "");
      return Promise.resolve();
    }
    const requestedSession = sessionRef.current;
    const existing = snapshotRequestRef.current;
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.session === requestedSession
    ) return existing.promise;
    existing?.controller.abort();
    const generation = ++snapshotGenerationRef.current;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const next = await fetchSnapshot(requestedSession, controller.signal);
        if (!shouldApplySnapshot(requestedSession, sessionRef.current, generation, snapshotGenerationRef.current)) return;
        const authoritativePaneIds = new Set(
          [...next.agents, ...next.shellPanes].map((pane) => pane.paneId),
        );
        const now = Date.now();
        for (const [paneId, pending] of pendingCreatedPanesRef.current) {
          if (authoritativePaneIds.has(paneId) || pending.expiresAt <= now) {
            pendingCreatedPanesRef.current.delete(paneId);
          }
        }
        const pendingPanes = [...pendingCreatedPanesRef.current.values()].map(({ pane }) => pane);
        const published = pendingPanes.length
          ? { ...next, shellPanes: [...next.shellPanes, ...pendingPanes] }
          : next;
        setSnapshot(published);
        setMode(modeForSnapshotBridge(next.bridge));
        if (next.bridge === "connected") hasConnectedRef.current = true;
        const panes = [...published.agents, ...published.shellPanes];
        if (!panes.some((pane) => pane.paneId === selectedPaneIdRef.current)) {
          setSelectedPaneId(defaultPane(next)?.paneId ?? "");
        }
      } catch (error) {
        if (controller.signal.aborted || generation !== snapshotGenerationRef.current) return;
        if (requestedSession && error instanceof ApiError && error.status === 404) {
          // Session names are ephemeral. A stale bookmark or notification must recover to primary
          // instead of retrying an unreachable session forever with no enabled picker option.
          sessionRef.current = undefined;
          pendingCreatedPanesRef.current.clear();
          setSessionState(undefined);
          setSelectedPaneId("");
          setPaneOutput(null);
          setSnapshot(emptySnapshot());
          setMode("connecting");
          const url = new URL(window.location.href);
          url.searchParams.delete("session");
          url.searchParams.delete("pane");
          window.history.replaceState(null, "", url);
          pushNotice("info", `Session '${requestedSession}' is no longer available. Reconnecting to primary.`);
          return;
        }
        const failureMode = modeAfterSnapshotFailure();
        setSnapshot((current) => ({ ...current, bridge: "disconnected" }));
        setMode(failureMode);
        pushNotice("error", hasConnectedRef.current
          ? "Bridge connection lost. Actions will fail until it reconnects."
          : "Herdr bridge is unavailable. Retrying the connection.");
      } finally {
        if (snapshotRequestRef.current?.controller === controller) {
          snapshotRequestRef.current = null;
        }
      }
    })();
    snapshotRequestRef.current = { session: requestedSession, controller, promise };
    return promise;
  }, [pushNotice]);

  useEffect(() => () => snapshotRequestRef.current?.controller.abort(), []);

  useEffect(() => {
    void refreshSnapshot();
    const timer = window.setInterval(() => void refreshSnapshot(), mode === "live" ? 2200 : 5000);
    return () => window.clearInterval(timer);
  }, [mode, refreshSnapshot]);

  useEffect(() => {
    if (!selectedPaneId) {
      setPaneLoading(false);
      setPaneOutput(null);
      return;
    }
    if (mode === "demo") {
      setPaneLoading((current) => paneLoadingAfterModeChange(mode, current));
      setPaneOutput(demoOutput.current[selectedPaneId] ?? null);
      return;
    }
    if (mode !== "live") {
      setPaneLoading((current) => paneLoadingAfterModeChange(mode, current));
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      setPaneLoading(true);
      try {
        const next = await fetchPane(selectedPaneId, session, controller.signal);
        if (!cancelled) setPaneOutput(next);
      } catch (error) {
        if (!cancelled) pushNotice("error", error instanceof Error ? error.message : "Pane read failed");
      } finally {
        inFlight = false;
        if (!cancelled) setPaneLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1600);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [mode, pushNotice, selectedPaneId, session]);

  const allPanes = useMemo(() => [...snapshot.agents, ...snapshot.shellPanes], [snapshot]);
  const selectedPane = allPanes.find((pane) => pane.paneId === selectedPaneId) ?? null;
  const selectedPaneOutput = paneOutput?.paneId === selectedPaneId ? paneOutput : null;

  const selectPane = useCallback((paneId: string) => {
    setSelectedPaneId(paneId);
    const url = new URL(window.location.href);
    url.searchParams.set("pane", paneId);
    window.history.replaceState(null, "", url);
  }, []);

  const setSession = useCallback((next: string | undefined) => {
    snapshotRequestRef.current?.controller.abort();
    snapshotRequestRef.current = null;
    pendingCreatedPanesRef.current.clear();
    tabCreateRequestRef.current = null;
    workspaceCreateRequestRef.current = null;
    snapshotGenerationRef.current++;
    sessionRef.current = next;
    setSessionState(next);
    if (!FORCE_DEMO) {
      // Never leave panes from the previous session selectable while the new session is loading.
      // Pane IDs are commonly reused, so a stale selection could otherwise mutate the new target.
      setSnapshot(emptySnapshot());
      setSelectedPaneId("");
      setPaneOutput(null);
      setMode("connecting");
    }
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("session", next);
    else url.searchParams.delete("session");
    url.searchParams.delete("pane");
    window.history.replaceState(null, "", url);
  }, []);

  const runAction = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
      if (actionInFlightRef.current) {
        pushNotice("info", "Another action is still in progress.");
        return undefined;
      }
      actionInFlightRef.current = true;
      setActionBusy(true);
      try {
        return await operation();
      } catch (error) {
        pushNotice("error", error instanceof Error ? error.message : "Action failed");
        return undefined;
      } finally {
        actionInFlightRef.current = false;
        setActionBusy(false);
      }
    },
    [pushNotice],
  );

  const send = useCallback(
    async (text: string) => {
      if (!selectedPaneId || !text.trim()) return false;
      if (mode === "demo") {
        const current = demoOutput.current[selectedPaneId] ?? {
          paneId: selectedPaneId,
          text: "",
          truncated: false,
          revision: 0,
        };
        const next = {
          ...current,
          revision: current.revision + 1,
          text: `${current.text}\n\n› ${text.trim()}\n\nWorking on that now. The durable pane keeps running even if this browser disconnects.`,
        };
        demoOutput.current[selectedPaneId] = next;
        setPaneOutput(next);
        setSnapshot((currentSnapshot) => ({
          ...currentSnapshot,
          agents: currentSnapshot.agents.map((agent) =>
            agent.paneId === selectedPaneId ? { ...agent, status: "working" } : agent,
          ),
        }));
        pushNotice("success", "Demo reply sent to the pane.");
        return true;
      }

      const normalizedText = text.trim();
      const replyKey = `${session ?? ""}\n${selectedPaneId}`;
      const prior = replyRequestsRef.current.get(replyKey);
      const request = prior?.text === normalizedText
        ? prior
        : { text: normalizedText, requestId: window.crypto.randomUUID() };
      replyRequestsRef.current.set(replyKey, request);
      const result = await runAction(() =>
        sendReply(selectedPaneId, request.text, request.requestId, session),
      );
      if (!result) return false;
      if (replyRequestsRef.current.get(replyKey)?.requestId === request.requestId) {
        replyRequestsRef.current.delete(replyKey);
      }
      if (!result.ok) {
        pushNotice(
          "error",
          result.deliveryAmbiguous
            ? result.error
            : result.textDelivered
            ? `${result.error} Use Enter under special terminal keys to submit it.`
            : result.error,
        );
        // Text is already in the terminal when only the submit key failed. Clear the composer so
        // the operator cannot accidentally duplicate it, while preserving the actionable error.
        return Boolean(result.textDelivered);
      }
      pushNotice("success", "Reply delivered to Herdr.");
      await refreshSnapshot();
      return true;
    },
    [mode, pushNotice, refreshSnapshot, runAction, selectedPaneId, session],
  );

  const sendKeys = useCallback(
    async (keys: string[]) => {
      if (!selectedPaneId) return;
      if (mode === "demo") {
        pushNotice("info", `Sent ${keys.join(" + ")} in demo mode.`);
        return;
      }
      const result = await runAction(() => sendKeysRequest(selectedPaneId, keys, session));
      if (result && !result.ok) pushNotice("error", result.error);
    },
    [mode, pushNotice, runAction, selectedPaneId, session],
  );

  const createTab = useCallback(
    async (workspaceId: string, label: string) => {
      if (mode === "demo") {
        const workspace = snapshot.workspaces.find((item) => item.workspaceId === workspaceId);
        if (!workspace) return;
        const id = `${workspaceId}:demo-${Date.now()}`;
        const pane: AgentView = {
          paneId: `${id}:p1`,
          workspaceId,
          workspaceLabel: workspace.label,
          workspaceNumber: workspace.number,
          tabId: id,
          agent: "shell",
          status: "idle",
          cwd: `/demo/${workspace.label}`,
          focused: false,
          kind: "shell",
        };
        demoOutput.current[pane.paneId] = {
          paneId: pane.paneId,
          text: `shell · ${workspace.label}\n${pane.cwd}\n\n$`,
          truncated: false,
          revision: 1,
        };
        setSnapshot((current) => ({
          ...current,
          shellPanes: [...current.shellPanes, pane],
          tabs: [
            ...current.tabs,
            { tabId: id, workspaceId, number: workspace.tabCount + 1, label: label || "shell", focused: false, paneCount: 1 },
          ],
          workspaces: current.workspaces.map((item) =>
            item.workspaceId === workspaceId
              ? { ...item, tabCount: item.tabCount + 1, paneCount: item.paneCount + 1 }
              : item,
          ),
        }));
        setSelectedPaneId(pane.paneId);
        pushNotice("success", "Demo tab created.");
        return;
      }
      const signature = JSON.stringify({ session, workspaceId, label });
      const prior = tabCreateRequestRef.current;
      const request = prior?.signature === signature
        ? prior
        : { signature, requestId: window.crypto.randomUUID() };
      tabCreateRequestRef.current = request;
      const result = await runAction(() =>
        createTabRequest(workspaceId, label, request.requestId, session),
      );
      if (!result) return;
      if (tabCreateRequestRef.current?.requestId === request.requestId) {
        tabCreateRequestRef.current = null;
      }
      if (!result.ok) {
        if (result.deliveryAmbiguous) await refreshSnapshot();
        return pushNotice("error", result.error);
      }
      if (sessionRef.current !== session) return;
      const workspace = snapshot.workspaces.find((item) => item.workspaceId === workspaceId);
      const pendingPane: AgentView = {
        ...result.pane,
        workspaceNumber: workspace?.number ?? 1,
        agent: "shell",
        status: "idle",
        focused: true,
        kind: "shell",
      };
      pendingCreatedPanesRef.current.set(pendingPane.paneId, {
        pane: pendingPane,
        expiresAt: Date.now() + 15_000,
      });
      selectedPaneIdRef.current = pendingPane.paneId;
      setSelectedPaneId(result.pane.paneId);
      await refreshSnapshot();
      pushNotice("success", "New Herdr tab created.");
    },
    [mode, pushNotice, refreshSnapshot, runAction, session, snapshot.workspaces],
  );

  const createWorkspace = useCallback(
    async (label: string, cwd: string) => {
      if (mode === "demo") {
        const number = snapshot.workspaces.length + 1;
        const workspaceId = `demo-w${number}`;
        const tabId = `${workspaceId}:t1`;
        const paneId = `${workspaceId}:p1`;
        const pane: AgentView = {
          paneId,
          workspaceId,
          workspaceLabel: label || `workspace-${number}`,
          workspaceNumber: number,
          tabId,
          agent: "shell",
          status: "idle",
          cwd: cwd || "/demo",
          focused: false,
          kind: "shell",
        };
        demoOutput.current[paneId] = { paneId, text: `shell\n${pane.cwd}\n\n$`, truncated: false, revision: 1 };
        setSnapshot((current) => ({
          ...current,
          workspaces: [
            ...current.workspaces,
            { workspaceId, number, label: pane.workspaceLabel, focused: false, activeTabId: tabId, tabCount: 1, paneCount: 1 },
          ],
          tabs: [...current.tabs, { tabId, workspaceId, number: 1, label: "shell", focused: true, paneCount: 1 }],
          shellPanes: [...current.shellPanes, pane],
        }));
        setSelectedPaneId(paneId);
        pushNotice("success", "Demo workspace created.");
        return;
      }
      const signature = JSON.stringify({ session, label, cwd });
      const prior = workspaceCreateRequestRef.current;
      const request = prior?.signature === signature
        ? prior
        : { signature, requestId: window.crypto.randomUUID() };
      workspaceCreateRequestRef.current = request;
      const result = await runAction(() =>
        createWorkspaceRequest({ label, cwd }, request.requestId, session),
      );
      if (!result) return;
      if (workspaceCreateRequestRef.current?.requestId === request.requestId) {
        workspaceCreateRequestRef.current = null;
      }
      if (!result.ok) {
        if (result.deliveryAmbiguous) await refreshSnapshot();
        return pushNotice("error", result.error);
      }
      if (sessionRef.current !== session) return;
      const pendingPane: AgentView = {
        ...result.pane,
        workspaceNumber: Math.max(0, ...snapshot.workspaces.map((item) => item.number)) + 1,
        agent: "shell",
        status: "idle",
        focused: true,
        kind: "shell",
      };
      pendingCreatedPanesRef.current.set(pendingPane.paneId, {
        pane: pendingPane,
        expiresAt: Date.now() + 15_000,
      });
      selectedPaneIdRef.current = pendingPane.paneId;
      setSelectedPaneId(result.pane.paneId);
      await refreshSnapshot();
      pushNotice("success", "New Herdr workspace created.");
    },
    [mode, pushNotice, refreshSnapshot, runAction, session, snapshot.workspaces.length],
  );

  const closePane = useCallback(async (paneId: string, targetSession?: string) => {
    if (mode === "demo") {
      setSnapshot((current) => ({
        ...current,
        agents: current.agents.filter((pane) => pane.paneId !== paneId),
        shellPanes: current.shellPanes.filter((pane) => pane.paneId !== paneId),
      }));
      setSelectedPaneId((current) => current === paneId ? "" : current);
      pushNotice("success", "Demo pane closed.");
      return;
    }
    const result = await runAction(() => closePaneRequest(paneId, targetSession));
    if (!result) return;
    if (!result.ok) return pushNotice("error", result.error);
    await refreshSnapshot();
    pushNotice("success", "Pane terminated.");
  }, [mode, pushNotice, refreshSnapshot, runAction]);

  const checkForUpdates = useCallback(async () => {
    if (mode === "demo") {
      pushNotice("info", "Update checks are available through the live bridge.");
      return;
    }
    const update = await runAction(checkForUpdatesRequest);
    if (!update) return;
    setSnapshot((current) => ({ ...current, update }));
    if (!update.enabled) {
      pushNotice("info", "Update checks need COLLIE_UPDATE_REPO configured on the bridge.");
    } else if (update.lastCheckSucceeded === false) {
      pushNotice("error", "The update check could not reach the configured repository.");
    } else if (update.bridgeStale) {
      pushNotice("info", "The bridge was updated on disk and needs a restart.");
    } else if (update.releaseAvailable) {
      pushNotice("info", `Herdr Web ${update.latest} is available.`);
    } else {
      pushNotice("success", "Herdr Web is up to date.");
    }
  }, [mode, pushNotice, runAction]);

  const uploadImage = useCallback(
    async (file: File) => {
      if (!selectedPaneId) return undefined;
      if (mode === "demo") {
        pushNotice("success", "Demo image attached.");
        return `/demo/uploads/${file.name}`;
      }
      const result = await runAction(() => uploadImageRequest(selectedPaneId, file, session));
      if (!result) return undefined;
      if (!result.ok) {
        pushNotice("error", result.error);
        return undefined;
      }
      return result.path;
    },
    [mode, pushNotice, runAction, selectedPaneId, session],
  );

  return {
    snapshot,
    mode,
    session,
    selectedPane,
    selectedPaneId,
    paneOutput: selectedPaneOutput,
    paneLoading,
    actionBusy,
    notice,
    selectPane,
    setSession,
    send,
    sendKeys,
    createTab,
    createWorkspace,
    closePane,
    checkForUpdates,
    uploadImage,
    refreshSnapshot,
  };
}
