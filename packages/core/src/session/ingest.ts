// ServerSession, in part (see base.ts): taking in messages, letting them disappear, and indexing them for search.

import { ApiError, decode, type ApiMessage, type ApiPinChange, type ApiReaction, type ApiReactionChange } from "../api";
import { checkEnvelope, namesItsSender, randomId, readSigned, type CheckedEnvelope, type Signer } from "../crypto";
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
  KEY_UNPROVEN,
  MAX_REACTIONS_BY_PERSON,
  SLOW_MODE_MARGIN_MS,
  slowModeOf,
  type CachedGroup,
  type MessageRow,
  type StoredBody,
  type SeenReaction,
  validApiMessage,
  validReactionChange,
  readStoredBody,
  expiryOf,
} from "./shared";
import { SessionChanges } from "./changes";

/** A message kept out of every chat (`withhold`), as it came, with whom it named if anyone. */
interface Withheld {
  message: ApiMessage;
  signer: Signer | null;
}

export abstract class SessionIngest extends SessionChanges {
  // --- Ingesting messages ---

  protected messageRow(groupId: string, id: string): MessageRow | undefined {
    return this.db.get<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND id = ?", [groupId, id]);
  }

  /**
   * Reactions as they came, opened where they can be: the signature inside says whose each is, and
   * the authenticated data which message it's on. The server isn't told whose. `waiting` are those
   * this device can't open yet: under an epoch it holds no key for, as when one comes in live before
   * the commit that made its epoch, or signed by a device it doesn't know yet (`unknown`). `junk` are
   * those that open for nobody, under a key MLS gave, which a group's admin has the server drop.
   */
  protected readReactions(groupId: string, messageId: string, raw: ApiReaction[]): { seen: SeenReaction[]; waiting: ApiReaction[]; junk: string[]; unknown: Signer[] } {
    const seen: SeenReaction[] = [];
    const waiting: ApiReaction[] = [];
    const junk: string[] = [];
    const unknown: Signer[] = [];
    for (const reaction of raw) {
      const key = this.epochKey(groupId, reaction.epoch);
      if (!key) {
        waiting.push(reaction);
        continue;
      }
      const signed = readSigned(decode(reaction.data));
      const checked = signed && signed.epoch === reaction.epoch ? checkEnvelope<{ id?: unknown }>(key, "reaction", groupId, messageId, reaction.epoch, signed.envelope, (signer) => this.deviceKey(signer)) : null;
      if (checked?.state === "unknown") {
        waiting.push(reaction);
        unknown.push(checked.signer);
        continue;
      }
      // A copy of someone's real one under an ID of its own opens too, and is nobody's.
      const parsed = checked?.state === "signed" && checked.value?.id === reaction.id ? parseReaction(checked.value) : null;
      if (checked?.state === "signed" && parsed) {
        const own = checked.signer.userId === this.account.userId && reaction.item_key;
        seen.push({ id: reaction.id, user: checked.signer.userId, key: parsed.key, ...(parsed.emote ? { emote: parsed.emote } : {}), ...(own ? { item: reaction.item_key } : {}) });
      } else if (!this.keyUnproven(groupId, reaction.epoch)) {
        junk.push(reaction.id);
      }
    }
    return { seen, waiting, junk, unknown };
  }

  /**
   * What's shown of a message's reactions, by what they are, and this account's own with their item keys.
   * Beyond the most one person may add, the server can't refuse someone's, as it can't tell whose they
   * are, so a changed app's extra ones are left out here, in the order they came.
   */
  protected viewsOf(seen: SeenReaction[]): { reactions: ReactionView[]; mine: NonNullable<StoredBody["mine"]> } {
    const grouped = new Map<string, ReactionView>();
    const counts = new Map<string, number>();
    const mine: NonNullable<StoredBody["mine"]> = [];
    for (const reaction of seen) {
      const count = (counts.get(reaction.user) ?? 0) + 1;
      counts.set(reaction.user, count);
      if (count > MAX_REACTIONS_BY_PERSON) continue;
      if (reaction.user === this.account.userId && reaction.item) mine.push({ id: reaction.id, key: reaction.key, item: reaction.item });
      const entry = grouped.get(reaction.key) ?? { key: reaction.key, emote: reaction.emote, userIds: [] };
      if (!entry.userIds.includes(reaction.user)) entry.userIds.push(reaction.user);
      grouped.set(reaction.key, entry);
    }
    return { reactions: [...grouped.values()], mine };
  }

