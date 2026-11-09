// ServerSession, in part (see base.ts): the conversation list, notifications, and reading messages.

import { ApiError } from "../api";
import { toBase64 } from "../encoding";
import type { SqlValue } from "../db";
import { MEDIA_KINDS } from "../media";
import { queryTokens } from "../search";
import type {
  AvatarRef,
  ConversationView,
  EarlierMessage,
  GroupMemberView,
  MediaCounts,
  MediaKind,
  MessageView,
  Preferences,
  PushSettings,
  ReportReason,
  ReportView,
  SearchResult,
} from "../types";
import { isMuted, REPORT_REASONS } from "../types";
import { PAGE_SIZE, LONGEST_WAIT_MS, type CachedGroup, type MessageRow, slowModeOf, eachLimited } from "./shared";
import { SessionIngest } from "./ingest";

export abstract class SessionConversations extends SessionIngest {
  // --- Conversations ---

  protected conversationKey(group: CachedGroup): string {
    return group.kind === "dm" ? `user:${group.peerId}` : `group:${group.id}`;
  }

  protected groupForKey(key: string): CachedGroup | undefined {
    if (key.startsWith("group:")) return this.groups.get(key.slice(6));
    return this.dmWith(key.slice(5));
  }

  protected lastMessage(groupId: string): MessageView | null {
    const blocked = this.notFromBlocked("sender_user");
    const where = `group_id = ? AND deleted_at IS NULL${blocked.sql}`;
    const params = [groupId, ...blocked.params];
    // The newest still being sent, or else the newest the server has ordered: each down
    // messages_order, where one query ordering by both would sort the whole group.
    const row =
      this.db.get<MessageRow>(`SELECT * FROM messages WHERE ${where} AND seq IS NULL ORDER BY created_at DESC LIMIT 1`, params) ??
      this.db.get<MessageRow>(`SELECT * FROM messages WHERE ${where} AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1`, params);
    return row ? this.toMessageView(row) : null;
  }

  protected isBlocked(userId: string): boolean {
    return this.prefs.blocked?.includes(userId) ?? false;
  }

  /** A condition leaving out messages from people this account blocked, to add to a query's WHERE. */
  protected notFromBlocked(column: string): { sql: string; params: string[] } {
    const blocked = this.prefs.blocked ?? [];
    if (blocked.length === 0) return { sql: "", params: [] };
    return { sql: ` AND ${column} NOT IN (${blocked.map(() => "?").join(",")})`, params: blocked };
  }

