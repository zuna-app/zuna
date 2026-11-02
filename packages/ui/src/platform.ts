// What a host gives the interface: the desktop's Electron shell, or the web app.
// Everything outside the page itself goes through here, so both show the same app.

import type { CoreEvent } from "@zuna/core";
import type { CoreConnection } from "@zuna/core/rpc";

export interface BootResult {
  core: CoreConnection;
  keyProtected: boolean;
}

/** Which chat a notification is about. */
export interface NotificationRoute {
  serverId: string;
  key: string;
}

export interface NotifyPayload {
  title: string;
  body: string;
  route: NotificationRoute;
  /** What a host that draws its own notifications needs. A system's own go without. */
  card?: NotificationCard;
}

export interface NotificationCard {
  messageId: string;
  kind: "dm" | "group" | "channel";
  /** The chat's picture, or nothing for the app's own when a notification shows nothing about who. */
  picture: { image: string | null; initials: string; color: string } | null;
  canReply: boolean;
  /** Stays up until the person next touches the computer, rather than only for a while. */
  waitForInput: boolean;
  accent: string;
  reduceMotion: boolean;
}

/** Takes notifications back: those matching everything given, so nothing given means all. */
export interface NotificationsToClear {
  serverId?: string;
  /** Chats that were read, which leaves one being replied to alone. */
  keys?: string[];
  messageId?: string;
}

export interface NotificationReply {
  route: NotificationRoute;
  messageId: string;
  text: string;
}

/** What the system wants right now, as a full-screen game or Do Not Disturb. */
export interface NotificationState {
  show: boolean;
  sound: boolean;
  waitForInput: boolean;
}

/** Something that can be shared: a whole screen, or one window. */
export interface DisplaySource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** What it looks like now, as a data URL. */
  thumbnail: string;
  /** It can be captured and encoded natively, which is much lighter on the computer. */
  native: boolean;
  /** The system's own dialog asks which screen or window, once Share is pressed. */
  systemPicks?: boolean;
  /** A window whose app the system can't say, so whose sound goes with it is asked. */
  ownerUnknown?: boolean;
}

/** What a native share is doing, as it says once it's publishing. */
export interface NativeScreenInfo {
  /** The screen, the graphics card and the encoder, in words. */
  description: string;
  width: number;
  height: number;
  fps: number;
  e2ee: boolean;
  /** What was chosen in the system's own dialog, where that's what picked. */
  source?: "screen" | "window";
}

/** How a native share went over the last second. */
export interface NativeScreenStats {
  /** The size it's encoded at now, which changes with a window's. */
  width?: number;
  height?: number;
  /** Frames with something new on them. */
  fps: number;
  /** Frames sent again while the screen is still, for the encoder to sharpen it. */
  repeatFps: number;
  kbps: number;
  /** What the network allows. */
  targetKbps: number;
  encoderKbps: number;
  encodeMsAvg: number;
  encodeMsMax: number;
  keys: number;
  keyRequests: number;
  bitrateChanges: number;
  /** Frames LiveKit wouldn't take. */
  rejected: number;
  idrRewritten: number;
  idrLeftAlone: number;
  cpuCores: number;
}

export interface NativeScreenOptions {
  url: string;
  token: string;
  key: Uint8Array;
  keyIndex: number;
  fps: number;
  bitrateKbps: number;
  /** The tallest the picture may be, or 0 for the screen's own size. */
  height: number;
  /** Draw the pointer into the picture. */
  cursor: boolean;
  /** Which of the system's encoders, or "auto" for whichever goes with the screen's graphics card. */
  encoder: string;
  /** How much work each frame gets: "speed", "balanced" or "best". */
  effort: string;
  keyframeSeconds: number;
  source: string;
}

/** Sharing a screen from a native process, which captures and encodes on the GPU and only uses LiveKit to carry the result. */
export interface NativeScreenShare {
  /** The encoders this system could have, for choosing one. */
  encoders: { id: string; name: string }[];
  /** It shares a window natively too, not only a whole screen. */
  windows: boolean;
  /** Starts it, finishing once it's publishing. */
  start(options: NativeScreenOptions): Promise<NativeScreenInfo>;
  /** Hears how it's going, about once a second. */
  onStats(listener: (stats: NativeScreenStats) => void): () => void;
  /** The key its frames go under from now on. */
  setKey(key: Uint8Array, keyIndex: number): void;
  stop(): void;
  /** It ended by itself, and why if that's a problem. */
  onEnded(listener: (problem: string | null) => void): () => void;
}

/** An app playing sound, which a share can take the sound of alone. */
export interface SoundApp {
  /** What the system knows it by, to capture it with. */
  id: string;
  name: string;
}

