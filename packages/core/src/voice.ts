// How voice channels are keyed. A room's media key comes from the channel's MLS group,
// so whoever can't read the channel can't hear it, and each change to who's in the
// group changes the key. It only ever exists for the group's current epoch, on the
// devices in it: unlike the keys to messages, it's kept nowhere and handed to nobody.
//
// Each sender has a key of their own, derived from it and from who they are in the
// room. Everyone in the group can work them all out, but the media server can't
// pass one person's voice off as another's, and a device can move to a new epoch's key
// to send with some time after it has started listening with it.
//
// This file has no dependencies, since the interface uses it directly.

import type { Role, ScreenRules } from "./types";

/** The MLS exporter's label for a room's media key. */
export const VOICE_LABEL = "zuna/voice/v1";

/** How many keys each sender's frames can be under at once, as LiveKit keeps them. */
export const VOICE_KEY_RING = 16;

export interface VoiceIdentity {
  userId: string;
  deviceId: string;
}

const HEX_ID = /^[0-9a-f]{32}$/;

/** Who a device is in a room. It says nothing but IDs: names are in a profile only members can read. */
export const voiceIdentity = (userId: string, deviceId: string): string => `${userId}.${deviceId}`;

/** Who a participant is, or null for a name that isn't ours to have let in. */
export function parseVoiceIdentity(identity: string): VoiceIdentity | null {
  const [userId, deviceId, ...rest] = identity.split(".");
  if (!userId || !deviceId || rest.length > 0 || !HEX_ID.test(userId) || !HEX_ID.test(deviceId)) return null;
  return { userId, deviceId };
}

/** The key one sender's media is under, from the room's key for an epoch. */
export async function voiceSenderKey(roomKey: Uint8Array, identity: string): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey("raw", roomKey as BufferSource, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`zuna/voice/sender/v1|${identity}`) },
    material,
    256,
  );
}

/** Which of a sender's key slots an epoch's key goes in. A few epochs go by before one is reused. */
export const voiceKeyIndex = (epoch: number): number => epoch % VOICE_KEY_RING;

/**
 * How long a key goes on opening what others send once a newer epoch's has come. Someone who
 * hears of the new epoch late, or is a few behind for a moment, sends under the old one meanwhile.
 * After it, the slot is given a random key, so that someone removed who kept the old one can't be
 * played to the others, even with the media server's help.
 */
export const VOICE_OLD_KEY_MS = 30_000;

/**
 * Which epoch's key each slot of the key ring holds, and when one that's been replaced is to be
 * retired. It only keeps the books: each app sets the keys, and overwrites a retired slot itself.
 * An epoch's slot is retired once, `VOICE_OLD_KEY_MS` after the epoch after it came, unless by then
 * it holds another epoch's key, as it does when the ring has gone round, or it's the current one.
 */
export class VoiceKeySlots {
  /** The epoch whose key each slot holds. */
  private readonly held = new Map<number, number>();
  /** The slots to retire, with the epoch each held and when. */
  private readonly retiring = new Map<number, { epoch: number; at: number }>();
  private current: number | undefined;

  constructor(private readonly keptMs = VOICE_OLD_KEY_MS) {}

  /**
   * The newest epoch's key goes in its slot, which takes it off any list to be retired, and the epoch
   * it replaces starts its time. Says which slot, and when the replaced one is due, if it is.
   */
  take(epoch: number, now: number): { index: number; retireAt?: number } {
    const index = voiceKeyIndex(epoch);
    const previous = this.current;
    this.current = epoch;
    this.retiring.delete(index);
    this.held.set(index, epoch);
    if (previous === undefined || previous === epoch) return { index };
    const old = voiceKeyIndex(previous);
    if (old === index || this.held.get(old) !== previous) return { index };
    const at = now + this.keptMs;
    this.retiring.set(old, { epoch: previous, at });
    return { index, retireAt: at };
  }

  /** The slots due by `now`, each to be given a random key: they hold nothing from here on. */
  due(now: number): { index: number; epoch: number }[] {
    const out: { index: number; epoch: number }[] = [];
    for (const [index, { epoch, at }] of [...this.retiring]) {
      if (at > now) continue;
      this.retiring.delete(index);
      if (this.held.get(index) !== epoch || (this.current !== undefined && index === voiceKeyIndex(this.current))) continue;
      this.held.delete(index);
      out.push({ index, epoch });
    }
    return out;
  }

