// What makes a channel a channel: anyone on the server can see it and join it, so
// what it's called is sealed with the key everyone on the server holds and the
// server doesn't. Once joined, a channel is an MLS group like any other.

import * as wasm from "@zuna/crypto";
import { readSignedGroupDetails, sealSignal, openSignal, signGroupDetails, type SignedGroupDetails, type Signer } from "./crypto";
import { utf8 } from "./encoding";
import type { ChannelDetails } from "./validate";

/**
 * Sealed for everyone holding the community key, and signed by the device that wrote
 * it, with a version so that an older copy can't be served again. The channel's ID is
 * part of what's sealed, so one channel's details can't be passed off as another's.
 */
export function sealChannelDetails(communityKey: Uint8Array, channelId: string, details: ChannelDetails, version: number, signer: Signer, deviceSecret: Uint8Array): Uint8Array {
  return sealSignal(communityKey, "channel", channelId, version, signGroupDetails(channelId, details, version, signer, deviceSecret));
}

/** What a channel's details say and who signed them, or null if they don't open or aren't signed. */
export function openChannelDetails(communityKey: Uint8Array, channelId: string, sealed: Uint8Array): SignedGroupDetails | null {
  const opened = openSignal<unknown>(communityKey, "channel", channelId, sealed);
  return opened === null ? null : readSignedGroupDetails(channelId, opened);
}

/**
 * Says this person holds the community key, for this channel. It goes on the
 * channel's roster, where other members check it. Without the key, which the server
 * doesn't hold, nobody can make one: so the server can't put someone of its own making
 * in a channel, where they'd be handed its keys.
 */
export function channelProof(communityKey: Uint8Array, channelId: string, userId: string): Uint8Array {
  return wasm.hkdfSha256(communityKey, new Uint8Array(0), utf8(`zuna/channel-member/v1|${channelId}|${userId}`), 32);
}
