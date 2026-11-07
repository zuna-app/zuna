/**
 * The maintainers' benchmark of 6 November 2026 (the "Zuna Electron vs Native" dashboard): the native Windows app (GPUI 0.2.2, a Rust release
 * build) beside the Electron app (Electron 45.2.1, packaged by electron-builder) built from the same code, on one Windows 11 machine with a Ryzen 7
 * 9800X3D, 32 GB and an RTX 5070 Ti, both signed into the same test account on the same local server with its history synced, windows the same size
 * and place. Memory is each app's working set, all its processes, idle 15 s after opening six chats, scrolling and settings. Opening is the median of
 * five launches taken in turns, to a painted conversation list. The processor is a share of one core while scrolling #general. Sizes are the
 * installed apps, each with its screen capture.
 * Left out: playing a video message took more of a core natively (5.0%) than in Electron (1.9%), so the page claims less processor only while
 * scrolling.
 *
 * Native everywhere is claimed for the first release, on the maintainers' word: docs/SITE_PLAN.md says what's left.
 */
const MEMORY = { zuna: 137, electron: 614 };

const FIGURES: { claim: string; zuna: string; electron: string; ratio: number }[] = [
  { claim: "faster to open", zuna: "263 ms", electron: "485 ms", ratio: 485 / 263 },
  { claim: "less processor while scrolling", zuna: "2.5% of a core", electron: "23%", ratio: 23 / 2.5 },
  { claim: "smaller installed", zuna: "191 MB", electron: "496 MB", ratio: 496 / 191 },
];

function times(ratio: number): string {
  return `${ratio.toFixed(1).replace(/\.0$/, "")}×`;
}

/** One bar; how long each is, its share of Electron's, is in sections.css, as the page's policy allows no inline styles. */
function Bar({ who, value, own }: { who: string; value: number; own?: boolean }) {
  return (
    <div className={own ? "bars-row is-zuna" : "bars-row"}>
      <span className="bars-who">{who}</span>
      <span className="bars-track">
        <span className="bars-fill" />
      </span>
      <span className="bars-value">
        {value} <small>MB</small>
      </span>
    </div>
  );
}

export function NativeApps() {
  return (
    <section className="section" id="native">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Native apps</p>
          <h2 className="heading">Native, not a website in a box.</h2>
          <p className="lead">
            Most desktop chat apps, Matrix's and Fluxer's among them, are a web page running in its own copy of Chrome. Zuna is written in Rust and drawn
            straight on your GPU.
          </p>
        </div>

        <div className="native-hero reveal">
          <div className="native-headline">
            <span className="native-times">{times(MEMORY.electron / MEMORY.zuna)}</span>
            <span className="native-claim">less memory than the same app built on Electron</span>
          </div>
          <div className="bars">
            <Bar who="Zuna" value={MEMORY.zuna} own />
            <Bar who="Electron" value={MEMORY.electron} />
          </div>
        </div>

        <ul className="native-figures reveal">
          {FIGURES.map((figure) => (
            <li key={figure.claim}>
              <span className="native-figure">{times(figure.ratio)}</span>
              <span className="native-figure-claim">{figure.claim}</span>
              <span className="native-figure-detail">
                {figure.zuna} against {figure.electron}
              </span>
            </li>
          ))}
        </ul>

        <p className="note center reveal">
          Zuna's native app beside its own Electron app, built from the same code, on the same account and the same chats, on Windows 11 with a Ryzen 7 9800X3D.
          Memory is the working set of every process after opening six chats.
        </p>
      </div>
    </section>
  );
}
