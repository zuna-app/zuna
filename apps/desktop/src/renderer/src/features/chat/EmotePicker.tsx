import { Search, Smile } from "lucide-react";
import { motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Emote } from "@/components/Emote";
import { quick, useReturnFocus } from "@/components/ui";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";
import { useRemoteImage } from "@/lib/media";
import { useActiveServer } from "@/state/store";

export type Pick =
  | { kind: "emoji"; value: string }
  | { kind: "emote"; id: string; name: string; animated: boolean; zeroWidth: boolean; owner: string };

const WIDTH = 352;
const HEIGHT = 420;

type Hovered = { kind: "emoji"; value: string; name: string } | { kind: "emote"; id: string; name: string; owner: string };

function EmotePreview({ address }: { address: string }) {
  const { url } = useRemoteImage(address);
  return url ? <img src={url} alt="" /> : null;
}

export const EmotePicker = memo(function EmotePicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  onPick: (pick: Pick) => void;
  onClose: () => void;
}) {
  const server = useActiveServer();
  const emotes = server?.emotes.emotes ?? [];
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
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) latestClose.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") latestClose.current();
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", close));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
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
          {server?.emotes.set_name || "Server emotes"}
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
            <div className="emote-grid">
              {filteredEmotes.map((emote) => (
                <button
                  key={emote.id}
                  className="emote-cell"
                  aria-label={emote.owner ? `${emote.name} by ${emote.owner}` : emote.name}
                  onMouseEnter={() => setHovered({ kind: "emote", id: emote.id, name: emote.name, owner: emote.owner })}
                  onClick={() => onPick({ kind: "emote", id: emote.id, name: emote.name, animated: emote.animated, zeroWidth: emote.zero_width, owner: emote.owner })}
                >
                  <Emote name={emote.name} emote={{ id: emote.id, animated: emote.animated }} serverUrl={server!.entry.url} size="picker" hoverCard={false} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Smile size={22} />
              <p>{needle ? "No emotes match that search." : "This server has no emotes yet."}</p>
            </div>
          )
        ) : (
          categories.map((category) => (
            <section key={category.id}>
              <h4 className="picker-heading">{category.label}</h4>
              <div className="emoji-grid">
                {category.emoji.map(([value, name]) => (
                  <button key={value} className="emoji-cell" aria-label={name} onMouseEnter={() => setHovered({ kind: "emoji", value, name })} onClick={() => onPick({ kind: "emoji", value })}>
                    {value}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      <div className="picker-footer">
        {hovered?.kind === "emote" && (
          <>
            <EmotePreview address={`${server!.entry.url}/api/emotes/${hovered.id}/2x.webp`} />
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
