// All UI state, kept in sync with the core through its event stream.

import type { CoreConnection, RemoteSession } from "@zuna/core/rpc";
import type {
  Attachment,
  CallView,
  ChannelView,
  ConnectionState,
  ConversationView,
  EmoteSet,
  MediaKind,
  MessageView,
  NewDevice,
  Preferences,
  ServerEntry,
  ServerInfo,
  SoundView,
  UserView,
  VoiceMember,
} from "@zuna/core";
import { create } from "zustand";
import { platform } from "@/platform";
import { voiceHooks } from "@/voice/events";
import { coreEvents } from "./events";
import { listActions } from "./lists";
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
  /** Who's in the voice channels and the calls, by device. */
  voice: Record<string, VoiceMember>;
  /** The calls going on in this person's conversations, by group. */
  calls: Record<string, CallView>;
  users: Record<string, UserView>;
  /** username -> user ID. Replaced only when the people change, not on presence. */
  mentionable: Map<string, string>;
  emotes: EmoteSet;
  /** The server's soundboard, for its voice channels and calls. */
  sounds: SoundView[];
  prefs: Preferences;
  activeKey: string | null;
  /** groupId -> userId -> time the typing indicator expires. */
  typing: Record<string, Record<string, number>>;
  /** Devices that signed in to this account after this one, which the person has to answer for. */
  newDevices: NewDevice[];
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
  /** Such a window has messages after its newest, so it reads on rather than taking new ones. */
  hasNewer: boolean;
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
  | { type: "image"; serverId: string; pictures: Attachment[]; index: number }
  | { type: "forward"; serverId: string; groupId: string; ids: string[] }
  | { type: "share-location"; conversationKey: string }
  | { type: "channel"; channelId?: string; channelType?: "text" | "voice" }
  | null;

/** "media" is one kind of thing from the chat, opened from its details. */
export type Panel = { type: "info" } | { type: "search" } | { type: "pins" } | { type: "media"; kind: MediaKind | "groups" } | null;

