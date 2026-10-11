import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

function visibleTabbables(sheet: HTMLElement): HTMLElement[] {
  const candidates = [...sheet.querySelectorAll<HTMLElement>("button,a[href],area[href],input,select,textarea,summary,iframe,object,embed,audio[controls],video[controls],[tabindex],[contenteditable='true']")];
  return candidates.filter(node => {
    if (node.closest(".work-sheet") !== sheet || node.matches(":disabled,input[type='hidden']") || node.getAttribute("aria-disabled") === "true") return false;
    if (node.hasAttribute("tabindex") && node.tabIndex < 0) return false;
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.hasAttribute("inert") || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector(":scope > summary") !== node) return false;
    }
    return true;
  }).sort((left, right) => {
    const a = left.tabIndex > 0 ? left.tabIndex : Infinity;
    const b = right.tabIndex > 0 ? right.tabIndex : Infinity;
    return a === b ? 0 : a - b;
  });
}
export function WorkSheet({ id, title, close, children }: { id: string; title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      const sheets = document.querySelectorAll(".work-sheet");
      if (sheets.item(sheets.length - 1) !== dialog.current) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onClose.current(); }
      if (event.key === "Tab") {
        const controls = dialog.current ? visibleTabbables(dialog.current) : [];
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
