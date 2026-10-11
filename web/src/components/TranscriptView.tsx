import { ChevronDown, ShieldAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BridgeReceiver } from "../lib/receiver";
import { demoImageUrl, demoLongOutput } from "../lib/mock";
import { parseAnsi } from "../lib/ansi";
import type { AgentView, PaneReadResponse } from "../lib/types";
import type { ImageRef, TranscriptRecord, TranscriptResponse } from "../lib/transcript-types";
import { isTranscriptNearBottom, transcriptScrollTop, type ScrollMetrics } from "../lib/transcriptFollow";
import { Markdown } from "./Markdown";
import { ToolDetails } from "./ToolDetails";
import { VibeCard, vibeSummary } from "./VibeCard";
import { TodoPanel, todoCounts } from "./TodoPanel";
import { SubagentTree } from "./SubagentTree";
import { IrcRow } from "./IrcRow";
import { disclosureId } from "../lib/workState";

function UnknownRecord({ record }: { record: { id: string; kind: string; summary?: string; text?: string } }) {
  return <section className="transcript-divider" data-record-id={record.id}>Unrecognized {record.kind} event{record.summary || record.text ? ` · ${record.summary ?? record.text}` : ""}</section>;
}

export interface TranscriptViewProps {
  pane: AgentView;
  data: TranscriptResponse | null;
  reconnecting: boolean;
  loading: boolean;
  output: PaneReadResponse | null;
  onEarlier: () => void;
  receiver: BridgeReceiver;
  session?: string;
  demo: boolean;
  readOnly: boolean;
  onSendKeys: (keys: string[]) => void;
}

export function groupTranscriptRecords(records: TranscriptRecord[]): TranscriptRecord[][] {
  const groups: TranscriptRecord[][] = [];
  for (const record of records) {
    const assistantSide = record.kind === "assistant" || record.kind === "tool" || record.kind === "thinking";
    const previous = groups[groups.length - 1];
    const priorKind = previous?.[0]?.kind;
    if (assistantSide && previous && (priorKind === "assistant" || priorKind === "tool" || priorKind === "thinking")) previous.push(record);
    else groups.push([record]);
  }
  return groups;
}

type ToolRecord = Extract<TranscriptRecord, { kind: "tool" }>;
type ToolSnapshot = Extract<TranscriptRecord, { kind: "vibe" | "subagents" }>;
function ToolCard({ record, expanded, toggle, receiver, paneId, session, children, demo, detailId, snapshot }: {
  record: ToolRecord; expanded: boolean; toggle: () => void; receiver: BridgeReceiver; paneId: string; session?: string; children: React.ReactNode; demo: boolean; detailId: string; snapshot?: ToolSnapshot;
}) {
  const [full, setFull] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const output = full ?? record.output;
  const interrupted = record.status === "error" && record.output?.text.trim().toLowerCase() === "interrupted";
  const glyph = /bash|shell|exec/.test(record.name) ? ">_" : /read/.test(record.name) ? "▤" : /write|edit/.test(record.name) ? "✎" : "⚙";
  return <section className={`tool-card tool-${interrupted ? "interrupted" : record.status}`} data-record-id={record.id}>
    <button className="tool-header" type="button" aria-expanded={expanded} aria-controls={detailId} onClick={toggle}>
      <span className="tool-glyph" aria-hidden="true">{glyph}</span><span className="tool-name">{record.name}</span><span className="tool-subject">{snapshot?.kind === "vibe" ? vibeSummary(snapshot) : record.summary ?? record.subject}</span>
      <span className="tool-status" aria-label={interrupted ? "Interrupted" : record.status === "running" ? "Observed running" : record.status === "ok" ? "Completed" : "Failed"}>{interrupted ? "■" : record.status === "running" ? "◷" : record.status === "ok" ? "✓" : "!"}</span><ChevronDown className="tool-chevron" aria-hidden="true" />
    </button>
    {expanded && <div className="tool-body" id={detailId}>{snapshot ? <>{snapshot.kind === "vibe" ? <VibeCard record={snapshot} scope={detailId} /> : <SubagentTree agents={snapshot.children} />}<details><summary>Original arguments and output</summary><ToolDetails record={record} output={output} /></details></> : <ToolDetails record={record} output={output} />}
      {output?.truncated && !full && <button type="button" disabled={fetching} onClick={async () => {
        if (demo) { setFull({ text: demoLongOutput, truncated: false }); return; }
        setFetching(true); setError(null);
        const controller = new AbortController(); abort.current = controller;
        try { const response = await receiver.transcriptRecord(paneId, record.id, session, controller.signal); if (!controller.signal.aborted) setFull(response); }
        catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load full output"); }
        finally { if (!controller.signal.aborted) setFetching(false); }
      }}>{fetching ? "Loading…" : "Load everything"}</button>}
      {full?.truncated && <p className="transcript-status" role="status">Full-record size limit reached; some output is omitted.</p>}
      {error && <p className="tool-error" role="alert">{error}</p>}
    </div>}{children}
  </section>;
}

