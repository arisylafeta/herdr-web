import {
  ArrowUp,
  Bot,
  ChevronDown,
  Command,
  ImagePlus,
  Keyboard,
  LockOpen,
  Paperclip,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { AgentView, TabView } from "../lib/types";

interface ComposerProps {
  pane: AgentView | null;
  tab: TabView | undefined;
  session: string | undefined;
  busy: boolean;
  running: boolean;
  readOnly: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onSendKeys: (keys: string[]) => void;
  onUpload: (file: File) => Promise<string | undefined>;
}

export const specialKeys = [
  { label: "Esc", keys: ["Esc"] },
  { label: "Ctrl C", keys: ["ctrl+c"] },
  { label: "Tab", keys: ["Tab"] },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "Enter", keys: ["Enter"] },
];

export function Composer({ pane, tab, session, busy, running, readOnly, onSend, onStop, onSendKeys, onUpload }: ComposerProps) {
  const [value, setValue] = useState("");
  const [keysOpen, setKeysOpen] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const contextId = `${session ?? ""}\n${pane?.paneId ?? ""}`;
  const contextIdRef = useRef(contextId);
  contextIdRef.current = contextId;
  const disabled = !pane || busy || readOnly;

  useEffect(() => {
    setValue("");
    setAttachments([]);
    setKeysOpen(false);
  }, [contextId]);

  const send = async () => {
    const targetContextId = contextId;
    const text = [value.trim(), ...attachments].filter(Boolean).join("\n\n");
    if (!text || disabled) return;
    if (await onSend(text) && contextIdRef.current === targetContextId) {
      setValue("");
      setAttachments([]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const targetContextId = contextId;
    const path = await onUpload(file);
    if (path && contextIdRef.current === targetContextId) {
      setAttachments((current) => [...current, path]);
    }
  };

  return (
    <div className="composer-shell">
      <div className="composer-card">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((path) => (
              <span key={path}>
                <ImagePlus />
                <span>{path.split("/").pop()}</span>
                <button onClick={() => setAttachments((current) => current.filter((item) => item !== path))} title="Remove attachment">
                  <X />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={readOnly ? "This device has read-only access" : pane ? "Reply to this pane…" : "Select a pane to send a message"}
          disabled={disabled}
          rows={3}
          aria-label="Reply to pane"
        />

        <div className="composer-footer">
          <div className="composer-controls">
            {running ? (
              <button
                className="composer-control model-control stop-control"
                onClick={onStop}
                disabled={!pane || readOnly}
                aria-label="Stop agent"
                title="Send Esc to stop agent"
              >
                <Square />
                <span>Stop</span>
              </button>
            ) : (
              <button className="composer-control model-control" disabled={!pane}>
                <span className="agent-mini-mark">{pane?.agent === "shell" ? ">_" : pane?.agent.slice(0, 1).toUpperCase()}</span>
                <span>{pane?.agent ?? "Agent"}</span>
                <ChevronDown />
              </button>
            )}
            <span className="composer-divider" />
            <button className="composer-control compact-hide" disabled={!pane}>
              <TerminalSquare />
              <span>{tab?.label ?? "Pane"}</span>
            </button>
            <span className="composer-divider compact-hide" />
            <button className="composer-control compact-hide" disabled={!pane}>
              <Bot />
              <span>Build</span>
            </button>
            <span className="composer-divider compact-hide" />
            <button className="composer-control compact-hide" disabled={!pane}>
              <LockOpen />
              <span>Full access</span>
            </button>
          </div>

          <div className="composer-actions">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFileChange} />
            <button className="icon-button composer-icon-button" onClick={() => fileRef.current?.click()} disabled={disabled} title="Attach image">
              <Paperclip />
            </button>
            <div className="special-keys-wrap">
              <button
                className={`icon-button composer-icon-button${keysOpen ? " is-active" : ""}`}
                onClick={() => setKeysOpen((current) => !current)}
                disabled={disabled}
                title="Special terminal keys"
              >
                <Keyboard />
              </button>
              {keysOpen && (
                <div className="special-keys-popover" role="menu">
                  <header>
                    <Command />
                    <span>Terminal keys</span>
                  </header>
                  <div>
                    {specialKeys.map((item) => (
                      <button
                        key={item.label}
                        onClick={() => {
                          onSendKeys(item.keys);
                          setKeysOpen(false);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {busy ? (
              <button className="send-button is-busy" title="Action in progress" disabled>
                <Square />
              </button>
            ) : (
              <button className="send-button" onClick={() => void send()} disabled={disabled || (!value.trim() && attachments.length === 0)} title="Send reply">
                <ArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-context-row">
        <span>{pane ? pane.cwd : "No pane selected"}</span>
        <span className="composer-context-branch">{pane?.workspaceLabel ?? "Herdr"}</span>
      </div>
    </div>
  );
}
