import { Cpu, Lock, MonitorUp, Volume2, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersLessMotion, useOnScreen } from "../components/reveal";

/** The most a share's frame rate can be set to, the last of SCREEN_RATES in packages/ui/src/voice/settings.ts. */
const MOST_FPS = 240;

/**
 * Each the most its setting goes to, from SCREEN_RATES and SCREEN_HEIGHTS, and the maintainers' measured latency. All three the same size, so none
 * is the headline, as docs/SITE_PLAN.md asks, since one share doesn't do all three at once.
 */
const SPECS: { lead: string; value: number; unit: string; label: string }[] = [
  { lead: "Up to", value: MOST_FPS, unit: "fps", label: "Every frame of a fast game" },
  { lead: "Up to", value: 4, unit: "K", label: "Small text stays sharp" },
  { lead: "About", value: 80, unit: "ms", label: "From your screen to theirs" },
];

/** The 1440p figure is the maintainers' measurement on Windows; encryption is LiveKit's, keyed from the MLS group, as every call is. */
const FACTS: { icon: ReactNode; value: string; label: string }[] = [
  { icon: <Zap size={18} />, value: "On your GPU", label: "Encoded by your graphics card, not your processor" },
  { icon: <Cpu size={18} />, value: "≈5% of a core", label: "For a 1440p share at 60 fps" },
  { icon: <Volume2 size={18} />, value: "One app's sound", label: "Share a game's audio, not your whole desktop" },
  { icon: <Lock size={18} />, value: "End to end", label: "Encrypted like every call, so the server sees noise" },
];

/** A shared screen this often a second, for the lane beside the visitor's own refresh rate. */
const SLOW_FPS = 30;

export function Streaming() {
  return (
    <section className="section stream-section" id="streaming">
      <div className="stream-glow" aria-hidden="true" />
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Screen sharing</p>
          <h2 className="heading">Your screen, exactly as you see it.</h2>
          <p className="lead">
            Captured natively, encoded on your GPU and encrypted end to end, so a fast game or a page of small text looks to your friends as it does to you.
          </p>
        </div>
        <ul className="stream-specs reveal">
          {SPECS.map((spec) => (
            <li key={spec.unit}>
              <span className="stream-lead">{spec.lead}</span>
              <span className="stream-number">
                <CountUp to={spec.value} />
                <span className={spec.unit === "K" ? "stream-unit is-joined" : "stream-unit"}>{spec.unit}</span>
              </span>
              <span className="stream-label">{spec.label}</span>
            </li>
          ))}
        </ul>
        <FrameRace />
        <ul className="stream-facts">
          {FACTS.map((fact) => (
            <li key={fact.value} className="reveal">
              <span className="stream-fact-icon" aria-hidden="true">
                {fact.icon}
              </span>
              <b>{fact.value}</b>
              <span>{fact.label}</span>
            </li>
          ))}
        </ul>
        <p className="note center reveal">
          Each number is the most that setting goes to, not one share doing all three at once: how much a share carries depends on the screen, the graphics card
          and the connection. The latency is as measured from one screen to another. Screens are captured natively on Windows and Linux, and through the
          browser's own capture on macOS and the web.
        </p>
      </div>
    </section>
  );
}

/** Counts up to its number once it comes into view. The page is rendered with the number itself, which is what shows without script or motion. */
function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const onScreen = useOnScreen(ref);
  const [shown, setShown] = useState(to);
  const done = useRef(false);

  useEffect(() => {
    if (!onScreen || done.current || prefersLessMotion()) return;
    done.current = true;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min((now - start) / 1400, 1);
      setShown(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [onScreen, to]);

  return <span ref={ref}>{shown}</span>;
}

/** Two lanes, one moved every frame at this screen's own rate and one only 30 times a second, with the rate it measured. */
function FrameRace() {
  const ref = useRef<HTMLDivElement>(null);
  const fast = useRef<HTMLDivElement>(null);
  const slow = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const [hz, setHz] = useState<number | null>(null);

  useEffect(() => {
    if (!onScreen) return;
    const still = prefersLessMotion();
    const gaps: number[] = [];
    let last = 0;
    let frame = requestAnimationFrame(function tick(now) {
      if (last) gaps.push(now - last);
      last = now;
      if (gaps.length === 90) {
        const sorted = [...gaps].sort((a, b) => a - b);
        setHz(nearestRate(1000 / sorted[45]!));
        gaps.length = 0;
      }
      if (!still && fast.current && slow.current) {
        const width = Math.max(fast.current.parentElement!.clientWidth - fast.current.clientWidth, 1);
        // One crossing every 1.6 s, the same path for both, the slow one only moved on its own frames.
        const at = (seconds: number) => ((seconds / 1.6) % 1) * width;
        fast.current.style.transform = `translateX(${at(now / 1000)}px)`;
        slow.current.style.transform = `translateX(${at(Math.floor((now / 1000) * SLOW_FPS) / SLOW_FPS)}px)`;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [onScreen]);

  return (
    <div className="race reveal" ref={ref}>
      <div className="race-head">
        <span>
          <MonitorUp size={15} aria-hidden="true" /> Sharing your screen
        </span>
        <span className="race-live">
          <i /> Live
        </span>
      </div>
      <div className="race-lanes">
        <div className="race-lane is-zuna">
          <span className="race-name">
            <b>Zuna</b> {hz === null ? "every frame" : `${Math.min(hz, MOST_FPS)} fps`}
          </span>
          <div className="race-track">
            <div className="race-block" ref={fast} />
          </div>
        </div>
        <div className="race-lane">
          <span className="race-name">
            <b>{SLOW_FPS} fps</b> for comparison
          </span>
          <div className="race-track">
            <div className="race-block" ref={slow} />
          </div>
        </div>
      </div>
      <p className="race-foot" aria-live="polite">
        {hz === null ? (
          "Measuring your screen…"
        ) : (
          <>
            Your screen refreshes at <b>{hz} Hz</b>. {hz <= MOST_FPS ? "Zuna can share every one of those frames." : `Zuna shares up to ${MOST_FPS} of them a second.`}
          </>
        )}
      </p>
    </div>
  );
}

/** Screens refresh at a handful of rates, so a measurement within 4% of one is that one. */
function nearestRate(measured: number): number {
  const known = [60, 75, 90, 100, 120, 144, 165, 175, 180, 200, 240, 280, 360, 480];
  return known.find((rate) => Math.abs(rate - measured) / rate < 0.04) ?? Math.round(measured);
}
