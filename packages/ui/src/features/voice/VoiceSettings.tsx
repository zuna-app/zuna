import { Camera, Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui";
import { useEscape } from "@/lib/escape";
import { SettingRow } from "@/features/overlays/Settings";
import { useApp } from "@/state/store";
import { MicError, Microphone, type MicReading } from "@/voice/mic";
import { keyName, type NoiseSuppression } from "@/voice/settings";
import { useVoice, watchMic } from "@/voice/store";

/** The dB the meter shows, from silence on the left to loud on the right. */
const METER_FLOOR = -80;
const percent = (level: number): number => Math.max(0, Math.min(100, ((level - METER_FLOOR) / -METER_FLOOR) * 100));

function useDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => undefined);
    load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, []);
  return devices;
}

function DeviceSelect({ devices, kind, value, onChange, label }: { devices: MediaDeviceInfo[]; kind: MediaDeviceKind; value: string; onChange: (id: string) => void; label: string }) {
  const options = devices.filter((device) => device.kind === kind && device.deviceId !== "communications");
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="select" value={options.some((device) => device.deviceId === value) ? value : "default"} onChange={(event) => onChange(event.target.value)}>
        {!options.some((device) => device.deviceId === "default") && <option value="default">Default</option>}
        {options.map((device, index) => (
          <option key={device.deviceId || index} value={device.deviceId}>
            {device.label || `${kind === "audioinput" ? "Microphone" : kind === "audiooutput" ? "Speaker" : "Camera"} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * How loud the microphone is, as what the noise suppression lets through, which is
 * what the gate goes by. The bar is green past the point where sound goes out.
 */
function InputMeter({ onReady }: { onReady: (setter: (reading: MicReading) => void) => void }) {
  const bar = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    onReady((reading) => {
      if (bar.current) bar.current.style.transform = `scaleX(${percent(reading.level) / 100})`;
      if (dot.current) dot.current.classList.toggle("is-open", reading.open);
    });
  }, [onReady]);
  return (
    <span className="mic-meter" aria-hidden="true">
      <span ref={bar} className="mic-meter-bar" />
      <span ref={dot} className="mic-meter-open" />
    </span>
  );
}

/** Tries the microphone without being in a channel, with the same processing a call gets. */
function useMicTest(onReading: (reading: MicReading) => void) {
  const settings = useVoice((state) => state.settings);
  const inCall = useVoice((state) => state.status !== "idle");
  const toast = useApp((state) => state.toast);
  const [testing, setTesting] = useState(false);
  const mic = useRef<Microphone | null>(null);
  const context = useRef<AudioContext | null>(null);
  const reading = useRef(onReading);
  reading.current = onReading;

  const stop = () => {
    mic.current?.stop();
    mic.current = null;
    void context.current?.close().catch(() => undefined);
    context.current = null;
    setTesting(false);
  };

  useEffect(() => stop, []);
  useEffect(() => {
    if (inCall && testing) stop();
    // Any change to how it's set up is heard right away.
    mic.current?.apply(settings);
  });

  const start = async () => {
    if (testing) {
      stop();
      return;
    }
    const audio = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    context.current = audio;
    try {
      await audio.resume();
      const opened = await Microphone.open(audio, settings);
      if (context.current !== audio) {
        opened.stop();
        return;
      }
      opened.onReading = (value) => reading.current(value);
      // What comes out plays straight back, to hear what others would.
      audio.createMediaStreamSource(new MediaStream([opened.track])).connect(audio.destination);
      mic.current = opened;
      setTesting(true);
    } catch (error) {
      void audio.close().catch(() => undefined);
      context.current = null;
      toast(error instanceof MicError ? error.message : "The microphone couldn't be used.", "error");
    }
  };
  return { testing, start };
}

function KeyBinder() {
  const settings = useVoice((state) => state.settings);
  const updateSettings = useVoice((state) => state.updateSettings);
  const [listening, setListening] = useState(false);
  // Escape stops listening for a key, and leaves the settings open.
  useEscape(listening ? () => setListening(false) : null);
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      updateSettings({ pttKey: event.code });
      setListening(false);
    };
    const onMouse = (event: MouseEvent) => {
      // Only the side buttons: the others are for using the window. Some systems only bind keys.
      if (event.button < 3) return;
      event.preventDefault();
      updateSettings({ pttKey: `Mouse${event.button}` });
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [listening, updateSettings]);
  return (
    <button className={`btn${listening ? " is-listening" : ""}`} style={{ minWidth: 150 }} onClick={() => setListening(!listening)}>
      {listening ? "Press a key" : keyName(settings.pttKey)}
    </button>
  );
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const toast = useApp((state) => state.toast);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      const opened = await navigator.mediaDevices.getUserMedia({ video: deviceId === "default" ? true : { deviceId: { ideal: deviceId } } });
      if (cancelled) {
        for (const track of opened.getTracks()) track.stop();
        return;
      }
      stream = opened;
      if (video.current) video.current.srcObject = opened;
    })().catch(() => {
      toast("There's no camera Zuna can use.", "error");
      setOn(false);
    });
    return () => {
      cancelled = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [on, deviceId, toast]);
  return (
    <div className="camera-preview">
      {on ? (
        <video ref={video} autoPlay playsInline muted />
      ) : (
        <button className="btn" onClick={() => setOn(true)}>
          <Camera size={15} /> Try your camera
        </button>
      )}
    </div>
  );
}

const NOISE_CHOICES: { id: NoiseSuppression; label: string; hint: string }[] = [
  { id: "zuna", label: "Noise cancelling", hint: "Takes out fans, keyboards and traffic, right on this device." },
  { id: "standard", label: "Standard", hint: "Your browser's own, lighter and less thorough." },
  { id: "off", label: "Off", hint: "For a good microphone in a quiet room." },
];

/** How this device does voice: which devices, and when sound goes out. */
export function VoiceSettingsSection() {
  const settings = useVoice((state) => state.settings);
  const update = useVoice((state) => state.updateSettings);
  const inCall = useVoice((state) => state.status !== "idle");
  const devices = useDevices();
  const listener = useRef<((reading: MicReading) => void) | null>(null);
  const test = useMicTest((reading) => listener.current?.(reading));
  useEffect(() => watchMic((reading) => listener.current?.(reading)), []);
  const live = inCall || test.testing;

  return (
    <>
      <h1>Voice and video</h1>
      <p className="settings-lead">These are for this device. Everything said in a voice channel is encrypted before it leaves it.</p>

      <DeviceSelect devices={devices} kind="audioinput" value={settings.inputDevice} onChange={(id) => update({ inputDevice: id })} label="Microphone" />
      <label className="field">
        <span className="field-label">
          Microphone volume <b style={{ fontWeight: 500 }}>{Math.round(settings.inputVolume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={settings.inputVolume} onChange={(event) => update({ inputVolume: Number(event.target.value) })} />
      </label>
      <DeviceSelect devices={devices} kind="audiooutput" value={settings.outputDevice} onChange={(id) => update({ outputDevice: id })} label="Speakers or headphones" />
      <label className="field">
        <span className="field-label">
          Volume <b style={{ fontWeight: 500 }}>{Math.round(settings.outputVolume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={settings.outputVolume} onChange={(event) => update({ outputVolume: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span className="field-label">
          Soundboard volume <b style={{ fontWeight: 500 }}>{settings.soundboardVolume === 0 ? "off" : `${Math.round(settings.soundboardVolume * 100)}%`}</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={1} step={0.01} value={settings.soundboardVolume} onChange={(event) => update({ soundboardVolume: Number(event.target.value) })} />
        <span className="setting-hint">All the way down, no sounds from the soundboard play for you.</span>
      </label>

      <div className="field">
        <span className="field-label">When sound goes out</span>
        <div className="segmented voice-mode">
          <button className={settings.inputMode === "voice" ? "is-active" : ""} onClick={() => update({ inputMode: "voice" })}>
            <Mic size={14} /> When you talk
          </button>
          <button className={settings.inputMode === "ptt" ? "is-active" : ""} onClick={() => update({ inputMode: "ptt" })}>
            <MicOff size={14} /> Push to talk
          </button>
        </div>
      </div>

      {settings.inputMode === "voice" ? (
        <>
          <SettingRow title="Work out what's speech" hint="Listens for speech itself, so you don't have to pick a level.">
            <Switch on={settings.autoSensitivity} onChange={(value) => update({ autoSensitivity: value })} label="Work out what's speech" />
          </SettingRow>
          {!settings.autoSensitivity && (
            <label className="field">
              <span className="field-label">
                Only sounds louder than <b style={{ fontWeight: 500 }}>{settings.sensitivity} dB</b>
              </span>
              <span className="mic-sensitivity">
                <InputMeter onReady={(setter) => (listener.current = setter)} />
                <input className="voice-slider is-over-meter" type="range" min={METER_FLOOR} max={0} step={1} value={settings.sensitivity} onChange={(event) => update({ sensitivity: Number(event.target.value) })} />
              </span>
            </label>
          )}
        </>
      ) : (
        <>
          <SettingRow title="Key to hold" hint="Works while this window is in front.">
            <KeyBinder />
          </SettingRow>
          <label className="field">
            <span className="field-label">
              Keep going after you let go <b style={{ fontWeight: 500 }}>{settings.pttRelease} ms</b>
            </span>
            <input className="voice-slider" type="range" min={0} max={1000} step={10} value={settings.pttRelease} onChange={(event) => update({ pttRelease: Number(event.target.value) })} />
          </label>
        </>
      )}

      {(settings.inputMode !== "voice" || settings.autoSensitivity) && (
        <div className="field">
          <span className="field-label">How your microphone sounds</span>
          <InputMeter onReady={(setter) => (listener.current = setter)} />
        </div>
      )}
      {!inCall && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => void test.start()}>
            {test.testing ? "Stop" : "Test your microphone"}
          </button>
          {test.testing && <span className="faint" style={{ fontSize: 12.5 }}>You're hearing what others would.</span>}
          {!live && <span className="faint" style={{ fontSize: 12.5 }}>Use headphones, or you'll hear yourself twice.</span>}
        </div>
      )}

      <div className="field">
        <span className="field-label">Background noise</span>
        <div className="voice-noise">
          {NOISE_CHOICES.map((choice) => (
            <button key={choice.id} className={settings.noiseSuppression === choice.id ? "is-active" : ""} onClick={() => update({ noiseSuppression: choice.id })} aria-pressed={settings.noiseSuppression === choice.id}>
              <b>{choice.label}</b>
              <span>{choice.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <SettingRow title="Echo cancellation" hint="Stops others hearing themselves through your speakers.">
        <Switch on={settings.echoCancellation} onChange={(value) => update({ echoCancellation: value })} label="Echo cancellation" />
      </SettingRow>
      <SettingRow title="Automatic volume" hint="Keeps your voice at about the same level.">
        <Switch on={settings.autoGain} onChange={(value) => update({ autoGain: value })} label="Automatic volume" />
      </SettingRow>

      <DeviceSelect devices={devices} kind="videoinput" value={settings.cameraDevice} onChange={(id) => update({ cameraDevice: id })} label="Camera" />
      <CameraPreview deviceId={settings.cameraDevice} />

      <SettingRow title="Sounds" hint="When people come and go, and when you mute.">
        <Switch on={settings.sounds} onChange={(value) => update({ sounds: value })} label="Sounds" />
      </SettingRow>
      <SettingRow title="Come in muted" hint="Starts every voice channel with your microphone off.">
        <Switch on={settings.startMuted} onChange={(value) => update({ startMuted: value })} label="Come in muted" />
      </SettingRow>
    </>
  );
}
