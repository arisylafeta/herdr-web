import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function WorkSheet({ id, title, close, children }: { id: string; title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onClose.current(); }
      if (event.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, [tabindex="0"]') ?? [])];
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); launcher?.focus(); };
  }, []);
  return <div className="work-sheet-scrim" onClick={close}><div ref={dialog} id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} className="work-sheet" onClick={event => event.stopPropagation()}><header><h2 id={`${id}-heading`}>{title}</h2><button type="button" aria-label={`Close ${title}`} onClick={close}><X aria-hidden="true" /></button></header><div className="work-sheet-content">{children}</div></div></div>;
}
