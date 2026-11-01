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

/** The MLS exporter's label for a room's media key. */
export const VOICE_LABEL = "zuna/voice/v1";

/** How many keys each sender's frames can be under at once, as LiveKit keeps them. */
export const VOICE_KEY_RING = 16;

export interface VoiceIdentity {
  userId: string;
  deviceId: string;
  /** The native process sharing that device's screen, as a participant of its own. */
  screen: boolean;
}

const HEX_ID = /^[0-9a-f]{32}$/;

/** Who a device is in a room. It says nothing but IDs: names are in a profile only members can read. */
export const voiceIdentity = (userId: string, deviceId: string): string => `${userId}.${deviceId}`;

/** Who a participant is, or null for a name that isn't ours to have let in. */
export function parseVoiceIdentity(identity: string): VoiceIdentity | null {
  const [userId, deviceId, extra, ...rest] = identity.split(".");
  if (!userId || !deviceId || rest.length > 0 || !HEX_ID.test(userId) || !HEX_ID.test(deviceId)) return null;
  if (extra !== undefined && extra !== "screen") return null;
  return { userId, deviceId, screen: extra === "screen" };
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
