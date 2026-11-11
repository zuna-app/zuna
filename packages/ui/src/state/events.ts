// The core's events, and refreshing what they say has changed, for the store (store.ts).

import type { CallView, ConversationView, CoreEvent, MessageView } from "@zuna/core";
import { platform } from "@/platform";
import { playNotificationSound } from "@/lib/sound";
import { voiceHooks } from "@/voice/events";
import type { StoreApi } from "zustand";
import { type AppState, type ServerState, sortMessages, countedUnread, emptyList, conversationOfGroup, mentionMap } from "./store";

const debouncers = new Map<string, ReturnType<typeof setTimeout>>();
function debounced(key: string, fn: () => void, ms = 60): void {
  if (debouncers.has(key)) return;
  debouncers.set(
    key,
    setTimeout(() => {
      debouncers.delete(key);
      fn();
    }, ms),
  );
}

/**
 * What useApp does with the core's events, and the refreshes they ask for: made once, in its
 * initializer, from its set, get and patchServer.
 */
export function coreEvents(
  set: StoreApi<AppState>["setState"], get: StoreApi<AppState>["getState"],
  patchServer: (serverId: string, patch: Partial<ServerState> | ((server: ServerState) => Partial<ServerState>)) => void,
) {
  const refreshUsers = (serverId: string) =>
    debounced(`users:${serverId}`, async () => {
      try {
        const session = get().session(serverId);
        const [users, self] = await Promise.all([session.getUsers(), session.getSelf()]);
        patchServer(serverId, { users: Object.fromEntries(users.map((user) => [user.id, user])), mentionable: mentionMap(users), self });
      } catch {
        // The server may have just been removed.
      }
    });

  const refreshConversations = (serverId: string) =>
    debounced(`conversations:${serverId}`, async () => {
      try {
        const session = get().session(serverId);
        const asked = Date.now();
        const [conversations, channels] = await Promise.all([session.getConversations(), session.getChannels()]);
        patchServer(serverId, { conversations, channels });
        updateBadge();
        clearRead(serverId, asked, [...conversations, ...channels.flatMap((channel) => channel.conversation ?? [])]);
      } catch {
        // The server may have just been removed.
      }
    });

  const refreshVoice = (serverId: string) =>
    debounced(`voice:${serverId}`, async () => {
      try {
        const members = await get().session(serverId).getVoiceMembers();
        patchServer(serverId, { voice: Object.fromEntries(members.map((member) => [member.deviceId, member])) });
      } catch {
        // The server may have just been removed.
      }
    });

  const refreshCalls = (serverId: string) =>
    debounced(`calls:${serverId}`, async () => {
      try {
        const session = get().session(serverId);
        const [calls, members] = await Promise.all([session.getCalls(), session.getVoiceMembers()]);
        const before = get().servers[serverId]?.calls ?? {};
        patchServer(serverId, { calls: Object.fromEntries(calls.map((call) => [call.groupId, call])), voice: Object.fromEntries(members.map((member) => [member.deviceId, member])) });
        for (const call of calls) noticeCall(serverId, call.groupId, before[call.groupId], call);
        for (const groupId of Object.keys(before)) {
          if (!calls.some((call) => call.groupId === groupId)) noticeCall(serverId, groupId, before[groupId], null);
        }
      } catch {
        // The server may have just been removed.
      }
    });

  /**
   * Tells the system about a call ringing this person, while the app isn't in front, and about one they
   * missed. The card in the app and its ringing are the call's own.
   */
  const noticeCall = (serverId: string, groupId: string, before: CallView | undefined, call: CallView | null) => {
    const { servers, settings, windowFocused } = get();
    const server = servers[serverId];
    const self = server?.self?.userId;
    if (!server || !self) return;
    const wasRinging = !!before?.ringing.includes(self);
    const ringing = !!call?.ringing.includes(self);
    if (wasRinging === ringing) return;
    const messageId = `call:${groupId}`;
    if (wasRinging) platform.clearNotifications({ serverId, messageId });
    const conversation = conversationOfGroup(server, groupId);
    const caller = (call ?? before)!.startedBy;
    if (!conversation || conversation.muted || conversation.blocked || server.prefs.blocked?.includes(caller)) return;
    // Answered on another device, or declined, isn't missed.
    const answered = Object.values(server.voice).some((member) => member.channelId === groupId && member.userId === self);
    const missed = wasRinging && !answered && !call?.declined.includes(self);
    if (!ringing && !missed) return;
    const name = server.users[caller]?.displayName ?? "Someone";
    const body = ringing ? (conversation.kind === "dm" ? "Calling you" : `${name} started a call`) : conversation.kind === "dm" ? "Missed call" : `Missed call from ${name}`;
    if (windowFocused) {
      if (missed) get().toast(conversation.kind === "dm" ? `Missed call from ${name}.` : `Missed call from ${name} in ${conversation.title}.`, "info");
      return;
    }
    if (!settings.notifications) return;
    const preview = settings.notificationPreview;
    // A call's ringing has its own sound, so the notification makes none.
    platform.notify({
      title: preview === "none" ? "Zuna" : conversation.title,
      body: preview === "none" ? (ringing ? "Incoming call" : "Missed call") : body,
      route: { serverId, key: conversation.key },
      messageId,
    });
  };

  /** When each chat was last notified about, by server: what may still be up. */
  const notified = new Map<string, Map<string, number>>();

  /** A chat with nothing unread has nothing to notify about any more, however it came to be read. */
  const clearRead = (serverId: string, asked: number, conversations: ConversationView[]) => {
    const inServer = notified.get(serverId);
    if (!inServer?.size) return;
    // What was just notified about may be newer than this list of what's unread.
    const keys = conversations.filter((item) => item.unread === 0 && (inServer.get(item.key) ?? asked) < asked).map((item) => item.key);
    if (keys.length === 0) return;
    for (const key of keys) inServer.delete(key);
    platform.clearNotifications({ serverId, keys });
  };

  const clearServerNotifications = (serverId: string) => {
    notified.delete(serverId);
    platform.clearNotifications({ serverId });
  };

  const updateBadge = () => {
    const { servers } = get();
    let total = 0;
    for (const server of Object.values(servers)) {
      for (const conversation of server.conversations) {
        total += countedUnread(conversation);
      }
      // In a channel, only what's said to someone counts for this.
      for (const channel of server.channels) {
        if (channel.conversation && !channel.conversation.muted) total += channel.conversation.unreadMentions;
      }
    }
    platform.setUnreadCount(total);
  };

  const upsertMessage = (message: MessageView) => {
    set((state) => {
      const list = state.lists[message.groupId];
      if (!list) return state;
      const index = list.items.findIndex((item) => item.id === message.id);
      let items: MessageView[];
      if (index >= 0) {
        items = list.items.slice();
        items[index] = message;
      } else {
        // A window around an old message takes new ones once it has read on to the newest.
        if (list.detached && list.hasNewer) return state;
        items = sortMessages([...list.items, message]);
      }
      return { lists: { ...state.lists, [message.groupId]: { ...list, items } } };
    });
  };

  const patchEntry = (serverId: string, signedOut: string | null) => {
    const server = get().servers[serverId];
    if (server) patchServer(serverId, { entry: { ...server.entry, signedOut } });
  };

  const handleEvent = (event: CoreEvent) => {
    switch (event.type) {
      case "connection":
        patchServer(event.serverId, { connection: event.state });
        break;
      case "conversations":
        refreshConversations(event.serverId);
        break;
      case "channels":
        refreshConversations(event.serverId);
        refreshVoice(event.serverId);
        break;
      case "voice":
        patchServer(event.serverId, (server) => {
          const voice = { ...server.voice };
          if (event.member) voice[event.deviceId] = event.member;
          else delete voice[event.deviceId];
          return { voice };
        });
        if (event.member) voiceHooks.onMember?.(event.serverId, event.member);
        else voiceHooks.onLeft?.(event.serverId, event.channelId, event.userId);
        break;
      case "call": {
        const before = get().servers[event.serverId]?.calls[event.groupId];
        patchServer(event.serverId, (server) => {
          const calls = { ...server.calls };
          if (event.call) calls[event.groupId] = event.call;
          else delete calls[event.groupId];
          return { calls };
        });
        noticeCall(event.serverId, event.groupId, before, event.call);
        voiceHooks.onCall?.(event.serverId, event.groupId, event.call);
        break;
      }
      case "calls":
        refreshCalls(event.serverId);
        break;
      case "voice_key":
        voiceHooks.onKey?.(event.serverId, event.channelId);
        break;
      case "voice_ended":
        voiceHooks.onEnded?.(event.serverId, event.channelId, event.reason);
        break;
      case "screen_ended":
        voiceHooks.onScreenEnded?.(event.serverId, event.channelId, event.reason);
        break;
      case "users":
        refreshUsers(event.serverId);
        refreshConversations(event.serverId);
        break;
      case "message":
        // Deleted for everyone: its row stays in the chat, but what it said goes from everywhere.
        if (event.message.deletedAt) platform.clearNotifications({ serverId: event.serverId, messageId: event.message.id });
        upsertMessage(event.message);
        // A message from someone ends their typing, instead of leaving it up for seconds.
        if (event.isNew && get().servers[event.serverId]?.typing[event.message.groupId]?.[event.message.senderId]) {
          patchServer(event.serverId, (server) => {
            const next = { ...server.typing[event.message.groupId] };
            delete next[event.message.senderId];
            return { typing: { ...server.typing, [event.message.groupId]: next } };
          });
        }
        break;
      case "message_removed":
        platform.clearNotifications({ serverId: event.serverId, messageId: event.id });
        set((state) => {
          const list = state.lists[event.groupId];
          if (!list) return state;
          return {
            lists: { ...state.lists, [event.groupId]: { ...list, items: list.items.filter((item) => item.id !== event.id) } },
          };
        });
        break;
      case "message_moved":
        // The first message of a DM moves once its group exists; it stays on screen.
        set((state) => {
          const lists = { ...state.lists };
          const from = lists[event.fromGroupId];
          if (from) lists[event.fromGroupId] = { ...from, items: from.items.filter((item) => item.id !== event.message.id) };
          const target = lists[event.message.groupId] ?? { ...emptyList(), hasMore: from?.hasMore ?? true };
          lists[event.message.groupId] = { ...target, items: sortMessages([...target.items.filter((item) => item.id !== event.message.id), event.message]) };
          // The chat follows it in the same update, so it never shows an empty list in between.
          const server = state.servers[event.serverId];
          if (!server) return { lists };
          const key = event.fromGroupId.replace(/^pending:/, "");
          const conversations = server.conversations.map((item) => (item.key === key ? { ...item, groupId: event.message.groupId } : item));
          return { lists, servers: { ...state.servers, [event.serverId]: { ...server, conversations } } };
        });
        break;
      case "presence":
        patchServer(event.serverId, (server) => {
          const user = server.users[event.userId];
          if (!user) return {};
          return {
            users: { ...server.users, [event.userId]: { ...user, online: event.online, lastSeenAt: event.lastSeenAt } },
          };
        });
        break;
      case "typing":
        patchServer(event.serverId, (server) => ({
          typing: {
            ...server.typing,
            [event.groupId]: { ...(server.typing[event.groupId] ?? {}), [event.userId]: Date.now() + 5000 },
          },
        }));
        setTimeout(() => {
          patchServer(event.serverId, (server) => {
            const current = server.typing[event.groupId];
            if (!current?.[event.userId] || current[event.userId]! > Date.now()) return {};
            const next = { ...current };
            delete next[event.userId];
            return { typing: { ...server.typing, [event.groupId]: next } };
          });
        }, 5100);
        break;
      case "read":
        // Someone else reading on only moves the ticks in one conversation, so it's set
        // there, rather than every conversation and channel fetched again for each
        // receipt. This person's own comes with "conversations" too, for what's unread.
        patchServer(event.serverId, (server) => {
          if (event.userId === server.self?.userId) return {};
          let moved = false;
          const conversations = server.conversations.map((conversation) => {
            if (conversation.groupId !== event.groupId || (conversation.readBy[event.userId] ?? 0) >= event.seq) return conversation;
            moved = true;
            return { ...conversation, readBy: { ...conversation.readBy, [event.userId]: event.seq } };
          });
          return moved ? { conversations } : {};
        });
        break;
      case "settings":
        patchServer(event.serverId, (server) => ({
          info: event.info,
          entry: { ...server.entry, name: event.info.name, hasIcon: event.info.has_icon },
        }));
        break;
      case "emotes":
        void get()
          .session(event.serverId)
          .getEmotes()
          .then((emotes) => patchServer(event.serverId, { emotes }))
          .catch(() => undefined);
        break;
      case "sounds":
        void get()
          .session(event.serverId)
          .getSounds()
          .then((sounds) => patchServer(event.serverId, { sounds }))
          .catch(() => undefined);
        break;
      case "sound":
        voiceHooks.onSound?.(event.serverId, event.channelId, event.userId, event.soundId);
        break;
      case "preferences":
        void get()
          .session(event.serverId)
          .getPreferences()
          .then((prefs) => patchServer(event.serverId, { prefs }))
          .catch(() => undefined);
        break;
      case "signed_out":
        voiceHooks.onServerGone?.(event.serverId);
        clearServerNotifications(event.serverId);
        patchEntry(event.serverId, event.reason);
        get().toast(
          event.reason === "banned"
            ? "You were removed from a server by its admins."
            : event.reason === "account_deleted"
              ? "Your account on a server was deleted from another device."
              : "You've been signed out of a server.",
          "info",
        );
        break;
      case "signed_in":
        patchEntry(event.serverId, null);
        break;
      case "security":
        get().toast(event.message, "security");
        break;
      case "new_devices":
        patchServer(event.serverId, { newDevices: event.devices });
        break;
      case "notify":
        notify(event);
        break;
    }
  };

  const notify = (event: Extract<CoreEvent, { type: "notify" }>) => {
    const state = get();
    const server = state.servers[event.serverId];
    const isOpenAndVisible = state.windowFocused && state.activeServerId === event.serverId && server?.activeKey === event.conversationKey;
    if (isOpenAndVisible) return;
    const { settings } = state;
    if (!settings.notifications) return;
    if (!notified.has(event.serverId)) notified.set(event.serverId, new Map());
    notified.get(event.serverId)!.set(event.conversationKey, Date.now());
    if (settings.notificationSound) playNotificationSound();
    const preview = settings.notificationPreview;
    platform.notify({
      title: preview === "none" ? "Zuna" : event.title,
      body: preview === "full" ? event.body : "New message",
      route: { serverId: event.serverId, key: event.conversationKey },
      messageId: event.messageId,
    });
  };

  return { refreshUsers, refreshConversations, clearServerNotifications, updateBadge, handleEvent };
}
