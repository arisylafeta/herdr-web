import type { TranscriptRecord } from "../lib/transcript-types";
import "./tool-details.css";

export interface ToolDetailsProps {
  record: Extract<TranscriptRecord, { kind: "tool" }>;
  output?: { text: string; truncated: boolean };
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function isDiff(text: string | undefined): text is string {
  return text !== undefined && (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)
    || (/^\+(?!\+).+/m.test(text) && /^-(?!-).+/m.test(text)));
}

function Diff({ text }: { text: string }) {
  const lines = text.split("\n");
  return <pre className="tool-output tool-diff" aria-label="Diff">{lines.map((line, index) => {
    const className = line.startsWith("+") && !line.startsWith("+++") ? "tool-diff-added"
      : line.startsWith("-") && !line.startsWith("---") ? "tool-diff-removed" : undefined;
    return <span key={index} className={className}>{line}{index < lines.length - 1 ? "\n" : ""}</span>;
  })}</pre>;
}

export function ToolDetails({ record, output }: ToolDetailsProps) {
  const name = record.name.toLowerCase();
  const result = output && <pre className="tool-output" aria-label="Tool output">{output.text}</pre>;
  if (/bash|shell|exec/.test(name)) {
    const command = stringArg(record.args, "command", "cmd") ?? record.subject;
    return <><pre className="tool-command" aria-label="Command">$ {command}</pre>{result}</>;
  }
  if (/read|write|edit/.test(name)) {
    const path = stringArg(record.args, "path", "file_path", "filename") ?? record.subject;
    const outputDiff = /edit/.test(name) && isDiff(output?.text) ? output.text : undefined;
    const argumentDiff = /edit/.test(name)
      ? [stringArg(record.args, "patch"), stringArg(record.args, "diff")].find(isDiff) : undefined;
    const diff = outputDiff ?? argumentDiff;
    return <><code className="tool-file-path" aria-label="File path">{path}</code>
      {diff !== undefined && <Diff text={diff} />}
      {outputDiff === undefined && result}
    </>;
  }
  return <><pre className="tool-args" aria-label="Tool arguments">{JSON.stringify(record.args, null, 2)}</pre>{result}</>;
}
