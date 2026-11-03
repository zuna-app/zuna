import { Maximize2, MonitorUp, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prefersLessMotion, useOnScreen } from "../components/reveal";

/** What a share's frame rate can be set to, from SCREEN_RATES in packages/ui/src/voice/settings.ts. */
const RATES = [5, 10, 15, 24, 30, 45, 60, 75, 90, 120, 144, 165, 240];

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
            <p className="stream-number" aria-hidden="true">
              240<span>fps</span>
            </p>
            <h2 className="heading">Share your screen at up to 240 fps.</h2>
            <p className="lead">
              Captured natively, encoded on your GPU and encrypted end to end, so a fast game looks as smooth to your friends as it does to you.
            </p>
            <ul className="rates" aria-label="Frame rates you can share at">
              {RATES.map((rate) => (
                <li key={rate} className={rate === 240 ? "is-top" : ""}>
                  {rate}
                </li>
              ))}
            </ul>
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
          Up to 240 fps needs a screen that refreshes that fast. Screens are captured natively on Windows and Linux, and through the browser's own capture on
          macOS and the web.
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
              Your screen refreshes at <b>{hz} Hz</b>. {hz >= 200 ? "Zuna can share every frame of it." : "On a faster one, Zuna shares up to 240 fps."}
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