  protected unreadCount(group: CachedGroup): { unread: number; mentioned: boolean; unreadMentions: number } {
    const blocked = this.notFromBlocked("sender_user");
    const rows = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND seq > ? AND sender_user != ?
       AND deleted_at IS NULL AND id NOT LIKE 'sys-%'${blocked.sql}`,
      [group.id, group.ownRead, this.account.userId, ...blocked.params],
    );
    // As in Telegram, only groups have them: everything in a direct message is for you.
    const fromBlocked = this.notFromBlocked("m.sender_user");
    const mentions = group.kind === "dm" ? undefined : this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND d.kind = ? AND m.seq > ? AND m.sender_user != ? AND m.deleted_at IS NULL AND m.mention_seen = 0${fromBlocked.sql}`,
      [group.id, this.mentionTag, group.ownRead, this.account.userId, ...fromBlocked.params],
    );
    const unreadMentions = mentions?.n ?? 0;
    return { unread: rows?.n ?? 0, mentioned: unreadMentions > 0, unreadMentions };
  }

  /**
   * The messages in a group after `after` that mention this account or reply to it,
   * oldest first, leaving out those already jumped to. The app asks from where the
   * chat is read, so those read by scrolling past them drop out of Telegram's "@".
   */
  unreadMentions(groupId: string, after: number): { id: string; seq: number }[] {
    if (this.groups.get(groupId)?.kind === "dm") return [];
    const blocked = this.notFromBlocked("m.sender_user");
    return this.db.all<{ id: string; seq: number }>(
      `SELECT m.id, m.seq FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND d.kind = ? AND m.seq > ? AND m.sender_user != ? AND m.deleted_at IS NULL AND m.mention_seen = 0${blocked.sql}
       ORDER BY m.seq LIMIT 500`,
      [groupId, this.mentionTag, after, this.account.userId, ...blocked.params],
    );
  }

  /** A mention that was jumped to, which no longer counts as waiting. */
  markMentionSeen(groupId: string, id: string): void {
    this.db.run("UPDATE messages SET mention_seen = 1 WHERE group_id = ? AND id = ?", [groupId, id]);
    this.emitConversations();
  }

  getConversations(): ConversationView[] {
    const out: ConversationView[] = [];
    const usersWithDm = new Set<string>();
    const selfId = this.account.userId;
    const now = Date.now();

    for (const group of this.groups.values()) {
      // Channels come with getChannels, and an app that doesn't ask for them doesn't see them.
      if (group.kind === "channel") continue;
      if (group.kind === "dm" && group.peerId) usersWithDm.add(group.peerId);
      out.push(this.conversationOf(group, now));
    }

    // Everyone on the server is a conversation from the start.
    for (const user of this.users.values()) {
      if (usersWithDm.has(user.id) || user.banned || user.deleted) continue;
      const key = `user:${user.id}`;
      out.push({
        key,
        kind: "dm",
        groupId: null,
        peerId: user.id,
        title: user.id === selfId ? "Saved messages" : user.profile.displayName || user.username,
        avatar: user.profile.avatar ?? null,
        description: "",
        lastMessage: null,
        lastActivityAt: 0,
        unread: 0,
        mentioned: false,
        unreadMentions: 0,
        pinned: this.prefs.pinned.includes(key),
        muted: isMuted(this.prefs, key, now),
        mutedUntil: this.mutedUntil(key, now),
        hidden: this.prefs.hidden.includes(key),
        markedUnread: this.prefs.markedUnread?.includes(key) ?? false,
        mentionsOnly: this.prefs.mentionsOnly?.includes(key) ?? false,
        blocked: this.isBlocked(user.id),
        members: [],
        historyVisible: false,
        readBy: {},
        ownRead: 0,
        ready: false,
        removed: false,
        disappearAfter: 0,
        slowMode: 0,
        slowUntil: 0,
      });
    }
    return out.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastActivityAt - a.lastActivityAt ||
        a.title.localeCompare(b.title),
    );
  }

  protected conversationOf(group: CachedGroup, now: number): ConversationView {
    const key = this.conversationKey(group);
    const last = this.lastMessage(group.id);
    const { unread, mentioned, unreadMentions } = this.unreadCount(group);
    let title = group.meta.name || "Group";
    let description = group.meta.description ?? "";
    let avatar: AvatarRef | null = group.meta.avatar ?? null;
    if (group.kind === "dm" && group.peerId) {
      const peer = this.users.get(group.peerId);
      title = group.peerId === this.account.userId ? "Saved messages" : peer?.profile.displayName || peer?.username || "Unknown";
      avatar = peer?.profile.avatar ?? null;
    } else if (group.kind === "channel") {
      const details = this.channels.get(group.id)?.details;
      title = details?.name ?? "Channel";
      description = details?.topic ?? "";
    }
    return {
      key,
      kind: group.kind,
      groupId: group.id,
      peerId: group.peerId,
      title,
      avatar,
      description,
      lastMessage: last,
      lastActivityAt: last?.createdAt ?? group.createdAt,
      unread,
      mentioned,
      unreadMentions,
      pinned: this.prefs.pinned.includes(key),
      muted: isMuted(this.prefs, key, now),
      mutedUntil: this.mutedUntil(key, now),
      hidden: this.prefs.hidden.includes(key),
      markedUnread: this.prefs.markedUnread?.includes(key) ?? false,
      mentionsOnly: this.prefs.mentionsOnly?.includes(key) ?? false,
      blocked: group.kind === "dm" && !!group.peerId && this.isBlocked(group.peerId),
      members: this.membersWithKeys(group),
      historyVisible: group.kind === "channel" || this.sharesHistory(group),
      readBy: group.readBy,
      ownRead: group.ownRead,
      // A device comes into a channel by itself, some time after others started it.
      ready: group.epoch > 0 && !group.removedAt && (group.kind !== "channel" || this.hasMlsGroup(group.id)),
      removed: !!group.removedAt,
      disappearAfter: this.disappearAfter(group),
      slowMode: group.kind === "channel" ? slowModeOf(this.channels.get(group.id)?.api) : 0,
      slowUntil: this.slowUntil(group, now),
    };
  }

  /**
   * When a channel's slow mode lets this person send there again, from the last message
   * any of their devices sent, or one still going from here, or what the server said
   * when it held one back. The server decides; this is only for showing it.
   */
  protected slowUntil(group: CachedGroup, now: number): number {
    const slowMode = group.kind === "channel" ? slowModeOf(this.channels.get(group.id)?.api) : 0;
    if (slowMode === 0 || group.members.some((member) => member.userId === this.account.userId && member.role === "admin")) return 0;
    const own = this.db.get<{ sent: number | null; going: number | null }>(
      `SELECT MAX(CASE WHEN seq IS NOT NULL THEN created_at END) AS sent, MAX(CASE WHEN seq IS NULL AND status = 'sending' THEN created_at END) AS going
       FROM messages WHERE group_id = ? AND sender_user = ?`,
      [group.id, this.account.userId],
    );
    const held = this.slowHeld.get(this.conversationKey(group)) ?? 0;
    // One still going goes once it's let through, and the wait starts again from there.
    const going = own?.going ? Math.max(own.going, held, now) : 0;
    const sent = Math.max((own?.sent ?? 0) - this.api.serverAhead, this.getKv<EarlierMessage>(`sent/${group.id}`)?.at ?? 0);
    const until = Math.max(sent, going) + slowMode * 1000;
    return until > now ? until : 0;
  }

  /**
   * A group's members, as the server lists them and as its keys say. Who holds
   * the keys is what MLS proves, so a difference is shown, not hidden.
   */
  protected membersWithKeys(group: CachedGroup): GroupMemberView[] {
    if (group.kind !== "group" || group.removedAt || group.epoch === 0) return group.members;
    let inTree = this.treeUsersCache.get(group.id);
    if (!inTree) {
      if (!this.hasMlsGroup(group.id)) return group.members;
      inTree = new Set(this.treeUsers(group.id));
      this.treeUsersCache.set(group.id, inTree);
    }
    const members = group.members.map((member) => (inTree.has(member.userId) ? member : { ...member, noKeys: true }));
    for (const userId of inTree) {
      if (!group.members.some((member) => member.userId === userId)) {
        members.push({ userId, role: "member", joinedAt: 0, notOnRoster: true });
      }
    }
    return members;
  }

  getPreferences(): Preferences {
    return this.prefs;
  }

  async updatePreferences(changes: Partial<Preferences>): Promise<void> {
    this.prefs = { ...this.prefs, ...changes };
    this.setKv("prefs", this.prefs);
    this.noteUnsavedTrust({ prefs: true });
    this.emit({ type: "preferences", serverId: this.serverId });
    this.emitConversations();
    this.watchMutes();
    if (changes.muted || changes.mutedUntil || changes.blocked) this.resendPush();
    await this.writeManifest();
  }

  /** Mutes a chat until `until` (ms), or without it until it's unmuted. */
  mute(key: string, until?: number): Promise<void> {
    const mutedUntil = Object.fromEntries(Object.entries(this.prefs.mutedUntil ?? {}).filter(([other, end]) => other !== key && end > Date.now()));
    // Whole milliseconds, which is what the server reads: a phone may give a fraction of one.
    if (until !== undefined) mutedUntil[key] = Math.round(until);
    const muted = this.prefs.muted.filter((other) => other !== key);
    if (until === undefined) muted.push(key);
    return this.updatePreferences({ muted, mutedUntil });
  }

  unmute(key: string): Promise<void> {
    const mutedUntil = Object.fromEntries(Object.entries(this.prefs.mutedUntil ?? {}).filter(([other, end]) => other !== key && end > Date.now()));
    return this.updatePreferences({ muted: this.prefs.muted.filter((other) => other !== key), mutedUntil });
  }

  /** Marks a chat as unread by hand, or takes the mark off, on every device. */
  setMarkedUnread(key: string, marked: boolean): Promise<void> {
    const current = this.prefs.markedUnread ?? [];
    if (current.includes(key) === marked) return Promise.resolve();
    return this.updatePreferences({ markedUnread: marked ? [...current, key] : current.filter((other) => other !== key) });
  }

  /**
   * Blocks someone, or unblocks them: their messages stay on this device but out of
   * sight, unread counts and notifications. It's in the synced preferences, sealed
   * in the vault, so neither they nor the server learn of it.
   */
  setBlocked(userId: string, blocked: boolean): Promise<void> {
    const current = this.prefs.blocked ?? [];
    if (userId === this.account.userId || current.includes(userId) === blocked) return Promise.resolve();
    return this.updatePreferences({ blocked: blocked ? [...current, userId] : current.filter((other) => other !== userId) });
  }

  /**
   * Reports someone to this server's admins, who see whom and why, never what was said
   * nor who reported them. This account remembers it, so that each person is reported once.
   */
  async reportUser(userId: string, reason: ReportReason): Promise<void> {
    await this.api.report(userId, reason);
    const reported = this.prefs.reported ?? [];
    if (!reported.includes(userId)) await this.updatePreferences({ reported: [...reported, userId] });
  }

  /** What people were reported for, one entry a person, the latest first. For admins. */
  async getReports(): Promise<ReportView[]> {
    const { reports } = await this.api.reports();
    const byUser = new Map<string, ReportView>();
    for (const report of reports) {
      const view = byUser.get(report.user_id) ?? { userId: report.user_id, count: 0, reasons: [], lastAt: report.created_at };
      view.count++;
      const reason = REPORT_REASONS.find((known) => known === report.reason);
      if (reason && !view.reasons.includes(reason)) view.reasons.push(reason);
      byUser.set(report.user_id, view);
    }
    return [...byUser.values()];
  }

  /** Forgets what someone was reported for, as an admin. */
  async dismissReports(userId: string): Promise<void> {
    await this.api.dismissReports(userId);
  }

  /** Has a chat notify only about messages that mention you or reply to you, or about all of them again. */
  setMentionsOnly(key: string, on: boolean): Promise<void> {
    const current = this.prefs.mentionsOnly ?? [];
    if (current.includes(key) === on) return Promise.resolve();
    return this.updatePreferences({ mentionsOnly: on ? [...current, key] : current.filter((other) => other !== key) });
  }

  /** Reads a chat to its newest message without opening it, and takes off any mark of being unread. */
  async markChatRead(key: string): Promise<void> {
    await this.setMarkedUnread(key, false);
    const group = this.groupForKey(key);
    if (group) await this.markRead(group.id, this.latestSeq(group.id));
  }

  protected mutedUntil(key: string, now = Date.now()): number | null {
    const until = this.prefs.mutedUntil?.[key];
    return until && until > now && !this.prefs.muted.includes(key) ? until : null;
  }

  /** Shows a chat muted for a while as heard again the moment its time is up. */
  protected watchMutes(): void {
    clearTimeout(this.muteTimer);
    const now = Date.now();
    const next = Math.min(...Object.values(this.prefs.mutedUntil ?? {}).filter((until) => until > now));
    if (!Number.isFinite(next) || this.stopped) return;
    // A mute from another device can last longer than setTimeout can wait, which would fire at once, over and over.
    this.muteTimer = setTimeout(() => {
      this.emitConversations();
      this.watchMutes();
    }, Math.min(next - now + 50, LONGEST_WAIT_MS));
  }

  // --- Notifications ---

  /**
   * Whether the person is using this device right now, as in Telegram: the
   * desktop's window in front with input in the last 30 s, the phone app on
   * screen. While they are, and for a while after, their other devices'
   * notifications wait, and don't show if they read the chat here. They show
   * as online while they are, and offline, last seen then, as soon as they
   * aren't, as Telegram's apps tell its server.
   */
  setActive(active: boolean): void {
    if (this.active && !active) this.leftHereAt = Date.now();
    this.active = active;
    this.socket.setActive(active);
  }

  /** Whether the person is using another of their devices, as the server last said. */
  isActiveElsewhere(): boolean {
    return this.activeElsewhere;
  }

  /**
   * Has the server wake this device through a push relay for new messages, or
   * stops it with null. It's remembered, and sent again after reconnecting and
   * whenever the muted chats change, if the server is told about them.
   */
  async setPush(push: PushSettings | null): Promise<void> {
    this.push = push ?? "off";
    this.setKv("push", push ? { ...push, key: toBase64(push.key) } : "off");
    await this.sendPush();
  }

  /** One update at a time, each sending what's current then, so a late one can't undo a newer one. */
  protected sendPush(): Promise<void> {
    return this.withLock("push", () => this.sendPushNow());
  }

  protected async sendPushNow(): Promise<void> {
    const push = this.push;
    if (push === null) return;
    if (push === "off") {
      await this.api.deletePush();
      return;
    }
    // Muted DMs are kept by the person's key; the server knows the DM's group.
    // A chat muted for a while is pushed again once its time is up, even while the app isn't running.
    const groupOf = (key: string) => this.groupForKey(key)?.id;
    // A direct message with someone blocked is muted for good, which is all the server learns of it.
    const quiet = [...this.prefs.muted, ...(this.prefs.blocked ?? []).map((userId) => `user:${userId}`)];
    const muted = push.sendMuted ? [...new Set(quiet.map(groupOf).filter((id): id is string => !!id))] : [];
    const mutedUntil: Record<string, number> = {};
    for (const [key, until] of Object.entries(push.sendMuted ? (this.prefs.mutedUntil ?? {}) : {})) {
      const groupId = groupOf(key);
      // A time another device kept with a fraction of a millisecond would make the server refuse the whole registration.
      if (groupId && until > Date.now()) mutedUntil[groupId] = Math.round(until);
    }
    // An app that hides what it shouldn't show is pushed for everything, channels too.
    await this.api.setPush({ relay: push.relay, handle: push.handle, call_handle: push.callHandle, key: push.key, registration: push.registration, muted, muted_until: mutedUntil, filters: !push.sendMuted });
  }

  protected resendPush(): void {
    this.sendPush().catch((error) => console.warn("[zuna] updating notifications", error));
  }

  // --- Reading messages ---

  protected backfilled(groupId: string): boolean {
    const group = this.groups.get(groupId);
    return !!group && this.syncedSeq(groupId) >= group.seq;
  }

  /** One page of history, newest last. Older pages come from the server if needed. */
  async loadMessages(groupId: string, before?: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const upper = before ?? Number.MAX_SAFE_INTEGER;
    if (!this.backfilled(groupId)) {
      try {
        const remote = await this.api.messages(groupId, { before: before ?? undefined, limit: PAGE_SIZE });
        for (const message of remote) this.ingest(message, false);
      } catch (error) {
        console.warn("[zuna] couldn't fetch history", error);
      }
    }
    const rows = this.db
      .all<MessageRow>(
        `SELECT * FROM messages WHERE group_id = ? AND seq IS NOT NULL AND seq < ?
         ORDER BY seq DESC, id LIKE 'sys-%' DESC, row_id DESC LIMIT ?`,
        [groupId, upper, PAGE_SIZE + 1],
      )
      .reverse();
    const hasMore = rows.length > PAGE_SIZE;
    if (hasMore) {
      // A notice can share its number with the message before it. A page never
      // splits them, since the next page starts below that number.
      const cut = rows.shift()!.seq;
      while (rows[0]?.seq === cut) rows.shift();
    }
    const pendingRows =
      before === undefined
        ? this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND seq IS NULL ORDER BY created_at", [groupId])
        : [];
    const messages = [...rows, ...pendingRows].map((row) => this.toMessageView(row));
    void this.fetchMissingReplies(groupId, messages);
    return { messages, hasMore };
  }

  /** Loads the messages around a sequence number, for jumping to a reply or search hit. */
  async loadAround(groupId: string, seq: number): Promise<MessageView[]> {
    const remote = await this.api.messages(groupId, { around: seq, limit: PAGE_SIZE }).catch(() => []);
    for (const message of remote) this.ingest(message, false);
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE group_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?
       ) UNION SELECT * FROM (
         SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
       ) ORDER BY seq ASC`,
      [groupId, seq, PAGE_SIZE / 2 + 1, groupId, seq, PAGE_SIZE / 2],
    );
    return rows.map((row) => this.toMessageView(row));
  }

  /**
   * The page after a sequence number, oldest first, for reading on from a window around
   * a message jumped to. It asks the server too, as what lies between an old message and
   * the newest may never have come to this device. With no more after it, it's the newest
   * page, messages still being sent included, as `loadMessages` gives them.
   */
  async loadNewer(groupId: string, after: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    try {
      const remote = await this.api.messages(groupId, { after, limit: PAGE_SIZE });
      for (const message of remote) this.ingest(message, false);
    } catch (error) {
      console.warn("[zuna] couldn't fetch newer messages", error);
    }
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE group_id = ? AND seq IS NOT NULL AND seq > ?
       ORDER BY seq ASC, id LIKE 'sys-%' ASC, row_id ASC LIMIT ?`,
      [groupId, after, PAGE_SIZE + 1],
    );
    const hasMore = rows.length > PAGE_SIZE;
    if (hasMore) {
      // A notice can share its number with the message before it, so a page never splits them:
      // the next one starts after the last number left here.
      const cut = rows.pop()!.seq;
      while (rows.at(-1)?.seq === cut) rows.pop();
    }
    const pendingRows = hasMore
      ? []
      : this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND seq IS NULL ORDER BY created_at", [groupId]);
    const messages = [...rows, ...pendingRows].map((row) => this.toMessageView(row));
    void this.fetchMissingReplies(groupId, messages);
    return { messages, hasMore };
  }

  async messageById(groupId: string, id: string): Promise<MessageView | null> {
    let row = this.messageRow(groupId, id);
    if (!row) {
      try {
        this.ingest(await this.api.message(groupId, id), false);
      } catch {
        return null;
      }
      row = this.messageRow(groupId, id);
    }
    return row ? this.toMessageView(row) : null;
  }

  protected async fetchMissingReplies(groupId: string, messages: MessageView[]): Promise<void> {
    const missing = messages.filter((message) => message.reply && !message.reply.senderId && !message.reply.deleted && !this.unreachableReplies.has(`${groupId}/${message.reply.id}`));
    await eachLimited(missing, 4, async (message) => {
      const target = message.reply!.id;
      try {
        this.ingest(await this.api.message(groupId, target), false);
        const row = this.messageRow(groupId, message.id);
        if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
      } catch (error) {
        // Not visible to this member, for example sent before they joined, or gone: that won't change.
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) this.unreachableReplies.add(`${groupId}/${target}`);
      }
    });
  }

  async loadPins(groupId: string): Promise<MessageView[]> {
    try {
      for (const message of await this.api.pins(groupId)) this.ingest(message, false);
    } catch (error) {
      console.warn("[zuna] couldn't fetch pins", error);
    }
    return this.db
      .all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC", [groupId])
      .map((row) => this.toMessageView(row));
  }

  search(query: string, groupId?: string, limit = 50): SearchResult[] {
    const match = queryTokens(this.searchKey, query);
    if (!match) return [];
    const params: SqlValue[] = [match];
    let filter = "";
    if (groupId) {
      filter = " AND m.group_id = ?";
      params.push(groupId);
    }
    params.push(limit);
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM search s JOIN messages m ON m.row_id = s.rowid
       WHERE search MATCH ? AND m.deleted_at IS NULL${filter}
       ORDER BY m.created_at DESC LIMIT ?`,
      params,
    );
    return rows.map((row) => {
      const group = this.groups.get(row.group_id);
      return { message: this.toMessageView(row), conversationKey: group ? this.conversationKey(group) : "" };
    });
  }

  /** How much of a group's history is indexed locally. Used to explain partial search results. */
  searchCoverage(): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const group of this.groups.values()) {
      total += group.seq;
      done += Math.min(this.syncedSeq(group.id), group.seq);
    }
    return { done, total };
  }

  /** How many photos, files, links and so on a chat holds, among its messages on this device. */
  mediaCounts(groupId: string): MediaCounts {
    const counts = Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, 0])) as MediaCounts;
    const rows = this.db.all<{ kind: string; count: number }>(
      `SELECT d.kind, SUM(d.count) AS count FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND m.deleted_at IS NULL AND m.status = 'sent' GROUP BY d.kind`,
      [groupId],
    );
    for (const row of rows) {
      const kind = MEDIA_KINDS.find((item) => this.mediaTags.get(item) === row.kind);
      if (kind) counts[kind] = Number(row.count);
    }
    return counts;
  }

  /** A page of a chat's messages that hold one kind, newest first, from those on this device. */
  loadMedia(groupId: string, kind: MediaKind, before?: number, limit = PAGE_SIZE): { messages: MessageView[]; hasMore: boolean } {
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND d.kind = ? AND m.deleted_at IS NULL AND m.status = 'sent' AND m.seq < ?
       ORDER BY m.seq DESC LIMIT ?`,
      [groupId, this.mediaTags.get(kind) ?? "", before ?? Number.MAX_SAFE_INTEGER, limit + 1],
    );
    return { messages: rows.slice(0, limit).map((row) => this.toMessageView(row)), hasMore: rows.length > limit };
  }
}
