// The table the broker in the native app checks every core call and event of a plugin
// against: for each method `rpc.ts` lets an interface call, the permission a plugin needs
// for it, or "never". It's typed against the core's own classes, as rpc.ts's lists are, so a
// method added to the core doesn't type-check here until someone has classified it.
// apps/desktop/core-bundle/build.mjs writes it as JSON beside the core bundle, which the
// broker reads (apps/desktop/src/plugins/surface.rs).
//
// "never" is the default answer. A method is open to plugins when a plugin has a use for it
// and it reaches nothing on the Never list of docs/PLUGINS_PLAN.md: keys, passwords, the
// account's life, devices and trust, bots' setup, administration, sound and video
// themselves, the disk. A method that fetches a URL through the core is "never" too, as it
// would reach the internet around `network` and its hosts.

import type { CoreEvent, ServerSession, ZunaClient } from "@zuna/core";
import { PERMISSIONS, type Permission } from "./manifest.ts";

type MethodName<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] & string;
type Rule = Permission | "never";

export const CLIENT: Record<MethodName<ZunaClient>, Rule> = {
  deleteAccount: "never",
  findLink: "never",
  forwardMessages: "messages.send",
  leaveServer: "never",
  linkPreview: "never",
  listServers: "servers.read",
  login: "never",
  nudge: "never",
  open: "never",
  previewInvite: "never",
  recover: "never",
  register: "never",
  registerBot: "never",
  reload: "never",
  reorderServers: "never",
  resume: "never",
  serverInfo: "never",
  session: "never",
  setActive: "never",
  stop: "never",
  suspend: "never",
};

export const SESSION: Record<MethodName<ServerSession>, Rule> = {
  // Reading.
  getConnectionState: "servers.read",
  getInfo: "servers.read",
  getSelf: "servers.read",
  serverUrl: "servers.read",
  getEmotes: "servers.read",
  emotesIn: "servers.read",
  emoteUrl: "servers.read",
  getConversations: "conversations.read",
  getChannels: "conversations.read",
  getUsers: "users.read",
  loadMessages: "messages.read",
  loadAround: "messages.read",
  loadNewer: "messages.read",
  loadMedia: "messages.read",
  loadPins: "messages.read",
  messageById: "messages.read",
  mediaCounts: "messages.read",
  previewText: "messages.read",
  search: "messages.read",
  searchCoverage: "messages.read",
  unreadMentions: "messages.read",
  forwardable: "messages.read",
  downloadChunk: "files.read",
  downloadFile: "files.read",
  getVoiceMembers: "voice.read",
  getCalls: "voice.read",
  getSounds: "voice.read",
  getWatch: "voice.read",

  // Acting as the person.
  sendMessage: "messages.send",
  sendNow: "messages.send",
  editMessage: "messages.send",
  deleteMessage: "messages.send",
  deleteMessages: "messages.send",
  discardMessage: "messages.send",
  retryMessage: "messages.send",
  forwardMessage: "messages.send",
  toggleReaction: "messages.send",
  setPinned: "messages.send",
  pressButton: "messages.send",
  sendTyping: "messages.send",
  markRead: "messages.send",
  markChatRead: "messages.send",
  markMentionSeen: "messages.send",
  // Files go out only as bytes a plugin holds: the broker refuses a path anywhere in a call.
  sendWithAttachments: "messages.send",

  // Voice is joined in the app, not the core, so plugins reach it through the broker's own
  // voice calls (zuna.voice), and only a room's lighter controls here.
  declineCall: "voice.control",
  playSound: "voice.control",
  watchControl: "voice.control",
  watchStart: "voice.control",
  watchStop: "voice.control",
  setVoiceState: "never",
  ringCall: "never",
  prepareCall: "never",
  voiceDisconnect: "never",
  voiceMute: "never",
  soundFile: "never",

  // Keys, sessions and media access.
  voiceKey: "never",
  voiceAccess: "never",
  voiceScreenAccess: "never",
  voiceScreenStop: "never",
  voiceScreenStopOf: "never",
  holdsKeys: "never",
  hearsChat: "never",

  // The account's life, devices and trust.
  changePassword: "never",
  regenerateRecoveryKey: "never",
  rotate: "never",
  deleteAccount: "never",
  signOut: "never",
  answerNewDevice: "never",
  prepareNewDevice: "never",
  getNewDevices: "never",
  getDevices: "never",
  revokeDevice: "never",
  markVerified: "never",
  clearVerification: "never",
  safetyCheck: "never",
  exportServerData: "never",

  // The person's own settings and profile, which a plugin reads nothing of but what servers.read gives.
  getPreferences: "never",
  updatePreferences: "never",
  updateProfile: "never",
  setHideLastSeen: "never",
  setPush: "never",
  setBlocked: "never",
  mute: "never",
  unmute: "never",
  setMentionsOnly: "never",
  setMarkedUnread: "never",
  setDisappearing: "never",
  forgetConversation: "never",

  // Groups, channels, invites, bots and the server's administration.
  addMembers: "never",
  removeMember: "never",
  createGroup: "never",
  deleteGroup: "never",
  leaveGroup: "never",
  setGroupRole: "never",
  updateGroupMeta: "never",
  createChannel: "never",
  updateChannel: "never",
  deleteChannel: "never",
  reorderChannels: "never",
  createInvite: "never",
  revokeInvite: "never",
  invites: "never",
  linkForInvite: "never",
  createBot: "never",
  deleteBot: "never",
  getBots: "never",
  newBotLink: "never",
  setBotChannels: "never",
  updateBot: "never",
  updateBotProfile: "never",
  banUser: "never",
  unbanUser: "never",
  getBans: "never",
  getReports: "never",
  reportUser: "never",
  dismissReports: "never",
  setServerRole: "never",
  setEmoteSet: "never",
  refreshEmotes: "never",
  updateServerIcon: "never",
  updateServerSettings: "never",
  addSound: "never",
  updateSound: "never",
  deleteSound: "never",

  // The session's own running.
  start: "never",
  stop: "never",
  suspend: "never",
  resume: "never",
  setActive: "never",
  nudge: "never",
  catchUpFirst: "never",
  flushOutbox: "never",
  syncGroup: "never",
  isActiveElsewhere: "never",
};

export const EVENTS: Record<CoreEvent["type"], Rule> = {
  connection: "servers.read",
  settings: "servers.read",
  emotes: "servers.read",
  signed_out: "servers.read",
  signed_in: "servers.read",
  conversations: "conversations.read",
  channels: "conversations.read",
  users: "users.read",
  presence: "users.read",
  typing: "users.read",
  message: "messages.read",
  message_removed: "messages.read",
  message_moved: "messages.read",
  read: "messages.read",
  notify: "messages.read",
  voice: "voice.read",
  voice_ended: "voice.read",
  screen_ended: "voice.read",
  call: "voice.read",
  calls: "voice.read",
  sounds: "voice.read",
  sound: "voice.read",
  watch: "voice.read",
  voice_key: "never",
  activity: "never",
  preferences: "never",
  security: "never",
  new_devices: "never",
  button: "never",
};

/** The table as the broker reads it. */
export function surfaceJson(): string {
  return JSON.stringify({ permissions: PERMISSIONS, client: CLIENT, session: SESSION, events: EVENTS }, null, 2);
}
