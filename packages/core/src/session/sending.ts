// ServerSession, in part (see base.ts): sending messages, and the files they carry.

import * as wasm from "@zuna/crypto";
import { ApiError, decode, type ApiMessage, type FileShare, type Seal, type TokenSize } from "../api";
import { frameSigned, randomId, sealEnvelope, sealSignal, subkey } from "../crypto";
import { concat, equalBytes, fromBase64, toBase64, toHex, u64Bytes, utf8 } from "../encoding";
import { linkInText } from "../links";
import { withoutMetadata, type ByteSource } from "../metadata";
import type { Attachment, EarlierMessage, EmoteRef, MessageBody, MessageButton, MessageView } from "../types";
import {
  CHUNK_SIZE,
  PREVIEW_WAIT_MS,
  SEND_NOW_WAIT_MS,
  UPLOAD_CONCURRENCY,
  EPOCH_MAX_AGE_MS,
  TYPING_THROTTLE_MS,
  MAX_COMMIT_ATTEMPTS,
  type CachedGroup,
  type OutboxEntry,
  MAX_SLOW_MODE,
  MAX_REACTIONS_BY_PERSON,
  slowModeOf,
  TOKEN_BATCH,
  TOKEN_LOW,
  TOKEN_PERIOD_MS,
  TOKEN_SIZES,
  TOKEN_SMALL_BYTES,
  tokenTiming,
  eachLimited,
  assertSendable,
} from "./shared";
import { SessionConversations } from "./conversations";

export abstract class SessionSending extends SessionConversations {
  // --- Sending ---

  protected async groupIdForKey(key: string): Promise<string> {
    if (key.startsWith("group:")) {
      const groupId = key.slice(6);
      return groupId;
    }
    const peerId = key.slice(5);
    const existing = this.dmWith(peerId);
    if (existing && existing.epoch > 0 && !existing.removedAt) return existing.id;
    const created = await this.api.createDm(peerId);
    // Whoever this message is for is who the person chose, whatever else the server says.
    const people = new Set([this.account.userId, peerId]);
    const listed = new Set(created.group.members.map((member) => member.user_id));
    // A conversation this device already knows stays what it was, so naming one for someone else changes nothing.
    const held = this.groups.get(created.group.id);
    const elsewhere = !!held && (held.kind !== "dm" || held.peerId !== peerId);
    if (created.group.kind !== "dm" || elsewhere || listed.size !== people.size || [...people].some((id) => !listed.has(id))) {
      this.warnOnce(`dm-reply/${created.group.id}`, "The server answered with the wrong people for a new direct message, so nothing was sent.");
      throw new Error("This message wasn't sent: the server's answer about this conversation doesn't hold together.");
    }
    this.applyGroup(created.group);
    return created.group.id;
  }