  /** Whether a slot still holds an epoch's key, so that it may be set for someone. */
  holds(index: number, epoch: number): boolean {
    return this.held.get(index) === epoch;
  }

  /** Whether a slot holds no epoch's key, as one retired does until the ring comes round to it. */
  free(index: number): boolean {
    return !this.held.has(index);
  }

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  /** Hands `retire` what's due at `at`, which `take` gave, when it comes, unless the room is left first. */
  retireAt(at: number, now: number, retire: (index: number, epoch: number) => void): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      for (const { index, epoch } of this.due(at)) retire(index, epoch);
    }, Math.max(0, at - now));
    this.timers.add(timer);
  }

  /** The room is left: nothing more is retired. */
  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.retiring.clear();
  }
}

/** What a server's rules come to before its admins have said anything. */
export const DEFAULT_SCREEN_RULES: ScreenRules = {
  who: "everyone",
  sound: true,
  admins_exempt: false,
  max_per_channel: 0,
  max_per_server: 0,
  max_height: 0,
  max_fps: 0,
  max_kbps: 0,
};

/** The most a share sends when it's left to the app, or the server's limit if that's lower. */
export const SCREEN_AUTO_KBPS = 20_000;
/** A share's frame rate until someone chooses another. */
export const SCREEN_DEFAULT_FPS = 60;
/** A share's sound, in stereo, which is too little beside its picture to be worth choosing. */
export const SCREEN_SOUND_KBPS = 128;

/** What someone has chosen for their shares. */
export interface ScreenChoices {
  /** The tallest the picture may be, or 0 for the screen's own. */
  height: number;
  fps: number;
  /** The most it may send, or null to leave it to the app (`SCREEN_AUTO_KBPS`). */
  kbps: number | null;
}

/** What a share will really use, once what someone chose has met what their server allows. */
export interface ScreenTerms {
  /** The tallest the picture may be, or 0 for the screen's own. */
  height: number;
  fps: number;
  kbps: number;
  soundKbps: number;
  /** Sound may go with it. */
  sound: boolean;
  /** Which of those the server's limits brought down. */
  held: ("height" | "fps" | "kbps")[];
}

/** Why someone can't share a screen at all right now, or null if they may try. */
export function screenRefusal(rules: ScreenRules = DEFAULT_SCREEN_RULES, role: Role | undefined, channelLimit = 0): string | null {
  if (rules.who === "nobody") return "Screen sharing is off on this server";
  if (rules.who === "admins" && role !== "owner" && role !== "admin") return "Only admins can share a screen on this server";
  if (channelLimit < 0) return "Screen sharing is disabled in this voice channel";
  return null;
}

export function screenTerms(choices: ScreenChoices, rules: ScreenRules = DEFAULT_SCREEN_RULES, role: Role | undefined): ScreenTerms {
  const exempt = rules.admins_exempt && (role === "owner" || role === "admin");
  const held: ScreenTerms["held"] = [];
  const atMost = (name: ScreenTerms["held"][number], wanted: number, limit: number): number => {
    if (exempt || limit <= 0 || wanted <= limit) return wanted;
    held.push(name);
    return limit;
  };
  // The screen's own size could be any height, so it's only known to fit without a limit.
  let height = atMost("height", choices.height, rules.max_height);
  if (choices.height === 0 && !exempt && rules.max_height > 0) {
    height = rules.max_height;
    held.push("height");
  }
  // Left to the app, it's whichever is lower, which nobody chose to go past.
  const limit = exempt ? 0 : rules.max_kbps;
  const kbps = choices.kbps === null ? (limit > 0 ? Math.min(limit, SCREEN_AUTO_KBPS) : SCREEN_AUTO_KBPS) : atMost("kbps", choices.kbps, rules.max_kbps);
  return { height, fps: atMost("fps", choices.fps, rules.max_fps), kbps, soundKbps: SCREEN_SOUND_KBPS, sound: rules.sound, held };
}
