// The soundboard: sounds a server's admins add, which anyone in a voice channel or a
// call can play to the others there. What each is called, and the key to its file,
// are sealed with the community key, as a channel's name is. Playing one is a signal
// under the room's own key, and each device plays the file itself, so a sound goes
// out as it was made rather than through someone's microphone.

import { readSignedGroupDetails, sealSignal, openSignal, signGroupDetails, type SignedGroupDetails, type Signer } from "./crypto";
import type { SoundDetails } from "./validate";

/** A sound's details, sealed for everyone holding the community key and signed by the device that wrote them, as a channel's are. */
export function sealSoundDetails(communityKey: Uint8Array, soundId: string, details: SoundDetails, version: number, signer: Signer, deviceSecret: Uint8Array): Uint8Array {
  return sealSignal(communityKey, "sound", soundId, version, signGroupDetails(soundId, details, version, signer, deviceSecret));
}

/** What a sound's details say and who signed them, or null if they don't open or aren't signed. */
export function openSoundDetails(communityKey: Uint8Array, soundId: string, sealed: Uint8Array): SignedGroupDetails | null {
  const opened = openSignal<unknown>(communityKey, "sound", soundId, sealed);
  return opened === null ? null : readSignedGroupDetails(soundId, opened);
}
