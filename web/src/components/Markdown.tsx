import DOMPurify from "dompurify";
import { marked } from "marked";
import { createElement, useMemo, useState, type ReactNode } from "react";

function CodeBlock({ text, language }: { text: string; language: string }) {
  const long = text.trimEnd().split("\n").length > 40;
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState("Copy");
  const visible = long && !expanded ? text.split("\n").slice(0, 40).join("\n") : text;
  return <section className="code-block">
    <header className="code-header"><span>{language || "Code"}</span><button className="code-copy" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopyState("Copied"); }
      catch { setCopyState("Copy failed"); }
    }}>{copyState}</button></header>
    <pre className="code-content"><code>{visible}</code></pre>
    {long && <button className="code-fold" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Fold code" : `Show all ${text.trimEnd().split("\n").length} lines`}</button>}
  </section>;
}

export function sanitizeMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }), {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["style"],
  });
}

function renderNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    // GFM table formatting includes newlines where HTML permits elements only.
    if (!node.textContent?.trim() && /^(TABLE|THEAD|TBODY|TFOOT|TR|COLGROUP)$/.test(node.parentElement?.tagName ?? "")) return null;
    return node.textContent;
  }
  if (!(node instanceof Element)) return null;
  const tag = node.tagName.toLowerCase();
  const code = tag === "pre" ? node.querySelector("code") : null;
  if (code) return <CodeBlock key={key} text={code.textContent ?? ""} language={code.className.match(/language-(\S+)/)?.[1] ?? ""} />;
  const attributes: Record<string, string> = { key };
  for (const attribute of Array.from(node.attributes)) {
    if (/^on/i.test(attribute.name)) continue;
    const name = attribute.name === "class" ? "className" : attribute.name === "for" ? "htmlFor" : attribute.name;
    attributes[name] = attribute.value;
  }
  return createElement(tag, attributes, ...Array.from(node.childNodes, (child, index) => renderNode(child, `${key}.${index}`)));
}

export function Markdown({ text }: { text: string }) {
  const content = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = sanitizeMarkdown(text);
    return Array.from(template.content.childNodes, (node, index) => renderNode(node, String(index)));
  }, [text]);
  return <div className="markdown">{content}</div>;
}
