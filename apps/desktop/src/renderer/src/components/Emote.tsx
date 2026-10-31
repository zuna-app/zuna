import type { EmoteRef } from "@zuna/core";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRemoteImage } from "@/lib/media";
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
/** Holds an emote's square place until its picture is here. */
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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
  const { url } = useRemoteImage(`${serverUrl}/api/emotes/${emote.id}/3x.webp`);
  useLayoutEffect(() => {
    const rect = card.current!.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, anchor.left + anchor.width / 2 - rect.width / 2));
    const above = anchor.top - rect.height - CARD_GAP;
    setPosition({ left, top: above >= 8 ? above : anchor.bottom + CARD_GAP });
  }, [anchor]);
  const owner = emoteOwner(emote);
  return createPortal(
    <div ref={card} className="emote-card" style={position}>
      {url ? <img src={url} alt="" /> : <span className="emote-card-blank" />}
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
  const [broken, setBroken] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const file = size === "reaction" ? "1x" : size === "jumbo" ? "3x" : "2x";
  const address = `${serverUrl}/api/emotes/${emote.id}/${file}.webp`;
  const className = `emote emote-${size}${stackOnPrevious ? " emote-zero-width" : ""}`;
  // A picker holds hundreds, so each waits until it's close to being seen.
  const image = useRef<HTMLImageElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!image.current || near) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), { rootMargin: "300px" });
    observer.observe(image.current);
    return () => observer.disconnect();
  }, [near]);
  const { url, failed } = useRemoteImage(address, near);
  if (failed || broken) return <span className="emote-fallback">{name}</span>;
  return (
    <>
      <img
        ref={image}
        className={className}
        src={url ?? BLANK_IMAGE}
        alt={name}
        draggable={false}
        onError={() => setBroken(true)}
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