  /** What's shown of reactions as they came, opening each. */
  protected openReactions(groupId: string, messageId: string, raw: ApiReaction[]): ReactionView[] {
    return this.viewsOf(this.readReactions(groupId, messageId, raw).seen).reactions;
  }

  /** Whatever reading reactions turned up besides what's shown: junk for an admin to clear, and devices to learn. */
  protected afterReadingReactions(groupId: string, messageId: string, read: { junk: string[]; unknown: Signer[] }): void {
    this.clearJunkReactions(groupId, messageId, read.junk);
    for (const signer of read.unknown) this.learnDevice(groupId, signer);
  }

  /**
   * A group's admin's app has the server drop reactions that open for nobody, as it would delete
   * someone else's message: nobody can take them back but whoever added them, whom nothing names,
   * and enough of them would close a message to anyone else's. It asks once for each.
   */
  protected clearJunkReactions(groupId: string, messageId: string, ids: string[]): void {
    const group = this.groups.get(groupId);
    if (ids.length === 0 || !group || group.kind === "dm" || group.removedAt || !this.isGroupAdmin(group, this.account.userId)) return;
    for (const id of ids) {
      const ref = `${groupId}/${messageId}/${id}`;
      if (this.clearedReactions.has(ref)) continue;
      this.clearedReactions.add(ref);
      void this.api
        .clearReaction(groupId, messageId, id)
        .then((change) => this.applyReactionChange(change))
        .catch((error) => console.warn("[zuna] clearing a reaction nobody can open", error));
    }
  }

  /**
   * One reaction added to a message, or taken back, as the server sends them: on its own, never
   * with the message and all its others. Only a change from after what's held changes anything,
   * so a copy that comes late, as the answer to this device's own request may, undoes nothing.
   */
  protected applyReactionChange(change: ApiReactionChange): void {
    if (!validReactionChange(change)) return;
    const row = this.messageRow(change.group_id, change.message_id);
    if (!row) return;
    const ref = `${change.group_id}/${change.message_id}`;
    const waiting = this.rawReactionsOf(row);
    if (!row.body || row.status !== "sent") {
      // Kept as they come, to be read once the message opens.
      if (!row.raw) return;
      const next = change.removed ? waiting.filter((item) => item.id !== change.removed) : waiting.some((item) => item.id === change.reaction!.id) ? waiting : [...waiting, change.reaction!];
      if (next !== waiting) this.db.run("UPDATE messages SET raw_reactions = ? WHERE row_id = ?", [next.length ? this.sealJson("message_reactions", ref, next) : null, row.row_id]);
      return;
    }
    const stored = this.storedBody(row);
    if (!stored || change.updated_seq <= (stored.reactionsAt ?? row.updated_seq)) return;
    if (!stored.seen && (stored.reactions?.length || waiting.length)) {
      // Kept before reactions came one at a time, with nothing to say whose each was: read whole once.
      this.refetchMessage(change.group_id, change.message_id);
      return;
    }
    let seen = stored.seen ?? [];
    let pending = waiting;
    if (change.removed) {
      seen = seen.filter((item) => item.id !== change.removed);
      pending = waiting.filter((item) => item.id !== change.removed);
    } else if (!seen.some((item) => item.id === change.reaction!.id) && !waiting.some((item) => item.id === change.reaction!.id)) {
      const read = this.readReactions(change.group_id, change.message_id, [change.reaction!]);
      seen = [...seen, ...read.seen];
      pending = [...waiting, ...read.waiting];
      this.afterReadingReactions(change.group_id, change.message_id, read);
    }
    this.storeReactions(row, stored, seen, pending, change.updated_seq);
  }

