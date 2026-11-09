// ServerSession, in part (see base.ts): taking in messages, letting them disappear, and indexing them for search.

import { ApiError, decode, type ApiMessage, type ApiReaction } from "../api";
import { namesItsSender, openEnvelope, randomId, readSigned } from "../crypto";
import { equalBytes, toBase64 } from "../encoding";
import { mediaIn } from "../media";
import { notificationDelay, notificationText, previewText } from "../notify";
import { SEARCH_INDEX_VERSION, indexTokens } from "../search";
import { couldBeSent, sealedRows } from "../sendable";
import { MAX_EXPIRES_IN, parseMessageBody, parseReaction } from "../validate";
import type { CoreEvent, MessageBody, MessageStatus, MessageView, ReactionView, ReplyPreview, SystemEvent } from "../types";
import { onlyMentionsNotify } from "../types";
import {
  REMOVED_KEPT_MS,
  TIME_DIFFERS_MS,
  EARLIER_LOOKED_FOR_MS,
  EARLIER_LOOK_DELAY_MS,
  SEARCH_REBUILD_BATCH,
  LONGEST_WAIT_MS,
  type CachedGroup,
  type MessageRow,
  type StoredBody,
  validApiMessage,
  readStoredBody,
  expiryOf,
} from "./shared";
import { SessionChanges } from "./changes";

export abstract class SessionIngest extends SessionChanges {
  // --- Ingesting messages ---

  protected messageRow(groupId: string, id: string): MessageRow | undefined {
    return this.db.get<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND id = ?", [groupId, id]);
  }

  /** What a reaction is, if it's what it says: the signature says whose it is, and the authenticated data which message it's on. */
  protected openReaction(groupId: string, messageId: string, reaction: ApiReaction): ReturnType<typeof parseReaction> {
    const key = this.epochKey(groupId, reaction.epoch);
    if (!key) return null;
    const signed = readSigned(decode(reaction.data));
    const device = signed && this.users.get(reaction.user_id)?.devices.get(signed.deviceId);
    if (!signed || !device || signed.epoch !== reaction.epoch) return null;
    const opened = openEnvelope<{ id?: unknown }>(key, device.signatureKey, "reaction", groupId, messageId, reaction.epoch, signed.envelope, { userId: reaction.user_id, deviceId: signed.deviceId });
    return opened.ok && opened.value?.id === reaction.id ? parseReaction(opened.value) : null;
  }

  protected openReactions(groupId: string, messageId: string, raw: ApiReaction[]): ReactionView[] {
    const grouped = new Map<string, ReactionView>();
    for (const reaction of raw) {
      const opened = this.openReaction(groupId, messageId, reaction);
      if (!opened) continue;
      const entry = grouped.get(opened.key) ?? { key: opened.key, emote: opened.emote, userIds: [] };
      if (!entry.userIds.includes(reaction.user_id)) entry.userIds.push(reaction.user_id);
      grouped.set(opened.key, entry);
    }
    return [...grouped.values()];
  }

  /**
   * Whether a message would be stored as it is with what this device holds now: there, opening,
   * from a device it knows, and one that could have been sent then. One that isn't is left for
   * when the keys and people it may depend on have been caught up on (`catchUpFirst`).
   */
  protected readableNow(message: ApiMessage): boolean {
    if (!validApiMessage(message) || message.deleted_at !== null || !message.envelope || !this.couldBeSent(message)) return false;
    const key = this.epochKey(message.group_id, message.epoch);
    const device = this.users.get(message.sender_user)?.devices.get(message.sender_device);
    if (!key || !device) return false;
    const opened = openEnvelope<unknown>(key, device.signatureKey, "message", message.group_id, message.id, message.epoch, decode(message.envelope), { userId: message.sender_user, deviceId: message.sender_device });
    return opened.ok && namesItsSender(opened.value, message.sender_user, message.sender_device) && parseMessageBody(opened.value) !== null;
  }

