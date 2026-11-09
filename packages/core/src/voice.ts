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
  max_sound_kbps: 0,
  default_height: 0,
  default_fps: 60,
  default_kbps: 20_000,
};

/** What someone has chosen for their shares, with null where they've left it to the server. */
export interface ScreenChoices {
  height: number | null;
  fps: number | null;
  kbps: number | null;
  soundKbps: number;
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
  held: ("height" | "fps" | "kbps" | "soundKbps")[];
}

/** Why someone can't share a screen at all right now, or null if they may try. */
export function screenRefusal(rules: ScreenRules = DEFAULT_SCREEN_RULES, role: Role | undefined, channelLimit = 0): string | null {
  if (rules.who === "nobody") return "Screen sharing is off on this server";
  if (rules.who === "admins" && role !== "owner" && role !== "admin") return "Only admins can share a screen on this server";
  if (channelLimit < 0) return "Screen sharing is off in this voice channel";
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
  const wantedHeight = choices.height ?? rules.default_height;
  // The screen's own size could be any height, so it's only known to fit without a limit.
  let height = atMost("height", wantedHeight, rules.max_height);
  if (wantedHeight === 0 && !exempt && rules.max_height > 0) {
    height = rules.max_height;
    held.push("height");
  }
  return {
    height,
    fps: atMost("fps", choices.fps ?? rules.default_fps, rules.max_fps),
    kbps: atMost("kbps", choices.kbps ?? rules.default_kbps, rules.max_kbps),
    soundKbps: atMost("soundKbps", choices.soundKbps, rules.max_sound_kbps),
    sound: rules.sound,
    held,
  };
}
