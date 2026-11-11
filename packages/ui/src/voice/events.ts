// How what the core says about voice reaches the voice store, which depends on the
// app's store, without the app's store depending on it in turn.

import type { CallView, VoiceMember, WatchView } from "@zuna/core";

export const voiceHooks: {
  onKey: ((serverId: string, channelId: string) => void) | null;
  onEnded: ((serverId: string, channelId: string, reason: string) => void) | null;
  onScreenEnded: ((serverId: string, channelId: string, reason: string) => void) | null;
  onMember: ((serverId: string, member: VoiceMember) => void) | null;
  /** Someone's device left a voice channel or a call. */
  onLeft: ((serverId: string, channelId: string, userId: string) => void) | null;
  /** A call in a conversation changed whom it's ringing, or ended. */
  onCall: ((serverId: string, groupId: string, call: CallView | null) => void) | null;
  /** This device is no longer on a server, so it can't be in any of its voice channels. */
  onServerGone: ((serverId: string) => void) | null;
  /** Someone else in the voice channel or call this device is in played a sound from the soundboard. */
  onSound: ((serverId: string, channelId: string, userId: string, soundId: string) => void) | null;
  /** What the voice channel or call this device is in watches together changed, or it stopped. */
  onWatch: ((serverId: string, channelId: string, watch: WatchView | null) => void) | null;
} = { onKey: null, onEnded: null, onScreenEnded: null, onMember: null, onLeft: null, onCall: null, onServerGone: null, onSound: null, onWatch: null };
