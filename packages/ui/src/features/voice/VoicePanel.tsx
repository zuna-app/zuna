import { Camera, CameraOff, Headphones, HeadphoneOff, Lock, Mic, MicOff, MonitorOff, MonitorUp, PhoneOff, Settings as SettingsIcon, Signal, SignalLow, SignalMedium } from "lucide-react";
import { useEffect } from "react";
import { screenRefusal } from "@zuna/core/voice";
import { Spinner, Tooltip } from "@/components/ui";
import { useScreenAwake } from "@/lib/awake";
import { t } from "@/lib/i18n";
import { keyName } from "@/voice/settings";
import { conversationOfGroup, useApp } from "@/state/store";
import { selfIsSpeaking, useVoice } from "@/voice/store";

function QualityIcon() {
  const quality = useVoice((state) => state.quality);
  const rtt = useVoice((state) => state.rtt);
  const icon = quality === "poor" || quality === "lost" ? <SignalLow size={14} /> : quality === "good" ? <SignalMedium size={14} /> : <Signal size={14} />;
  const words = quality === "lost" ? t("voice.quality.lost") : quality === "poor" ? t("voice.quality.weak") : quality === "good" ? t("voice.quality.good") : quality === "excellent" ? t("voice.quality.great") : t("voice.quality.connected");
  return (
    <Tooltip text={rtt !== null ? t("voice.quality.withPing", { quality: words, ms: rtt }) : words} side="top">
      <span className={`voice-quality is-${quality}`}>{icon}</span>
    </Tooltip>
  );
}

/** Stays at the bottom of the sidebar while in a voice channel or a call, wherever else the person is. */
export function VoicePanel() {
  const status = useVoice((state) => state.status);
  const serverId = useVoice((state) => state.serverId);
  const channelId = useVoice((state) => state.channelId);
  const isCall = useVoice((state) => state.call);
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
  const shareRefusal = screenRefusal(server?.info?.screen_share, server?.self?.role, isCall ? 0 : server?.channels.find((item) => item.id === channelId)?.screenLimit);
  const selectServer = useApp((state) => state.selectServer);
  const setOverlay = useApp((state) => state.setOverlay);
  const startScreen = useVoice((state) => state.startScreen);
  // The browser asks what to share, and offers its sound when this asks for that.
  const shareSound = useVoice((state) => state.settings.screenSoundByDefault);

  // Leaves cleanly when the page goes, instead of being left in the channel for a while.
  useEffect(() => {
    const onLeave = () => {
      if (useVoice.getState().status !== "idle") useVoice.getState().leave();
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, []);
  // A camera or a screen going out is watched by the others wherever this person is in the app, so the screen stays on for it.
  useScreenAwake(status !== "idle" && (camera || !!screen));

  if (status === "idle" || !server || !channelId) return null;
  const channel = server.channels.find((item) => item.id === channelId);
  const conversation = isCall ? conversationOfGroup(server, channelId) : undefined;
  const self = server.self ? server.users[server.self.userId] : null;
  const micOff = muted || deafened || serverMuted || noMic;
  const statusText = status === "connected" ? (isCall ? t("voice.panel.callConnected") : t("voice.panel.voiceConnected")) : status === "reconnecting" ? t("voice.panel.reconnecting") : t("voice.panel.connecting");
  const where = isCall ? (conversation?.title ?? t("voice.panel.call")) : (channel?.name ?? t("voice.panel.voiceChannel"));

  return (
    <div className="voice-panel" role="region" aria-label={isCall ? t("voice.panel.call") : t("voice.panel.voiceChannel")}>
      <div className="voice-panel-top">
        <button
          className="voice-panel-where"
          onClick={() => {
            selectServer(server.entry.id);
            useApp.getState().selectConversation(conversation?.key ?? `group:${channelId}`);
          }}
        >
          <span className={`voice-panel-status is-${status}`}>
            {status === "connected" ? <QualityIcon /> : <Spinner size={12} />}
            {statusText}
            <Tooltip text={t("voice.panel.encrypted")} side="top">
              <Lock size={11} className="voice-panel-lock" />
            </Tooltip>
          </span>
          <span className="voice-panel-channel truncate">
            {where} / {server.entry.name}
          </span>
        </button>
        <Tooltip text={t("voice.controls.disconnect")} side="top">
          <button className="icon-btn voice-leave" onClick={leave} aria-label={isCall ? t("voice.panel.leaveCall") : t("voice.bar.disconnect")}>
            <PhoneOff size={17} />
          </button>
        </Tooltip>
      </div>
      <div className="voice-panel-actions">
        <Tooltip text={camera ? t("voice.controls.cameraOff") : t("voice.controls.cameraOn")} side="top">
          <button className={`voice-action${camera ? " is-on" : ""}`} onClick={() => void toggleCamera()} aria-label={camera ? t("voice.controls.cameraOff") : t("voice.controls.cameraOn")} aria-pressed={camera}>
            {camera ? <Camera size={16} /> : <CameraOff size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={screen ? t("voice.controls.stopSharing") : (shareRefusal ?? t("voice.controls.shareScreen"))} side="top">
          <button className={`voice-action${screen ? " is-on" : ""}`} disabled={!screen && !!shareRefusal} onClick={() => (screen ? void stopScreen() : void startScreen({ audio: shareSound }))} aria-label={screen ? t("voice.controls.stopSharing") : t("voice.controls.shareScreen")} aria-pressed={!!screen}>
            {screen ? <MonitorOff size={16} /> : <MonitorUp size={16} />}
          </button>
        </Tooltip>
      </div>
      <div className="voice-panel-self">
        <span className="grow voice-self-name">
          <b className="truncate">{self?.displayName ?? t("common.you")}</b>
          <span className="truncate faint">
            {serverMuted
              ? t("voice.panel.adminMuted")
              : noMic
                ? t("voice.controls.noMic")
                : settings.inputMode === "ptt"
                  ? settings.pttKey
                    ? keyHeld
                      ? t("voice.panel.holding", { key: keyName(settings.pttKey) })
                      : t("voice.panel.hold", { key: keyName(settings.pttKey) })
                    : t("voice.panel.setKey")
                  : t("voice.settings.voiceActivity")}
          </span>
        </span>
        <Tooltip text={serverMuted ? t("voice.controls.adminMuted") : micOff ? t("voice.controls.unmute") : t("voice.controls.mute")} side="top">
          <button className={`icon-btn is-small${micOff ? " voice-off" : speaking ? " voice-heard" : ""}`} disabled={serverMuted || noMic} onClick={toggleMute} aria-label={micOff ? t("voice.controls.unmute") : t("voice.controls.mute")} aria-pressed={micOff}>
            {micOff ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={deafened ? t("voice.controls.undeafen") : t("voice.controls.deafen")} side="top">
          <button className={`icon-btn is-small${deafened ? " voice-off" : ""}`} onClick={toggleDeafen} aria-label={deafened ? t("voice.controls.undeafen") : t("voice.controls.deafen")} aria-pressed={deafened}>
            {deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={t("voice.controls.settings")} side="top">
          <button className="icon-btn is-small" onClick={() => setOverlay({ type: "settings", section: "voice" })} aria-label={t("voice.controls.settings")}>
            <SettingsIcon size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