  protected ensureLocalEcho(groupKey: string, id: string, body: MessageBody): MessageView {
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, status, body)
       VALUES(?,?,NULL,0,?,?,0,?,?,?)`,
      [groupId, id, this.account.userId, this.account.deviceId, now, "sending", this.sealJson("message", `${groupId}/${id}`, body)],
    );
    const view = this.toMessageView(this.messageRow(groupId, id)!);
    this.emit({ type: "message", serverId: this.serverId, message: view, isNew: true });
    // The chat list shows it as it's sent, not once the server has it.
    this.emitConversations();
    return view;
  }

  /** What a message says, to forward it: its text, emotes, files and preview, and whose it was. */
  forwardable(groupId: string, id: string): MessageBody & { senderId: string } {
    const row = this.messageRow(groupId, id);
    const body = row ? this.storedBody(row) : null;
    if (!row?.body || !body || row.status !== "sent" || row.deleted_at !== null) throw new Error("That message can't be forwarded.");
    return {
      text: body.text,
      emotes: body.emotes,
      attachments: body.attachments,
      preview: body.preview,
      forwarded: body.forwarded,
      location: body.location,
      senderId: row.sender_user,
    };
  }

  /**
   * Forwards a message to another conversation on this server, saying whose
   * it was. Its files aren't uploaded again: the copy shares them.
   */
  forwardMessage(groupId: string, id: string, toKey: string): MessageView {
    const { senderId, ...original } = this.forwardable(groupId, id);
    const body: MessageBody = { ...original, forwarded: original.forwarded ?? { userId: senderId } };
    const newId = randomId();
    const view = this.ensureLocalEcho(toKey, newId, body);
    this.enqueue(toKey, { kind: "message", id: newId, body });
    return view;
  }

  /**
   * Sends a message. It appears immediately and survives restarts until delivered.
   * With `previewUrl`, a link whose preview isn't made yet, it waits a moment for
   * that preview, so a link pasted and sent at once still gets one.
   */
  sendMessage(groupKey: string, body: MessageBody, options: { previewUrl?: string } = {}): MessageView {
    assertSendable(body);
    const id = randomId();
    const view = this.ensureLocalEcho(groupKey, id, body);
    this.enqueue(groupKey, { kind: "message", id, body, previewUrl: this.pendingPreview(body, options.previewUrl) });
    return view;
  }

  protected pendingPreview(body: MessageBody, url: string | undefined): string | undefined {
    return url && !body.preview && this.linkPreview && body.text?.includes(url) ? url : undefined;
  }

  /** Adds a preview that's ready within a few seconds to a message about to go, and shows it here too. */
  protected async withPreview(groupKey: string, id: string, body: MessageBody, url: string): Promise<MessageBody> {
    const made = this.linkPreview?.(url).catch(() => null) ?? Promise.resolve(null);
    const preview = await Promise.race([made, new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIEW_WAIT_MS))]);
    if (!preview || !body.text?.includes(preview.url)) return body;
    const withPreview: MessageBody = { ...body, preview };
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    this.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [this.sealJson("message", `${groupId}/${id}`, withPreview), groupId, id]);
    const row = this.messageRow(groupId, id);
    if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
    return withPreview;
  }

  protected enqueue(groupKey: string, entry: OutboxEntry): void {
    this.db.run("INSERT OR REPLACE INTO outbox(id, group_key, kind, payload, created_at) VALUES(?,?,?,?,?)", [
      entry.id,
      groupKey,
      entry.kind,
      this.sealJson("outbox", entry.id, entry),
      Date.now(),
    ]);
    void this.flushOutbox();
  }

  /** Sends what's waiting. Anything that comes to wait while it does is sent too, in another pass. */
  flushOutbox(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        await this.runOutbox();
      } while (this.flushAgain && !this.stopped);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  protected async runOutbox(): Promise<void> {
    clearTimeout(this.flushRetry);
    for (;;) {
      // A chat that slow mode holds back waits, with everything after it there, but no other chat does.
      const now = Date.now();
      for (const [key, until] of this.slowHeld) if (until <= now) this.slowHeld.delete(key);
      for (const [key, until] of this.retryHeld) if (until <= now) this.retryHeld.delete(key);
      const held = [...new Set([...this.slowHeld.keys(), ...this.retryHeld.keys()])];
      const row = this.db.get<{ id: string; group_key: string; payload: Uint8Array }>(
        `SELECT id, group_key, payload FROM outbox WHERE group_key NOT IN (${held.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`,
        held,
      );
      if (!row || this.stopped) {
        if (held.length > 0 && !this.stopped) this.flushRetry = setTimeout(() => void this.flushOutbox(), Math.min(...this.slowHeld.values(), ...this.retryHeld.values()) - now);
        return;
      }
      let entry: OutboxEntry;
      try {
        entry = this.openJson<OutboxEntry>("outbox", row.id, row.payload);
      } catch (error) {
        // One that won't open can't be sent, and mustn't stand in front of everything after it.
        console.warn("[zuna] something waiting to be sent couldn't be read", error);
        this.db.run("DELETE FROM outbox WHERE id = ?", [row.id]);
        continue;
      }
      // A message names nobody, so the server can't hold anyone to a channel's slow mode: each app holds its own person.
      const slowUntil = entry.kind === "message" ? this.slowModeHolds(row.group_key, now) : 0;
      if (slowUntil > now) {
        this.slowHeld.set(row.group_key, Math.min(slowUntil, now + MAX_SLOW_MODE * 1000));
        this.emitConversations();
        continue;
      }
      try {
        await this.deliver(row.group_key, entry);
        this.db.run("DELETE FROM outbox WHERE id = ?", [row.id]);
        this.retryDelay.delete(row.group_key);
      } catch (error) {
        if (error instanceof ApiError && error.retryable) {
          const delay = Math.min((this.retryDelay.get(row.group_key) ?? 1250) * 2, 30_000);
          this.retryDelay.set(row.group_key, delay);
          this.retryHeld.set(row.group_key, Date.now() + delay);
          continue;
        }
        console.warn("[zuna] sending failed", error);
        this.db.run("DELETE FROM outbox WHERE id = ?", [row.id]);
        this.markFailed(row.group_key, entry.id);
      }
    }
  }

  protected markFailed(groupKey: string, id: string): void {
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    this.db.run("UPDATE messages SET status = 'failed' WHERE group_id = ? AND id = ?", [groupId, id]);
    const row = this.messageRow(groupId, id);
    if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
    this.emitConversations();
  }

  protected markStaleSendsFailed(): void {
    // A send still marked in progress with nothing in the outbox was interrupted
    // by a restart, for example during an upload.
    this.db.run(
      `UPDATE messages SET status = 'failed' WHERE status = 'sending' AND id NOT IN (SELECT id FROM outbox)`,
    );
  }

  /** When a channel's slow mode lets this person's next message there go, from the last any of their devices sent, or 0. */
  protected slowModeHolds(groupKey: string, now: number): number {
    const group = this.groupForKey(groupKey);
    const slowMode = group?.kind === "channel" ? slowModeOf(this.channels.get(group.id)?.api) : 0;
    if (!group || slowMode === 0 || group.members.some((member) => member.userId === this.account.userId && member.role === "admin")) return 0;
    const own = this.db.get<{ sent: number | null }>("SELECT MAX(created_at) AS sent FROM messages WHERE group_id = ? AND sender_user = ? AND seq IS NOT NULL", [group.id, this.account.userId]);
    const sent = Math.max((own?.sent ?? 0) - this.api.serverAhead, this.getKv<EarlierMessage>(`sent/${group.id}`)?.at ?? 0);
    const until = sent + slowMode * 1000;
    return until > now ? until : 0;
  }

  protected async deliver(groupKey: string, entry: OutboxEntry): Promise<void> {
    if (entry.kind === "edit") {
      await this.withLock(entry.groupId, () =>
        this.sealAndRetry(entry.groupId, async (epoch, key) => {
          const row = this.messageRow(entry.groupId, entry.id);
          const held = row ? this.storedBody(row) : null;
          // An edit says how long the message lasts as it first did, so it disappears all the same.
          const body: MessageBody = { ...entry.body, revision: this.nextRevision(entry.groupId, entry.id), after: held?.after, expiresIn: held?.expiresIn };
          const envelope = sealEnvelope(key, this.account.deviceSecret, "message", entry.groupId, entry.id, epoch, this.signedBody(body, entry.groupId), this.signer);
          const item = this.heldItemSecret("message", entry.groupId, entry.id, row?.item_key ?? null);
          if (!item) throw new Error("This message can't be edited from this device.");
          this.ingest(await this.api.sealedEdit(entry.groupId, entry.id, await this.seal(entry.groupId, epoch, envelope.length, item), envelope), false);
        }),
      );
      return;
    }
    // Messages go in order, so the ones after it wait for its preview too.
    const body = entry.previewUrl ? await this.withPreview(groupKey, entry.id, entry.body, entry.previewUrl) : entry.body;
    let saved = null as ApiMessage | null;
    const groupId = await this.groupIdForKey(groupKey);
    await this.withLock(groupId, async () => {
      await this.ensureReady(groupId);
      await this.rotateIfOld(groupId);
      this.moveLocalEcho(groupKey, groupId, entry.id);
      await this.sealAndRetry(groupId, async (epoch, key) => {
        const after = this.getKv<EarlierMessage>(`sent/${groupId}`) ?? undefined;
        // It lasts as long as the chat says when it goes, whenever it was written.
        const expiresIn = this.disappearAfter(this.groups.get(groupId)) || undefined;
        const envelope = sealEnvelope(key, this.account.deviceSecret, "message", groupId, entry.id, epoch, this.signedBody({ ...body, after, expiresIn }, groupId), this.signer);
        const files = this.sharesOf(body);
        saved = await this.api.sealedSend(groupId, await this.seal(groupId, epoch, envelope.length), {
          id: entry.id,
          envelope,
          item_key: wasm.signingPublic(this.itemSecret("message", groupId, entry.id)),
          files: files.length ? files : undefined,
          expires_in: expiresIn,
        });
        this.setKv(`sent/${groupId}`, { id: entry.id, epoch, at: Date.now(), expiresIn } satisfies EarlierMessage);
        this.ingest(saved, false);
      });
    });
    this.emitConversations();
    // Read at once, at its own message, as anyone reading it as it arrives would: the server
    // can't tell whose phones to leave out, and holds each push a moment for this to spare them.
    if (saved) void this.markRead(groupId, saved.seq).catch((error) => console.warn("[zuna] read state", error));
  }

  /** The files a message carries, with the secrets they were made with, which the server checks. */
  protected sharesOf(body: MessageBody): FileShare[] {
    return (body.attachments ?? []).filter((item) => item.share).map((item) => ({ id: item.fileId, secret: fromBase64(item.share!) }));
  }

  /**
   * The key only this account's devices can make for something it added, which changing or
   * deleting it takes: from the account key, so any of its devices can, and tied to nothing
   * else, so it names nobody.
   */
  protected itemSecret(kind: "message" | "reaction", groupId: string, itemId: string, accountKey = this.account.accountKey): Uint8Array {
    return wasm.hkdfSha256(subkey(accountKey, "author"), new Uint8Array(0), utf8(`zuna/item-key/v1|${kind}|${groupId}|${itemId}`), 32);
  }

  /**
   * The item key whose public half the server holds for something, from whichever of this
   * account's keys made it: the account's keys are replaced now and then, and the older ones
   * are tried too. Null if none of them did, as for something someone else added.
   */
  protected heldItemSecret(kind: "message" | "reaction", groupId: string, itemId: string, shown: Uint8Array | string | null | undefined): Uint8Array | null {
    if (!shown) return null;
    const wanted = typeof shown === "string" ? decode(shown) : shown;
    for (const key of [this.account.accountKey, ...Object.values(this.account.core.olderKeys)]) {
      const secret = this.itemSecret(kind, groupId, itemId, key);
      if (equalBytes(wasm.signingPublic(secret), wanted)) return secret;
    }
    return null;
  }

  /**
   * What a sealed request is signed and paid with: the group's send key for the epoch it's for,
   * which any member could make, a token for something of `bytes`, and `item` to change or delete something.
   */
  protected async seal(groupId: string, epoch: number, bytes: number | null, item?: Uint8Array): Promise<Seal> {
    const send = this.sendKey(groupId);
    if (send.epoch !== epoch) throw new ApiError(409, "stale_epoch", "The conversation's keys changed.");
    return { epoch, secret: send.secret, token: bytes === null ? undefined : await this.takeToken(bytes), item };
  }

  /**
   * An edit's revision, worked out as it goes rather than when it was made, so
   * it's after whatever arrived meanwhile. It's this device's time unless that's
   * behind the last revision, so an edit from a device whose clock is behind still
   * comes after, and one queued on a device offline comes after edits made since.
   */
  protected nextRevision(groupId: string, id: string): number {
    const row = this.messageRow(groupId, id);
    const held = row ? (this.storedBody(row)?.revision ?? 0) : 0;
    return Math.max(held + 1, Date.now());
  }

  /**
   * Presses a button under a bot's message, which sends the data it holds back to the bot.
   * It goes to the whole chat, as a chat's messages do, and only the bot acts on it.
   */
  async pressButton(groupId: string, messageId: string, row: number, column: number): Promise<void> {
    const stored = this.messageRow(groupId, messageId);
    const button = stored ? this.toMessageView(stored).buttons[row]?.[column] : undefined;
    if (button?.data === undefined) throw new Error("That button isn't there anymore.");
    await this.sendSignal(groupId, { type: "button", message: messageId, data: button.data });
  }

  /**
   * Sends something for the apps of a chat's members to act on, which they show nowhere.
   * To the server it's a message like any other, but one no phone is woken for.
   */
  protected async sendSignal(groupId: string, signal: NonNullable<MessageBody["signal"]>, files?: FileShare[]): Promise<void> {
    const id = randomId();
    await this.withLock(groupId, async () => {
      await this.ensureReady(groupId);
      await this.sealAndRetry(groupId, async (epoch, key) => {
        const envelope = sealEnvelope(key, this.account.deviceSecret, "message", groupId, id, epoch, this.signedBody({ signal }, groupId), this.signer);
        const item_key = wasm.signingPublic(this.itemSecret("message", groupId, id));
        this.ingest(await this.api.sealedSend(groupId, await this.seal(groupId, epoch, envelope.length), { id, envelope, item_key, files: files?.length ? files : undefined, silent: true }), false);
      });
    });
  }

  /**
   * What goes under this device's signature: the message, when it was sent, who's sending it,
   * which token keys this device was shown, and the newest head of the log of keys it holds,
   * when it's newer than the one it last sent there, so that everyone can tell they were shown the same.
   */
  protected signedBody(body: MessageBody, groupId: string): MessageBody & { sentAt: number; by: { user: string; device: string } } {
    const log = this.headForMessage(groupId);
    return { ...body, sentAt: Date.now(), by: { user: this.account.userId, device: this.account.deviceId }, tokenKeys: this.tokenKeysTag(), ...(log ? { log } : {}) };
  }

  /** A DM's first message is echoed before its group exists; this moves it there. */
  protected moveLocalEcho(groupKey: string, groupId: string, id: string): void {
    const pending = `pending:${groupKey}`;
    const row = this.messageRow(pending, id);
    if (!row) return;
    // Its body is sealed to where it was, so it's sealed again for where it goes.
    const body = row.body && this.openLocal("message", `${pending}/${id}`, row.body);
    this.db.run("UPDATE messages SET group_id = ?, body = ? WHERE group_id = ? AND id = ?", [groupId, body ? this.sealLocal("message", `${groupId}/${id}`, body) : null, pending, id]);
    this.emit({
      type: "message_moved",
      serverId: this.serverId,
      fromGroupId: pending,
      message: this.toMessageView(this.messageRow(groupId, id)!),
    });
  }

  /**
   * Runs `send` with the current epoch's key, catching up and retrying if we were behind, and
   * with another token if one was spent already, as one used on a request that never answered may be.
   */
  protected async sealAndRetry(groupId: string, send: (epoch: number, key: Uint8Array) => Promise<void>): Promise<void> {
    let unsealed = false;
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      this.refuseDoubtful(groupId);
      if (!this.hasMlsGroup(groupId)) await this.ensureReady(groupId);
      await this.ensureTreeClean(groupId);
      const epoch = this.rememberCurrentEpochKey(groupId);
      const key = this.epochKey(groupId, epoch)!;
      try {
        await send(epoch, key);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.code === "stale_epoch") {
          await this.pullChanges(groupId);
          continue;
        }
        if (error instanceof ApiError && (error.code === "token_spent" || error.code === "token_invalid")) continue;
        if (error instanceof ApiError && error.code === "not_sealed") {
          // The server holds no send key for this epoch that its members make. It forgets the key
          // when someone leaves, is banned or signs a device out, as their device still makes it
          // until a commit takes it out of the tree. With who's in the group read again, the next
          // turn takes out whoever went (`ensureTreeClean`), and that commit carries the next key.
          this.applyGroup(await this.api.group(groupId));
          if (!unsealed) {
            unsealed = true;
            // The tree was clean for who was in the group before, which says nothing of who is now.
            this.cleanEpochs.delete(groupId);
            continue;
          }
          // Nobody to take out, so whoever made the epoch gave a wrong key, or the server changed
          // it. A member puts it right with a commit (`checkSendKey`); this goes once that's in.
          throw new ApiError(0, "not_sealed", "This conversation's keys are being put right. This will go once they are.");
        }
        throw error;
      }
    }
    throw new Error("Couldn't catch up with this conversation. Please try again.");
  }

  /**
   * Renews a group's keys once its epoch is a week old, or this device's leaf still has an
   * older certificate. Syncing does it (`reconcile`), so sending rarely has to.
   */
  protected async rotateIfOld(groupId: string): Promise<void> {
    if (!this.needsRotating(groupId)) return;
    const nobodyNeeded = new Error("no longer needed");
    await this.commitWithRetry(groupId, async () => {
      // Someone else may have renewed it while this one caught up.
      if (!this.needsRotating(groupId)) throw nobodyNeeded;
      return { kind: "update" };
    }).catch((error) => {
      if (error !== nobodyNeeded) throw error;
    });
  }

  protected needsRotating(groupId: string): boolean {
    const epoch = this.mlsEpoch(groupId);
    const row = this.db.get<{ created_at: number }>("SELECT created_at FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, epoch]);
    // A leaf with an older certificate gets the new one in any commit, and that's
    // how everyone sharing this group finds out about a rotation the server may be keeping from them.
    const old = !!row && Date.now() - row.created_at >= EPOCH_MAX_AGE_MS;
    return old || this.leafIsBehind(groupId);
  }

  protected leafIsBehind(groupId: string): boolean {
    const groupBytes = utf8(groupId);
    const own = this.mls.ownLeafIndex(groupBytes);
    const members = this.mls.members(groupBytes) as { leafIndex: number; credential: Uint8Array }[];
    const leaf = members.find((member) => member.leafIndex === own);
    return !!leaf && !equalBytes(leaf.credential, this.account.certificate);
  }

  retryMessage(groupId: string, id: string): void {
    const row = this.messageRow(groupId, id);
    const body = row ? this.storedBody(row) : null;
    if (!row || row.status !== "failed" || !row.body || !body) return;
    // A file that never went up has nothing on the server for the message to point at.
    if (body.attachments?.some((item) => !item.fileId)) throw new Error("Its files didn't upload. Attach them again to send this.");
    const group = this.groups.get(groupId);
    const key = group ? this.conversationKey(group) : groupId.replace(/^pending:/, "");
    this.db.run("UPDATE messages SET status = 'sending' WHERE group_id = ? AND id = ?", [groupId, id]);
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(this.messageRow(groupId, id)!), isNew: false });
    this.enqueue(key, {
      kind: "message",
      id,
      body: {
        text: body.text,
        replyTo: body.replyTo,
        emotes: body.emotes,
        attachments: body.attachments,
        mentions: body.mentions,
        location: body.location,
        forwarded: body.forwarded,
        preview: body.preview && linkInText(body.preview.url, body.text ?? "") ? body.preview : undefined,
      },
    });
  }

  discardMessage(groupId: string, id: string): void {
    this.db.run("DELETE FROM outbox WHERE id = ?", [id]);
    this.db.run("DELETE FROM messages WHERE group_id = ? AND id = ? AND seq IS NULL", [groupId, id]);
    this.emit({ type: "message_removed", serverId: this.serverId, groupId, id });
  }

  /** `buttons` replaces a bot's message's buttons, or with null takes them away. Left out, they stay. */
  editMessage(groupId: string, id: string, text: string, emotes: Record<string, EmoteRef>, mentions: string[], buttons?: MessageButton[][] | null): void {
    const row = this.messageRow(groupId, id);
    const previous = row ? this.storedBody(row) : null;
    if (!row?.body || !previous) return;
    const body: MessageBody = {
      text,
      emotes,
      mentions,
      buttons: buttons === undefined ? previous.buttons : (buttons ?? undefined),
      replyTo: previous.replyTo,
      attachments: previous.attachments,
      // The preview stays while its link does; an edit doesn't fetch a new one.
      preview: previous.preview && linkInText(previous.preview.url, text) ? previous.preview : undefined,
      forwarded: previous.forwarded,
      location: previous.location,
    };
    assertSendable(body);
    this.db.run("UPDATE messages SET body = ?, edited_at = ? WHERE group_id = ? AND id = ?", [
      this.sealJson("message", `${groupId}/${id}`, { ...previous, ...body }),
      Date.now(),
      groupId,
      id,
    ]);
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(this.messageRow(groupId, id)!), isNew: false });
    const group = this.groups.get(groupId);
    if (group) this.enqueue(this.conversationKey(group), { kind: "edit", id, groupId, body });
  }

  async deleteMessage(groupId: string, id: string): Promise<void> {
    await this.deleteSigned(groupId, id);
    this.emitConversations();
  }

  /** Deletes several messages for everyone, in order. */
  async deleteMessages(groupId: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.deleteSigned(groupId, id);
    this.emitConversations();
  }

  /**
   * This device signs the deletion, so other members' apps can tell it from the server's word
   * before erasing their copies. Its author's own goes sealed, with its item key, and a group
   * admin's of someone else's by name, as it's the server's to check their role.
   */
  protected async deleteSigned(groupId: string, id: string): Promise<void> {
    const { userId, deviceSecret } = this.account;
    await this.withLock(groupId, () =>
      this.sealAndRetry(groupId, async (epoch, epochKey) => {
        const deletion = frameSigned(epoch, sealEnvelope(epochKey, deviceSecret, "deletion", groupId, id, epoch, { by: userId }, this.signer));
        const row = this.messageRow(groupId, id);
        const item = row?.sender_user === userId ? this.heldItemSecret("message", groupId, id, row.item_key) : null;
        this.ingest(item ? await this.api.sealedDelete(groupId, id, await this.seal(groupId, epoch, 0, item), deletion) : await this.api.moderateMessage(groupId, id, epoch, deletion), false);
      }),
    );
  }

  /** This device signs the pin, so other members' apps can tell it from the server's word. */
  async setPinned(groupId: string, id: string, pinned: boolean): Promise<void> {
    const { userId, deviceSecret } = this.account;
    await this.withLock(groupId, () =>
      this.sealAndRetry(groupId, async (epoch, epochKey) => {
        // After the pin this device holds, whatever its clock says, as with edits.
        const revision = Math.max((this.messageRow(groupId, id)?.pin_revision ?? 0) + 1, Date.now());
        const pin = frameSigned(epoch, sealEnvelope(epochKey, deviceSecret, "pin", groupId, id, epoch, { by: userId, pinned, revision }, this.signer));
        this.ingest(await this.api.sealedPin(groupId, id, pinned, await this.seal(groupId, epoch, pin.length), pin), false);
      }),
    );
  }

  async toggleReaction(groupId: string, messageId: string, key: string, emote?: EmoteRef): Promise<void> {
    const { userId, deviceSecret } = this.account;
    const row = this.messageRow(groupId, messageId);
    const stored = row ? this.storedBody(row) : null;
    const current = stored?.reactions ?? [];
    const already = current.some((item) => item.key === key && item.userIds.includes(userId));
    await this.withLock(groupId, async () => {
      if (already) {
        // Another device may have made it, or two devices the same one: each is taken back with the key that made it.
        for (const mine of (this.storedBody(this.messageRow(groupId, messageId)!)?.mine ?? []).filter((item) => item.key === key)) {
          const item = this.heldItemSecret("reaction", groupId, mine.id, mine.item);
          if (!item) continue;
          await this.sealAndRetry(groupId, async (epoch) => {
            this.ingest(await this.api.sealedUnreact(groupId, messageId, mine.id, await this.seal(groupId, epoch, 0, item)), false);
          });
        }
        return;
      }
      // How many one person puts on a message is held by each app, as the server can't tell whose they are.
      if (current.filter((item) => item.userIds.includes(userId)).length >= MAX_REACTIONS_BY_PERSON) throw new Error("That's as many reactions as one person can add to a message.");
      const id = randomId();
      await this.sealAndRetry(groupId, async (epoch, epochKey) => {
        const data = frameSigned(epoch, sealEnvelope(epochKey, deviceSecret, "reaction", groupId, messageId, epoch, { id, key, emote }, this.signer));
        const item_key = wasm.signingPublic(this.itemSecret("reaction", groupId, id));
        this.ingest(await this.api.sealedReact(groupId, messageId, await this.seal(groupId, epoch, data.length), { id, data, item_key }), false);
      });
    });
  }

  sendTyping(groupId: string): void {
    const now = Date.now();
    if (now - (this.lastTypingSent.get(groupId) ?? 0) < TYPING_THROTTLE_MS) return;
    if (!this.hasMlsGroup(groupId)) return;
    this.lastTypingSent.set(groupId, now);
    const epoch = this.rememberCurrentEpochKey(groupId);
    const key = this.epochKey(groupId, epoch);
    if (!key) return;
    // Signed inside, so that a server can't show someone typing who isn't, timed, so it can't send it on again
    // later, and sealed, so it doesn't say who's typing, which would name whoever sends the message after it.
    const data = frameSigned(epoch, sealEnvelope(key, this.account.deviceSecret, "typing", groupId, "typing", epoch, { at: now }, this.signer));
    void this.seal(groupId, epoch, null)
      .then((seal) => this.api.sealedTyping(groupId, seal, data))
      .catch(() => undefined);
  }

  async markRead(groupId: string, seq: number): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group || seq <= group.ownRead || !this.hasMlsGroup(groupId)) return;
    group.readSent ??= group.ownRead;
    group.ownRead = seq;
    this.persistGroup(group);
    this.emitConversations();
    await this.sendRead(group);
  }

  /**
   * Tells the server how far this person has read. One that doesn't arrive, as when
   * the app closes or the network drops while it's on its way, goes again at the next
   * sync, since the chat already looks read here and nothing else would send it.
   */
  protected async sendRead(group: CachedGroup): Promise<void> {
    const seq = group.ownRead;
    const epoch = this.rememberCurrentEpochKey(group.id);
    const { userId, deviceSecret, accountKey } = this.account;
    let framed: Uint8Array;
    // Nobody has read ticks in a channel, so where someone is stays their own.
    if (this.prefs.sendReadReceipts && group.kind !== "channel") {
      const key = this.epochKey(group.id, epoch);
      if (!key) return;
      framed = frameSigned(epoch, sealEnvelope(key, deviceSecret, "read", group.id, userId, epoch, { seq }, this.signer));
    } else {
      // The position is sealed to our own account key, so our other devices stay
      // in sync while nobody else can read it.
      const sealed = sealSignal(subkey(accountKey, "read"), "read", group.id, epoch, { seq });
      framed = new Uint8Array(sealed.length + 1);
      framed[0] = 1;
      framed.set(sealed, 1);
    }
    try {
      await this.api.setRead(group.id, framed);
    } catch (error) {
      console.warn("[zuna] read state", error);
      // Refused for good, sending it again won't help. Signed out, it can go once signed back in.
      if (!(error instanceof ApiError) || error.retryable || error.status === 401) return;
    }
    // The group may have been read in again from the server meanwhile.
    const current = this.groups.get(group.id);
    if (current && seq > (current.readSent ?? 0)) {
      current.readSent = seq;
      this.persistGroup(current);
    }
  }

  /** Read positions that never reached the server. */
  protected async sendUnsentReads(): Promise<void> {
    for (const group of this.groups.values()) {
      if (group.readSent !== undefined && group.ownRead > group.readSent && !group.removedAt && this.hasMlsGroup(group.id)) {
        await this.sendRead(group).catch((error) => console.warn("[zuna] read state", error));
      }
    }
  }

  // --- Tokens ---

  /** The period tokens are issued for now, by the server's clock as far as this device knows it. */
  protected tokenPeriod(): number {
    return Math.floor((Date.now() + this.api.serverAhead) / TOKEN_PERIOD_MS);
  }

  /** The public keys tokens are issued under, by period and size, as a request with no session was shown them. */
  protected heldTokenKeys(): Record<string, Partial<Record<TokenSize, string>>> {
    return this.getKv<Record<string, Partial<Record<TokenSize, string>>>>("token_keys") ?? {};
  }

  /**
   * Asks which keys tokens are issued under, without the session, as anyone would. A key
   * doesn't change within its period, so one shown differently later is the server
   * showing this device something else, and it's said so.
   */
  protected async refreshTokenKeys(): Promise<number> {
    const shown = await this.api.tokenKeys();
    const held = this.heldTokenKeys();
    for (const key of shown.keys) {
      if (key.size !== "small" && key.size !== "large") continue;
      const before = held[key.period]?.[key.size];
      if (before && before !== key.public) {
        this.warnOnce(`token-key/${key.period}`, "The server changed the keys it shows for sending in the middle of their time, which could let it tell which messages are yours.");
        continue;
      }
      (held[key.period] ??= {})[key.size] = key.public;
    }
    for (const period of Object.keys(held)) if (Number(period) < shown.period - 1) delete held[period];
    this.setKv("token_keys", held);
    return shown.period;
  }

  /** A short hash of a period's token keys, which signed messages carry so that everyone can tell they were shown the same. */
  protected tokenKeysHash(period: number): string | null {
    const keys = this.heldTokenKeys()[period];
    if (!keys?.small || !keys.large) return null;
    return toHex(wasm.sha256(concat(utf8(`zuna/token-keys/v1|${period}|`), fromBase64(keys.small), fromBase64(keys.large))).subarray(0, 8));
  }

  /** What a signed message says of the token keys its sender holds, for the newest period it holds them for. */
  protected tokenKeysTag(): { p: number; h: string } | undefined {
    const periods = Object.keys(this.heldTokenKeys()).map(Number).sort((a, b) => b - a);
    for (const period of periods) {
      const hash = this.tokenKeysHash(period);
      if (hash) return { p: period, h: hash };
    }
    return undefined;
  }

  /**
   * Someone's message says which token keys they were shown. If they're not the ones this
   * device was shown for the same period, the server is showing people keys of their own,
   * which would let it follow their tokens to what they send, and it's said so.
   */
  protected compareTokenKeys(tag: { p: number; h: string }, from: string): void {
    const own = this.tokenKeysHash(tag.p);
    if (!own || own === tag.h) return;
    this.warnOnce(
      `token-keys/${tag.p}`,
      "The server showed someone in one of your conversations other keys for sending than it showed you, which would let it tell which messages are theirs.",
      from,
    );
  }

  protected tokenCount(size: TokenSize): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE size = ? AND period >= ?", [size, this.tokenPeriod() - 1])?.n ?? 0;
  }

  /**
   * Fetches tokens of a size, signed in, which the server counts against this person, and
   * unblinds them with the key everyone is shown, which the server proves it used.
   */
  protected async fetchTokens(size: TokenSize): Promise<void> {
    const period = await this.refreshTokenKeys();
    const key = this.heldTokenKeys()[period]?.[size];
    if (!key) throw new Error("The server didn't show the keys tokens are issued under.");
    const count = TOKEN_BATCH[size];
    const blinds = wasm.tokenBlind(count);
    const blinded = Array.from({ length: count }, (_, index) => blinds.slice(index * 96 + 64, index * 96 + 96));
    const answer = await this.api.issueTokens(period, size, blinded);
    if (!Array.isArray(answer.evaluated) || answer.evaluated.length !== count) throw new Error("The server's tokens weren't what was asked for.");
    const outputs = wasm.tokenFinalize(blinds, concat(...answer.evaluated.map((element) => fromBase64(element))), fromBase64(answer.proof), fromBase64(key));
    const tag = new Uint8Array([size === "small" ? 1 : 2]);
    this.db.transaction(() => {
      for (let index = 0; index < count; index++) {
        const token = concat(u64Bytes(period), tag, blinds.subarray(index * 96, index * 96 + 32), outputs.subarray(index * 64, index * 64 + 64));
        const id = randomId();
        this.db.run("INSERT INTO tokens(id, period, size, token) VALUES(?, ?, ?, ?)", [id, period, size, this.sealLocal("token", id, token)]);
      }
    });
  }

  /**
   * Takes a token to spend on something of `bytes`, the oldest first, as it runs out soonest.
   * With none left it fetches some, which is the one time asking says something is about to go.
   */
  protected async takeToken(bytes: number): Promise<Uint8Array> {
    const size: TokenSize = bytes <= TOKEN_SMALL_BYTES ? "small" : "large";
    const pick = () =>
      this.db.get<{ id: string; token: Uint8Array }>("SELECT id, token FROM tokens WHERE size = ? AND period >= ? ORDER BY period LIMIT 1", [size, this.tokenPeriod() - 1]);
    let row = pick();
    if (!row) {
      await this.fetchTokens(size);
      row = pick();
    }
    if (!row) throw new ApiError(0, "no_tokens", "Couldn't get what's needed to send. This will go when the server answers.");
    this.db.run("DELETE FROM tokens WHERE id = ?", [row.id]);
    this.topUpTokensSoon();
    return this.openLocal("token", row.id, row.token);
  }

  /**
   * Fetches more tokens a random while after this device runs low, at a time of its own,
   * never because something is about to go. `now` fetches at once any size there are none
   * of, as when the device has just signed in.
   */
  protected topUpTokensSoon(now = false): void {
    if (this.stopped) return;
    this.db.run("DELETE FROM tokens WHERE period < ?", [this.tokenPeriod() - 1]);
    const low = TOKEN_SIZES.filter((size) => this.tokenCount(size) < TOKEN_LOW[size]);
    if (low.length === 0 || this.tokenTopUp) return;
    const empty = now && low.some((size) => this.tokenCount(size) === 0);
    const [least, most] = tokenTiming.topUpMs;
    this.tokenTopUp = setTimeout(
      () => {
        this.tokenTopUp = undefined;
        void (async () => {
          for (const size of TOKEN_SIZES) if (this.tokenCount(size) < TOKEN_LOW[size]) await this.fetchTokens(size);
        })().catch((error) => console.warn("[zuna] fetching tokens", error));
      },
      empty ? 0 : least + Math.random() * (most - least),
    );
  }

  // --- Files ---

  /** A file to upload, read as it is. */
  protected whole(blob: Blob): ByteSource {
    return { size: this.files.size(blob), read: (start, end) => this.files.read(blob, start, end) };
  }

  /**
   * Uploads a file. One a message will carry (`share`) is made with a secret, which travels
   * inside the message with its key and shows the server whoever sends it holds it; from
   * then on the server keeps nothing of who uploaded it. A picture that stands on its own has none.
   */
  protected async uploadBlob(
    source: ByteSource,
    onProgress?: (loaded: number, total: number) => void,
    attach = false,
    share = false,
  ): Promise<{ fileId: string; key: string; prefix: string; chunks: number; share?: string }> {
    const key = wasm.randomBytes(32);
    const prefix = wasm.randomBytes(15);
    const secret = share ? wasm.randomBytes(32) : null;
    const size = source.size;
    const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const created = await this.api.createFile(chunks, size + chunks * 16, secret ? wasm.sha256(secret) : undefined);
    let loaded = 0;
    // A few chunks go at once, and once one fails the rest of a file given up on don't.
    await eachLimited(Array.from({ length: chunks }, (_, index) => index), UPLOAD_CONCURRENCY, async (index) => {
      const start = index * CHUNK_SIZE;
      const plain = await source.read(start, Math.min(start + CHUNK_SIZE, size));
      const sealed = wasm.streamSeal(key, prefix, index, index === chunks - 1, plain);
      await this.api.uploadChunk(created.id, index, sealed);
      loaded += plain.length;
      onProgress?.(loaded, size);
    });
    await this.api.completeFile(created.id, attach);
    return { fileId: created.id, key: toBase64(key), prefix: toBase64(prefix), chunks, ...(secret ? { share: toBase64(secret) } : {}) };
  }

  /** Decrypts a file, verifying that every chunk is present and in order. */
  async downloadFile(ref: { fileId: string; key: string; prefix: string; chunks: number; mime?: string }, onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
    const parts: Uint8Array[] = new Array(ref.chunks);
    let done = 0;
    await eachLimited(Array.from({ length: ref.chunks }, (_, index) => index), UPLOAD_CONCURRENCY, async (index) => {
      parts[index] = await this.openChunk(ref, index);
      done++;
      onProgress?.(done, ref.chunks);
    });
    return this.files.assemble(parts, ref.mime ?? "application/octet-stream");
  }

  /**
   * One chunk of a file, decrypted, as a file of its own: for a video that plays as it comes,
   * rather than once all of it has. Each chunk is sealed for its place in the file, so none
   * can be passed off as another, and only the last says it's the last.
   */
  async downloadChunk(ref: { fileId: string; key: string; prefix: string; chunks: number; mime?: string }, index: number): Promise<Blob> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= ref.chunks) throw new Error("This file has no such part.");
    return this.files.assemble([await this.openChunk(ref, index)], ref.mime ?? "application/octet-stream");
  }

  protected async openChunk(ref: { fileId: string; key: string; prefix: string; chunks: number }, index: number): Promise<Uint8Array> {
    const sealed = await this.api.downloadChunk(ref.fileId, index);
    // The server's limit plus a little: this is all held in memory.
    if (sealed.length > CHUNK_SIZE + 256) throw new Error("This file isn't what it should be.");
    return wasm.streamOpen(fromBase64(ref.key), fromBase64(ref.prefix), index, index === ref.chunks - 1, sealed);
  }

  /**
   * Uploads attachments, then sends the message. Progress shows on the local echo.
   * What files say about where, when and on what they were made is taken out first,
   * unless this device's settings keep it.
   */
  async sendWithAttachments(
    groupKey: string,
    files: { blob: Blob; name: string; mime: string; width?: number; height?: number; thumb?: string; duration?: number; voice?: boolean; waveform?: string; round?: boolean }[],
    body: MessageBody,
    options: { previewUrl?: string; keepMetadata?: boolean } = {},
  ): Promise<string> {
    assertSendable(body);
    const id = randomId();
    const totalBytes = files.reduce((sum, file) => sum + this.files.size(file.blob), 0);
    const placeholders: Attachment[] = files.map((file) => ({
      fileId: "",
      key: "",
      prefix: "",
      chunks: 0,
      name: file.name,
      mime: file.mime,
      size: this.files.size(file.blob),
      width: file.width,
      height: file.height,
      thumb: file.thumb,
      duration: file.duration,
      voice: file.voice,
      waveform: file.waveform,
      round: file.round,
    }));
    const echo = this.ensureLocalEcho(groupKey, id, { ...body, attachments: placeholders });
    const groupId = echo.groupId;

    const limitMb = this.info?.max_upload_mb ?? 100;
    const tooBig = files.find((file) => this.files.size(file.blob) > limitMb * (1 << 20));
    if (tooBig) {
      this.markFailed(groupKey, id);
      throw new Error(`${tooBig.name} is larger than this server's ${limitMb} MB limit.`);
    }

    try {
      const attachments: Attachment[] = [];
      let uploaded = 0;
      for (const [index, file] of files.entries()) {
        // A voice or video message is recorded by the app, so it holds nothing of the kind.
        const source = options.keepMetadata || file.voice || file.round ? this.whole(file.blob) : await withoutMetadata(this.whole(file.blob), file.mime, file.name);
        const ref = await this.uploadBlob(source, (loaded) => {
          const current = this.messageRow(groupId, id);
          if (!current) return;
          this.emit({
            type: "message",
            serverId: this.serverId,
            message: { ...this.toMessageView(current), uploadProgress: (uploaded + loaded) / Math.max(totalBytes, 1) },
            isNew: false,
          });
        }, false, true);
        uploaded += this.files.size(file.blob);
        attachments.push({ ...placeholders[index]!, size: source.size, ...ref });
      }
      const finalBody: MessageBody = { ...body, attachments };
      this.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [this.sealJson("message", `${groupId}/${id}`, finalBody), groupId, id]);
      this.enqueue(groupKey, {
        kind: "message",
        id,
        body: finalBody,
        previewUrl: this.pendingPreview(finalBody, options.previewUrl),
      });
    } catch (error) {
      this.markFailed(groupKey, id);
      throw error;
    }
    return id;
  }

  /**
   * Sends a message, with any files, and resolves once it's gone, for a
   * process that stops straight after: the iOS share extension. One still
   * waiting after a minute, as when the server can't be reached, stays in
   * the outbox and goes when the app is next online, and this says so.
   */
  async sendNow(
    groupKey: string,
    files: Parameters<SessionSending["sendWithAttachments"]>[1],
    body: MessageBody,
    options: { previewUrl?: string; keepMetadata?: boolean } = {},
  ): Promise<void> {
    const id = files.length > 0 ? await this.sendWithAttachments(groupKey, files, body, options) : this.sendMessage(groupKey, body, options).id;
    const deadline = Date.now() + SEND_NOW_WAIT_MS;
    for (;;) {
      // The ID is random and new, wherever the message has moved since, such as into a DM just started.
      const status = this.db.get<{ status: string }>("SELECT status FROM messages WHERE id = ?", [id])?.status;
      if (status === "sent") return;
      if (status === "failed") throw new Error("This message couldn't be sent.");
      if (Date.now() > deadline) throw new Error("This message is taking a while to send. It goes once Zuna is back online.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
