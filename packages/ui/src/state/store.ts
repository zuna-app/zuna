// All UI state, kept in sync with the core through its event stream.

import type { CoreConnection, RemoteSession } from "@zuna/core/rpc";
import type {
  ChannelView,
  ConnectionState,
  ConversationView,
  CoreEvent,
  EmoteSet,
  MediaKind,
  MessageView,
  Preferences,
  ServerEntry,
  ServerInfo,
  UserView,
  VoiceMember,
} from "@zuna/core";
import { create } from "zustand";
import { platform } from "@/platform";
import { playNotificationSound } from "@/lib/sound";
import { voiceHooks } from "@/voice/events";
import { loadSettings, type AppSettings } from "./settings";

export interface ServerSelf {
  userId: string;
  username: string;
  role: "owner" | "admin" | "member";
  deviceId: string;
}

export interface ServerState {
  entry: ServerEntry;
  info: ServerInfo | null;
  connection: ConnectionState;
  self: ServerSelf | null;
  conversations: ConversationView[];
  channels: ChannelView[];
  /** Who's in the voice channels, by device. */
  voice: Record<string, VoiceMember>;
  users: Record<string, UserView>;
  /** username -> user ID. Replaced only when the people change, not on presence. */
  mentionable: Map<string, string>;
  emotes: EmoteSet;
  prefs: Preferences;
  activeKey: string | null;
  /** groupId -> userId -> time the typing indicator expires. */
  typing: Record<string, Record<string, number>>;
}

export interface MessageList {
  items: MessageView[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  /** Virtuoso index of the first item; decreases as older messages load. */
  firstIndex: number;
  /** The list is showing a window around a jump target, not the latest messages. */
  detached: boolean;
}

export type Toast = { id: number; kind: "info" | "error" | "security"; message: string };

export type Overlay =
  | { type: "add-server"; link?: string; signInUrl?: string }
  | { type: "settings"; section?: string }
  | { type: "server-settings"; section?: string }
  | { type: "new-group" }
  | { type: "invite" }
  | { type: "verify"; userId: string }
  | { type: "add-members"; groupId: string }
  | { type: "image"; url: string; name: string }
  | { type: "forward"; serverId: string; groupId: string; ids: string[] }
  | { type: "share-location"; conversationKey: string }
  | { type: "channel"; channelId?: string; channelType?: "text" | "voice" }
  | null;

/** "media" is one kind of thing from the chat, opened from its details. */
export type Panel = { type: "info" } | { type: "search" } | { type: "pins" } | { type: "media"; kind: MediaKind | "groups" } | null;

interface AppState {
  phase: "booting" | "ready" | "failed";
  bootError: string | null;
  core: CoreConnection | null;
  keyProtected: boolean;
  servers: Record<string, ServerState>;
  order: string[];
  activeServerId: string | null;
  lists: Record<string, MessageList>;
  overlay: Overlay;
  panel: Panel;
  toasts: Toast[];
  settings: AppSettings;
  windowFocused: boolean;
  jumpTarget: { groupId: string; messageId: string; nonce: number } | null;
  replyTo: Record<string, MessageView | null>;
  editing: Record<string, MessageView | null>;
  /** Messages picked in a chat to act on together, by message ID in the order picked. */
  selection: { listId: string; ids: string[] } | null;
  onboarding: { open: boolean };

