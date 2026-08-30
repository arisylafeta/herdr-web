import { useCallback, useEffect, useState } from "react";
import type { BridgeReceiver } from "../lib/receiver";
import {
  disablePush,
  enablePush,
  getPushState,
  isPushDisabledByUser,
  type EnableResult,
  type PushState,
} from "../lib/push";

export function usePushSetup(receiver: BridgeReceiver) {
  useEffect(() => {
    if (isPushDisabledByUser() || !("Notification" in window) || Notification.permission !== "granted") return;
    void enablePush(receiver, false).catch(() => undefined);
  }, [receiver]);
}

export function usePushControl(receiver: BridgeReceiver, active = true) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => setState(await getPushState(receiver)), [receiver]);
  useEffect(() => {
    if (active) {
      void refresh().then(() => setError(null)).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Push status could not be loaded.");
      });
    }
  }, [active, refresh]);
  const setEnabled = useCallback(
    async (enabled: boolean): Promise<EnableResult> => {
      setBusy(true);
      setError(null);
      try {
        let result: EnableResult;
        if (enabled) result = await enablePush(receiver, true);
        else {
          await disablePush(receiver);
          result = { ok: true };
        }
        await refresh();
        return result;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Push settings could not be changed.");
        await refresh().catch(() => undefined);
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [receiver, refresh],
  );
  return { state, busy, error, setEnabled };
}
