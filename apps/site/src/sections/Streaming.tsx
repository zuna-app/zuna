import { Maximize2, MonitorUp, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prefersLessMotion, useOnScreen } from "../components/reveal";

/** The most a share's frame rate can be set to, the last of SCREEN_RATES in packages/ui/src/voice/settings.ts. */
const MOST_FPS = 240;

/** Each the most its setting goes to, from SCREEN_RATES and SCREEN_HEIGHTS, and the maintainers' measured latency. */
const SPECS = [
  { name: "Frame rate", value: `Up to ${MOST_FPS} fps` },
  { name: "Resolution", value: "Up to 4K" },
  { name: "Latency", value: "About 80 ms" },
];

const FACTS = [
  { value: "≈5%", label: "of one core for a 1440p share at 60 fps" },
  { value: "1 app", label: "Share one app's sound, not your whole desktop" },
  { value: "GPU", label: "Encoded on your graphics card, not your processor" },
];

export function Streaming() {
  return (
    <section className="section" id="streaming">
      <div className="wrap">
        <div className="stream">
          <div className="stream-copy reveal">
            <p className="eyebrow">Screen sharing</p>
            <h2 className="heading">Your screen, sharp and smooth.</h2>
            <p className="lead">
              Captured natively, encoded on your GPU and encrypted end to end, so a fast game or a page of small text looks to your friends as it does to you.
            </p>
            <dl className="specs">
              {SPECS.map((spec) => (
                <div key={spec.name}>
                  <dt>{spec.name}</dt>
                  <dd>{spec.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <RefreshMeter />
        </div>
        <ul className="stream-facts reveal">
          {FACTS.map((fact) => (
            <li key={fact.value}>
              <b>{fact.value}</b>
              <span>{fact.label}</span>
            </li>
          ))}
        </ul>
        <p className="note reveal">
          Each is the most that setting goes to, not one share doing all three at once: how much a share carries depends on the screen, the graphics card and the
          connection. The latency is as measured from one screen to another. Screens are captured natively on Windows and Linux, and through the browser's own
          capture on macOS and the web.
        </p>
      </div>
    </section>
  );
}

/** A bar that moves once per frame, with the rate this screen refreshes at. */
function RefreshMeter() {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const [hz, setHz] = useState<number | null>(null);

  useEffect(() => {
    if (!onScreen) return;
    const still = prefersLessMotion();
    const gaps: number[] = [];
    let last = 0;
    let x = 0;
    let frame = requestAnimationFrame(function tick(now) {
      if (last) gaps.push(now - last);
      last = now;
      if (gaps.length === 90) {
        const sorted = [...gaps].sort((a, b) => a - b);
        setHz(nearestRate(1000 / sorted[45]!));
        gaps.length = 0;
      }
      if (!still && bar.current) {
        const width = bar.current.parentElement!.clientWidth - bar.current.clientWidth;
        x = (x + 3) % Math.max(width, 1);
        bar.current.style.transform = `translateX(${x}px)`;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [onScreen]);

  return (
    <div className="meter reveal" ref={ref}>
      <div className="meter-head">
        <span>
          <MonitorUp size={15} aria-hidden="true" /> Your screen
        </span>
        <span className="meter-live">
          <i /> Live
        </span>
      </div>
      <div className="meter-screen">
        <div className="meter-bar" ref={bar} />
        <div className="meter-grid" aria-hidden="true" />
      </div>
      <div className="meter-foot">
        <p aria-live="polite">
          {hz === null ? (
            "Measuring your screen…"
          ) : (
            <>
              Your screen refreshes at <b>{hz} Hz</b>. {hz <= MOST_FPS ? "Zuna can share every frame." : `Zuna shares up to ${MOST_FPS} frames a second.`}
            </>
          )}
        </p>
        <span className="meter-tools" aria-hidden="true">
          <Volume2 size={15} />
          <Maximize2 size={15} />
        </span>
      </div>
    </div>
  );
}

/** Screens refresh at a handful of rates, so a measurement within 4% of one is that one. */
function nearestRate(measured: number): number {
  const known = [60, 75, 90, 100, 120, 144, 165, 175, 180, 200, 240, 280, 360, 480];
  return known.find((rate) => Math.abs(rate - measured) / rate < 0.04) ?? Math.round(measured);
}