/** The app a window belongs to, as a share's sound. */
export interface WindowSoundApp extends SoundApp {
  /** It's playing sound now. */
  playing: boolean;
  /** The ids `apps` gives the same sound, which needn't be offered twice. */
  covers: string[];
}

/** The computer's sound for a share, captured natively: everything apart from this app, or one app's. */
export interface ShareSound {
  /** It captures everything apart from this app too. Otherwise the browser does that. */
  everything: boolean;
  /** The apps playing sound now, apart from this one. */
  apps(): Promise<SoundApp[]>;
  /** Which app a window from `displaySources` belongs to, where the system can tell. */
  windowApp(source: string): Promise<WindowSoundApp | null>;
  /**
   * Starts capturing one app, or everything but this app for null. The samples come over
   * the port as Float32Arrays, two channels interleaved at 48 kHz, and only while something plays.
   */
  start(app: string | null): Promise<MessagePort>;
  stop(): void;
  /** It ended by itself, and why if that's a problem. */
  onEnded(listener: (problem: string | null) => void): () => void;
}

export interface Platform {
  /** Whether the system shows times with AM and PM, or undefined to follow the language. */
  hour12: boolean | undefined;
  /** The desktop draws its own title bar. */
  titleBar: boolean;
  /** The operating system, for how the title bar is laid out. */
  os?(): Promise<string>;
  /** Starts the core in its worker. */
  bootCore(onEvent: (event: CoreEvent) => void): Promise<BootResult>;
  openExternal(url: string): void;
  /** Unread messages in chats that aren't muted, on every server. */
  setUnreadCount(count: number): void;
  /** System notifications. Without them there are no notification settings either. */
  notify?(payload: NotifyPayload): void;
  /** It draws notifications itself, so each is given a card and may be replied to. */
  drawsNotifications?: boolean;
  notificationState?(): Promise<NotificationState>;
  clearNotifications?(which: NotificationsToClear): void;
  /** A reply typed into a notification. */
  onNotificationReply?(listener: (reply: NotificationReply) => void): () => void;
  /** Whether the operating system lets Zuna record, asking the person the first time. */
  microphone?(): Promise<boolean>;
  /** The same for the camera. */
  camera?(): Promise<boolean>;
  /** What can be shared, for a picker of Zuna's own. Without it, the browser asks. */
  displaySources?(): Promise<DisplaySource[]>;
  /** Says what the next request to capture the display gets. */
  chooseDisplaySource?(id: string, audio: boolean): Promise<void>;
  /** Sharing a screen can bring the computer's sound with it. */
  systemAudio?: boolean;
  /** That sound comes from here rather than from the browser, and can be one app's. */
  shareSound?: ShareSound;
  nativeScreen?: NativeScreenShare;
  /** Says when a key goes down or up anywhere on the computer, not just in this window, and what the system bound where it binds the key itself. */
  watchKey?(code: string, listener: (down: boolean) => void, onBound?: (trigger: string) => void): () => void;
  /**
   * Whether a key held in another window can be heard here, and a mouse button too.
   * Under Wayland that takes the compositor's global shortcuts, which bind keys alone.
   * Where it can't be, why: the compositor has none, or only gives them to installed apps.
   */
  pushToTalk?(): Promise<{ anywhere: boolean; mouse: boolean; why?: "compositor" | "uninstalled" }>;
  /** "active", "idle" after this many seconds without input anywhere, or "locked". */
  idleState?(seconds: number): Promise<"active" | "idle" | "locked" | "unknown">;
  /** The screen locking or the computer sleeping ("away"), and coming back ("back"). */
  onPresence?(listener: (state: "away" | "back") => void): () => void;
  onFocus?(listener: (focused: boolean) => void): () => void;
  /** An invite link the app was opened with, once. */
  takeDeepLink?(): Promise<string | null>;
  onDeepLink?(listener: (link: string) => void): () => void;
  /** A click on a notification. */
  onOpenConversation?(listener: (route: NotificationRoute) => void): () => void;
  setCloseToTray?(enabled: boolean): void;
  /** Shown in Security when the device key isn't protected, or null to say nothing. */
  keyWarning: string | null;
  /** A server address to start the sign-in form with. */
  defaultServer?: string;
  /** A newer version of the app is ready, and reloading picks it up. */
  onUpdate?(listener: () => void): () => void;
  /** Closing the page stops whatever is still sending, so it asks first. */
  warnBeforeLeaving?: boolean;
}

/** Set once by the host, before the interface renders. */
export let platform: Platform;

export function setPlatform(value: Platform): void {
  platform = value;
}
