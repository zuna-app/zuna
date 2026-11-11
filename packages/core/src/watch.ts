// Watching YouTube together: one video a voice channel or a call plays at the same moment on
// every device in it. The video comes from YouTube to each device that chose to watch; only
// which video, playing or not, where and how fast goes through Zuna, sealed under the room's
// key and signed by the device that changed it. The server hands it on and keeps nothing.
//
// One state per room, held only by the devices in it, where the last change wins. Nobody
// sends the time as it passes: where the video is now follows from where it was at `at`.

/** The speeds YouTube's player offers, and so all a room can share. */
export const WATCH_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** A YouTube video's ID, which goes into the player's address. */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** A picture small enough to travel inside a state, as a data URL. */
export interface WatchImage {
  data: string;
  width: number;
  height: number;
}

export interface WatchVideo {
  id: string;
  /** Who put it on. */
  by: string;
  /** What the device that put it on found about it, which only travels when the video changes or someone asks. */
  title?: string;
  author?: string;
  image?: WatchImage;
}

/** What a room watches, as the devices in it hold it. */
export interface WatchState {
  /** New each time a video is put on where nothing was, which is what pressing Watch is for. */
  session: string;
  /** One more with each change. The higher wins, then the later `at`, then the device. */
  rev: number;
  /** Null once someone stopped it, which stays, so that a late answer can't bring it back. */
  video: WatchVideo | null;
  playing: boolean;
  /** Milliseconds into the video at `at`. */
  position: number;
  /** When that was, in ms, by the server's clock as the sender knew it. */
  at: number;
  rate: number;
  /** Who made the change, and on which device. */
  user: string;
  device: string;
}

/**
 * What goes between the devices in a room: a state, sent with every change and as the answer
 * to someone coming in, or that someone asking for one. `sent` and `nonce` keep one from
 * being played back later.
 */
export type WatchSignal =
  | { kind: "state"; state: WatchState; sent: number; nonce: string }
  | { kind: "ask"; sent: number; nonce: string; have?: { session: string; rev: number } };

/** Where a state's video is at `now`, on the same clock as its `at`. */
export function watchPosition(state: Pick<WatchState, "playing" | "position" | "at" | "rate">, now: number): number {
  return Math.max(0, state.playing ? state.position + (now - state.at) * state.rate : state.position);
}

/** Whether one state wins over another, as every device decides it the same way. */
export function watchBeats(a: WatchState, b: WatchState | null | undefined): boolean {
  if (!b) return true;
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.at !== b.at) return a.at > b.at;
  return a.device > b.device;
}

/** Whether two states say the same thing, apart from the details a video carries only sometimes. */
export function sameWatch(a: WatchState, b: WatchState): boolean {
  return a.session === b.session && a.rev === b.rev && a.at === b.at && a.device === b.device;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

/** How far into the video `t=` or `start=` says, which is seconds, or a time such as 1h2m3s. */
function startOf(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?s?$/.test(value)) return Math.round(parseFloat(value) * 1000);
  const parts = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!parts) return 0;
  const [, hours, minutes, seconds] = parts;
  return ((Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)) * 1000;
}

/**
 * The video a YouTube link is for, and where it says to start, in ms, or null for anything
 * else. A link without its scheme, as people copy from an address bar, is read too.
 */
export function readYouTubeLink(text: string): { id: string; start: number } | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || (url.port && url.port !== "443" && url.port !== "80")) return null;
  const host = url.hostname.toLowerCase();
  const start = startOf(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const path = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (host === "youtu.be" || host === "www.youtu.be") id = path[0];
  else if (YOUTUBE_HOSTS.has(host)) {
    if (path[0] === "watch" && path.length === 1) id = url.searchParams.get("v") ?? undefined;
    else if (["shorts", "live", "embed", "v", "e"].includes(path[0] ?? "") && path.length <= 2) id = path[1];
  }
  return id && YOUTUBE_ID.test(id) ? { id, start } : null;
}

/** Why a link can't be watched, in words for the person who pasted it. */
export const NOT_A_YOUTUBE_LINK = "That isn't a link to a YouTube video. Paste one from youtube.com or youtu.be.";
