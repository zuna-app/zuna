import { screenTerms } from "@zuna/core/voice";
import { useState } from "react";
import { Modal, Spinner, Switch } from "@/components/ui";
import { useApp } from "@/state/store";
import { heightName, rateName, SCREEN_HEIGHTS, SCREEN_RATES, screenLimitsText } from "@/voice/settings";
import { useVoice } from "@/voice/store";
import { NumberSelect } from "./ScreenSettings";

const QUALITIES: { kbps: number; label: string; hint: string }[] = [
  { kbps: 6_000, label: "Smooth", hint: "For a slow connection" },
  { kbps: 12_000, label: "Clear", hint: "A good all-round choice" },
  { kbps: 20_000, label: "Sharp", hint: "Text stays crisp" },
  { kbps: 40_000, label: "Best", hint: "For fast connections and games" },
];

/** How a share goes, chosen before the browser asks what to share. */
export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const settings = useVoice((state) => state.settings);
  const updateSettings = useVoice((state) => state.updateSettings);
  const startScreen = useVoice((state) => state.startScreen);
  const serverId = useVoice((state) => state.serverId);
  const server = useApp((state) => (serverId ? state.servers[serverId] : undefined));
  const setOverlay = useApp((state) => state.setOverlay);
  const [starting, setStarting] = useState(false);
  const [withSound, setWithSound] = useState(settings.screenSoundByDefault);

  const rules = server?.info?.screen_share;
  const role = server?.self?.role;
  const terms = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: settings.screenBitrate, soundKbps: settings.screenSoundKbps }, rules, role);
  const suggested = screenTerms({ height: null, fps: null, kbps: null, soundKbps: settings.screenSoundKbps }, rules, role);
  const limits = screenLimitsText(rules, role);
  // What the limits leave out of the lists, which is nothing for someone they don't apply to.
  const limit = (value: number | undefined) => (limits ? (value ?? 0) : 0);
  const qualities = QUALITIES.filter((quality) => limit(rules?.max_kbps) === 0 || quality.kbps <= limit(rules?.max_kbps));

  const start = async () => {
    setStarting(true);
    await startScreen({ audio: terms.sound && withSound });
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
          <button className="btn btn-primary" disabled={starting} onClick={() => void start()}>
            {starting ? <Spinner size={15} /> : "Share"}
          </button>
        </>
      }
    >
      <p className="settings-lead" style={{ marginTop: 0 }}>
        Your browser asks what to share next.
      </p>
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
      {terms.sound && (
        <div className="setting-row">
          <span className="grow">
            <b>Share sound too</b>
            <span className="setting-hint">Everything your computer plays, apart from this call.</span>
          </span>
          <Switch on={withSound} onChange={setWithSound} label="Share sound too" />
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
