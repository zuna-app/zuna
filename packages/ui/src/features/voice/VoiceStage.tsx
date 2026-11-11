import type { ConversationView, VoiceMember } from "@zuna/core";
import {
  Activity,
  BellRing,
  Camera,
  CameraOff,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
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
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Spinner, Tooltip, useContextMenu, type MenuEntry } from "@/components/ui";
import { useScreenAwake } from "@/lib/awake";
import { avatarColor } from "@/lib/format";
import { useActiveServer, useApp } from "@/state/store";
import type { VideoTile } from "@/voice/room";
import { selfIsSpeaking, useVoice, WATCH_FOCUS } from "@/voice/store";
import { screenRefusal } from "@zuna/core/voice";
import { ChatView } from "@/features/chat/ChatView";
import { SoundboardButton } from "./Soundboard";
import { WatchButton, WatchStage, WatchThumb } from "./Watch";
// With what it measures, which needs LiveKit, only once someone opens it.
const StreamStatsPanel = lazy(() => import("./StreamStatsPanel").then((module) => ({ default: module.StreamStatsPanel })));

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

function VolumeSlider({ userId, stream }: { userId: string; /** The sound of their shared screen, rather than their voice. */ stream?: boolean }) {
  const volume = useVoice((state) => (stream ? state.streamVolumes : state.volumes)[userId] ?? 1);
  const setVolume = useVoice((state) => (stream ? state.setStreamVolume : state.setVolume));
  return (
    <label className="member-volume" onMouseDown={(event) => event.stopPropagation()}>
      <span>
        {stream ? "Stream volume" : "Volume"} <b>{Math.round(volume * 100)}%</b>
      </span>
      <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={volume} onChange={(event) => setVolume(userId, Number(event.target.value))} />
    </label>
  );
}

/** How loud the person sharing was before being silenced here, to go back to. */
const streamVolumeBefore = new Map<string, number>();

