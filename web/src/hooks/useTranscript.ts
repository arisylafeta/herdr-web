import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeReceiver } from "../lib/receiver";
import type { AgentView } from "../lib/types";
import type { TranscriptResponse } from "../lib/transcript-types";
import { demoTranscript } from "../lib/mock";

export function useTranscript(receiver: BridgeReceiver, session: string | undefined, pane: AgentView | null, visible: boolean, demo: boolean) {
  const context = `${receiver.id}\n${receiver.baseUrl}\n${session ?? ""}\n${pane?.paneId ?? ""}`;
  const [windowState, setWindow] = useState({ context, limit: 60 });
  const limit = windowState.context === context ? windowState.limit : 60;
  const [state, setState] = useState<{ context: string; data: TranscriptResponse | null; reconnecting: boolean; loading: boolean }>({ context, data: null, reconnecting: false, loading: false });
  const status = pane?.status;
  const latest = useRef({ visible, status });
  latest.current = { visible, status };
  const enabled = Boolean(pane?.transcript);
  const paneId = pane?.paneId;

  useEffect(() => {
    if (!enabled || !paneId) return;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    setState((previous) => ({ context, data: previous.context === context ? previous.data : null, reconnecting: false, loading: true }));
    const poll = async () => {
      try {
        const data = demo ? demoTranscript(paneId, limit, latest.current.status ?? "unknown") : await receiver.transcript(paneId, limit, session, controller.signal);
        if (!cancelled) setState({ context, data, reconnecting: false, loading: false });
      } catch {
        if (!cancelled) setState((previous) => ({ context, data: previous.context === context ? previous.data : null, reconnecting: true, loading: false }));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), (latest.current.visible && document.visibilityState !== "hidden") || latest.current.status === "working" ? 1200 : 6000);
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [context, demo, enabled, limit, paneId, receiver, session]);

  const showEarlier = useCallback(() => setWindow((previous) => ({ context, limit: Math.min(400, (previous.context === context ? previous.limit : 60) + 60) })), [context]);
  const data = state.context === context ? state.data : null;
  return { data, loading: state.context !== context || state.loading, reconnecting: state.context === context && state.reconnecting, showEarlier };
}