  /** Stores a message's current state, decrypting it if the keys are available. */
  protected ingest(message: ApiMessage, live: boolean): void {
    if (!validApiMessage(message)) {
      console.warn("[zuna] the server sent something that isn't a message");
      return;
    }
    // A disappearing message that went from here stays gone, whatever the server sends.
    if (this.hasExpired(message.group_id, message.id)) return;
    const existing = this.messageRow(message.group_id, message.id);
    // A pin or unpin this device couldn't check yet, such as one under keys it didn't have then, is looked at again.
    const pinUnsettled = !!existing && (existing.pinned_at === null) !== (message.pinned_at === null);
    if (existing && existing.updated_seq >= message.updated_seq && existing.status !== "undecryptable" && existing.status !== "unverified" && !pinUnsettled) {
      return;
    }
    // A message's author never changes. A signature only proves who signed what's arriving now.
    if (existing && existing.sender_user !== message.sender_user) {
      this.warnOnce(`author/${message.group_id}/${message.id}`, "The server tried to change who wrote a message in one of your conversations. The message was left as it was.");
      return;
    }
    let status: MessageStatus = "sent";
    let body: StoredBody | null = null;
    let raw: Uint8Array | null = null;
    // Nothing local is erased on the server's word: only a deletion its author, or a
    // group's admin, signed does that. Otherwise the copy is hidden, and kept a while.
    const kept = message.deleted_at !== null && existing && (existing.body || existing.raw) && !this.deletionProven(message) ? existing : null;
    let heldAfterLeaving: Uint8Array | null = null;
    // A later edit this device holds, kept with how it arrived when the server sends an earlier one.
    let laterEdit: MessageRow | null = null;
    if (!message.deleted_at && message.envelope) {
      const envelope = decode(message.envelope);
      const key = this.epochKey(message.group_id, message.epoch);
      const device = this.users.get(message.sender_user)?.devices.get(message.sender_device);
      if (!this.couldBeSent(message)) {
        status = "unverified";
        raw = envelope;
      } else if (!key || !device) {
        status = "undecryptable";
        raw = envelope;
      } else {
        const opened = openEnvelope<unknown>(key, device.signatureKey, "message", message.group_id, message.id, message.epoch, envelope, { userId: message.sender_user, deviceId: message.sender_device });
        if (opened.ok && !namesItsSender(opened.value, message.sender_user, message.sender_device)) {
          status = "unverified";
          raw = envelope;
        } else if (opened.ok) {
          this.keyProvedItself(message.group_id, message.epoch);
          const parsed = parseMessageBody(opened.value);
          if (parsed && this.changedAfterLeaving(message, existing, parsed)) {
            status = "unverified";
            raw = envelope;
            heldAfterLeaving = existing!.body;
          } else if (parsed && existing && this.editedSince(existing, parsed)) {
            laterEdit = existing;
            body = this.storedBody(existing)!;
          } else if (parsed) {
            body = parsed;
          } else {
            status = "invalid";
            raw = envelope;
          }
        } else if (opened.reason === "signature") {
          status = "unverified";
          raw = envelope;
        } else {
          status = "undecryptable";
          raw = envelope;
        }
      }
    }
    // What's sealed, kept as it is too, so the event needn't open it again.
    const storedValue: StoredBody | null = body ? { ...body, reactions: this.openReactions(message.group_id, message.id, message.reactions) } : null;
    const stored = storedValue ? this.sealJson("message", `${message.group_id}/${message.id}`, storedValue) : (kept?.body ?? heldAfterLeaving);
    // A message that didn't open keeps its reactions as they came, to be read once it does.
    const rawReactions = body ? null : kept ? kept.raw_reactions : raw ? this.sealJson("message_reactions", `${message.group_id}/${message.id}`, message.reactions) : null;
    const pin = this.pinState(message, existing);
    // When it was first seen to go is when it goes: an edit can't make it last longer.
    const expiresAt = existing?.expires_at ?? (body ? expiryOf(message.created_at, body) : null);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      this.eraseExpired(message.group_id, message.id);
      return;
    }
    // One that still doesn't open, and nothing newer came for, is left as it is, unannounced.
    if (
      existing &&
      !body &&
      !kept &&
      !pinUnsettled &&
      existing.updated_seq >= message.updated_seq &&
      status === existing.status &&
      stored === existing.body &&
      !!raw &&
      !!existing.raw &&
      equalBytes(raw, existing.raw)
    ) {
      return;
    }

