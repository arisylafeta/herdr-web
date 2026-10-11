import { useEffect, useRef, useState } from "react";
export function useElapsed(startedAt: string | undefined, active: boolean, frozenMs = 0) {
  const element = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !startedAt || !visible) return;
    let timer: number | undefined;
    const sync = () => { clearInterval(timer); if (document.visibilityState !== "hidden") { setNow(Date.now()); timer = window.setInterval(() => setNow(Date.now()), 1000); } };
    sync(); document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [active, startedAt, visible]);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  return { element, elapsed: active && Number.isFinite(start) ? Math.max(0, now - start) : frozenMs };
}