export function TranscriptView({ pane, data, reconnecting, loading, output, onEarlier, receiver, session, demo, readOnly, onSendKeys }: TranscriptViewProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const approval = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const earlier = useRef<(Pick<ScrollMetrics, "scrollTop" | "scrollHeight"> & { firstId?: string }) | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [viewer, setViewer] = useState<{ url: string; alt: string; launcher: HTMLButtonElement } | null>(null);
  const snapshots = useMemo(() => {
    const rows = new Map<string, ToolSnapshot>();
    const toolIds = new Set(data?.records.filter(record => record.kind === "tool").map(record => record.id));
    for (const record of data?.records ?? []) if ((record.kind === "vibe" || record.kind === "subagents") && record.callId && toolIds.has(record.callId)) rows.set(record.callId, record);
    return rows;
  }, [data?.records]);
  const groups = useMemo(() => groupTranscriptRecords((data?.records ?? []).filter(record => !((record.kind === "vibe" || record.kind === "subagents") && record.callId && snapshots.has(record.callId)))), [data?.records, snapshots]);
  const identity = disclosureId(receiver.id, session ?? "", pane.paneId, data?.sessionId ?? "");
  useLayoutEffect(() => { following.current = true; earlier.current = null; setAtBottom(true); setExpanded(new Set()); setViewer(null); }, [identity]);
  useLayoutEffect(() => { if (reconnecting) earlier.current = null; }, [reconnecting]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const anchor = earlier.current;
    const loadedEarlier = anchor && data?.records[0]?.id !== anchor.firstId;
    if (anchor && !loadedEarlier) return;
    node.scrollTop = transcriptScrollTop(node, following.current, loadedEarlier ? anchor : undefined);
    if (loadedEarlier) earlier.current = null;
  }, [data, loading, groups, expanded]);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current && !earlier.current) scroll.current.scrollTop = Math.max(0, scroll.current.scrollHeight - scroll.current.clientHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [identity]);
  useEffect(() => {
    if (!viewer) return;
    const previous = viewer.launcher;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewer(null);
      if (event.key === "Tab") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".image-viewer-close")?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("keydown", close); previous.focus(); };
  }, [viewer]);
  const status = pane.status;
  const approvalOutput = useMemo(() => parseAnsi(output?.text ?? "").map(segment => segment.text).join("").split("\n").slice(-12).join("\n"), [output?.text]);
  useLayoutEffect(() => {
    if (approval.current) approval.current.scrollTop = approval.current.scrollHeight;
  }, [approvalOutput, status]);
  const toggle = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const images = (recordId: string, refs?: ImageRef[]) => refs?.length ? <div className="transcript-images">{refs.map(image => {
    const url = demo ? demoImageUrl : receiver.transcriptImageUrl(pane.paneId, recordId, image.index, session);
    const alt = `Image ${image.index + 1}`;
    return <button className="transcript-image" type="button" key={image.index} aria-label={`View ${alt.toLowerCase()}`} onClick={event => setViewer({ url, alt, launcher: event.currentTarget })}><img src={url} alt={alt} loading="lazy" onLoad={() => { if (following.current && scroll.current) scroll.current.scrollTop = Math.max(0, scroll.current.scrollHeight - scroll.current.clientHeight); }} /></button>;
  })}</div> : null;
  return <main className="session-main transcript-session">
    <div className="transcript-scroll" ref={scroll} onScroll={event => {
      following.current = isTranscriptNearBottom(event.currentTarget); setAtBottom(following.current);
    }}>
      <div className="transcript-content" ref={content}>
        {data?.hasEarlier && data.records.length < 400 && <button className="transcript-earlier" type="button" disabled={loading} onClick={() => {
          if (scroll.current) earlier.current = { scrollTop: scroll.current.scrollTop, scrollHeight: scroll.current.scrollHeight, firstId: data.records[0]?.id };
          onEarlier();
        }}>{loading ? "Loading earlier…" : "Show earlier"}</button>}
        {data?.hasEarlier && data.records.length >= 400 && <p className="transcript-status" role="status">History window limited to the latest 400 records.</p>}
        {groups.map(group => <div className={`transcript-group ${group[0].kind === "user" ? "transcript-user" : group[0].kind === "divider" ? "transcript-system" : "transcript-assistant"}`} key={group[0].id}>
          {group.map(record => {
            const recordKey = record.id;
            if (record.kind === "user") return <section key={record.id} data-record-id={record.id}><div className="transcript-role">You</div><div className="transcript-text">{record.text}</div>{images(record.id, record.images)}</section>;
            if (record.kind === "assistant") return <section key={record.id} data-record-id={record.id}><Markdown text={record.text} /></section>;
            if (record.kind === "tool") return <ToolCard key={`${identity}:${record.id}`} snapshot={snapshots.get(record.id)} detailId={disclosureId(identity, record.id)} record={record} expanded={expanded.has(record.id)} toggle={() => toggle(record.id)} receiver={receiver} paneId={pane.paneId} session={session} demo={demo}>{images(record.id, record.images)}</ToolCard>;
            if (record.kind === "thinking") return <section key={record.id} className="thought-card" data-record-id={record.id}><button className="thought-header" type="button" disabled={record.redacted} aria-expanded={!record.redacted && expanded.has(record.id)} onClick={() => toggle(record.id)}>✧ {record.redacted ? "Thought (redacted)" : "Thought"}{!record.redacted && <ChevronDown aria-hidden="true" />}</button>{!record.redacted && expanded.has(record.id) && <div className="thought-body">{record.text}</div>}</section>;
            if (record.kind === "irc") return <IrcRow key={record.id} record={record} expanded={expanded.has(record.id)} toggle={() => toggle(record.id)} id={disclosureId(identity, record.id)} />;
            if (record.kind === "vibe" || record.kind === "todo" || record.kind === "subagents") {
              const detailId = disclosureId(identity, record.id);
              const label = record.kind === "vibe" ? `vibe ${vibeSummary(record)}` : record.kind === "todo" ? `todo · ${todoCounts(record.phases).closed}/${todoCounts(record.phases).total} closed · ${todoCounts(record.phases).blocked} blocked` : `task · ${record.children.length} workers observed`;
              return <section className="tool-card tool-snapshot" key={record.id} data-record-id={record.id}><button type="button" className="tool-header" aria-expanded={expanded.has(record.id)} aria-controls={detailId} onClick={() => toggle(record.id)}><span aria-hidden="true">└</span><strong className="tool-subject">{label}</strong><ChevronDown aria-hidden="true" /></button>{expanded.has(record.id) && <div className="tool-body" id={detailId}>{record.kind === "vibe" ? <VibeCard record={record} scope={detailId} /> : record.kind === "todo" ? <TodoPanel phases={record.phases} /> : <SubagentTree agents={record.children} />}</div>}</section>;
            }
            if (record.kind !== "divider") return <UnknownRecord key={recordKey} record={record} />;
            if (record.variant === "error" || record.variant === "aborted") return <section key={record.id} className={`transcript-failure transcript-failure-${record.variant}`} data-record-id={record.id} role={record.variant === "error" ? "alert" : "status"} aria-label={record.variant === "error" ? "Agent error" : "Agent aborted"}>
              <header><span aria-hidden="true">{record.variant === "error" ? "!" : "■"}</span><strong>{record.label}</strong></header>
              {record.detail && <div className="transcript-failure-detail">{record.detail}</div>}
            </section>;
            return <section key={record.id} className="transcript-divider" data-record-id={record.id}>{record.detail ? <details><summary>{record.label}</summary><div className="transcript-divider-detail"><Markdown text={record.detail} /></div></details> : <span>{record.label}</span>}</section>;
          })}
        </div>)}
        {!data?.records.length && <p className="transcript-empty">{loading ? "Loading conversation…" : "No conversation messages yet."}</p>}
        {data?.truncatedFile && <p className="transcript-status">Earlier session history was omitted from this bounded read.</p>}
      </div>
    </div>
    {!atBottom && <button className="transcript-jump" type="button" onClick={() => { following.current = true; setAtBottom(true); if (scroll.current) scroll.current.scrollTop = Math.max(0, scroll.current.scrollHeight - scroll.current.clientHeight); }}>Jump to latest ↓</button>}
    {status === "blocked" && <section className="approval-card" aria-label="Agent needs input"><header className="approval-header"><ShieldAlert aria-hidden="true" />Needs input</header><pre className="approval-output" ref={approval}>{approvalOutput || "The agent is waiting for input. Inspect its prompt before responding."}</pre><div className="approval-actions">{["Enter", "Esc", "Up", "Down", "Tab"].map(key => <button type="button" key={key} disabled={readOnly || reconnecting} onClick={() => onSendKeys([key])}>{key}</button>)}</div></section>}
    {reconnecting && <div className="transcript-status" role="status" aria-live="polite">Reconnecting…</div>}
    {viewer && <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image viewer" onClick={() => setViewer(null)}><button className="image-viewer-close" type="button" autoFocus aria-label="Close image viewer" onClick={() => setViewer(null)}><X /></button><img src={viewer.url} alt={viewer.alt} onClick={event => event.stopPropagation()} /></div>}
  </main>;
}
