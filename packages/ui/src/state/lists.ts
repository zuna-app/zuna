// Loading a chat's messages: its newest pages, older and newer ones, and those around one
// message, for the store (store.ts).

import type { RemoteSession } from "@zuna/core/rpc";
import type { MessageView } from "@zuna/core";
import type { StoreApi } from "zustand";
import { type AppState, type MessageList, BASE_INDEX, sortMessages, isUnread, emptyList } from "./store";

/** How many pages a chat loads to open at its first unread message, which past that it opens without. */
const UNREAD_PAGES = 20;

/**
 * Each list's page of older messages on its way, by a number of its own. Going back to the
 * newest messages, or jumping to one, puts another list in its place, and forgets the
 * number, so the page that comes after doesn't land on the new list.
 */
const olderLoads = new Map<string, number>();
let olderLoadCount = 0;

/** useApp's actions that load a chat's messages. */
export function listActions(set: StoreApi<AppState>["setState"], get: StoreApi<AppState>["getState"]): Pick<AppState, "loadList" | "loadOlder" | "loadNewer" | "jumpToMessage" | "returnToLatest"> {
  return {
    async loadList(listId, groupId, toUnread = true) {
      // The server it's on, held across the awaits, since the person may switch to another meanwhile.
      const serverId = get().activeServerId ?? undefined;
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
        const session = get().session(serverId);
        const page = await session.loadMessages(groupId);
        // A chat opens at its first unread message, so the pages back to it come first, all at once.
        const server = serverId ? get().servers[serverId] : undefined;
        const { ownRead = 0, unread = 0 } = server?.conversations.find((item) => item.groupId === groupId) ?? server?.channels.find((item) => item.id === groupId)?.conversation ?? {};
        const unreadIn = (messages: MessageView[]) => messages.filter((message) => isUnread(message, ownRead, server?.self?.userId, server?.prefs.blocked)).length;
        for (let pages = 1; toUnread && page.hasMore && pages < UNREAD_PAGES && unreadIn(page.messages) < unread; pages++) {
          const oldest = page.messages.find((message) => message.seq !== null)?.seq;
          if (oldest == null || oldest <= ownRead + 1) break;
          const older = await session.loadMessages(groupId, oldest);
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
      const load = ++olderLoadCount;
      olderLoads.set(listId, load);
      const same = (current: MessageList | undefined): current is MessageList => !!current && olderLoads.get(listId) === load;
      let session: RemoteSession;
      try {
        session = get().session();
      } catch {
        return;
      }
      set((state) => ({ lists: { ...state.lists, [listId]: { ...list, loading: true } } }));
      try {
        const page = await session.loadMessages(listId, oldest.seq!);
        set((state) => {
          const current = state.lists[listId];
          if (!same(current)) return state;
          olderLoads.delete(listId);
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
        set((state) => {
          const current = state.lists[listId];
          if (!same(current)) return state;
          olderLoads.delete(listId);
          return { lists: { ...state.lists, [listId]: { ...current, loading: false } } };
        });
      }
    },

    async loadNewer(listId) {
      const list = get().lists[listId];
      if (!list || list.loading || !list.detached || !list.hasNewer) return;
      const newest = list.items.findLast((item) => item.seq !== null);
      if (!newest) return;
      let session: RemoteSession;
      try {
        session = get().session();
      } catch {
        return;
      }
      const same = (current: MessageList | undefined): current is MessageList => !!current && current.detached && current.hasNewer;
      set((state) => ({ lists: { ...state.lists, [listId]: { ...list, loading: true } } }));
      try {
        const page = await session.loadNewer(listId, newest.seq!);
        let end = newest.seq!;
        set((state) => {
          const current = state.lists[listId];
          if (!same(current)) return state;
          const known = new Set(current.items.map((item) => item.id));
          const items = sortMessages([...current.items, ...page.messages.filter((message) => !known.has(message.id))]);
          end = items.findLast((item) => item.seq !== null)?.seq ?? end;
          return { lists: { ...state.lists, [listId]: { ...current, items, hasNewer: page.hasMore, loading: false } } };
        });
        if (page.hasMore) return;
        // What came while the window wasn't taking new messages, between that page and now. Only
        // after its end, as one not yet a page long would take older ones in too.
        const latest = await session.loadMessages(listId);
        set((state) => {
          const current = state.lists[listId];
          if (!current?.detached || current.hasNewer) return state;
          const known = new Map(current.items.map((item, index) => [item.id, index]));
          const items = [...current.items];
          for (const message of latest.messages) {
            const index = known.get(message.id);
            if (index !== undefined) items[index] = message;
            else if (message.seq === null || message.seq > end) items.push(message);
          }
          return { lists: { ...state.lists, [listId]: { ...current, items: sortMessages(items) } } };
        });
      } catch {
        set((state) => {
          const current = state.lists[listId];
          if (!same(current)) return state;
          return { lists: { ...state.lists, [listId]: { ...current, loading: false } } };
        });
      }
    },

    async jumpToMessage(groupId, messageId, seq) {
      const session = get().session();
      const list = get().lists[groupId];
      const present = list?.items.some((item) => item.id === messageId);
      const jumpTarget = { groupId, messageId, nonce: Date.now() };
      if (!present) {
        let target = seq ?? null;
        if (target === null) {
          const message = await session.messageById(groupId, messageId);
          target = message?.seq ?? null;
        }
        if (target === null) {
          get().toast("That message isn't available.", "info");
          return;
        }
        const window = await session.loadAround(groupId, target);
        // Together, so the window's list knows from its first frame which message it opens on.
        olderLoads.delete(groupId);
        set((state) => ({
          lists: {
            ...state.lists,
            [groupId]: { items: sortMessages(window), hasMore: true, loading: false, loaded: true, firstIndex: BASE_INDEX, detached: true, hasNewer: true },
          },
          jumpTarget,
        }));
        return;
      }
      set({ jumpTarget });
    },

    async returnToLatest(listId) {
      olderLoads.delete(listId);
      set((state) => {
        const lists = { ...state.lists };
        delete lists[listId];
        return { lists };
      });
      await get().loadList(listId, listId, false);
    },
  };
}