export interface AppState {
  phase: "booting" | "ready" | "failed";
  bootError: string | null;
  core: CoreConnection | null;
  servers: Record<string, ServerState>;
  order: string[];
  activeServerId: string | null;
  lists: Record<string, MessageList>;
  overlay: Overlay;
  panel: Panel;
  toasts: Toast[];
  /** A new device the person said wasn't them was removed: where, and the secret it signed in with, which they're asked to change next. */
  deviceRemoved: { serverId: string; secret: NewDevice["secret"] } | null;
  setDeviceRemoved(removed: AppState["deviceRemoved"]): void;
  settings: AppSettings;
  windowFocused: boolean;
  /** Whether the person is here (activity.ts): the window has focus, with input in the last 30 s. Only then does a chat on screen count as read. */
  personHere: boolean;
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
  loadNewer(listId: string): Promise<void>;
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

export function sortMessages(items: MessageView[]): MessageView[] {
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

export function mentionMap(users: UserView[]): Map<string, string> {
  return new Map(users.map((user) => [user.username.toLowerCase(), user.id]));
}

export function emptyList(): MessageList {
  return { items: [], hasMore: true, loading: false, loaded: false, firstIndex: BASE_INDEX, detached: false, hasNewer: false };
}

/** How many of a chat's newest messages stay in memory once it's closed. Opening it again loads older ones as it's scrolled. */
const KEPT_WHEN_CLOSED = 150;

/** A closed chat's list cut back to its newest messages, or null when it should go: a window around an old message. Undefined leaves it. */
function closedList(list: MessageList | undefined): MessageList | null | undefined {
  if (!list || list.loading) return undefined;
  if (list.detached) return null;
  if (list.items.length <= KEPT_WHEN_CLOSED) return undefined;
  return { ...list, items: list.items.slice(-KEPT_WHEN_CLOSED), firstIndex: BASE_INDEX, hasMore: true };
}

/** Everything the interface keeps about a server, read from its session. Boot and adding a server both start from it. */
async function fetchServerState(session: RemoteSession, entry: ServerEntry): Promise<ServerState> {
  const [conversations, users, emotes, prefs, self, connection, info, channels, voice, calls, sounds, newDevices] = await Promise.all([
    session.getConversations(),
    session.getUsers(),
    session.getEmotes(),
    session.getPreferences(),
    session.getSelf(),
    session.getConnectionState(),
    session.getInfo(),
    session.getChannels(),
    session.getVoiceMembers(),
    session.getCalls(),
    session.getSounds(),
    session.getNewDevices(),
  ]);
  return {
    entry,
    info,
    connection,
    self,
    conversations,
    channels,
    voice: Object.fromEntries(voice.map((member) => [member.deviceId, member])),
    calls: Object.fromEntries(calls.map((call) => [call.groupId, call])),
    users: Object.fromEntries(users.map((user) => [user.id, user])),
    mentionable: mentionMap(users),
    emotes,
    sounds,
    prefs,
    activeKey: null,
    typing: {},
    newDevices,
  };
}

/** The lists a server's chats and channels are kept under. */
function listIdsOf(server: ServerState | undefined): Set<string> {
  if (!server) return new Set();
  return new Set([...server.conversations.map(listIdFor), ...server.channels.map((channel) => (channel.conversation ? listIdFor(channel.conversation) : channel.id))]);
}

const without = <T,>(record: Record<string, T>, ids: Set<string>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => !ids.has(id)));

let toastId = 1;

/** The conversation whose call is in a group, if it's one this person has. */
export function conversationOfGroup(server: ServerState | undefined, groupId: string): ConversationView | undefined {
  return server?.conversations.find((item) => item.groupId === groupId);
}

/** A conversation by its key, whether it's in the list or is a channel. */
export function findConversation(server: ServerState | undefined, key: string): ConversationView | undefined {
  return server?.conversations.find((item) => item.key === key) ?? server?.channels.find((item) => item.conversation?.key === key)?.conversation ?? undefined;
}

export const useApp = create<AppState>((set, get) => {
  const patchServer = (serverId: string, patch: Partial<ServerState> | ((server: ServerState) => Partial<ServerState>)) =>
    set((state) => {
      const server = state.servers[serverId];
      if (!server) return state;
      const changes = typeof patch === "function" ? patch(server) : patch;
      // Nothing that differs, as with presence for someone not known here, wakes nobody.
      if (Object.entries(changes).every(([key, value]) => server[key as keyof ServerState] === value)) return state;
      return { servers: { ...state.servers, [serverId]: { ...server, ...changes } } };
    });

  /** Cuts a chat back to its newest messages once it isn't shown, so a long session doesn't keep every page it ever loaded. */
  const closeList = (serverId: string, key: string) =>
    set((state) => {
      const server = state.servers[serverId];
      const channel = server?.channels.find((item) => item.key === key);
      const conversation = server?.conversations.find((item) => item.key === key) ?? channel?.conversation;
      const listId = conversation ? listIdFor(conversation) : channel?.id;
      if (!listId) return state;
      const list = closedList(state.lists[listId]);
      if (list === undefined) return state;
      const lists = { ...state.lists };
      if (list) lists[listId] = list;
      else delete lists[listId];
      return { lists };
    });

  const { refreshUsers, refreshConversations, clearServerNotifications, updateBadge, handleEvent } = coreEvents(set, get, patchServer);

  return {
    phase: "booting",
    bootError: null,
    core: null,
    servers: {},
    order: [],
    activeServerId: null,
    lists: {},
    overlay: null,
    panel: null,
    toasts: [],
    deviceRemoved: null,
    setDeviceRemoved(deviceRemoved) {
      set({ deviceRemoved });
    },
    settings: loadSettings(),
    windowFocused: document.hasFocus(),
    personHere: false,
    jumpTarget: null,
    replyTo: {},
    editing: {},
    selection: null,
    onboarding: { open: false },

    async boot() {
      try {
        const { core } = await platform.bootCore(handleEvent);
        set({ core });
        const entries = await core.client.listServers();
        // All at once, and one that doesn't load leaves the others, saying so, rather than the whole app.
        const loaded = await Promise.allSettled(entries.map(async (entry) => fetchServerState(core.session(entry.id), entry)));
        const servers: Record<string, ServerState> = {};
        const failed: ServerEntry[] = [];
        loaded.forEach((result, index) => {
          if (result.status === "fulfilled") servers[entries[index]!.id] = result.value;
          else failed.push(entries[index]!);
        });
        const order = entries.filter((entry) => servers[entry.id]).map((entry) => entry.id);
        set((state) => ({ servers: { ...state.servers, ...servers }, phase: "ready", order, activeServerId: order[0] ?? null }));
        for (const entry of failed) get().toast(`${entry.name} didn't open. Reload the page to try it again.`, "error");
        // What came in while the app was closed counts from the start, not from the next message.
        updateBadge();
      } catch (error) {
        set({ phase: "failed", bootError: (error as Error).message });
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
      const loaded = await fetchServerState(session, entry);
      // A sign-in replaces any earlier account on the same server.
      const staleIds = get().order.filter((id) => !entries.some((item) => item.id === id));
      set((state) => {
        const servers = { ...state.servers };
        for (const id of staleIds) delete servers[id];
        servers[serverId] = loaded;
        return { servers, order: entries.map((item) => item.id), activeServerId: serverId };
      });
      // Anything that happened while this state was loading had nowhere to go.
      refreshConversations(serverId);
      refreshUsers(serverId);
      void session.getConnectionState().then((state) => patchServer(serverId, { connection: state }));
    },

    removeServer(serverId) {
      voiceHooks.onServerGone?.(serverId);
      clearServerNotifications(serverId);
      set((state) => {
        const servers = { ...state.servers };
        delete servers[serverId];
        const order = state.order.filter((id) => id !== serverId);
        // Its chats' messages, and what was being written in them, go with it.
        const gone = listIdsOf(state.servers[serverId]);
        return {
          servers,
          order,
          lists: without(state.lists, gone),
          replyTo: without(state.replyTo, gone),
          editing: without(state.editing, gone),
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
      const { activeServerId, servers } = get();
      const leaving = activeServerId && activeServerId !== serverId ? servers[activeServerId]?.activeKey : null;
      set({ activeServerId: serverId, panel: null });
      if (leaving) closeList(activeServerId!, leaving);
    },

    selectConversation(key) {
      const serverId = get().activeServerId;
      if (!serverId) return;
      const previous = get().servers[serverId]?.activeKey;
      patchServer(serverId, { activeKey: key });
      if (previous && previous !== key) closeList(serverId, previous);
      set({ panel: null });
      // Opening a chat marked as unread takes the mark off, as in Telegram.
      if (key && get().servers[serverId]?.conversations.find((item) => item.key === key)?.markedUnread) {
        get().session().setMarkedUnread(key, false).catch(() => {});
      }
    },

    ...listActions(set, get),

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

/**
 * The active server, whole. Anything reading this re-renders on every presence,
 * typing and voice event, so a component that needs a few things takes them with
 * `useActiveField` instead.
 */
export const useActiveServer = (): ServerState | null =>
  useApp((state) => (state.activeServerId ? (state.servers[state.activeServerId] ?? null) : null));

/**
 * One thing from the active server, so a component re-renders when that changes and
 * not with the rest. `pick` returns a part of the state or a plain value, never a new
 * object or array, and `fallback` is a constant for when no server is open.
 */
export const useActiveField = <T,>(pick: (server: ServerState) => T, fallback: T): T =>
  useApp((state) => {
    const server = state.activeServerId ? state.servers[state.activeServerId] : null;
    return server ? pick(server) : fallback;
  });

/** The active server as it is now, for an event handler, which needn't re-render with it. */
export const activeServerNow = (): ServerState | null => {
  const state = useApp.getState();
  return state.activeServerId ? (state.servers[state.activeServerId] ?? null) : null;
};

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
