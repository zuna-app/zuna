import type { Emote as ServerEmote } from "@zuna/core";
import { Search, Smile } from "lucide-react";
import { motion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Emote } from "@/components/Emote";
import { quick, useReturnFocus } from "@/components/ui";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";
import { useEscape } from "@/lib/escape";
import { useRemoteImage } from "@/lib/media";
import { useActiveField } from "@/state/store";

export type Pick =
  | { kind: "emoji"; value: string }
  | { kind: "emote"; id: string; name: string; animated: boolean; zeroWidth: boolean; owner: string };

const WIDTH = 352;
const NO_EMOTES: ServerEmote[] = [];
const HEIGHT = 420;

type Hovered = { kind: "emoji"; value: string; name: string } | { kind: "emote"; id: string; name: string; owner: string };

function EmotePreview({ address }: { address: string }) {
  const { url } = useRemoteImage(address);
  return url ? <img src={url} alt="" /> : null;
}

type Category = (typeof EMOJI_CATEGORIES)[number];

// The grids are kept apart from what's hovered, which only the footer shows, so moving
// over hundreds of emotes redraws none of them.
const EmoteGrid = memo(function EmoteGrid({
  emotes,
  serverUrl,
  onHover,
  onPick,
}: {
  emotes: ServerEmote[];
  serverUrl: string;
  onHover: (hovered: Hovered) => void;
  onPick: (pick: Pick) => void;
}) {
  return (
    <div className="emote-grid">
      {emotes.map((emote) => (
        <button
          key={emote.id}
          className="emote-cell"
          aria-label={emote.owner ? `${emote.name} by ${emote.owner}` : emote.name}
          onMouseEnter={() => onHover({ kind: "emote", id: emote.id, name: emote.name, owner: emote.owner })}
          onClick={() => onPick({ kind: "emote", id: emote.id, name: emote.name, animated: emote.animated, zeroWidth: emote.zero_width, owner: emote.owner })}
        >
          <Emote name={emote.name} emote={emote} serverUrl={serverUrl} size="picker" hoverCard={false} />
        </button>
      ))}
    </div>
  );
});

const EmojiGrid = memo(function EmojiGrid({ categories, onHover, onPick }: { categories: Category[]; onHover: (hovered: Hovered) => void; onPick: (pick: Pick) => void }) {
  return categories.map((category) => (
    <section key={category.id}>
      <h4 className="picker-heading">{category.label}</h4>
      <div className="emoji-grid">
        {category.emoji.map(([value, name]) => (
          <button key={value} className="emoji-cell" aria-label={name} onMouseEnter={() => onHover({ kind: "emoji", value, name })} onClick={() => onPick({ kind: "emoji", value })}>
            {value}
          </button>
        ))}
      </div>
    </section>
  ));
});

export const EmotePicker = memo(function EmotePicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  onPick: (pick: Pick) => void;
  onClose: () => void;
}) {
  const emotes = useActiveField((server) => server.emotes.emotes, NO_EMOTES);
  const setName = useActiveField((server) => server.emotes.set_name, "");
  const serverUrl = useActiveField((server) => server.entry.url, "");
  const [tab, setTab] = useState<"emotes" | "emoji">(emotes.length > 0 ? "emotes" : "emoji");
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y - HEIGHT - 8 });
  useReturnFocus();

  useLayoutEffect(() => {
    setPosition({
      left: Math.min(Math.max(8, anchor.x - 16), window.innerWidth - WIDTH - 8),
      top: Math.max(8, Math.min(anchor.y - HEIGHT - 8, window.innerHeight - HEIGHT - 8)),
    });
  }, [anchor.x, anchor.y]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const latestPick = useRef(onPick);
  latestPick.current = onPick;
  const pick = useCallback((choice: Pick) => latestPick.current(choice), []);
  useEscape(onClose);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) latestClose.current();
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", close));
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const filteredEmotes = useMemo(() => (needle ? emotes.filter((emote) => emote.name.toLowerCase().includes(needle)) : emotes), [emotes, needle]);
  const categories = useMemo(
    () =>
      EMOJI_CATEGORIES.map((category) => ({
        ...category,
        emoji: needle ? category.emoji.filter(([, name]) => name.includes(needle)) : category.emoji,
      })).filter((category) => category.emoji.length > 0),
    [needle],
  );

  return createPortal(
    <motion.div
      ref={panel}
      className="picker"
      style={{ left: position.left, top: position.top, width: WIDTH, height: HEIGHT }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.06 } }}
      transition={quick}
      onMouseLeave={() => setHovered(null)}
    >
      <div className="picker-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "emotes"} className={tab === "emotes" ? "is-active" : ""} onClick={() => setTab("emotes")}>
          {setName || "Server emotes"}
        </button>
        <button role="tab" aria-selected={tab === "emoji"} className={tab === "emoji" ? "is-active" : ""} onClick={() => setTab("emoji")}>
          Emoji
        </button>
      </div>
      <div className="picker-search">
        <div className="input-wrap search-wrap">
          <Search size={14} className="faint" />
          <input className="input" placeholder="Search" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label="Search emotes and emoji" />
        </div>
      </div>
      <div className="picker-body">
        {tab === "emotes" ? (
          filteredEmotes.length > 0 ? (
            <EmoteGrid emotes={filteredEmotes} serverUrl={serverUrl} onHover={setHovered} onPick={pick} />
          ) : (
            <div className="empty-state">
              <Smile size={22} />
              <p>{needle ? "No emotes match that search." : "This server has no emotes yet."}</p>
            </div>
          )
        ) : (
          <EmojiGrid categories={categories} onHover={setHovered} onPick={pick} />
        )}
      </div>
      <div className="picker-footer">
        {hovered?.kind === "emote" && (
          <>
            <EmotePreview address={`${serverUrl}/api/emotes/${hovered.id}/2x.webp`} />
            <span className="grow truncate">
              <b>{hovered.name}</b>
              {hovered.owner && <span> by {hovered.owner}</span>}
            </span>
          </>
        )}
        {hovered?.kind === "emoji" && (
          <>
            <span style={{ fontSize: 22, color: "inherit" }}>{hovered.value}</span>
            <b className="truncate">{hovered.name}</b>
          </>
        )}
        {!hovered && <span>Hover over one to see its name</span>}
      </div>
    </motion.div>,
    document.body,
  );
});
