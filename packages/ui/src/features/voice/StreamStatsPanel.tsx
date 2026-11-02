import { Activity, Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { useActiveServer, useApp } from "@/state/store";
import { statsAsText, StreamStats, type StatSection } from "@/voice/stats";
import { useVoice } from "@/voice/store";

const READ_EVERY_MS = 1000;
/** So that a panel dragged to an edge can always be caught again. */
const KEEP_IN_VIEW = 40;

/** How the frame rate has gone lately, against what was wanted if that's known. */
function FpsGraph({ history, wanted }: { history: number[]; wanted: number | null }) {
  const top = Math.max(wanted ?? 0, ...history, 1) * 1.1;
  const height = (value: number) => 24 - (value / top) * 24;
  const points = history.map((value, index) => `${59 - (history.length - 1 - index)},${height(value).toFixed(2)}`).join(" ");
  return (
    <svg className="stream-stats-graph" viewBox="0 0 59 24" preserveAspectRatio="none" aria-hidden>
      {wanted !== null && <line className="stream-stats-wanted" x1={0} x2={59} y1={height(wanted)} y2={height(wanted)} />}
      {history.length > 1 && <polyline points={points} />}
    </svg>
  );
}

function Section({ section }: { section: StatSection }) {
  const { headline } = section;
  return (
    // Sound is what there's least to wonder about, so it starts folded.
    <details className="stream-stats-section" open={section.kind !== "audio"}>
      <summary>{section.title}</summary>
      {headline && (
        <div className="stream-stats-headline">
          <div className="stream-stats-fps">
            <b>{headline.fps === null ? "…" : headline.fps.toFixed(1)}</b>
            <span>
              fps {headline.label}
              {headline.wanted !== null && ` of ${headline.wanted}`}
            </span>
          </div>
          <FpsGraph history={headline.history} wanted={headline.wanted} />
        </div>
      )}
      <dl className="stream-stats-rows">
        {section.rows.map((row) => (
          <div key={row.label} className={row.warn ? "is-warn" : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Everything there is to know about what's going out and coming in, over the call. */
export function StreamStatsPanel({ onClose }: { onClose: () => void }) {
  const server = useActiveServer();
  const readStats = useVoice((state) => state.readStats);
  const toast = useApp((state) => state.toast);
  const [sections, setSections] = useState<StatSection[]>([]);
  const [copied, setCopied] = useState(false);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const users = useRef(server?.users);
  users.current = server?.users;

  useEffect(() => {
    const reader = new StreamStats();
    let stopped = false;
    const read = async () => {
      const next = await readStats(reader, (userId) => users.current?.[userId]?.displayName ?? "Someone").catch((error) => {
        console.warn("[zuna] reading stream stats", error);
        return null;
      });
      if (next && !stopped) setSections(next);
    };
    void read();
    const timer = setInterval(() => void read(), READ_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      reader.close();
    };
  }, [readStats]);

  const startDrag = (event: React.PointerEvent) => {
    const box = panel.current?.getBoundingClientRect();
    const stage = panel.current?.offsetParent?.getBoundingClientRect();
    if (!box || !stage || (event.target as HTMLElement).closest("button")) return;
    const fromLeft = event.clientX - box.left;
    const fromTop = event.clientY - box.top;
    const move = (moved: PointerEvent) => {
      setPlace({
        x: Math.min(Math.max(moved.clientX - fromLeft - stage.left, KEEP_IN_VIEW - box.width), stage.width - KEEP_IN_VIEW),
        y: Math.min(Math.max(moved.clientY - fromTop - stage.top, 0), stage.height - KEEP_IN_VIEW),
      });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const copy = async () => {
    try {
      await copyText(statsAsText(sections));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  return (
    <aside ref={panel} className="stream-stats" aria-label="Stream stats" style={place ? { left: place.x, top: place.y, right: "auto" } : undefined}>
      <header className="stream-stats-head" onPointerDown={startDrag}>
        <Activity size={14} />
        <h4 className="grow">Stream stats</h4>
        <Tooltip text={copied ? "Copied" : "Copy all of it"}>
          <button className="icon-btn is-small" onClick={() => void copy()} aria-label="Copy all of it">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </Tooltip>
        <Tooltip text="Close">
          <button className="icon-btn is-small" onClick={onClose} aria-label="Close stream stats">
            <X size={15} />
          </button>
        </Tooltip>
      </header>
      <div className="stream-stats-body">
        {sections.map((section) => (
          <Section key={section.id} section={section} />
        ))}
      </div>
    </aside>
  );
}
