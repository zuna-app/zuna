import { Monitor, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal, Spinner, Switch } from "@/components/ui";
import { platform, type DisplaySource } from "@/platform";
import { useVoice } from "@/voice/store";

const QUALITIES: { kbps: number; label: string; hint: string }[] = [
  { kbps: 6_000, label: "Smooth", hint: "For a slow connection" },
  { kbps: 12_000, label: "Clear", hint: "A good all-round choice" },
  { kbps: 20_000, label: "Sharp", hint: "Text stays crisp" },
  { kbps: 40_000, label: "Best", hint: "For fast connections and games" },
];

/** What to share, and how, with a look at each before choosing. */
export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const settings = useVoice((state) => state.settings);
  const updateSettings = useVoice((state) => state.updateSettings);
  const startScreen = useVoice((state) => state.startScreen);
  const [sources, setSources] = useState<DisplaySource[] | null>(platform.displaySources ? null : []);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [chosen, setChosen] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void platform
      .displaySources?.()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        setChosen(list.find((source) => source.kind === "screen")?.id ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickable = sources?.filter((source) => source.kind === tab) ?? [];
  const source = sources?.find((item) => item.id === chosen);
  const usesBrowserPicker = sources !== null && sources.length === 0;
  const canShareAudio = !!platform.systemAudio;

  const start = async () => {
    setStarting(true);
    await startScreen({
      source: source?.id,
      native: !!source?.native,
      fps: settings.screenFps,
      bitrateKbps: settings.screenBitrate,
      audio: audio && canShareAudio,
      name: source?.name,
    });
    onClose();
  };

  return (
    <Modal
      title="Share your screen"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={starting || sources === null || (!usesBrowserPicker && !source)} onClick={() => void start()}>
            {starting ? <Spinner size={15} /> : "Share"}
          </button>
        </>
      }
    >
      {sources === null ? (
        <div className="screen-loading">
          <Spinner />
        </div>
      ) : usesBrowserPicker ? (
        <p className="settings-lead" style={{ marginTop: 0 }}>
          Your browser asks what to share next.
        </p>
      ) : (
        <>
          <div className="segmented screen-tabs">
            <button className={tab === "screen" ? "is-active" : ""} onClick={() => setTab("screen")}>
              Screens
            </button>
            <button className={tab === "window" ? "is-active" : ""} onClick={() => setTab("window")}>
              Windows
            </button>
          </div>
          <div className="screen-grid">
            {pickable.map((item) => (
              <button key={item.id} className={`screen-source${item.id === chosen ? " is-chosen" : ""}`} onClick={() => setChosen(item.id)} onDoubleClick={() => void start()} aria-pressed={item.id === chosen}>
                <span className="screen-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} /> : <Monitor size={26} />}</span>
                <span className="screen-name truncate">{item.name}</span>
              </button>
            ))}
            {pickable.length === 0 && <p className="faint">{tab === "window" ? "There are no windows to share." : "There are no screens to share."}</p>}
          </div>
          {source?.native && (
            <p className="screen-native">
              <Zap size={13} /> Captured and encoded on your graphics card, so it stays light on your computer.
            </p>
          )}
        </>
      )}
      <div className="field">
        <span className="field-label">Quality</span>
        <div className="screen-quality">
          {QUALITIES.map((quality) => (
            <button key={quality.kbps} className={settings.screenBitrate === quality.kbps ? "is-active" : ""} onClick={() => updateSettings({ screenBitrate: quality.kbps })}>
              <b>{quality.label}</b>
              <span>{quality.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <span className="grow">
          <b>Frame rate</b>
        </span>
        <div className="segmented">
          {([30, 60] as const).map((fps) => (
            <button key={fps} className={settings.screenFps === fps ? "is-active" : ""} onClick={() => updateSettings({ screenFps: fps })}>
              {fps} fps
            </button>
          ))}
        </div>
      </div>
      {canShareAudio && (
        <div className="setting-row">
          <span className="grow">
            <b>Share sound too</b>
            <span className="setting-hint">Everything your computer plays, apart from this call.</span>
          </span>
          <Switch on={audio} onChange={setAudio} label="Share sound too" />
        </div>
      )}
    </Modal>
  );
}
