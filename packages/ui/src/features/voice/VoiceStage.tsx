import type { ChannelView, VoiceMember } from "@zuna/core";
import {
  Activity,
  Camera,
  CameraOff,
  ChevronUp,
  Expand,
  HeadphoneOff,
  Headphones,
  Lock,
  MessageSquare,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  Pin,
  PinOff,
  Settings,
  ShieldOff,
  Shrink,
  UserX,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Spinner, Tooltip, useContextMenu, type MenuEntry } from "@/components/ui";
import { avatarColor } from "@/lib/format";
import { useActiveServer, useApp } from "@/state/store";
import type { VideoTile } from "@/voice/room";
import { selfIsSpeaking, useVoice } from "@/voice/store";
import { screenRefusal } from "@zuna/core/voice";
import { ChatView } from "@/features/chat/ChatView";
import { channelTitle } from "./ChannelList";
import { ScreenPicker } from "./ScreenPicker";
import { StreamStatsPanel } from "./StreamStatsPanel";

/** Shows one video. A track can be attached to many elements, and each is let go of when it's gone. */
const VideoView = memo(function VideoView({ tile, contain }: { tile: VideoTile; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    tile.track.attach(element);
    return () => {
      tile.track.detach(element);
    };
  }, [tile.track]);
  return <video ref={ref} className={`voice-video${contain ? " is-contained" : ""}${tile.local && tile.source === "camera" ? " is-mirrored" : ""}`} autoPlay playsInline muted />;
});

function useMemberMenu() {
  const menu = useContextMenu();
  const [target, setTarget] = useState<string | null>(null);
  return { ...menu, target, openFor: (event: React.MouseEvent, userId: string) => (setTarget(userId), menu.open(event)) };
}

function VolumeSlider({ userId }: { userId: string }) {
  const volume = useVoice((state) => state.volumes[userId] ?? 1);
  const setVolume = useVoice((state) => state.setVolume);
  return (
    <label className="member-volume" onMouseDown={(event) => event.stopPropagation()}>
      <span>
        Volume <b>{Math.round(volume * 100)}%</b>
      </span>
      <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={volume} onChange={(event) => setVolume(userId, Number(event.target.value))} />
    </label>
  );
}