/** A share's sound, over the share itself, as a video player has it. */
function StreamVolume({ userId }: { userId: string }) {
  const volume = useVoice((state) => state.streamVolumes[userId] ?? 1);
  const setStreamVolume = useVoice((state) => state.setStreamVolume);
  const silent = volume === 0;
  const toggle = () => {
    if (!silent) streamVolumeBefore.set(userId, volume);
    setStreamVolume(userId, silent ? (streamVolumeBefore.get(userId) ?? 1) : 0);
  };
  return (
    <div className="voice-tile-sound" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <button className="icon-btn is-small" onClick={toggle} aria-label={silent ? "Unmute stream" : "Mute stream"} title={silent ? "Unmute stream" : "Mute stream"}>
        {silent ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
      <input
        className="voice-slider"
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={volume}
        onChange={(event) => setStreamVolume(userId, Number(event.target.value))}
        aria-label="Stream volume"
        title={`Stream volume ${Math.round(volume * 100)}%`}
      />
    </div>
  );
}

function MemberMenu({ userId, channelId, call, member, x, y, onClose }: { userId: string; channelId: string; /** In a call, which is between the people in it, admins have no say. */ call: boolean; member?: VoiceMember; x: number; y: number; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const setOverlay = useApp((state) => state.setOverlay);
  const toast = useApp((state) => state.toast);
  const localMuted = useVoice((state) => !!state.localMutes[userId]);
  const toggleLocalMute = useVoice((state) => state.toggleLocalMute);
  const streamSound = useVoice((state) => state.videos.some((video) => video.userId === userId && video.sound));
  const micOff = useVoice((state) => state.muted || state.deafened);
  const deafened = useVoice((state) => state.deafened);
  const canTalk = useVoice((state) => !state.serverMuted && !state.noMic);
  const toggleMute = useVoice((state) => state.toggleMute);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const selfRole = server?.self?.role;
  const isSelf = userId === server?.self?.userId;
  const target = server?.users[userId];
  const canModerate = !call && !isSelf && (selfRole === "owner" || (selfRole === "admin" && target?.role === "member"));
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
  const header = isSelf ? undefined : (
    <>
      <VolumeSlider userId={userId} />
      {streamSound && <VolumeSlider userId={userId} stream />}
    </>
  );
  return <PopupMenu x={x} y={y} entries={entries} onClose={onClose} header={header} />;
}

/** Someone a call is ringing, faded until they answer. */
function RingingTile({ userId }: { userId: string }) {
  const server = useActiveServer();
  const user = server?.users[userId];
  const name = user?.displayName ?? "Someone";
  return (
    <div className="voice-tile is-ringing" style={{ background: `color-mix(in srgb, ${avatarColor(userId)} 10%, var(--bg-2))` }}>
      <Avatar name={name} seed={userId} avatar={user?.avatar} size={84} />
      <div className="voice-tile-label">
        <span className="truncate">{name}</span>
        <span className="voice-tile-calling">Calling…</span>
      </div>
    </div>
  );
}

/** One person in the call: their camera, or their picture, ringed while they talk. */
const PersonTile = memo(function PersonTile({ member, camera, onMenu }: { member: VoiceMember; camera?: VideoTile; onMenu: (event: React.MouseEvent, userId: string) => void }) {
  const server = useActiveServer();
  const isSelf = member.userId === server?.self?.userId;
  const speaking = useVoice((state) => (isSelf ? selfIsSpeaking(state) : !!state.speaking[member.userId]));
  const localMuted = useVoice((state) => !!state.localMutes[member.userId]);
  const sounding = useVoice((state) => state.sounding[member.userId]);
  const user = server?.users[member.userId];
  const name = user?.displayName ?? "Someone";
  return (
    <div className={`voice-tile${speaking ? " is-speaking" : ""}`} onContextMenu={(event) => onMenu(event, member.userId)} style={camera ? undefined : { background: `color-mix(in srgb, ${avatarColor(member.userId)} 16%, var(--bg-2))` }}>
      {camera ? <VideoView tile={camera} /> : <Avatar name={name} seed={member.userId} avatar={user?.avatar} size={84} />}
      {sounding && (
        <span className="voice-tile-played" role="status" aria-label={`${name} played a sound`}>
          {sounding}
        </span>
      )}
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
      {tile.sound && <StreamVolume userId={tile.userId} />}
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

function Controls({
  chatOpen,
  chatUnread,
  onToggleChat,
  shareRefusal,
  sounds,
  watch,
}: {
  chatOpen: boolean;
  /** Something new in the chat beside the call, which only those in it would want to know. */
  chatUnread: boolean;
  /** Without it, the chat is always there, under a call. */
  onToggleChat?: () => void;
  /** Why this person can't share a screen here, if they can't. */
  shareRefusal: string | null;
  /** Whether the soundboard plays here. */
  sounds: boolean;
  /** Whether people may watch YouTube together here. */
  watch: boolean;
}) {
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
  const startScreen = useVoice((state) => state.startScreen);
  // The browser asks what to share, and offers its sound when this asks for that.
  const shareSound = useVoice((state) => state.settings.screenSoundByDefault);
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
        <button className={`voice-control${screen ? " is-on" : ""}`} disabled={!screen && !!shareRefusal} onClick={() => (screen ? void stopScreen() : void startScreen({ audio: shareSound }))} aria-label={screen ? "Stop sharing" : "Share your screen"} aria-pressed={!!screen}>
          {screen ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
        </button>
      </Tooltip>
      <SoundboardButton roomSounds={sounds} />
      <WatchButton allowed={watch} />
      {onToggleChat && (
        <Tooltip text={chatOpen ? "Hide chat" : "Show chat"} side="top">
          <button className={`voice-control${chatOpen ? " is-on" : ""}`} onClick={onToggleChat} aria-label={chatOpen ? "Hide chat" : "Show chat"} aria-pressed={chatOpen}>
            <MessageSquare size={20} />
            {chatUnread && !chatOpen && <i className="voice-control-dot" />}
          </button>
        </Tooltip>
      )}
      <Tooltip text="Disconnect" side="top">
        <button className="voice-control is-leave" onClick={leave} aria-label="Disconnect">
          <PhoneOff size={20} />
        </button>
      </Tooltip>
      {deviceMenu && <DeviceMenu kind={deviceMenu.kind} x={deviceMenu.x} y={deviceMenu.y} onClose={() => setDeviceMenu(null)} />}
    </div>
  );
}

/** A voice channel's room, or a conversation's call. */
export interface StageRoom {
  id: string;
  /** A conversation's call, which sits above its chat, rather than a voice channel's room. */
  call: boolean;
  title: string;
  topic?: string;
  /** The chat that goes with it, once there is one. */
  conversation: ConversationView | null;
  /** How many may share a screen at once: 0 for what the server's rules say, or -1 for nobody. */
  screenLimit: number;
  /** Whether the soundboard plays there, which it always does in a call. */
  sounds: boolean;
  /** Whether people may watch YouTube together there, which they always may in a call. */
  watch: boolean;
}

/** How long a call has gone on, as a call shows it. */
function CallTime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return <span className="voice-call-time">{hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`}</span>;
}

/**
 * A voice channel, open: everyone in it, what they're sharing, and its chat alongside. A call is the
 * same, above its conversation's chat, which it can take the whole of with `expanded`.
 */
export function VoiceStage({ room, expanded, onExpand }: { room: StageRoom; expanded?: boolean; onExpand?: () => void }) {
  const server = useActiveServer();
  const status = useVoice((state) => state.status);
  const videos = useVoice((state) => state.videos);
  const focus = useVoice((state) => state.focus);
  const setFocus = useVoice((state) => state.setFocus);
  const ringAgain = useVoice((state) => state.ringAgain);
  const watch = useVoice((state) => state.watch);
  const [chatOpen, setChatOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const menu = useMemberMenu();
  const call = room.call ? server?.calls[room.id] : undefined;

  const members = useMemo(
    () => Object.values(server?.voice ?? {}).filter((member) => member.channelId === room.id).sort((a, b) => a.since - b.since),
    [server?.voice, room.id],
  );
  const ringing = (call?.ringing ?? []).filter((userId) => !members.some((member) => member.userId === userId));
  // Someone in the group who isn't in the call, and isn't being rung, can be rung again.
  const notHere = room.call && room.conversation?.kind === "group" && room.conversation.members.some((member) => !members.some((other) => other.userId === member.userId) && !ringing.includes(member.userId));
  const cameras = new Map(videos.filter((video) => video.source === "camera").map((video) => [video.userId, video]));
  const screens = videos.filter((video) => video.source === "screen");
  const watchFocused = focus === WATCH_FOCUS && !!watch;
  const focused = focus ? videos.find((video) => video.key === focus) : undefined;
  const people = members.length + ringing.length + screens.length + (watch ? 1 : 0);
  const columns = Math.min(4, Math.ceil(Math.sqrt(Math.max(1, people))));
  const shareRefusal = screenRefusal(server?.info?.screen_share, server?.self?.role, room.screenLimit);
  // A camera or a shared screen is watched rather than listened to, so the screen stays on while one is here.
  useScreenAwake(status !== "connecting" && videos.length > 0);

  return (
    <div className={`voice-stage-wrap${room.call ? " is-call" : ""}${expanded ? " is-expanded" : ""}`}>
      <div className="voice-stage">
        {room.call ? (
          <header className="voice-head is-call">
            <Tooltip text="End-to-end encrypted, with keys from this conversation's members. The server and the media server can't listen in or watch.">
              <span className="voice-e2ee">
                <Lock size={12} /> Encrypted
              </span>
            </Tooltip>
            {call && status === "connected" && <CallTime since={call.startedAt} />}
            <span className="grow" />
            {notHere && (
              <Tooltip text="Ring everyone who isn't here">
                <button className="icon-btn is-small" onClick={() => void ringAgain()} aria-label="Ring everyone who isn't here">
                  <BellRing size={15} />
                </button>
              </Tooltip>
            )}
            <Tooltip text="Stream stats">
              <button className={`icon-btn is-small${statsOpen ? " is-active" : ""}`} onClick={() => setStatsOpen(!statsOpen)} aria-label="Stream stats" aria-pressed={statsOpen}>
                <Activity size={15} />
              </button>
            </Tooltip>
            {onExpand && (
              <Tooltip text={expanded ? "Show the chat" : "Hide the chat"}>
                <button className="icon-btn is-small" onClick={onExpand} aria-label={expanded ? "Show the chat" : "Hide the chat"} aria-pressed={expanded}>
                  {expanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
                </button>
              </Tooltip>
            )}
          </header>
        ) : (
          <header className="voice-head">
            <Volume2 size={18} className="faint" />
            <h3 className="truncate">{room.title}</h3>
            {room.topic && <span className="voice-topic truncate">{room.topic}</span>}
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
        )}
        {statsOpen && (
          <Suspense fallback={null}>
            <StreamStatsPanel onClose={() => setStatsOpen(false)} />
          </Suspense>
        )}

        {status === "connecting" ? (
          <div className="voice-connecting">
            <Spinner size={26} />
            <p>{room.call ? "Connecting the call…" : `Coming into ${room.title}…`}</p>
          </div>
        ) : (
          <>
            {status === "reconnecting" && <div className="voice-banner">Reconnecting…</div>}
            <div className={`voice-grid-area${focused || watchFocused ? " is-focused" : ""}`}>
              {watchFocused && watch && (
                <div className="voice-focus">
                  <WatchStage watch={watch} />
                </div>
              )}
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
              <div className={focused || watchFocused ? "voice-strip" : "voice-grid"} style={focused || watchFocused ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                {watch && !watchFocused && (
                  <div className="voice-person">
                    <WatchThumb watch={watch} />
                  </div>
                )}
                {screens
                  .filter((tile) => tile.key !== focused?.key)
                  .map((tile) => (
                    <div key={tile.key} className="voice-person">
                      <ScreenTile tile={tile} focused={false} onFocus={() => setFocus(tile.key)} onMenu={menu.openFor} />
                    </div>
                  ))}
                {members.map((member) => {
                  const camera = cameras.get(member.userId);
                  return (
                    <div key={member.deviceId} className="voice-person" onClick={() => camera && setFocus(camera.key)}>
                      <PersonTile member={member} camera={camera} onMenu={menu.openFor} />
                    </div>
                  );
                })}
                {ringing.map((userId) => (
                  <div key={`ringing:${userId}`} className="voice-person">
                    <RingingTile userId={userId} />
                  </div>
                ))}
              </div>
            </div>
            <Controls
              chatOpen={chatOpen}
              chatUnread={(room.conversation?.unread ?? 0) > 0}
              onToggleChat={room.call ? undefined : () => setChatOpen(!chatOpen)}
              shareRefusal={shareRefusal}
              sounds={room.sounds}
              watch={room.watch}
            />
          </>
        )}
      </div>
      {!room.call && chatOpen && room.conversation && (
        <div className="voice-chat">
          <ChatView key={room.id} conversation={room.conversation} voice onClose={() => setChatOpen(false)} />
        </div>
      )}
      {menu.menu && menu.target && (
        <MemberMenu userId={menu.target} channelId={room.id} call={room.call} member={members.find((member) => member.userId === menu.target)} x={menu.menu.x} y={menu.menu.y} onClose={menu.close} />
      )}
    </div>
  );
}
