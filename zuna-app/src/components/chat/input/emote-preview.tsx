interface EmotePreviewProps {
  tokens: string[];
  emoteMap: ReadonlyMap<string, string>;
}

export function EmotePreview({ tokens, emoteMap }: EmotePreviewProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-0 px-4 pb-2 text-sm leading-relaxed pointer-events-none select-none text-foreground/70 border-t border-border/30 pt-1.5">
      {tokens.map((part, i) => {
        const url = emoteMap.get(part);
        if (url) {
          return (
            <img
              key={i}
              src={url}
              alt={part}
              className="inline-block align-middle h-[1.6em] mx-px"
            />
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}
