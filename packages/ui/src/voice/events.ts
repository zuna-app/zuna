// How what the core says about voice reaches the voice store, which depends on the
// app's store, without the app's store depending on it in turn.

import type { VoiceMember } from "@zuna/core";

export const voiceHooks: {
  onKey: ((serverId: string, channelId: string) => void) | null;
  onEnded: ((serverId: string, channelId: string, reason: string) => void) | null;
  onMember: ((serverId: string, member: VoiceMember) => void) | null;
  /** This device is no longer on a server, so it can't be in any of its voice channels. */
  onServerGone: ((serverId: string) => void) | null;
} = { onKey: null, onEnded: null, onMember: null, onServerGone: null };