    let row!: MessageRow;
    const isNew = !existing || existing.seq === null;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, edited_at, deleted_at, pinned_at, pinned_by, pin_revision, status, body, raw, raw_reactions, unproven_delete_at, expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_id, id) DO UPDATE SET seq = excluded.seq, updated_seq = excluded.updated_seq, sender_device = excluded.sender_device,
           epoch = excluded.epoch, created_at = excluded.created_at, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at,
           pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by, pin_revision = excluded.pin_revision, status = excluded.status, body = excluded.body, raw = excluded.raw,
           raw_reactions = excluded.raw_reactions, unproven_delete_at = excluded.unproven_delete_at, expires_at = excluded.expires_at`,
        [
          message.group_id,
          message.id,
          message.seq,
          message.updated_seq,
          message.sender_user,
          laterEdit ? laterEdit.sender_device : message.sender_device,
          laterEdit ? laterEdit.epoch : message.epoch,
          message.created_at,
          laterEdit ? laterEdit.edited_at : message.edited_at,
          message.deleted_at,
          pin.at,
          pin.by,
          pin.revision,
          kept ? kept.status : status,
          stored,
          kept ? kept.raw : raw,
          rawReactions,
          kept ? (kept.unproven_delete_at ?? Date.now()) : null,
          expiresAt,
        ],
      );
      // Read once, for its row ID here and for the event after.
      row = this.messageRow(message.group_id, message.id)!;
      const rowId = row.row_id;
      this.db.run("DELETE FROM search WHERE rowid = ?", [rowId]);
      this.db.run("DELETE FROM media WHERE row_id = ?", [rowId]);
      if (body) this.indexMessage(rowId, message.group_id, body);
      this.db.run("UPDATE groups SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?", [message.created_at, message.group_id]);
    });

    const view = this.toMessageView(row, storedValue ? readStoredBody(row, storedValue) : undefined);
    this.emit({ type: "message", serverId: this.serverId, message: view, isNew: live && isNew });
    if (expiresAt !== null && expiresAt < this.nextExpiry) this.expireMessages();
    // The first message in a new chat often beats its welcome, and only opens once that's in.
    const ref = `${message.group_id}/${message.id}`;
    if (live && isNew && status !== "sent") this.awaitingKeys.add(ref);
    const fresh = live ? isNew : status === "sent" && this.awaitingKeys.delete(ref);
    if (fresh && status === "sent" && message.sender_user !== this.account.userId) this.maybeNotify(view);
    if (body?.after) this.lookForEarlier(message, body);
  }

  /**
   * A message names the one its device sent before it here, so if that one never
   * arrived, the server may be holding it back. It's asked for, and if the server
   * says there's no such message, the person is told. Only for one sent while this
   * device was in the conversation, and recently, so it can't have expired.
   */
  protected lookForEarlier(message: ApiMessage, body: MessageBody): void {
    const after = body.after!;
    if (this.messageRow(message.group_id, after.id) || this.hasExpired(message.group_id, after.id)) return;
    // One that disappeared before it could arrive is simply gone.
    if (after.expiresIn !== undefined && after.at + after.expiresIn * 1000 <= Date.now() + EARLIER_LOOK_DELAY_MS) return;
    const joined = this.joinedEpoch(message.group_id);
    if (joined === null || after.epoch < joined || body.sentAt === undefined) return;
    if (message.created_at < Date.now() - EARLIER_LOOKED_FOR_MS || body.sentAt - after.at > EARLIER_LOOKED_FOR_MS) return;
    this.missing.set(`${message.group_id}/${after.id}`, { groupId: message.group_id, id: after.id, userId: message.sender_user });
    clearTimeout(this.missingTimer);
    this.missingTimer = setTimeout(() => void this.findMissing(), EARLIER_LOOK_DELAY_MS);
  }

  /** Looks for the messages later ones named, once caught up with their conversations. */
  protected async findMissing(): Promise<void> {
    const missing = [...this.missing.values()].filter((item) => !this.messageRow(item.groupId, item.id));
    this.missing.clear();
    for (const groupId of new Set(missing.map((item) => item.groupId))) {
      await this.syncGroup(groupId).catch(() => undefined);
    }
    for (const item of missing) {
      const group = this.groups.get(item.groupId);
      if (this.stopped || !group || group.removedAt || group.doubtful || this.messageRow(item.groupId, item.id)) continue;
      try {
        this.ingest(await this.api.message(item.groupId, item.id), false);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) continue;
        const name = this.users.get(item.userId)?.profile.displayName || "Someone";
        this.warnOnce(
          `held-back/${item.groupId}/${item.id}`,
          `${name}'s app says they sent a message in one of your conversations that never reached you, and the server says there's no such message.`,
          item.userId,
        );
      }
    }
  }

  /**
   * Only the server enforces that content is sent under the current epoch, so a
   * malicious server working with someone removed could slip in new-looking
   * messages under an old key. This catches a message from a device in an epoch
   * after it left, or before it came, and one that came after a later epoch had already begun. Genuinely
   * old messages are unaffected: they fit the order the group's commits came in.
   */
  protected couldBeSent(message: ApiMessage): boolean {
    const { group_id: groupId, sender_user: userId, sender_device: deviceId } = message;
    return couldBeSent(
      {
        left: () => this.departedAt(groupId, userId, deviceId),
        joined: () => this.joinedEpoch(groupId),
        arrived: () => this.arrivedAt(groupId, userId, deviceId),
        nextStart: () => {
          const next = this.db.get<{ seq: Uint8Array }>("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [groupId, message.epoch + 1]);
          const { name, row, careful } = sealedRows.epochStart;
          return next ? this.openValue(name, row(groupId, message.epoch + 1), next.seq, careful) : null;
        },
      },
      message,
    );
  }

  /**
   * Whether this device holds a later edit than what's arriving. The server can
   * send any version its author signed, so it could bring back what an edit
   * replaced, but not on a device that has seen the edit.
   */
  protected editedSince(existing: MessageRow, parsed: MessageBody): boolean {
    if (existing.status !== "sent" || existing.seq === null || !existing.body) return false;
    return (parsed.revision ?? 0) < (this.storedBody(existing)?.revision ?? 0);
  }

  /**
   * Whether this changes what a message says, from a device this one already saw
   * leave the group. An edit keeps the message's place, so it gets past couldBeSent
   * when sealed under a key from before the device left, which it still holds. An
   * honest server refuses that, so it can only be one made before it left that's
   * arriving late, or one made after with the server's help, and this can't tell.
   * The copy held stays, so trying again later still finds the change.
   */
  protected changedAfterLeaving(message: ApiMessage, existing: MessageRow | undefined, parsed: MessageBody): boolean {
    if (!existing?.body || existing.seq === null || this.departedAt(message.group_id, message.sender_user, message.sender_device) === null) return false;
    const held = parseMessageBody(this.openJson<StoredBody>("message", `${existing.group_id}/${existing.id}`, existing.body));
    return !!held && JSON.stringify(held) !== JSON.stringify(parsed);
  }

  /**
   * Whether a message is pinned, when and by whom, as a member's device signed it,
   * under an epoch from before that device left. The server's word alone changes
   * nothing, and a pin or unpin only replaces one this device holds if it's later.
   */
  protected pinState(message: ApiMessage, existing: MessageRow | undefined): { at: number | null; by: string | null; revision: number | null } {
    const none = { at: null, by: null, revision: null };
    if (message.deleted_at !== null) return none;
    const held = existing ? { at: existing.pinned_at, by: existing.pinned_by, revision: existing.pin_revision } : none;
    const signed = this.openPin(message);
    if (signed && signed.revision >= (held.revision ?? 0)) {
      return signed.pinned ? { at: signed.revision, by: signed.by, revision: signed.revision } : { ...none, revision: signed.revision };
    }
    return held.revision === null ? none : held;
  }

  protected openPin(message: ApiMessage): { by: string; pinned: boolean; revision: number } | null {
    if (!message.pin || !message.pin_by) return null;
    const signed = readSigned(decode(message.pin));
    if (!signed) return null;
    const key = this.epochKey(message.group_id, signed.epoch);
    const device = this.users.get(message.pin_by)?.devices.get(signed.deviceId);
    if (!key || !device) return null;
    const left = this.departedAt(message.group_id, message.pin_by, signed.deviceId);
    if (left !== null && signed.epoch >= left) return null;
    const opened = openEnvelope<{ by?: unknown; pinned?: unknown; revision?: unknown }>(key, device.signatureKey, "pin", message.group_id, message.id, signed.epoch, signed.envelope, { userId: message.pin_by, deviceId: signed.deviceId });
    if (!opened.ok || opened.value?.by !== message.pin_by || typeof opened.value.pinned !== "boolean") return null;
    const { revision } = opened.value;
    return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? { by: message.pin_by, pinned: opened.value.pinned, revision } : null;
  }

  /**
   * Whether a deletion is what its author, or in a group one of its admins, asked
   * for: their device signed it, under an epoch from before that device left.
   * Who's an admin is the server's word, as it is for history grants.
   */
  protected deletionProven(message: ApiMessage): boolean {
    if (!message.deletion || !message.deleted_by) return false;
    const signed = readSigned(decode(message.deletion));
    if (!signed) return false;
    const key = this.epochKey(message.group_id, signed.epoch);
    const device = this.users.get(message.deleted_by)?.devices.get(signed.deviceId);
    if (!key || !device) return false;
    const left = this.departedAt(message.group_id, message.deleted_by, signed.deviceId);
    if (left !== null && signed.epoch >= left) return false;
    const opened = openEnvelope<{ by?: unknown }>(key, device.signatureKey, "deletion", message.group_id, message.id, signed.epoch, signed.envelope, { userId: message.deleted_by, deviceId: signed.deviceId });
    if (!opened.ok || opened.value?.by !== message.deleted_by) return false;
    if (message.deleted_by === message.sender_user) return true;
    const group = this.groups.get(message.group_id);
    return !!group && group.kind !== "dm" && this.isGroupAdmin(group, message.deleted_by);
  }

  /** A copy kept after a deletion nobody proved goes once that's long enough ago. */
  protected forgetUnprovenDeletions(): void {
    this.db.run("UPDATE messages SET body = NULL, raw = NULL, unproven_delete_at = NULL WHERE unproven_delete_at < ?", [Date.now() - REMOVED_KEPT_MS]);
  }

  // --- Disappearing messages ---

  /**
   * The IDs of disappearing messages that went from here are kept so that none comes back, but
   * not for ever: once longer ago than a message can last, and a month more, any copy that
   * arrived would have run out by its own signed time and go at once anyway.
   */
  protected forgetLongExpired(): void {
    this.db.run("DELETE FROM expired WHERE at < ?", [Date.now() - MAX_EXPIRES_IN * 1000 - 30 * 24 * 3600 * 1000]);
  }

  protected hasExpired(groupId: string, id: string): boolean {
    return !!this.db.get("SELECT 1 FROM expired WHERE group_id = ? AND id = ?", [groupId, id]);
  }

  /**
   * Erases a disappearing message from this device: its row, and what the search
   * and the chat's details know of it. Only its ID stays, so it can't come back.
   */
  protected eraseExpired(groupId: string, id: string): void {
    const row = this.db.get<{ row_id: number }>("SELECT row_id FROM messages WHERE group_id = ? AND id = ?", [groupId, id]);
    this.db.transaction(() => {
      if (row) {
        this.db.run("DELETE FROM search WHERE rowid = ?", [row.row_id]);
        this.db.run("DELETE FROM media WHERE row_id = ?", [row.row_id]);
        this.db.run("DELETE FROM messages WHERE row_id = ?", [row.row_id]);
      }
      this.db.run("INSERT OR IGNORE INTO expired(group_id, id, at) VALUES(?, ?, ?)", [groupId, id, Date.now()]);
    });
    if (row) this.emit({ type: "message_removed", serverId: this.serverId, groupId, id });
  }

  /** Erases the disappearing messages that are due, and waits for the next. */
  protected expireMessages(): void {
    clearTimeout(this.expiryTimer);
    this.nextExpiry = Infinity;
    const now = Date.now();
    const due = this.db.all<{ group_id: string; id: string }>("SELECT group_id, id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
    for (const row of due) this.eraseExpired(row.group_id, row.id);
    if (due.length > 0) this.emitConversations();
    const next = this.db.get<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM messages WHERE expires_at IS NOT NULL")?.at ?? null;
    if (next === null || this.stopped) return;
    this.nextExpiry = next;
    this.expiryTimer = setTimeout(() => this.expireMessages(), Math.min(next - now + 50, LONGEST_WAIT_MS));
  }

  /** How long messages sent to a group now last, in seconds, or 0. */
  protected disappearAfter(group: CachedGroup | undefined): number {
    return group?.meta.disappearAfter ?? 0;
  }

  /**
   * Sets how long messages sent to a chat from now on last, in seconds, or 0 for
   * as long as they're kept. In a group only its admins may, and in a direct
   * message either person. It's signed with the chat's details, so nobody else's
   * word changes it, and the messages already sent keep the time they had.
   */
  async setDisappearing(groupId: string, seconds: number): Promise<void> {
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_EXPIRES_IN) throw new Error("Messages can't be set to last that long.");
    const group = this.groups.get(groupId);
    if (!group || group.removedAt) throw new Error("This chat can't be changed right now.");
    if (this.disappearAfter(group) === seconds) return;
    await this.updateGroupMeta(groupId, { disappearAfter: seconds });
  }

  /** A line in the chat saying who changed how long messages last, and to what. */
  protected noteTimerChange(groupId: string, actorId: string, seconds: number): void {
    this.addSystemRow(groupId, Date.now(), actorId, { type: "timer_changed", actorId, seconds });
  }

  protected retryUndecryptable(groupId: string): void {
    const rows = this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND status IN ('undecryptable','unverified')", [groupId]);
    for (const row of rows) {
      if (!row.raw) continue;
      // Without its epoch's key or its sender's device it can only fail again.
      if (!this.epochKey(groupId, row.epoch) || !this.users.get(row.sender_user)?.devices.has(row.sender_device)) continue;
      this.ingest(
        {
          group_id: row.group_id,
          id: row.id,
          seq: row.seq ?? 0,
          updated_seq: row.updated_seq,
          sender_user: row.sender_user,
          sender_device: row.sender_device,
          epoch: row.epoch,
          envelope: toBase64(row.raw),
          created_at: row.created_at,
          edited_at: row.edited_at,
          deleted_at: row.deleted_at,
          pinned_at: row.pinned_at,
          pinned_by: row.pinned_by ?? undefined,
          reactions: this.rawReactionsOf(row),
        },
        false,
      );
    }
    const group = this.groups.get(groupId);
    if (group) {
      this.refreshGroupSecrets(group);
      this.persistGroup(group);
    }
  }

  protected rawReactionsOf(row: MessageRow): ApiReaction[] {
    if (!row.raw_reactions) return [];
    try {
      const reactions = this.openJson<unknown>("message_reactions", `${row.group_id}/${row.id}`, row.raw_reactions);
      return Array.isArray(reactions) ? (reactions as ApiReaction[]) : [];
    } catch {
      return [];
    }
  }

  protected addSystemRow(groupId: string, createdAt: number, actor: string, system: SystemEvent, seq?: number): void {
    const id = seq !== undefined ? `sys-${seq}` : `sys-${randomId()}`;
    if (!this.groups.has(groupId) || this.messageRow(groupId, id)) return;
    // A notice only this device knows about goes after everything seen so far.
    // Having no sequence number means a message is still being sent.
    this.db.run(
      `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, created_at, status, body) VALUES(?,?,?,?,?,?,?,?)`,
      [groupId, id, seq ?? this.latestSeq(groupId), seq ?? 0, actor, createdAt, "sent", this.sealJson("message", `${groupId}/${id}`, { system })],
    );
    this.emit({
      type: "message",
      serverId: this.serverId,
      message: this.toMessageView(this.messageRow(groupId, id)!),
      isNew: false,
    });
  }

  protected latestSeq(groupId: string): number {
    const newest = this.db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM messages WHERE group_id = ?", [groupId])?.seq ?? 0;
    return Math.max(newest, this.groups.get(groupId)?.seq ?? 0);
  }

  protected maybeNotify(view: MessageView): void {
    const notification = this.notification(view);
    if (!notification) return;
    // As in Telegram, a notification waits while the person is on another device,
    // and doesn't show if they read the chat there, or here, meanwhile.
    const delay = notificationDelay({
      here: this.active,
      leftHereAt: this.leftHereAt,
      elsewhereNow: this.activeElsewhere,
      usedElsewhereAt: this.usedElsewhereAt,
    });
    if (delay === 0) {
      this.emit(notification);
      return;
    }
    const timer = setTimeout(() => {
      this.waitingNotifications.delete(timer);
      const row = this.messageRow(view.groupId, view.id);
      const ownRead = this.groups.get(view.groupId)?.ownRead ?? Infinity;
      if (!row || row.deleted_at !== null || row.seq === null || row.seq <= ownRead) return;
      // Muted or edited meanwhile, it's as it is now.
      const event = this.notification(this.toMessageView(row));
      if (event) this.emit(event);
    }, delay);
    this.waitingNotifications.add(timer);
  }

  /** The notification for a new message from someone else, or null if it shouldn't notify. */
  protected notification(view: MessageView): Extract<CoreEvent, { type: "notify" }> | null {
    const group = this.groups.get(view.groupId);
    if (!group) return null;
    if (this.isBlocked(view.senderId)) return null;
    const key = this.conversationKey(group);
    const self = this.account.userId;
    const mentioned = view.mentions.includes(self) || view.reply?.senderId === self;
    if (onlyMentionsNotify(this.prefs, key) && !mentioned) return null;
    // Everything said in a channel isn't for everyone in it, as in Discord: only what's said to them.
    if (group.kind === "channel" && !mentioned) return null;
    const sender = this.users.get(view.senderId);
    const senderName = sender?.profile.displayName || sender?.username || "Someone";
    const groupName = group.kind === "channel" ? `#${this.channels.get(group.id)?.details?.name ?? "channel"}` : group.meta.name;
    const { title, body } = notificationText(group.kind, groupName, senderName, view);
    return { type: "notify", serverId: this.serverId, title, body, conversationKey: key, groupId: view.groupId, messageId: view.id };
  }

  previewText(view: Pick<MessageView, "text" | "attachments"> & { location?: MessageView["location"] }): string {
    return previewText(view);
  }

  /** What a row holds, as far as it can be shown. Stored before these checks, it may be anything. */
  protected storedBody(row: MessageRow): StoredBody | null {
    return row.body ? readStoredBody(row, this.openJson<StoredBody>("message", `${row.group_id}/${row.id}`, row.body)) : {};
  }

  /** `opened`, when given, is what the row's body holds, already open, as when it was just sealed. */
  protected toMessageView(row: MessageRow, opened?: StoredBody | null): MessageView {
    // A copy kept after a deletion the server claimed stays out of sight.
    const stored = row.deleted_at === null ? (opened !== undefined ? opened : this.storedBody(row)) : {};
    const body: StoredBody = stored ?? {};
    const view: MessageView = {
      id: row.id,
      groupId: row.group_id,
      seq: row.seq,
      senderId: row.sender_user,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      pinnedAt: row.pinned_at,
      pinnedBy: row.pinned_by,
      status: stored ? row.status : "invalid",
      text: body.text ?? "",
      emotes: body.emotes ?? {},
      attachments: body.attachments ?? [],
      mentions: body.mentions ?? [],
      reply: body.replyTo ? this.replyPreview(row.group_id, body.replyTo) : null,
      reactions: body.reactions ?? [],
      system: body.system ?? null,
      preview: body.preview ?? null,
      forwarded: body.forwarded ?? null,
      location: body.location ?? null,
      expiresAt: row.expires_at,
    };
    if (body.sentAt !== undefined && Math.abs(body.sentAt - (row.edited_at ?? row.created_at)) > TIME_DIFFERS_MS) view.timeDiffers = true;
    return view;
  }

  protected replyPreview(groupId: string, id: string): ReplyPreview {
    const row = this.messageRow(groupId, id);
    if (!row) return { id, senderId: "", text: "", hasAttachment: false, deleted: this.hasExpired(groupId, id) };
    if (!row.body || row.deleted_at !== null) return { id, senderId: row.sender_user, text: "", hasAttachment: false, deleted: row.deleted_at !== null };
    const body = this.storedBody(row);
    return {
      id,
      senderId: row.sender_user,
      text: body?.text?.slice(0, 200) || (body?.location ? "📍 Location" : ""),
      hasAttachment: (body?.attachments?.length ?? 0) > 0,
      deleted: false,
    };
  }

  // --- Search index ---

  /** Builds the search index again after the way it's hashed changed, a little at a time. */
  protected async rebuildSearchIndex(): Promise<void> {
    if (this.getKv<number>("search_version") === SEARCH_INDEX_VERSION) return;
    try {
      this.db.run("DELETE FROM search");
      this.db.run("DELETE FROM media");
      let after = 0;
      for (;;) {
        const rows = this.db.all<MessageRow>("SELECT * FROM messages WHERE row_id > ? AND body IS NOT NULL ORDER BY row_id LIMIT ?", [after, SEARCH_REBUILD_BATCH]);
        if (rows.length === 0) break;
        this.db.transaction(() => {
          for (const row of rows) {
            after = row.row_id;
            // One message that won't open is left out, rather than leaving search empty, again at every start.
            try {
              const body = this.storedBody(row);
              if (body) this.indexMessage(row.row_id, row.group_id, body);
            } catch (error) {
              console.warn("[zuna] a message couldn't be indexed", error);
            }
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.setKv("search_version", SEARCH_INDEX_VERSION);
    } catch (error) {
      console.warn("[zuna] rebuilding the search index", error);
    }
  }

  /**
   * Indexes a message's words for search, and what it holds for its chat's details.
   * The rebuild can reach a message ingested while it ran, so either may come second.
   */
  protected indexMessage(rowId: number, groupId: string, body: MessageBody): void {
    const words = [body.text ?? "", ...(body.attachments ?? []).map((item) => item.name)].join(" ");
    const tokens = indexTokens(this.searchKey, words);
    if (tokens) this.db.run("INSERT OR REPLACE INTO search(rowid, tokens) VALUES(?, ?)", [rowId, tokens]);
    for (const [kind, count] of mediaIn(body)) {
      this.db.run("INSERT OR REPLACE INTO media(row_id, group_id, kind, count) VALUES(?, ?, ?, ?)", [rowId, groupId, this.mediaTags.get(kind)!, count]);
    }
    if (this.mentionsSelf(groupId, body)) {
      this.db.run("INSERT OR REPLACE INTO media(row_id, group_id, kind, count) VALUES(?, ?, ?, 1)", [rowId, groupId, this.mentionTag]);
    }
  }

  /** Whether a message mentions this account, or replies to one of its messages, as far as this device knows. */
  protected mentionsSelf(groupId: string, body: MessageBody): boolean {
    const self = this.account.userId;
    if (body.mentions?.includes(self)) return true;
    return !!body.replyTo && this.messageRow(groupId, body.replyTo)?.sender_user === self;
  }
}
