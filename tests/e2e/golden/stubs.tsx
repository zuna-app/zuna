// Stand-ins for the desktop components that markup renders, so the golden
// HTML shows what was parsed (an emote, a code block, a spoiler) without
// their behavior: images, highlighting and clicks are the UI's business.

import type { EmoteRef } from "@zuna/core";
import type { ReactNode } from "react";

export function Emote({ name, emote, stackOnPrevious }: { name: string; emote: EmoteRef; serverUrl: string; stackOnPrevious?: boolean }) {
  return <i data-emote={name} data-id={emote.id} data-zw={stackOnPrevious ? "1" : "0"} />;
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return <pre data-language={language ?? ""}>{code}</pre>;
}

export function Spoiler({ children }: { children: ReactNode }) {
  return <span className="spoiler">{children}</span>;
}
