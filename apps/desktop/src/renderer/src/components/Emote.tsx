import type { EmoteRef } from "@zuna/core";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "@/state/store";

interface EmoteProps {
  name: string;
  emote: EmoteRef;
  serverUrl: string;
  size?: "inline" | "jumbo" | "reaction" | "picker";
  stackOnPrevious?: boolean;
  /** The picker shows details in its own footer instead. */
  hoverCard?: boolean;
  /** An extra line on the hover card, such as who reacted. */
  note?: string;
}

const HOVER_DELAY_MS = 120;
const CARD_GAP = 8;

/** Who made an emote: recorded in the message, or known from the server's set. */
export function emoteOwner(emote: EmoteRef): string | null {
  if (emote.owner) return emote.owner;
  const state = useApp.getState();
  const server = state.activeServerId ? state.servers[state.activeServerId] : null;
  return server?.emotes.emotes.find((item) => item.id === emote.id)?.owner || null;
}

function EmoteCard({ anchor, name, emote, serverUrl, note }: { anchor: DOMRect; name: string; emote: EmoteRef; serverUrl: string; note?: string }) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const rect = card.current!.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, anchor.left + anchor.width / 2 - rect.width / 2));
    const above = anchor.top - rect.height - CARD_GAP;
    setPosition({ left, top: above >= 8 ? above : anchor.bottom + CARD_GAP });
  }, [anchor]);
  const owner = emoteOwner(emote);
  return createPortal(
    <div ref={card} className="emote-card" style={position}>
      <img src={`${serverUrl}/api/emotes/${emote.id}/3x.webp`} alt="" />
      <div>
        <b>{name}</b>
        {owner && <span>by {owner}</span>}
        {note && <em>{note}</em>}
      </div>
    </div>,
    document.body,
  );
}

/** A 7TV emote, served and cached by the user's own Zuna server. */
export const Emote = memo(function Emote({ name, emote, serverUrl, size = "inline", stackOnPrevious, hoverCard = true, note }: EmoteProps) {
  const [failed, setFailed] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (failed) return <span className="emote-fallback">{name}</span>;
  const file = size === "reaction" ? "1x" : size === "jumbo" ? "3x" : "2x";
  return (
    <>
      <img
        className={`emote emote-${size}${stackOnPrevious ? " emote-zero-width" : ""}`}
        src={`${serverUrl}/api/emotes/${emote.id}/${file}.webp`}
        alt={name}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        onMouseEnter={
          hoverCard
            ? (event) => {
                const target = event.currentTarget;
                timer.current = setTimeout(() => setAnchor(target.getBoundingClientRect()), HOVER_DELAY_MS);
              }
            : undefined
        }
        onMouseLeave={
          hoverCard
            ? () => {
                clearTimeout(timer.current);
                setAnchor(null);
              }
            : undefined
        }
      />
      {anchor && <EmoteCard anchor={anchor} name={name} emote={emote} serverUrl={serverUrl} note={note} />}
    </>
  );
});
