import React from "react";
import { emoteUrl } from "@/lib/seventv";
import type { EmoteV3 } from "@/lib/seventv";
import type { EmoteDataMap } from "@/hooks/ui/useEmotes";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { usePlatform } from "../../../platform";

export const URL_SPLIT_RE = /(https?:\/\/[^\s<>"']+)/i;

export function EmoteHoverCard({
  name,
  emote,
  src,
}: {
  name: string;
  emote: EmoteV3;
  src: string;
}) {
  const { shell } = usePlatform();
  const srcLarge = emoteUrl(emote, "3x") ?? emoteUrl(emote, "2x") ?? src;
  const emotePageUrl = `https://7tv.app/emotes/${emote.data.id}`;
  const owner = emote.data.owner;

  const sizeFiles = emote.data.host.files.filter((f) =>
    /^\dx\.webp$/.test(f.name),
  );
  const largestFile = sizeFiles[sizeFiles.length - 1];
  const dimensions = largestFile
    ? `${largestFile.width}×${largestFile.height}`
    : null;

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <img
          src={src}
          alt={name}
          className="inline-block align-middle h-[2em] cursor-default"
        />
      </HoverCardTrigger>
      <HoverCardContent
        className="w-auto min-w-44 max-w-60 p-3"
        align="center"
        side="top"
      >
        <div className="flex flex-col items-center gap-2">
          {srcLarge && (
            <img
              src={srcLarge}
              alt={name}
              className="max-h-24 max-w-full object-contain"
            />
          )}
          <div className="w-full space-y-1 text-center">
            <p className="font-semibold text-sm leading-tight">{name}</p>
            {(dimensions || emote.data.animated) && (
              <p className="text-xs text-muted-foreground">
                {emote.data.animated && (
                  <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium">
                    Animated
                  </span>
                )}
                {dimensions}
              </p>
            )}
            {owner && (
              <p className="text-xs text-muted-foreground">
                By{" "}
                <button
                  type="button"
                  onClick={() =>
                    shell.openExternal(`https://7tv.app/users/${owner.id}`)
                  }
                  className="underline underline-offset-1 hover:text-foreground transition-colors duration-100"
                >
                  {owner.display_name || owner.username}
                </button>
              </p>
            )}
            <button
              type="button"
              onClick={() => shell.openExternal(emotePageUrl)}
              className="text-xs text-primary/80 hover:text-primary underline underline-offset-1 transition-colors duration-100"
            >
              View on 7TV ↗
            </button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function renderMessage(
  text: string,
  emoteMap: ReadonlyMap<string, string>,
  emoteDataMap: EmoteDataMap,
  shell: { openExternal: (url: string) => void },
): React.ReactNode {
  const urlParts = text.split(URL_SPLIT_RE);

  return urlParts.map((part, i) => {
    if (URL_SPLIT_RE.test(part)) {
      const clean = part.replace(/[.,;:!?)'"\]]+$/, "");
      const trailing = part.slice(clean.length);
      return (
        <span key={i}>
          <button
            type="button"
            onClick={() => shell.openExternal(clean)}
            className="underline underline-offset-2 opacity-90 hover:opacity-100 cursor-pointer break-all"
          >
            {clean}
          </button>
          {trailing}
        </span>
      );
    }

    const emoteParts = part.split(/(\b[a-zA-Z0-9_]+\b)/g);
    return emoteParts.map((ep, j) => {
      const src = emoteMap.get(ep);
      const emoteData = emoteDataMap.get(ep);
      if (src && emoteData) {
        return (
          <EmoteHoverCard
            key={`${i}-${j}`}
            name={ep}
            emote={emoteData}
            src={src}
          />
        );
      }
      if (src) {
        return (
          <img
            key={`${i}-${j}`}
            src={src}
            alt={ep}
            className="inline-block align-middle h-[2em]"
          />
        );
      }
      return <span key={`${i}-${j}`}>{ep}</span>;
    });
  });
}