  boot(): Promise<void>;
  session(serverId?: string): RemoteSession;
  addServer(serverId: string): Promise<void>;
  removeServer(serverId: string): void;
  selectServer(serverId: string): void;
  /** The rail's order as a server is dragged along it, saved when it's let go. */
  setServerOrder(order: string[]): void;
  saveServerOrder(): void;
  selectConversation(key: string | null): void;
  /** The newest page, and with unread messages, the pages back to the first of them unless `toUnread` is false. */
  loadList(listId: string, groupId: string | null, toUnread?: boolean): Promise<void>;
  loadOlder(listId: string): Promise<void>;
  jumpToMessage(groupId: string, messageId: string, seq?: number | null): Promise<void>;
  returnToLatest(listId: string): Promise<void>;
  setOverlay(overlay: Overlay): void;
  setPanel(panel: Panel): void;
  togglePanel(type: "info" | "search" | "pins"): void;
  toast(message: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  setReply(listId: string, message: MessageView | null): void;
  setEditing(listId: string, message: MessageView | null): void;
  /** Starts picking messages with this one, adds or removes one, or stops with null. */
  toggleSelected(listId: string, id: string | null): void;
  /** Picks exactly these messages, or stops picking with none. */
  setSelected(listId: string, ids: string[]): void;
  updateSettings(changes: Partial<AppSettings>): void;
  refreshConversations(serverId: string): void;
}

export const BASE_INDEX = 1_000_000;
/** How many pages a chat loads to open at its first unread message, which past that it opens without. */
const UNREAD_PAGES = 20;

function sortMessages(items: MessageView[]): MessageView[] {
  return items.sort((a, b) => {
    // A notice shares its number with the message before it, and goes after it.
    if (a.seq !== null && b.seq !== null) return a.seq - b.seq || Number(!!a.system) - Number(!!b.system) || a.createdAt - b.createdAt;
    if (a.seq === null && b.seq === null) return a.createdAt - b.createdAt;
    return a.seq === null ? 1 : -1;
  });
}

/** Whether a message counts as unread, as the core counts them: someone else's, after where you've read, and not from someone you blocked. */
export function isUnread(message: MessageView, ownRead: number, selfId: string | undefined, blocked: readonly string[] = []): boolean {
  return (
    message.seq !== null &&
    message.seq > ownRead &&
    message.senderId !== selfId &&
    !message.id.startsWith("sys-") &&
    message.deletedAt === null &&
    !blocked.includes(message.senderId)
  );
}

/** What a chat adds to the unread counts: its unread messages, or one if it's only marked unread, and nothing while it's muted. */
export function countedUnread(conversation: ConversationView): number {
  if (conversation.muted) return 0;
  return conversation.unread || (conversation.markedUnread ? 1 : 0);
}

function mentionMap(users: UserView[]): Map<string, string> {
  return new Map(users.map((user) => [user.username.toLowerCase(), user.id]));
}

function emptyList(): MessageList {
  return { items: [], hasMore: true, loading: false, loaded: false, firstIndex: BASE_INDEX, detached: false };
}

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

let toastId = 1;

export const useApp = create<AppState>((set, get) => {
  const patchServer = (serverId: string, patch: Partial<ServerState> | ((server: ServerState) => Partial<ServerState>)) =>
    set((state) => {
      const server = state.servers[serverId];
      if (!server) return state;
      const changes = typeof patch === "function" ? patch(server) : patch;
      return { servers: { ...state.servers, [serverId]: { ...server, ...changes } } };
    });

  const refreshUsers = (serverId: string) =>
    debounced(`users:${serverId}`, async () => {
      try {
        const users = await get().session(serverId).getUsers();
        const self = await get().session(serverId).getSelf();
        patchServer(serverId, { users: Object.fromEntries(users.map((user) => [user.id, user])), mentionable: mentionMap(users), self });
      } catch {
        // The server may have just been removed.
      }
    });

  const refreshConversations = (serverId: string) =>
    debounced(`conversations:${serverId}`, async () => {
      try {
        const session = get().session(serverId);
        const [conversations, channels] = await Promise.all([session.getConversations(), session.getChannels()]);
        patchServer(serverId, { conversations, channels });
        updateBadge();
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
        items[index] = { ...message, uploadProgress: message.uploadProgress };
      } else {
        if (list.detached) return state;
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
        break;
      case "voice_key":
        voiceHooks.onKey?.(event.serverId, event.channelId);
        break;
      case "voice_ended":
        voiceHooks.onEnded?.(event.serverId, event.channelId, event.reason);
        break;
      case "users":
        refreshUsers(event.serverId);
        refreshConversations(event.serverId);
        break;
      case "message":
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
        refreshConversations(event.serverId);
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
      case "preferences":
        void get()
          .session(event.serverId)
          .getPreferences()
          .then((prefs) => patchServer(event.serverId, { prefs }))
          .catch(() => undefined);
        break;
      case "signed_out":
        voiceHooks.onServerGone?.(event.serverId);
        patchEntry(event.serverId, event.reason);
        get().toast(
          event.reason === "banned"
            ? "You were removed from a server by its admins."
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
    if (!platform.notify || !settings.notifications) return;
    if (settings.notificationSound) playNotificationSound();
    const body = settings.notificationPreview === "full" ? event.body : "New message";
    const title = settings.notificationPreview === "none" ? "Zuna" : event.title;
    const route = { serverId: event.serverId, key: event.conversationKey };
    platform.notify({ title, body, route });
  };

  return {
    phase: "booting",
    bootError: null,
    core: null,
    keyProtected: true,
    servers: {},
    order: [],
    activeServerId: null,
    lists: {},
    overlay: null,
    panel: null,
    toasts: [],
    settings: loadSettings(),
    windowFocused: document.hasFocus(),
    jumpTarget: null,
    replyTo: {},
    editing: {},
    selection: null,
    onboarding: { open: false },

    async boot() {
      try {
        const { core, keyProtected } = await platform.bootCore(handleEvent);
        set({ core, keyProtected });
        const entries = await core.client.listServers();
        for (const entry of entries) await loadServerState(entry);
        set({
          phase: "ready",
          order: entries.map((entry) => entry.id),
          activeServerId: entries[0]?.id ?? null,
        });
      } catch (error) {
        set({ phase: "failed", bootError: (error as Error).message });
      }

      async function loadServerState(entry: ServerEntry) {
        const { core } = get();
        const session = core!.session(entry.id);
        const [conversations, users, emotes, prefs, self, connection, info, channels, voice] = await Promise.all([
          session.getConversations(),
          session.getUsers(),
          session.getEmotes(),
          session.getPreferences(),
          session.getSelf(),
          session.getConnectionState(),
          session.getInfo(),
          session.getChannels(),
          session.getVoiceMembers(),
        ]);
        set((state) => ({
          servers: {
            ...state.servers,
            [entry.id]: {
              entry,
              info,
              connection,
              self,
              conversations,
              channels,
              voice: Object.fromEntries(voice.map((member) => [member.deviceId, member])),
              users: Object.fromEntries(users.map((user) => [user.id, user])),
              mentionable: mentionMap(users),
              emotes,
              prefs,
              activeKey: null,
              typing: {},
            },
          },
        }));
      }
    },

    session(serverId) {
      const { core, activeServerId } = get();
      const id = serverId ?? activeServerId;
      if (!core || !id) throw new Error("No server is selected.");
      return core.session(id);
    },

    async addServer(serverId) {
      const { core } = get();
      if (!core) return;
      const entries = await core.client.listServers();
      const entry = entries.find((item) => item.id === serverId);
      if (!entry) return;
      const session = core.session(serverId);
      const [conversations, users, emotes, prefs, self, info, connection, channels, voice] = await Promise.all([
        session.getConversations(),
        session.getUsers(),
        session.getEmotes(),
        session.getPreferences(),
        session.getSelf(),
        session.getInfo(),
        session.getConnectionState(),
        session.getChannels(),
        session.getVoiceMembers(),
      ]);
      // A sign-in replaces any earlier account on the same server.
      const staleIds = get().order.filter((id) => !entries.some((item) => item.id === id));
      set((state) => {
        const servers = { ...state.servers };
        for (const id of staleIds) delete servers[id];
        servers[serverId] = {
          entry,
          info,
          connection,
          self,
          conversations,
          channels,
          voice: Object.fromEntries(voice.map((member) => [member.deviceId, member])),
          users: Object.fromEntries(users.map((user) => [user.id, user])),
          mentionable: mentionMap(users),
          emotes,
          prefs,
          activeKey: null,
          typing: {},
        };
        return { servers, order: entries.map((item) => item.id), activeServerId: serverId };
      });
      // Anything that happened while this state was loading had nowhere to go.
      refreshConversations(serverId);
      refreshUsers(serverId);
      void session.getConnectionState().then((state) => patchServer(serverId, { connection: state }));
    },

    removeServer(serverId) {
      voiceHooks.onServerGone?.(serverId);
      set((state) => {
        const servers = { ...state.servers };
        delete servers[serverId];
        const order = state.order.filter((id) => id !== serverId);
        return {
          servers,
          order,
          activeServerId: state.activeServerId === serverId ? (order[0] ?? null) : state.activeServerId,
          panel: null,
          overlay: null,
        };
      });
      updateBadge();
    },

    setServerOrder(order) {
      set({ order });
    },

    saveServerOrder() {
      const { core, order, toast } = get();
      core?.client.reorderServers(order).catch(() => toast("Couldn't save the order of your servers.", "error"));
    },

    selectServer(serverId) {
      set({ activeServerId: serverId, panel: null });
    },

    selectConversation(key) {
      const serverId = get().activeServerId;
      if (!serverId) return;
      patchServer(serverId, { activeKey: key });
      set({ panel: null });
      // Opening a chat marked as unread takes the mark off, as in Telegram.
      if (key && get().servers[serverId]?.conversations.find((item) => item.key === key)?.markedUnread) {
        get().session().setMarkedUnread(key, false).catch(() => {});
      }
    },

    async loadList(listId, groupId, toUnread = true) {
      const existing = get().lists[listId];
      if (existing?.loaded || existing?.loading) return;
      set((state) => ({ lists: { ...state.lists, [listId]: { ...(existing ?? emptyList()), loading: true } } }));
      if (!groupId) {
        // A conversation that hasn't started yet has nothing to load.
        set((state) => ({
          lists: { ...state.lists, [listId]: { ...(state.lists[listId] ?? emptyList()), loading: false, loaded: true, hasMore: false } },
        }));
        return;
      }
      try {
        const page = await get().session().loadMessages(groupId);
        // A chat opens at its first unread message, so the pages back to it come first, all at once.
        const { activeServerId, servers } = get();
        const server = activeServerId ? servers[activeServerId] : undefined;
        const { ownRead = 0, unread = 0 } = server?.conversations.find((item) => item.groupId === groupId) ?? server?.channels.find((item) => item.id === groupId)?.conversation ?? {};
        const unreadIn = (messages: MessageView[]) => messages.filter((message) => isUnread(message, ownRead, server?.self?.userId, server?.prefs.blocked)).length;
        for (let pages = 1; toUnread && page.hasMore && pages < UNREAD_PAGES && unreadIn(page.messages) < unread; pages++) {
          const oldest = page.messages.find((message) => message.seq !== null)?.seq;
          if (oldest == null || oldest <= ownRead + 1) break;
          const older = await get().session().loadMessages(groupId, oldest);
          page.messages = [...older.messages, ...page.messages];
          page.hasMore = older.hasMore;
        }
        set((state) => {
          const current = state.lists[listId] ?? emptyList();
          const byId = new Map(page.messages.map((message) => [message.id, message]));
          for (const item of current.items) if (!byId.has(item.id)) byId.set(item.id, item);
          return {
            lists: {
              ...state.lists,
              [listId]: { ...current, items: sortMessages([...byId.values()]), hasMore: page.hasMore, loading: false, loaded: true },
            },
          };
        });
      } catch (error) {
        set((state) => ({ lists: { ...state.lists, [listId]: { ...(state.lists[listId] ?? emptyList()), loading: false } } }));
        get().toast((error as Error).message, "error");
      }
    },

    async loadOlder(listId) {
      const list = get().lists[listId];
      if (!list || list.loading || !list.hasMore) return;
      const oldest = list.items.find((item) => item.seq !== null);
      if (!oldest) return;
      set((state) => ({ lists: { ...state.lists, [listId]: { ...list, loading: true } } }));
      try {
        const page = await get().session().loadMessages(listId, oldest.seq!);
        set((state) => {
          const current = state.lists[listId];
          if (!current) return state;
          const known = new Set(current.items.map((item) => item.id));
          const older = page.messages.filter((message) => !known.has(message.id));
          return {
            lists: {
              ...state.lists,
              [listId]: {
                ...current,
                items: [...older, ...current.items],
                firstIndex: current.firstIndex - older.length,
                hasMore: page.hasMore,
                loading: false,
              },
            },
          };
        });
      } catch {
        set((state) => ({ lists: { ...state.lists, [listId]: { ...state.lists[listId]!, loading: false } } }));
      }
    },

    async jumpToMessage(groupId, messageId, seq) {
      const list = get().lists[groupId];
      const present = list?.items.some((item) => item.id === messageId);
      if (!present) {
        let target = seq ?? null;
        if (target === null) {
          const message = await get().session().messageById(groupId, messageId);
          target = message?.seq ?? null;
        }
        if (target === null) {
          get().toast("That message isn't available.", "info");
          return;
        }
        const window = await get().session().loadAround(groupId, target);
        set((state) => ({
          lists: {
            ...state.lists,
            [groupId]: { items: sortMessages(window), hasMore: true, loading: false, loaded: true, firstIndex: BASE_INDEX, detached: true },
          },
        }));
      }
      set({ jumpTarget: { groupId, messageId, nonce: Date.now() } });
    },

    async returnToLatest(listId) {
      set((state) => {
        const lists = { ...state.lists };
        delete lists[listId];
        return { lists };
      });
      await get().loadList(listId, listId, false);
    },

    setOverlay(overlay) {
      set({ overlay });
    },

    setPanel(panel) {
      set({ panel });
    },

    togglePanel(type) {
      set((state) => ({ panel: state.panel?.type === type ? null : { type } }));
    },

    toast(message, kind = "info") {
      const id = toastId++;
      set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, message }] }));
      setTimeout(() => get().dismissToast(id), kind === "security" ? 12000 : 4500);
    },

    dismissToast(id) {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },

    setReply(listId, message) {
      set((state) => ({
        replyTo: { ...state.replyTo, [listId]: message },
        editing: message ? { ...state.editing, [listId]: null } : state.editing,
      }));
    },

    setEditing(listId, message) {
      set((state) => ({
        editing: { ...state.editing, [listId]: message },
        replyTo: message ? { ...state.replyTo, [listId]: null } : state.replyTo,
      }));
    },

    toggleSelected(listId, id) {
      set((state) => {
        if (!id) return { selection: null };
        const current = state.selection?.listId === listId ? state.selection.ids : [];
        const ids = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
        return { selection: ids.length ? { listId, ids } : null };
      });
    },

    setSelected(listId, ids) {
      set({ selection: ids.length ? { listId, ids } : null });
    },

    updateSettings(changes) {
      set((state) => ({ settings: { ...state.settings, ...changes } }));
    },

    refreshConversations,
  };
});

export const useActiveServer = (): ServerState | null =>
  useApp((state) => (state.activeServerId ? (state.servers[state.activeServerId] ?? null) : null));

export const useActiveConversation = (): ConversationView | null =>
  useApp((state) => {
    const server = state.activeServerId ? state.servers[state.activeServerId] : null;
    if (!server?.activeKey) return null;
    return server.conversations.find((item) => item.key === server.activeKey) ?? server.channels.find((item) => item.key === server.activeKey)?.conversation ?? null;
  });

/** The channel open now, if that's what's open, whether or not this device has come into it yet. */
export const useActiveChannel = (): ChannelView | null =>
  useApp((state) => {
    const server = state.activeServerId ? state.servers[state.activeServerId] : null;
    if (!server?.activeKey) return null;
    return server.channels.find((item) => item.key === server.activeKey) ?? null;
  });

/** Where a conversation's messages live before and after its group exists. */
export const listIdFor = (conversation: Pick<ConversationView, "groupId" | "key">): string =>
  conversation.groupId ?? `pending:${conversation.key}`;