  /** Keeps what a message's reactions now are, and shows it. */
  protected storeReactions(row: MessageRow, stored: StoredBody, seen: SeenReaction[], waiting: ApiReaction[], at: number): void {
    const ref = `${row.group_id}/${row.id}`;
    const value: StoredBody = { ...stored, ...this.viewsOf(seen), seen, reactionsAt: at };
    if (!value.mine?.length) delete value.mine;
    this.db.run("UPDATE messages SET body = ?, raw_reactions = ? WHERE row_id = ?", [this.sealJson("message", ref, value), waiting.length ? this.sealJson("message_reactions", ref, waiting) : null, row.row_id]);
    const updated = this.messageRow(row.group_id, row.id)!;
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(updated, readStoredBody(updated, value)), isNew: false });
  }

  /** Reads again the reactions a group's messages kept for later, once keys or devices they wait on may be here. */
  protected retryWaitingReactions(groupId: string): void {
    const rows = this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND body IS NOT NULL AND raw_reactions IS NOT NULL AND status = 'sent'", [groupId]);
    for (const row of rows) {
      const stored = this.storedBody(row);
      if (!stored) continue;
      // One kept before reactions came one at a time kept all of them as they came, so all are read.
      const read = this.readReactions(groupId, row.id, this.rawReactionsOf(row));
      if (read.waiting.length === this.rawReactionsOf(row).length && read.junk.length === 0) continue;
      const held = (stored.seen ?? []).filter((item) => !read.seen.some((other) => other.id === item.id));
      this.storeReactions(row, stored, [...held, ...read.seen], read.waiting, stored.reactionsAt ?? row.updated_seq);
      this.clearJunkReactions(groupId, row.id, read.junk);
    }
  }

  /** A message fetched whole, as when a copy held can't take a change on its own. Once at a time for each. */
  protected refetchMessage(groupId: string, id: string): void {
    const ref = `${groupId}/${id}`;
    if (this.refetching.has(ref) || this.stopped) return;
    this.refetching.add(ref);
    void this.api
      .message(groupId, id)
      .then((message) => this.ingest(message, false))
      .catch(() => undefined)
      .finally(() => this.refetching.delete(ref));
  }

  /** A message pinned or unpinned, on its own, as a sealed request is answered: its signed pin decides, as when it comes whole. */
  protected applyPinChange(change: ApiPinChange): void {
    const row = this.messageRow(change.group_id, change.message_id);
    if (!row || row.deleted_at !== null) return;
    const pin = this.pinState({ group_id: change.group_id, id: change.message_id, deleted_at: null, pin: change.pin } as ApiMessage, row);
    if (pin.at === row.pinned_at && pin.by === row.pinned_by && pin.revision === row.pin_revision) return;
    this.db.run("UPDATE messages SET pinned_at = ?, pinned_by = ?, pin_revision = ? WHERE row_id = ?", [pin.at, pin.by, pin.revision, row.row_id]);
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(this.messageRow(row.group_id, row.id)!), isNew: false });
  }

  /**
   * Opens a message and checks who signed it. What it says it's from is also what its
   * body says, under the signature, and one where the two differ is nobody's.
   */
  protected checkMessage(message: ApiMessage, key: Uint8Array): CheckedEnvelope<unknown> {
    const checked = checkEnvelope<unknown>(key, "message", message.group_id, message.id, message.epoch, decode(message.envelope), (signer) => this.deviceKey(signer));
    if (checked.state === "signed" && !namesItsSender(checked.value, checked.signer.userId, checked.signer.deviceId)) return { state: "forged" };
    return checked;
  }

  /**
   * Whether a message would be stored as it is with what this device holds now: there, opening,
   * signed by a device it knows, and one that could have been sent then. One that isn't is left for
   * when the keys and people it may depend on have been caught up on (`catchUpFirst`).
   */
  protected readableNow(message: ApiMessage): boolean {
    if (!validApiMessage(message) || message.deleted_at !== null || !message.envelope) return false;
    const key = this.epochKey(message.group_id, message.epoch);
    const checked = key && this.checkMessage(message, key);
    return !!checked && checked.state === "signed" && this.couldBeSent(message, checked.signer) && parseMessageBody(checked.value) !== null;
  }

  /**
   * Whether a message in a channel with slow mode came sooner after its author's last one there
   * than the channel allows, less a margin for the network, by the server's times, which every
   * app sees alike. An honest app never sends one, as it holds its own person, so only a changed
   * app's extra messages are hidden, and tokens bound how many there can be. One whose author's
   * last this device doesn't hold shows: nobody is judged on what isn't there. Admins aren't held to it.
   */
  protected cameTooSoon(message: ApiMessage, author: string): boolean {
    const group = this.groups.get(message.group_id);
    if (group?.kind !== "channel") return false;
    const slowMode = slowModeOf(this.channels.get(group.id)?.api);
    if (slowMode === 0 || group.members.some((member) => member.userId === author && member.role === "admin")) return false;
    const before = this.db.get<{ created_at: number }>(
      "SELECT created_at FROM messages WHERE group_id = ? AND sender_user = ? AND seq IS NOT NULL AND seq < ? AND status = 'sent' ORDER BY seq DESC LIMIT 1",
      [group.id, author, message.seq],
    );
    return !!before && message.created_at - before.created_at < slowMode * 1000 - SLOW_MODE_MARGIN_MS;
  }

  /** Whether the key held for an epoch came from a grant and hasn't opened anything properly signed yet. */
  protected keyUnproven(groupId: string, epoch: number): boolean {
    return !!this.db.get("SELECT 1 FROM epoch_keys WHERE group_id = ? AND epoch = ? AND uploaded = ?", [groupId, epoch, KEY_UNPROVEN]);
  }

  /**
   * Stores a message's current state, decrypting it if the keys are available. Who wrote it
   * is whoever's device signed it, inside: the server isn't told. One that opens but names a
   * device this one doesn't know yet, or that nobody it names signed, goes nowhere (`withhold`).
   */
  protected ingest(message: ApiMessage, live: boolean): void {
    if (!validApiMessage(message)) {
      console.warn("[zuna] the server sent something that isn't a message");
      return;
    }
    // A disappearing message that went from here stays gone, whatever the server sends.
    if (this.hasExpired(message.group_id, message.id)) return;
    const withheld = this.db.get<{ updated_seq: number }>("SELECT updated_seq FROM withheld WHERE group_id = ? AND id = ?", [message.group_id, message.id]);
    if (withheld && withheld.updated_seq >= message.updated_seq) return;
    const existing = this.messageRow(message.group_id, message.id);
    // A pin or unpin this device couldn't check yet, such as one under keys it didn't have then, is looked at again.
    const pinUnsettled = !!existing && (existing.pinned_at === null) !== (message.pinned_at === null);
    // So is one whose reactions weren't all open to it, kept as they came (`readReactions`), as the key may be here now.
    const reactionsWaiting = !!existing?.body && !!existing.raw_reactions;
    if (existing && existing.updated_seq >= message.updated_seq && existing.status !== "undecryptable" && existing.status !== "unverified" && !pinUnsettled && !reactionsWaiting) {
      return;
    }
    // One this device never held, and nobody can read now, has nothing to show.
    if (message.deleted_at !== null && !existing) {
      if (withheld) this.db.run("DELETE FROM withheld WHERE group_id = ? AND id = ?", [message.group_id, message.id]);
      return;
    }
    // Who wrote it, as far as this device knows: whoever signed what it held, until something newer opens.
    let author: Signer | null = existing?.sender_user ? { userId: existing.sender_user, deviceId: existing.sender_device } : null;
    let status: MessageStatus = "sent";
    let body: StoredBody | null = null;
    let raw: Uint8Array | null = null;
    // Nothing local is erased on the server's word: only a deletion its author, or a
    // group's admin, signed does that. Otherwise the copy is hidden, and kept a while.
    const kept = message.deleted_at !== null && existing && (existing.body || existing.raw) && !this.deletionProven(message, existing) ? existing : null;
    let heldAfterLeaving: Uint8Array | null = null;
    // A later edit this device holds, kept with how it arrived when the server sends an earlier one.
    let laterEdit: MessageRow | null = null;
    if (!message.deleted_at && message.envelope) {
      const envelope = decode(message.envelope);
      let key = this.epochKey(message.group_id, message.epoch);
      let checked = key ? this.checkMessage(message, key) : null;
      if (checked?.state === "closed" && this.keyUnproven(message.group_id, message.epoch)) {
        // Another member may have handed on the key that opens it, where the one held came from someone who handed on a wrong one.
        const opens = (other: Uint8Array) => {
          const tried = this.checkMessage(message, other);
          return tried.state === "signed" && this.couldBeSent(message, tried.signer);
        };
        const other = this.keyThatOpens(message.group_id, message.epoch, opens);
        if (other) {
          key = other;
          checked = this.checkMessage(message, other);
        }
      }
      if (!checked || (checked.state === "closed" && this.keyUnproven(message.group_id, message.epoch))) {
        // Without the right key there's no telling who wrote it, or whether anyone did.
        status = "undecryptable";
        raw = envelope;
      } else if (checked.state !== "signed") {
        this.withhold(message, existing, checked.state === "unknown" ? checked.signer : null);
        return;
      } else {
        // A message's author never changes. A signature only proves who signed what's arriving now.
        if (author && author.userId !== checked.signer.userId) {
          this.warnOnce(`author/${message.group_id}/${message.id}`, "The server tried to change who wrote a message in one of your conversations. The message wasn't changed.");
          return;
        }
        author = checked.signer;
        if (!this.couldBeSent(message, author)) {
          status = "unverified";
          raw = envelope;
        } else {
          this.keyProvedItself(message.group_id, message.epoch);
          const parsed = parseMessageBody(checked.value);
          if (parsed?.signal) {
            this.noteSignal(message, parsed, existing, author.userId);
            return;
          }
          if (parsed && !existing?.body && this.cameTooSoon(message, author.userId)) {
            this.withhold(message, existing, null);
            return;
          }
          if (parsed && this.changedAfterLeaving(message, author, existing, parsed)) {
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
        }
      }
    }
    // What's sealed, kept as it is too, so the event needn't open it again.
    const ref = `${message.group_id}/${message.id}`;
    const reactions = body ? this.reactionsFor(message, existing) : null;
    const storedValue: StoredBody | null = body && reactions ? { ...body, ...reactions.value } : null;
    if (storedValue && !storedValue.mine?.length) delete storedValue.mine;
    const stored = storedValue ? this.sealJson("message", ref, storedValue) : (kept?.body ?? heldAfterLeaving);
    // A message that didn't open keeps its reactions as they came, to be read once it does, and one that did keeps those
    // it can't open yet, under an epoch whose key isn't here or from a device not known yet, to be read once they are.
    const rawReactions = reactions
      ? reactions.waiting.length
        ? this.sealJson("message_reactions", ref, reactions.waiting)
        : null
      : !kept && raw
        ? message.reactions
          ? this.sealJson("message_reactions", ref, message.reactions)
          : (existing?.raw_reactions ?? null)
        : (kept?.raw_reactions ?? null);
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
    const authorId = author?.userId ?? "";
    this.db.transaction(() => {
      if (withheld) this.db.run("DELETE FROM withheld WHERE group_id = ? AND id = ?", [message.group_id, message.id]);
      this.db.run(
        `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, edited_at, deleted_at, pinned_at, pinned_by, pin_revision, status, body, raw, raw_reactions, unproven_delete_at, expires_at, item_key)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_id, id) DO UPDATE SET seq = excluded.seq, updated_seq = excluded.updated_seq, sender_user = excluded.sender_user, sender_device = excluded.sender_device,
           epoch = excluded.epoch, created_at = excluded.created_at, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at,
           pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by, pin_revision = excluded.pin_revision, status = excluded.status, body = excluded.body, raw = excluded.raw,
           raw_reactions = excluded.raw_reactions, unproven_delete_at = excluded.unproven_delete_at, expires_at = excluded.expires_at,
           item_key = COALESCE(excluded.item_key, messages.item_key)`,
        [
          message.group_id,
          message.id,
          message.seq,
          message.updated_seq,
          authorId,
          laterEdit ? laterEdit.sender_device : (author?.deviceId ?? ""),
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
          message.item_key ? decode(message.item_key) : null,
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
    const fromOther = !!authorId && authorId !== this.account.userId;
    // A message new here shows its sender online for a while after it was sent, as on Telegram
    // (`History::newItemAdded`), or moves their last seen on to it when it's older. One that came
    // before its keys says who sent it only once it opens, which is when it counts.
    const authorLearned = !!authorId && !existing?.sender_user;
    if ((isNew || authorLearned) && message.deleted_at === null && fromOther) this.madeAction(authorId, message.created_at);
    if (expiresAt !== null && expiresAt < this.nextExpiry) this.expireMessages();
    // The first message in a new chat often beats its welcome, and only opens once that's in.
    if (live && isNew && status !== "sent") this.awaitingKeys.add(ref);
    const fresh = live ? isNew : status === "sent" && this.awaitingKeys.delete(ref);
    if (fresh && status === "sent" && fromOther) this.maybeNotify(view);
    if (body?.after && author) this.lookForEarlier(message, body, author.userId);
    if (body?.tokenKeys && fromOther) this.compareTokenKeys(body.tokenKeys, authorId);
    // Their head of the log of keys, inside the encryption and under their signature, where the server can't touch it.
    if (body?.log && fromOther) void this.compareHead(body.log, authorId).catch((error) => console.warn("[zuna] comparing a head of the log of keys", error));
  }

  /**
   * What a message that opens has for reactions. A copy sent live comes without them, and so, as
   * far as they go, does one from before a change to them this device already took on (`reactionsAt`):
   * those held stay. One that didn't open before kept all of its as they came, which are read now.
   */
  protected reactionsFor(message: ApiMessage, existing: MessageRow | undefined): { value: Pick<StoredBody, "reactions" | "mine" | "seen" | "reactionsAt">; waiting: ApiReaction[] } {
    const read = (raw: ApiReaction[], at: number) => {
      const result = this.readReactions(message.group_id, message.id, raw);
      this.afterReadingReactions(message.group_id, message.id, result);
      return { value: { ...this.viewsOf(result.seen), seen: result.seen, reactionsAt: at }, waiting: result.waiting };
    };
    const held = existing?.body ? this.storedBody(existing) : null;
    if (message.reactions && (!held || message.updated_seq >= (held.reactionsAt ?? existing!.updated_seq))) return read(message.reactions, message.updated_seq);
    if (held) return { value: { reactions: held.reactions, mine: held.mine, seen: held.seen, reactionsAt: held.reactionsAt }, waiting: this.rawReactionsOf(existing!) };
    if (existing?.raw_reactions) return read(this.rawReactionsOf(existing), existing.updated_seq);
    // Sent live, and never held here. One changed since it was sent may have some, which come when it's fetched.
    if (message.updated_seq > message.seq) this.refetchMessage(message.group_id, message.id);
    return { value: { reactions: [], seen: [], reactionsAt: message.updated_seq > message.seq ? 0 : message.updated_seq }, waiting: [] };
  }

  /**
   * Keeps a message out of every chat, shown, counted and notified about nowhere, and never as
   * from whoever it names: one naming a device this one doesn't know yet, which is tried again
   * once it does (`retryWithheld`), and one nobody it names signed, which is nobody's. What's
   * already shown as someone's stays as it is: a change nobody signed changes nothing.
   */
  protected withhold(message: ApiMessage, existing: MessageRow | undefined, unknown: Signer | null): void {
    if (existing && existing.status !== "undecryptable") return;
    const row = `${message.group_id}/${message.id}`;
    this.db.transaction(() => {
      if (existing) {
        this.db.run("DELETE FROM search WHERE rowid = ?", [existing.row_id]);
        this.db.run("DELETE FROM media WHERE row_id = ?", [existing.row_id]);
        this.db.run("DELETE FROM messages WHERE row_id = ?", [existing.row_id]);
      }
      this.db.run("INSERT OR REPLACE INTO withheld(group_id, id, updated_seq, held, data, at) VALUES(?, ?, ?, ?, ?, ?)", [
        message.group_id,
        message.id,
        message.updated_seq,
        unknown ? 1 : 0,
        this.sealJson("withheld", row, { message, signer: unknown } satisfies Withheld),
        Date.now(),
      ]);
    });
    if (existing) this.emit({ type: "message_removed", serverId: this.serverId, groupId: message.group_id, id: message.id });
    if (unknown) this.learnDevice(message.group_id, unknown);
  }

  /** Asks after a device something here names, and tries what it held back again once that's known. */
  protected learnDevice(groupId: string, signer: Signer): void {
    const ref = `${signer.userId}/${signer.deviceId}`;
    if (this.learning.has(ref)) return;
    this.learning.add(ref);
    void this.ensureUser(signer.userId, true)
      .then(() =>
        this.deviceKey(signer)
          ? this.withLock(groupId, async () => {
              this.retryWithheld(groupId);
              this.retryWaitingReactions(groupId);
            })
          : undefined,
      )
      .catch((error) => console.warn("[zuna] asking after a device", error))
      .finally(() => this.learning.delete(ref));
  }

  /** Takes in again what was held back for naming a device this one didn't know, now that it does. */
  protected retryWithheld(groupId: string): void {
    const rows = this.db.all<{ id: string; data: Uint8Array }>("SELECT id, data FROM withheld WHERE group_id = ? AND held = 1", [groupId]);
    for (const row of rows) {
      let withheld: Withheld;
      try {
        withheld = this.openJson<Withheld>("withheld", `${groupId}/${row.id}`, row.data);
      } catch {
        this.db.run("DELETE FROM withheld WHERE group_id = ? AND id = ?", [groupId, row.id]);
        continue;
      }
      if (!withheld.signer || !this.deviceKey(withheld.signer)) continue;
      this.db.run("DELETE FROM withheld WHERE group_id = ? AND id = ?", [groupId, row.id]);
      this.ingest(withheld.message, false);
    }
  }

  /**
   * A message that carries something to act on is shown nowhere, and acted on the first
   * time it comes, however often the server sends it.
   */
  protected noteSignal(message: ApiMessage, body: MessageBody, existing: MessageRow | undefined, from: string): void {
    if (existing) {
      // It came before its keys did, and showed as a message that wouldn't open.
      this.db.run("DELETE FROM messages WHERE group_id = ? AND id = ?", [message.group_id, message.id]);
      this.emit({ type: "message_removed", serverId: this.serverId, groupId: message.group_id, id: message.id });
    }
    if (this.db.get("SELECT 1 FROM signals WHERE group_id = ? AND id = ?", [message.group_id, message.id])) return;
    this.db.run("INSERT INTO signals(group_id, id, at) VALUES(?, ?, ?)", [message.group_id, message.id, Date.now()]);
    this.takeSignal(message, body, from);
  }

  /**
   * A message names the one its device sent before it here, so if that one never
   * arrived, the server may be holding it back. It's asked for, and if the server
   * says there's no such message, the person is told. Only for one sent while this
   * device was in the conversation, and recently, so it can't have expired.
   */
  protected lookForEarlier(message: ApiMessage, body: MessageBody, userId: string): void {
    const after = body.after!;
    if (this.messageRow(message.group_id, after.id) || this.hasExpired(message.group_id, after.id)) return;
    // One that disappeared before it could arrive is simply gone.
    if (after.expiresIn !== undefined && after.at + after.expiresIn * 1000 <= Date.now() + EARLIER_LOOK_DELAY_MS) return;
    const joined = this.joinedEpoch(message.group_id);
    if (joined === null || after.epoch < joined || body.sentAt === undefined) return;
    if (message.created_at < Date.now() - EARLIER_LOOKED_FOR_MS || body.sentAt - after.at > EARLIER_LOOKED_FOR_MS) return;
    this.missing.set(`${message.group_id}/${after.id}`, { groupId: message.group_id, id: after.id, userId });
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
  protected couldBeSent(message: { group_id: string; epoch: number; seq: number }, sender: Signer): boolean {
    const { group_id: groupId } = message;
    const { userId, deviceId } = sender;
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
  protected changedAfterLeaving(message: ApiMessage, sender: Signer, existing: MessageRow | undefined, parsed: MessageBody): boolean {
    if (!existing?.body || existing.seq === null || this.departedAt(message.group_id, sender.userId, sender.deviceId) === null) return false;
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

  /**
   * Who signed something about a message, if a device this one knows did, under an
   * epoch from before that device left the group, and it names them as who it's by.
   */
  protected signedAbout<T extends { by?: unknown }>(message: ApiMessage, kind: "pin" | "deletion", framed: string | undefined): { by: string; value: T } | null {
    const signed = framed ? readSigned(decode(framed)) : null;
    const key = signed && this.epochKey(message.group_id, signed.epoch);
    if (!signed || !key) return null;
    const checked = checkEnvelope<T>(key, kind, message.group_id, message.id, signed.epoch, signed.envelope, (signer) => this.deviceKey(signer));
    if (checked.state !== "signed" || checked.value?.by !== checked.signer.userId) return null;
    const left = this.departedAt(message.group_id, checked.signer.userId, checked.signer.deviceId);
    if (left !== null && signed.epoch >= left) return null;
    return { by: checked.signer.userId, value: checked.value };
  }

  protected openPin(message: ApiMessage): { by: string; pinned: boolean; revision: number } | null {
    const signed = this.signedAbout<{ by?: unknown; pinned?: unknown; revision?: unknown }>(message, "pin", message.pin);
    if (!signed || typeof signed.value.pinned !== "boolean") return null;
    const { revision } = signed.value;
    return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? { by: signed.by, pinned: signed.value.pinned, revision } : null;
  }

  /**
   * Whether a deletion is what its author, or in a group one of its admins, asked
   * for: their device signed it, under an epoch from before that device left.
   * Its author is whoever signed the copy this device holds.
   */
  protected deletionProven(message: ApiMessage, existing: MessageRow): boolean {
    const signed = this.signedAbout(message, "deletion", message.deletion);
    if (!signed) return false;
    if (existing.sender_user && signed.by === existing.sender_user) return true;
    const group = this.groups.get(message.group_id);
    return !!group && group.kind !== "dm" && this.isGroupAdmin(group, signed.by);
  }

  /** A copy kept after a deletion nobody proved goes once that's long enough ago, and so does what nobody signed. */
  protected forgetUnprovenDeletions(): void {
    this.db.run("UPDATE messages SET body = NULL, raw = NULL, unproven_delete_at = NULL WHERE unproven_delete_at < ?", [Date.now() - REMOVED_KEPT_MS]);
    this.db.run("DELETE FROM withheld WHERE held = 0 AND at < ?", [Date.now() - REMOVED_KEPT_MS]);
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
      // Without its epoch's key, or the device of whoever signed it, it can only fail again.
      if (!this.epochKey(groupId, row.epoch) || (row.sender_user && !this.deviceKey({ userId: row.sender_user, deviceId: row.sender_device }))) continue;
      this.ingest(
        {
          group_id: row.group_id,
          id: row.id,
          seq: row.seq ?? 0,
          updated_seq: row.updated_seq,
          epoch: row.epoch,
          envelope: toBase64(row.raw),
          created_at: row.created_at,
          edited_at: row.edited_at,
          deleted_at: row.deleted_at,
          pinned_at: row.pinned_at,
          reactions: this.rawReactionsOf(row),
        },
        false,
      );
    }
    this.retryWithheld(groupId);
    this.retryWaitingReactions(groupId);
    this.askForHistoryAgain(groupId);
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
    // The server's frames come in the order it made them, so what it last said is what it
    // went by for this message: it pushes nothing to a phone it takes to be in use.
    const inUse = this.seenInUse;
    const notification = this.notification(view, inUse);
    if (!notification) return;
    // As in Telegram, a notification waits while the person is on another device,
    // and doesn't show if they read the chat there, or here, meanwhile. A device the
    // server still took to be in use shows it as one in use, though its person just left:
    // their other devices wait as for one, and a phone has no push coming.
    const delay = notificationDelay({
      here: this.active || inUse,
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
      const event = this.notification(this.toMessageView(row), inUse);
      if (event) this.emit(event);
    }, delay);
    this.waitingNotifications.add(timer);
  }

  /** The notification for a new message from someone else, or null if it shouldn't notify. */
  protected notification(view: MessageView, inUse: boolean): Extract<CoreEvent, { type: "notify" }> | null {
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
    return { type: "notify", serverId: this.serverId, title, body, conversationKey: key, groupId: view.groupId, messageId: view.id, inUse };
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
      // Only a bot's messages come with buttons, whatever anyone else's say.
      buttons: body.buttons && this.users.get(row.sender_user)?.bot ? body.buttons : [],
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