function MemberMenu({ userId, channelId, member, x, y, onClose }: { userId: string; channelId: string; member?: VoiceMember; x: number; y: number; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const setOverlay = useApp((state) => state.setOverlay);
  const toast = useApp((state) => state.toast);
  const localMuted = useVoice((state) => !!state.localMutes[userId]);
  const toggleLocalMute = useVoice((state) => state.toggleLocalMute);
  const micOff = useVoice((state) => state.muted || state.deafened);
  const deafened = useVoice((state) => state.deafened);
  const canTalk = useVoice((state) => !state.serverMuted && !state.noMic);
  const toggleMute = useVoice((state) => state.toggleMute);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const selfRole = server?.self?.role;
  const isSelf = userId === server?.self?.userId;
  const target = server?.users[userId];
  const canModerate = !isSelf && (selfRole === "owner" || (selfRole === "admin" && target?.role === "member"));
  const fail = (error: Error) => toast(error.message, "error");
  const entries: MenuEntry[] = [
    // On yourself, what the buttons below the call do, as there's nothing to do to yourself.
    ...(isSelf
      ? [
          ...(canTalk ? [{ label: micOff ? "Unmute" : "Mute", icon: micOff ? <Mic size={15} /> : <MicOff size={15} />, onSelect: toggleMute }] : []),
          { label: deafened ? "Undeafen" : "Deafen", icon: deafened ? <Headphones size={15} /> : <HeadphoneOff size={15} />, onSelect: toggleDeafen },
          { label: "Voice settings", icon: <Settings size={15} />, onSelect: () => setOverlay({ type: "settings", section: "voice" }) },
        ]
      : []),
    ...(isSelf ? [] : [{ label: localMuted ? "Unmute for me" : "Mute for me", icon: localMuted ? <Volume2 size={15} /> : <VolumeX size={15} />, onSelect: () => toggleLocalMute(userId) }]),
    ...(isSelf ? [] : [{ label: "Verify with emoji", icon: <Lock size={15} />, onSelect: () => setOverlay({ type: "verify", userId }) }]),
    ...(canModerate
      ? [
          { separator: true },
          {
            label: member?.serverMuted ? "Let them talk" : "Mute for everyone",
            icon: <ShieldOff size={15} />,
            onSelect: () => void session().voiceMute(channelId, userId, !member?.serverMuted).catch(fail),
          },
          ...(member?.screen ? [{ label: "Stop their screen share", icon: <MonitorOff size={15} />, onSelect: () => void session().voiceScreenStopOf(channelId, userId).catch(fail) }] : []),
          { label: "Disconnect", icon: <UserX size={15} />, danger: true, onSelect: () => void session().voiceDisconnect(channelId, userId).catch(fail) },
        ]
      : []),
  ];
  return <PopupMenu x={x} y={y} entries={entries} onClose={onClose} header={isSelf ? undefined : <VolumeSlider userId={userId} />} />;
}

/** One person in the call: their camera, or their picture, ringed while they talk. */
const PersonTile = memo(function PersonTile({ member, camera, onMenu }: { member: VoiceMember; camera?: VideoTile; onMenu: (event: React.MouseEvent, userId: string) => void }) {
  const server = useActiveServer();
  const isSelf = member.userId === server?.self?.userId;
  const speaking = useVoice((state) => (isSelf ? selfIsSpeaking(state) : !!state.speaking[member.userId]));
  const localMuted = useVoice((state) => !!state.localMutes[member.userId]);
  const user = server?.users[member.userId];
  const name = user?.displayName ?? "Someone";
  return (
    <div className={`voice-tile${speaking ? " is-speaking" : ""}`} onContextMenu={(event) => onMenu(event, member.userId)} style={camera ? undefined : { background: `color-mix(in srgb, ${avatarColor(member.userId)} 16%, var(--bg-2))` }}>
      {camera ? <VideoView tile={camera} /> : <Avatar name={name} seed={member.userId} avatar={user?.avatar} size={84} />}
      <div className="voice-tile-label">
        {member.serverMuted ? <MicOff size={13} className="voice-server-muted" /> : member.muted && <MicOff size={13} />}
        {member.deafened && <HeadphoneOff size={13} />}
        {localMuted && <VolumeX size={13} />}
        <span className="truncate">{isSelf ? `${name} (you)` : name}</span>
      </div>
    </div>
  );
});

/** A shared screen. A click fills the stage with it, and a double click the screen. */
function ScreenTile({ tile, focused, onFocus, onMenu }: { tile: VideoTile; focused: boolean; onFocus: () => void; onMenu: (event: React.MouseEvent, userId: string) => void }) {
  const server = useActiveServer();
  const ref = useRef<HTMLDivElement>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const name = server?.users[tile.userId]?.displayName ?? "Someone";
  useEffect(() => {
    const onChange = () => setFullScreen(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullScreen = () => {
    if (fullScreen) void document.exitFullscreen().catch(() => undefined);
    else void ref.current?.requestFullscreen().catch(() => undefined);
  };
  return (
    <div
      ref={ref}
      className="voice-tile is-screen"
      onClick={() => !fullScreen && onFocus()}
      onDoubleClick={toggleFullScreen}
      // Menus open over the app, which a full screen hides.
      onContextMenu={(event) => (fullScreen ? event.preventDefault() : onMenu(event, tile.userId))}
    >
      <VideoView tile={tile} contain />
      <div className="voice-tile-label">
        <MonitorUp size={13} />
        <span className="truncate">{tile.local ? "Your screen" : `${name}'s screen`}</span>
      </div>
      <div className="voice-tile-actions">
        {!fullScreen && (
          <Tooltip text={focused ? "Back to everyone" : "Fill the stage"}>
            <button
              className="icon-btn is-small"
              onClick={(event) => {
                event.stopPropagation();
                onFocus();
              }}
              aria-label={focused ? "Back to everyone" : "Fill the stage"}
            >
              {focused ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
          </Tooltip>
        )}
        <Tooltip text={fullScreen ? "Exit full screen" : "Full screen"}>
          <button
            className="icon-btn is-small"
            onClick={(event) => {
              event.stopPropagation();
              toggleFullScreen();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={fullScreen ? "Exit full screen" : "Full screen"}
          >
            {fullScreen ? <Shrink size={15} /> : <Expand size={15} />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function DeviceMenu({ kind, x, y, onClose }: { kind: "audioinput" | "audiooutput"; x: number; y: number; onClose: () => void }) {
  const settings = useVoice((state) => state.settings);
  const updateSettings = useVoice((state) => state.updateSettings);
  const setOverlay = useApp((state) => state.setOverlay);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then((list) => setDevices(list.filter((device) => device.kind === kind && device.deviceId !== "communications")));
  }, [kind]);
  const current = kind === "audioinput" ? settings.inputDevice : settings.outputDevice;
  const entries: MenuEntry[] = [
    ...devices.map((device) => ({
      label: `${device.deviceId === current ? "✓ " : ""}${device.label || (device.deviceId === "default" ? "Default" : "Device")}`,
      onSelect: () => updateSettings(kind === "audioinput" ? { inputDevice: device.deviceId } : { outputDevice: device.deviceId }),
    })),
    { separator: true },
    { label: "Voice settings", onSelect: () => setOverlay({ type: "settings", section: "voice" }) },
  ];
  return <PopupMenu x={x} y={y} entries={entries} onClose={onClose} />;
}

function Controls({ chatOpen, chatUnread, onToggleChat, shareRefusal }: { chatOpen: boolean; /** Something new in the chat beside the call, which only those in it would want to know. */ chatUnread: boolean; onToggleChat: () => void; /** Why this person can't share a screen here, if they can't. */ shareRefusal: string | null }) {
  const muted = useVoice((state) => state.muted);
  const deafened = useVoice((state) => state.deafened);
  const serverMuted = useVoice((state) => state.serverMuted);
  const noMic = useVoice((state) => state.noMic);
  const camera = useVoice((state) => state.camera);
  const screen = useVoice((state) => state.screen);
  const open = useVoice((state) => state.open);
  const toggleMute = useVoice((state) => state.toggleMute);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const toggleCamera = useVoice((state) => state.toggleCamera);
  const stopScreen = useVoice((state) => state.stopScreen);
  const leave = useVoice((state) => state.leave);
  const [picking, setPicking] = useState(false);
  const [deviceMenu, setDeviceMenu] = useState<{ kind: "audioinput" | "audiooutput"; x: number; y: number } | null>(null);
  const micOff = muted || deafened || serverMuted || noMic;
  const showDevices = (kind: "audioinput" | "audiooutput") => (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setDeviceMenu({ kind, x: rect.left, y: rect.top - 8 });
  };
  return (
    <div className="voice-controls" role="toolbar" aria-label="Call">
      <div className="voice-control-group">
        <Tooltip text={serverMuted ? "An admin muted you" : noMic ? "No microphone" : micOff ? "Unmute" : "Mute"} side="top">
          <button className={`voice-control${micOff ? " is-off" : open ? " is-live" : ""}`} disabled={serverMuted || noMic} onClick={toggleMute} aria-label={micOff ? "Unmute" : "Mute"} aria-pressed={micOff}>
            {micOff ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
        </Tooltip>
        <button className="voice-control-more" onClick={showDevices("audioinput")} aria-label="Choose a microphone">
          <ChevronUp size={14} />
        </button>
      </div>
      <div className="voice-control-group">
        <Tooltip text={deafened ? "Undeafen" : "Deafen"} side="top">
          <button className={`voice-control${deafened ? " is-off" : ""}`} onClick={toggleDeafen} aria-label={deafened ? "Undeafen" : "Deafen"} aria-pressed={deafened}>
            {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
        </Tooltip>
        <button className="voice-control-more" onClick={showDevices("audiooutput")} aria-label="Choose where sound plays">
          <ChevronUp size={14} />
        </button>
      </div>
      <Tooltip text={camera ? "Turn off camera" : "Turn on camera"} side="top">
        <button className={`voice-control${camera ? " is-on" : ""}`} onClick={() => void toggleCamera()} aria-label={camera ? "Turn off camera" : "Turn on camera"} aria-pressed={camera}>
          {camera ? <Camera size={20} /> : <CameraOff size={20} />}
        </button>
      </Tooltip>
      <Tooltip text={screen ? "Stop sharing" : (shareRefusal ?? "Share your screen")} side="top">
        <button className={`voice-control${screen ? " is-on" : ""}`} disabled={!screen && !!shareRefusal} onClick={() => (screen ? void stopScreen() : setPicking(true))} aria-label={screen ? "Stop sharing" : "Share your screen"} aria-pressed={!!screen}>
          {screen ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
        </button>
      </Tooltip>
      <Tooltip text={chatOpen ? "Hide chat" : "Show chat"} side="top">
        <button className={`voice-control${chatOpen ? " is-on" : ""}`} onClick={onToggleChat} aria-label={chatOpen ? "Hide chat" : "Show chat"} aria-pressed={chatOpen}>
          <MessageSquare size={20} />
          {chatUnread && !chatOpen && <i className="voice-control-dot" />}
        </button>
      </Tooltip>
      <Tooltip text="Disconnect" side="top">
        <button className="voice-control is-leave" onClick={leave} aria-label="Disconnect">
          <PhoneOff size={20} />
        </button>
      </Tooltip>
      {picking && <ScreenPicker onClose={() => setPicking(false)} />}
      {deviceMenu && <DeviceMenu kind={deviceMenu.kind} x={deviceMenu.x} y={deviceMenu.y} onClose={() => setDeviceMenu(null)} />}
    </div>
  );
}

/** A voice channel, open: everyone in it, what they're sharing, and its chat alongside. */
export function VoiceStage({ channel }: { channel: ChannelView }) {
  const server = useActiveServer();
  const status = useVoice((state) => state.status);
  const videos = useVoice((state) => state.videos);
  const focus = useVoice((state) => state.focus);
  const setFocus = useVoice((state) => state.setFocus);
  const screenShare = useVoice((state) => state.screen);
  const [chatOpen, setChatOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const menu = useMemberMenu();

  const members = useMemo(
    () => Object.values(server?.voice ?? {}).filter((member) => member.channelId === channel.id).sort((a, b) => a.since - b.since),
    [server?.voice, channel.id],
  );
  const cameras = new Map(videos.filter((video) => video.source === "camera").map((video) => [video.userId, video]));
  const screens = videos.filter((video) => video.source === "screen");
  const focused = focus ? videos.find((video) => video.key === focus) : undefined;
  const nativeSelfShare = screenShare?.native;
  const people = members.length + screens.length + (nativeSelfShare ? 1 : 0);
  const columns = Math.min(4, Math.ceil(Math.sqrt(Math.max(1, people))));

  return (
    <div className="voice-stage-wrap">
      <div className="voice-stage">
        <header className="voice-head">
          <Volume2 size={18} className="faint" />
          <h3 className="truncate">{channelTitle(channel)}</h3>
          {channel.topic && <span className="voice-topic truncate">{channel.topic}</span>}
          <span className="grow" />
          <Tooltip text="End-to-end encrypted, with keys from this channel's members. The server and the media server can't listen in or watch.">
            <span className="voice-e2ee">
              <Lock size={12} /> Encrypted
            </span>
          </Tooltip>
          <Tooltip text="Stream stats">
            <button className={`icon-btn is-small${statsOpen ? " is-active" : ""}`} onClick={() => setStatsOpen(!statsOpen)} aria-label="Stream stats" aria-pressed={statsOpen}>
              <Activity size={15} />
            </button>
          </Tooltip>
        </header>
        {statsOpen && <StreamStatsPanel onClose={() => setStatsOpen(false)} />}

        {status === "connecting" ? (
          <div className="voice-connecting">
            <Spinner size={26} />
            <p>Coming into {channelTitle(channel)}…</p>
          </div>
        ) : (
          <>
            {status === "reconnecting" && <div className="voice-banner">Reconnecting…</div>}
            <div className={`voice-grid-area${focused ? " is-focused" : ""}`}>
              {focused && (
                <div className="voice-focus">
                  {focused.source === "screen" ? (
                    <ScreenTile tile={focused} focused onFocus={() => setFocus(null)} onMenu={menu.openFor} />
                  ) : (
                    <div className="voice-tile is-screen" onClick={() => setFocus(null)}>
                      <VideoView tile={focused} contain />
                    </div>
                  )}
                </div>
              )}
              <div className={focused ? "voice-strip" : "voice-grid"} style={focused ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                {screens
                  .filter((tile) => tile.key !== focused?.key)
                  .map((tile) => (
                    <div key={tile.key} className="voice-person">
                      <ScreenTile tile={tile} focused={false} onFocus={() => setFocus(tile.key)} onMenu={menu.openFor} />
                    </div>
                  ))}
                {nativeSelfShare && (
                  <div className="voice-person">
                    <div className="voice-tile is-self-share">
                      <MonitorUp size={30} />
                      <span>You're sharing {screenShare.name}</span>
                    </div>
                  </div>
                )}
                {members.map((member) => {
                  const camera = cameras.get(member.userId);
                  return (
                    <div key={member.deviceId} className="voice-person" onClick={() => camera && setFocus(camera.key)}>
                      <PersonTile member={member} camera={camera} onMenu={menu.openFor} />
                    </div>
                  );
                })}
              </div>
            </div>
            <Controls chatOpen={chatOpen} chatUnread={(channel.conversation?.unread ?? 0) > 0} onToggleChat={() => setChatOpen(!chatOpen)} shareRefusal={screenRefusal(server?.info?.screen_share, server?.self?.role, channel.screenLimit)} />
          </>
        )}
      </div>
      {chatOpen && channel.conversation && (
        <div className="voice-chat">
          <ChatView key={channel.id} conversation={channel.conversation} voice onClose={() => setChatOpen(false)} />
        </div>
      )}
      {menu.menu && menu.target && (
        <MemberMenu userId={menu.target} channelId={channel.id} member={members.find((member) => member.userId === menu.target)} x={menu.menu.x} y={menu.menu.y} onClose={menu.close} />
      )}
    </div>
  );
}
