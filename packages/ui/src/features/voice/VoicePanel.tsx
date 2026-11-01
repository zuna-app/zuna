import { Camera, CameraOff, Headphones, HeadphoneOff, Lock, Mic, MicOff, MonitorOff, MonitorUp, PhoneOff, Settings as SettingsIcon, Signal, SignalLow, SignalMedium } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner, Tooltip } from "@/components/ui";
import { keyName } from "@/voice/settings";
import { useApp } from "@/state/store";
import { selfIsSpeaking, useVoice } from "@/voice/store";
import { ScreenPicker } from "./ScreenPicker";

function QualityIcon() {
  const quality = useVoice((state) => state.quality);
  const rtt = useVoice((state) => state.rtt);
  const icon = quality === "poor" || quality === "lost" ? <SignalLow size={14} /> : quality === "good" ? <SignalMedium size={14} /> : <Signal size={14} />;
  const words = quality === "lost" ? "Connection lost" : quality === "poor" ? "Weak connection" : quality === "good" ? "Good connection" : quality === "excellent" ? "Great connection" : "Connected";
  return (
    <Tooltip text={rtt !== null ? `${words}, ${rtt} ms` : words} side="top">
      <span className={`voice-quality is-${quality}`}>{icon}</span>
    </Tooltip>
  );
}

/** Stays at the bottom of the sidebar while in a voice channel, wherever else the person is. */
export function VoicePanel() {
  const status = useVoice((state) => state.status);
  const serverId = useVoice((state) => state.serverId);
  const channelId = useVoice((state) => state.channelId);
  const muted = useVoice((state) => state.muted);
  const deafened = useVoice((state) => state.deafened);
  const serverMuted = useVoice((state) => state.serverMuted);
  const noMic = useVoice((state) => state.noMic);
  const camera = useVoice((state) => state.camera);
  const screen = useVoice((state) => state.screen);
  const speaking = useVoice(selfIsSpeaking);
  const keyHeld = useVoice((state) => state.keyHeld);
  const settings = useVoice((state) => state.settings);
  const toggleMute = useVoice((state) => state.toggleMute);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const toggleCamera = useVoice((state) => state.toggleCamera);
  const stopScreen = useVoice((state) => state.stopScreen);
  const leave = useVoice((state) => state.leave);
  const server = useApp((state) => (serverId ? state.servers[serverId] : null));
  const selectServer = useApp((state) => state.selectServer);
  const setOverlay = useApp((state) => state.setOverlay);
  const [picking, setPicking] = useState(false);

  // Leaves cleanly when the page goes, instead of being left in the channel for a while.
  useEffect(() => {
    const onLeave = () => {
      if (useVoice.getState().status !== "idle") useVoice.getState().leave();
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, []);

  if (status === "idle" || !server || !channelId) return null;
  const channel = server.channels.find((item) => item.id === channelId);
  const self = server.self ? server.users[server.self.userId] : null;
  const micOff = muted || deafened || serverMuted || noMic;
  const statusText = status === "connected" ? "Voice connected" : status === "reconnecting" ? "Reconnecting" : "Connecting";

  return (
    <div className="voice-panel" role="region" aria-label="Voice channel">
      <div className="voice-panel-top">
        <button
          className="voice-panel-where"
          onClick={() => {
            selectServer(server.entry.id);
            useApp.getState().selectConversation(`group:${channelId}`);
          }}
        >
          <span className={`voice-panel-status is-${status}`}>
            {status === "connected" ? <QualityIcon /> : <Spinner size={12} />}
            {statusText}
            <Tooltip text="End-to-end encrypted: the server can't listen in" side="top">
              <Lock size={11} className="voice-panel-lock" />
            </Tooltip>
          </span>
          <span className="voice-panel-channel truncate">
            {channel?.name ?? "Voice channel"} / {server.entry.name}
          </span>
        </button>
        <Tooltip text="Disconnect" side="top">
          <button className="icon-btn voice-leave" onClick={leave} aria-label="Disconnect from voice">
            <PhoneOff size={17} />
          </button>
        </Tooltip>
      </div>
      <div className="voice-panel-actions">
        <Tooltip text={camera ? "Turn off camera" : "Turn on camera"} side="top">
          <button className={`voice-action${camera ? " is-on" : ""}`} onClick={() => void toggleCamera()} aria-label={camera ? "Turn off camera" : "Turn on camera"} aria-pressed={camera}>
            {camera ? <Camera size={16} /> : <CameraOff size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={screen ? "Stop sharing" : "Share your screen"} side="top">
          <button className={`voice-action${screen ? " is-on" : ""}`} onClick={() => (screen ? void stopScreen() : setPicking(true))} aria-label={screen ? "Stop sharing" : "Share your screen"} aria-pressed={!!screen}>
            {screen ? <MonitorOff size={16} /> : <MonitorUp size={16} />}
          </button>
        </Tooltip>
      </div>
      <div className="voice-panel-self">
        <span className="grow voice-self-name">
          <b className="truncate">{self?.displayName ?? "You"}</b>
          <span className="truncate faint">
            {serverMuted ? "Muted by an admin" : noMic ? "No microphone" : settings.inputMode === "ptt" ? (settings.pttKey ? `Hold ${keyName(settings.pttKey)}${keyHeld ? "…" : ""}` : "Set a push to talk key") : "Voice activity"}
          </span>
        </span>
        <Tooltip text={serverMuted ? "An admin muted you" : micOff ? "Unmute" : "Mute"} side="top">
          <button className={`icon-btn is-small${micOff ? " voice-off" : speaking ? " voice-heard" : ""}`} disabled={serverMuted || noMic} onClick={toggleMute} aria-label={micOff ? "Unmute" : "Mute"} aria-pressed={micOff}>
            {micOff ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={deafened ? "Undeafen" : "Deafen"} side="top">
          <button className={`icon-btn is-small${deafened ? " voice-off" : ""}`} onClick={toggleDeafen} aria-label={deafened ? "Undeafen" : "Deafen"} aria-pressed={deafened}>
            {deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
          </button>
        </Tooltip>
        <Tooltip text="Voice settings" side="top">
          <button className="icon-btn is-small" onClick={() => setOverlay({ type: "settings", section: "voice" })} aria-label="Voice settings">
            <SettingsIcon size={16} />
          </button>
        </Tooltip>
      </div>
      {picking && <ScreenPicker onClose={() => setPicking(false)} />}
    </div>
  );
}
