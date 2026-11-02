import { screenTerms } from "@zuna/core/voice";
import { AppWindow, Monitor, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Modal, Spinner, Switch } from "@/components/ui";
import { platform, type DisplaySource, type SoundApp, type WindowSoundApp } from "@/platform";
import { useApp } from "@/state/store";
import { heightName, rateName, SCREEN_HEIGHTS, SCREEN_RATES, screenLimitsText } from "@/voice/settings";
import { useVoice } from "@/voice/store";
import { NumberSelect } from "./ScreenSettings";

/** How often the apps playing sound are looked at again while choosing. */
const SOUND_APPS_EVERY_MS = 3000;

const appName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

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
  const serverId = useVoice((state) => state.serverId);
  const server = useApp((state) => (serverId ? state.servers[serverId] : undefined));
  const setOverlay = useApp((state) => state.setOverlay);
  const [sources, setSources] = useState<DisplaySource[] | null>(platform.displaySources ? null : []);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [chosen, setChosen] = useState<string | null>(null);
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
  const rules = server?.info?.screen_share;
  const role = server?.self?.role;
  const terms = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: settings.screenBitrate, soundKbps: settings.screenSoundKbps }, rules, role);
  const suggested = screenTerms({ height: null, fps: null, kbps: null, soundKbps: settings.screenSoundKbps }, rules, role);
  const canShareAudio = !!platform.systemAudio && terms.sound;
  const soundApps = useSoundApps(canShareAudio);
  const sound = useShareSound(source, usesBrowserPicker, settings.screenSoundByDefault);
  const native = !!source?.native && settings.screenNative;
  const limits = screenLimitsText(rules, role);
  // What the limits leave out of the lists, which is nothing for someone they don't apply to.
  const limit = (value: number | undefined) => (limits ? (value ?? 0) : 0);
  const qualities = QUALITIES.filter((quality) => limit(rules?.max_kbps) === 0 || quality.kbps <= limit(rules?.max_kbps));

  const start = async () => {
    setStarting(true);
    const soundApp = sound.pick.startsWith("app:") ? sound.pick.slice(4) : null;
    await startScreen({ source: source?.id, native: !!source?.native, audio: canShareAudio && sound.pick !== "", soundApp, name: source?.name });
    onClose();
  };
  const showTab = (kind: "screen" | "window") => {
    setTab(kind);
    // Where the system picks, each tab has one thing to choose, which is what the tab means.
    const only = sources?.filter((item) => item.kind === kind) ?? [];
    if (only.length === 1 && only[0].systemPicks) setChosen(only[0].id);
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
            <button className={tab === "screen" ? "is-active" : ""} onClick={() => showTab("screen")}>
              Screens
            </button>
            <button className={tab === "window" ? "is-active" : ""} onClick={() => showTab("window")}>
              Windows
            </button>
          </div>
          <div className="screen-grid">
            {pickable.map((item) => (
              <button key={item.id} className={`screen-source${item.id === chosen ? " is-chosen" : ""}`} onClick={() => setChosen(item.id)} onDoubleClick={() => void start()} aria-pressed={item.id === chosen}>
                <span className="screen-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} /> : item.kind === "window" ? <AppWindow size={26} /> : <Monitor size={26} />}</span>
                <span className="screen-name truncate">{item.name}</span>
              </button>
            ))}
            {pickable.length === 0 && <p className="faint">{tab === "window" ? "There are no windows to share." : "There are no screens to share."}</p>}
          </div>
          {source?.systemPicks && <p className="setting-hint">{source.kind === "window" ? "Your system asks which window, once you press Share." : "Your system asks which screen, once you press Share."}</p>}
          {native && (
            <p className="screen-native">
              <Zap size={13} /> Captured and encoded on your graphics card, so it stays light on your computer.
            </p>
          )}
        </>
      )}
      {qualities.length > 0 && (
        <div className="field">
          <span className="field-label">Quality</span>
          <div className="screen-quality">
            {qualities.map((quality) => (
              <button key={quality.kbps} className={terms.kbps === quality.kbps ? "is-active" : ""} onClick={() => updateSettings({ screenBitrate: quality.kbps })}>
                <b>{quality.label}</b>
                <span>{quality.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="screen-sizes">
        <NumberSelect
          label="Size"
          value={settings.screenHeight}
          options={[0, ...SCREEN_HEIGHTS]}
          name={heightName}
          extras={[{ value: null, label: `Server's choice (${heightName(suggested.height)})` }]}
          limit={limit(rules?.max_height)}
          onChange={(value) => updateSettings({ screenHeight: value })}
        />
        <NumberSelect
          label="Frame rate"
          value={settings.screenFps}
          options={SCREEN_RATES}
          name={rateName}
          extras={[{ value: null, label: `Server's choice (${rateName(suggested.fps)})` }]}
          limit={limit(rules?.max_fps)}
          onChange={(value) => updateSettings({ screenFps: value })}
        />
      </div>
      {limits && <p className="screen-held">{limits}</p>}
      {canShareAudio && platform.shareSound && <SoundChoice pick={sound.pick} apps={soundApps} windowApp={sound.windowApp} ownerUnknown={!!source?.ownerUnknown} onChoose={sound.choose} />}
      {canShareAudio && !platform.shareSound && (
        <div className="setting-row">
          <span className="grow">
            <b>Share sound too</b>
            <span className="setting-hint">Everything your computer plays, apart from this call.</span>
          </span>
          <Switch on={sound.pick !== ""} onChange={(value) => sound.choose(value ? "everything" : "")} label="Share sound too" />
        </div>
      )}
      <button
        className="screen-more"
        onClick={() => {
          onClose();
          setOverlay({ type: "settings", section: "screen" });
        }}
      >
        More screen sharing settings
      </button>
    </Modal>
  );
}

/** The apps playing sound now, kept up to date while the picker is open, where the platform can tell them apart. */
function useSoundApps(wanted: boolean): SoundApp[] {
  const [apps, setApps] = useState<SoundApp[]>([]);
  useEffect(() => {
    const shareSound = platform.shareSound;
    if (!wanted || !shareSound) return;
    let cancelled = false;
    const look = () =>
      void shareSound
        .apps()
        .then((list) => {
          if (!cancelled) setApps(list);
        })
        .catch(() => undefined);
    look();
    // Apps only show while they play, so they come and go.
    const timer = setInterval(look, SOUND_APPS_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wanted]);
  return apps;
}

type SoundPick = "" | "everything" | `app:${string}`;

/**
 * Whose sound a share starts with: a screen's the whole computer's, and a window's the app
 * it belongs to, where the system says which. What the person chooses instead holds until
 * they choose another source.
 */
function useShareSound(source: DisplaySource | undefined, browserPicks: boolean, byDefault: boolean) {
  const key = browserPicks ? "browser" : (source?.id ?? null);
  const [chosen, setChosen] = useState<{ key: string | null; pick: SoundPick } | null>(null);
  const [lookup, setLookup] = useState<{ key: string; app: WindowSoundApp | null } | null>(null);
  const windowId = source?.kind === "window" && !source.ownerUnknown ? source.id : null;

  useEffect(() => {
    const shareSound = platform.shareSound;
    if (!windowId || !shareSound) return;
    let cancelled = false;
    void shareSound
      .windowApp(windowId)
      .catch(() => null)
      .then((app) => {
        if (!cancelled) setLookup({ key: windowId, app });
      });
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  const windowApp = lookup?.key === key ? lookup.app : null;
  const fallback = (): SoundPick => {
    if (!byDefault) return "";
    if (browserPicks || source?.kind !== "window") return "everything";
    // Only the window's own app will do: everything would be more than the window shows.
    if (!platform.shareSound) return "";
    // Wayland's portal doesn't say whose a window is, on any compositor, so it starts without, and the person can choose.
    return windowApp ? `app:${windowApp.id}` : "";
  };
  return {
    pick: chosen?.key === key ? chosen.pick : fallback(),
    windowApp,
    choose: (pick: SoundPick) => setChosen({ key, pick }),
  };
}

/** Whose sound goes with the share: nobody's, everything but Zuna's, or one app's. */
function SoundChoice({
  pick,
  apps,
  windowApp,
  ownerUnknown,
  onChoose,
}: {
  pick: SoundPick;
  apps: SoundApp[];
  windowApp: WindowSoundApp | null;
  ownerUnknown: boolean;
  onChoose: (pick: SoundPick) => void;
}) {
  // An app that stops playing stays on offer while it's chosen, since its sound goes once it plays again.
  const names = useRef(new Map<string, string>());
  for (const app of windowApp ? [windowApp, ...apps] : apps) names.current.set(app.id, app.name);
  const picked = pick.startsWith("app:") ? pick.slice(4) : null;
  const others = apps.filter((app) => app.id !== windowApp?.id && !windowApp?.covers.includes(app.id));
  const listed: (SoundApp & { quiet?: boolean })[] = [...(windowApp ? [{ ...windowApp, quiet: !windowApp.playing }] : []), ...others];
  if (picked && !listed.some((app) => app.id === picked)) listed.push({ id: picked, name: names.current.get(picked) ?? picked, quiet: true });
  const label = (app: SoundApp & { quiet?: boolean }) => {
    const name = appName(app.name);
    const named = listed.filter((other) => other.name === app.name).length > 1 ? `${name} (${app.id})` : name;
    return app.quiet ? `${named}, once it plays` : named;
  };
  const pickedName = listed.find((app) => app.id === picked)?.name;
  return (
    <label className="field">
      <span className="field-label">Sound</span>
      <select className="select" value={pick} onChange={(event) => onChoose(event.target.value as SoundPick)}>
        <option value="">No sound</option>
        <option value="everything">Entire system</option>
        {listed.length > 0 && (
          <optgroup label="One app">
            {listed.map((app) => (
              <option key={app.id} value={`app:${app.id}`}>
                {label(app)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <span className="setting-hint">
        {pick === "everything"
          ? `Everything your computer plays, apart from Zuna, so nobody hears themselves back.${ownerUnknown ? " That's more than the window shows." : ""}`
          : pickedName
            ? `Only what ${appName(pickedName)} plays.`
            : ownerUnknown
              ? "Your system doesn't say whose a window is, so choose the app whose sound goes with it. Apps show here while they play."
              : "Apps show here while they play sound."}
      </span>
    </label>
  );
}
