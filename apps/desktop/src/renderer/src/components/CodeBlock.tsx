import type { ThemedToken } from "shiki/core";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { highlightCode, languageName } from "@/lib/highlight";

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const known = language ? languageName(language) : null;

  useEffect(() => {
    if (!known) return;
    let cancelled = false;
    void highlightCode(code, known)
      .then((tokens) => {
        if (!cancelled) setLines(tokens);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, known]);

  const copy = async () => {
    await copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language || "code"}</span>
        <button className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-body selectable">
        <code>
          {lines
            ? lines.map((line, i) => (
                <span className="code-line" key={i}>
                  {line.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
