// ServerSession, in part (see base.ts): applying a group's changes in the server's order, and keeping its MLS tree to its roster.

import { ApiError, decode, type ApiEvent, type ApiMessage } from "../api";
import { parseCertificate } from "../crypto";
import { equalBytes, utf8 } from "../encoding";
import { sealedRows } from "../sendable";
import { RECONCILE_JITTER_MS, KEY_VOIDED, type StoredBody } from "./shared";
import { SessionJoining } from "./joining";

export abstract class SessionChanges extends SessionJoining {
  // --- Groups: applying changes ---

  /** Fetches and applies the feed until caught up. Serialized per group. */
  async syncGroup(groupId: string): Promise<void> {
    const running = this.syncing.get(groupId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          let more = true;
          while (more && !this.stopped) {
            more = await this.withLock(groupId, () => this.pullPage(groupId));
          }
        } while (entry.again && !this.stopped);
      } finally {
        this.syncing.delete(groupId);
      }
    })();
    this.syncing.set(groupId, entry);
    await entry.done;
    this.scheduleReconcile(groupId);
  }

  /** A sync started from an event. A group we were removed from stops being taken part in. */
  protected backgroundSync(groupId: string): void {
    void this.syncGroup(groupId).catch((error) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        void this.withLock(groupId, async () => this.markRemoved(groupId));
      } else {
        console.warn("[zuna] sync failed", error);
      }
    });
  }

  /**
   * Catches one chat up ahead of the rest, for the one in front as an app comes back, as from a
   * notification. Catching up on everything goes through the account's keys and who everyone is
   * before any chat, a dozen round trips that take most of a second on a phone's network. What
   * came meanwhile is taken now only if it's messages this device can open and check with what it
   * holds, as it would if they'd come live. Anything else, such as a change to the group or a
   * message from a device it doesn't know yet, waits for its turn, after what it may depend on.
   * Online, there's nothing to fetch: what came has come live.
   */
  async catchUpFirst(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (this.stopped || this.connection === "online" || !group || group.removedAt || group.doubtful || !this.hasMlsGroup(groupId) || this.syncing.has(groupId)) return;
    await this.withLock(groupId, async () => {
      let more = true;
      while (more && !this.stopped) {
        const after = this.syncedSeq(groupId);
        const page = await this.api.changes(groupId, after);
        if (this.stopped || page.events.length > 0 || !page.messages.every((message) => this.readableNow(message))) return;
        const messages = page.messages.sort((a, b) => a.updated_seq - b.updated_seq);
        if (messages.length > 0) this.db.transaction(() => messages.forEach((message) => this.ingest(message, false)));
        if (page.cursor > after) this.setSyncedSeq(groupId, page.cursor);
        const current = this.groups.get(groupId);
        if (messages.length > 0 && current) {
          this.refreshGroupSecrets(current);
          this.persistGroup(current);
          this.emitConversations();
        }
        more = page.has_more;
      }
    });
  }

  /** Catches up while already holding the group's lock. */
  protected async pullChanges(groupId: string): Promise<void> {
    while (await this.pullPage(groupId)) {
      // Keep going until the feed has no more pages.
    }
  }

  protected syncedSeq(groupId: string): number {
    return this.db.get<{ synced_seq: number }>("SELECT synced_seq FROM groups WHERE id = ?", [groupId])?.synced_seq ?? 0;
  }

  protected setSyncedSeq(groupId: string, seq: number): void {
    this.db.run("UPDATE groups SET synced_seq = ? WHERE id = ?", [seq, groupId]);
  }

  protected async pullPage(groupId: string): Promise<boolean> {
    const cached = this.groups.get(groupId);
    if (!cached || cached.removedAt || cached.doubtful) return false;
    if (!this.hasMlsGroup(groupId)) {
      const group = await this.api.group(groupId);
      this.applyGroup(group);
      if (group.epoch === 0) return false;
      await this.processWelcomesFor(groupId);
      if (!this.hasMlsGroup(groupId)) {
        await this.repair(groupId);
        if (!this.hasMlsGroup(groupId)) return false;
      }
    }
    const after = this.syncedSeq(groupId);
    const page = await this.api.changes(groupId, after);
    const items: ({ seq: number; message: ApiMessage } | { seq: number; event: ApiEvent })[] = [
      ...page.messages.map((message) => ({ seq: message.updated_seq, message })),
      ...page.events.map((event) => ({ seq: event.seq, event })),
    ];
    items.sort((a, b) => a.seq - b.seq);
    // The messages between two events are written in one transaction, rather than one each.
    let run: ApiMessage[] = [];
    const writeRun = () => {
      const messages = run;
      run = [];
      if (messages.length > 0) this.db.transaction(() => messages.forEach((message) => this.ingest(message, false)));
    };
    for (const item of items) {
      if ("event" in item) {
        writeRun();
        await this.applyEvent(item.event);
      } else {
        run.push(item.message);
      }
    }
    writeRun();
    if (page.cursor > after) this.setSyncedSeq(groupId, page.cursor);
    const group = this.groups.get(groupId);
    if (group) {
      this.refreshGroupSecrets(group);
      this.persistGroup(group);
    }
    if (items.length > 0) this.emitConversations();
    // Caught up, and still behind: a commit this device couldn't apply. If it's
    // been waiting for someone able to deal with that, this may be them.
    if (!page.has_more && group && !group.removedAt && this.hasMlsGroup(groupId) && group.epoch > this.mlsEpoch(groupId)) {
      await this.repair(groupId);
    }
    return page.has_more;
  }

  protected async applyEvent(event: ApiEvent): Promise<void> {
    if (event.kind === "member_left") {
      // Only said so by the server. It's shown once MLS bears it out.
      const group = this.groups.get(event.group_id);
      if (group && event.target_user) {
        group.pendingRemovals = {
          ...group.pendingRemovals,
          [event.target_user]: { actor: event.sender_user, seq: event.seq, at: event.created_at },
        };
        this.persistGroup(group);
        this.announceConfirmedRemovals(event.group_id);
      }
      this.scheduleReconcile(event.group_id);
      return;
    }
    if (event.kind === "commit_voided") {
      this.db.run("DELETE FROM epoch_starts WHERE group_id = ? AND epoch > ?", [event.group_id, event.epoch]);
      this.db.run("UPDATE epoch_keys SET uploaded = ? WHERE group_id = ? AND epoch > ?", [KEY_VOIDED, event.group_id, event.epoch]);
      this.confirmedEpochs.delete(event.group_id);
      this.noteVoidedCommit(event);
      // A device that got past that epoch has gone somewhere nobody else will follow.
      if (this.hasMlsGroup(event.group_id) && this.mlsEpoch(event.group_id) > event.epoch) await this.repair(event.group_id);
      return;
    }
    this.db.run("INSERT OR REPLACE INTO epoch_starts(group_id, epoch, seq) VALUES(?, ?, ?)", [event.group_id, event.epoch, this.sealJson("epoch-start", `${event.group_id}:${event.epoch}`, event.seq)]);
    await this.applyCommit(event);
  }

  /** People the server said left, whose keys are now really gone. */
  protected announceConfirmedRemovals(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group?.pendingRemovals || !this.hasMlsGroup(groupId)) return;
    const inTree = new Set(this.treeUsers(groupId));
    const pending = { ...group.pendingRemovals };
    let changed = false;
    for (const [target, { actor, seq, at }] of Object.entries(pending)) {
      if (inTree.has(target)) continue;
      changed = true;
      delete pending[target];
      // A channel doesn't say each time someone's banned from the server.
      if (group.kind === "channel") continue;
      if (target === actor) {
        this.addSystemRow(groupId, at, target, { type: "member_left", actorId: target }, seq);
      } else {
        // That they're gone is proven. Who did it is only the server's word, so it isn't repeated.
        this.addSystemRow(groupId, at, actor, { type: "member_removed", targetIds: [target] }, seq);
      }
    }
    if (changed) {
      group.pendingRemovals = pending;
      this.persistGroup(group);
    }
  }

  /**
   * Notes the epoch from which each device in a group's tree has been there, as of
   * the epoch this device is at. Anyone's certificate counts: being here only lets
   * their signed messages through, which still have to check out.
   */
  protected noteArrivals(groupId: string): void {
    if (!this.hasMlsGroup(groupId)) return;
    const epoch = this.mlsEpoch(groupId);
    for (const member of this.mls.members(utf8(groupId)) as { credential: Uint8Array }[]) {
      const cert = parseCertificate(member.credential);
      if (cert) this.db.run("INSERT OR IGNORE INTO device_arrivals(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [groupId, cert.userId, cert.deviceId, this.sealJson("arrival", `${groupId}/${cert.userId}/${cert.deviceId}`, epoch)]);
    }
  }

  /** The epoch from which someone's device has been in a group's tree, as this device saw. */
  protected arrivedAt(groupId: string, userId: string, deviceId: string): number | null {
    const row = this.db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_arrivals WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, userId, deviceId]);
    const sealed = sealedRows.arrival;
    return row ? this.openValue(sealed.name, sealed.row(groupId, userId, deviceId), row.epoch, sealed.careful) : null;
  }

  /** The epoch someone's device left a group's tree, if it has. */
  protected departedAt(groupId: string, userId: string, deviceId: string): number | null {
    const row = this.db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_departures WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, userId, deviceId]);
    const sealed = sealedRows.departure;
    return row ? this.openValue(sealed.name, sealed.row(groupId, userId, deviceId), row.epoch, sealed.careful) : null;
  }

  /** The genuine devices in a group's tree, as `user/device`. */
  protected presentDevices(groupId: string): Set<string> {
    return new Set(this.treeMembers(groupId).filter((member) => member.genuine).map((member) => `${member.userId}/${member.deviceId}`));
  }

  protected recordDepartures(groupId: string, epoch: number, removed: Uint8Array[]): void {
    const present = this.presentDevices(groupId);
    for (const member of this.treeMembers(groupId).filter((item) => item.genuine)) {
      this.db.run("DELETE FROM device_departures WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, member.userId, member.deviceId]);
    }
    for (const credential of removed) {
      const cert = parseCertificate(credential);
      // A real device still here means what went was something using its certificate.
      if (cert && !present.has(`${cert.userId}/${cert.deviceId}`)) {
        this.db.run("INSERT OR REPLACE INTO device_departures(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [groupId, cert.userId, cert.deviceId, this.sealJson("departure", `${groupId}/${cert.userId}/${cert.deviceId}`, epoch)]);
        // Coming back is a new arrival.
        this.db.run("DELETE FROM device_arrivals WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, cert.userId, cert.deviceId]);
      }
    }
  }

  /**
   * A commit nobody can apply: it reached the server well formed, but no member's
   * MLS state can follow it, and neither can anyone rejoin past it. Whoever's device
   * still has the last good state brings the group back to it, and everyone who
   * never got past that epoch simply carries on. Nobody has to accept anything new,
   * since they keep the keys they already trust.
   */
  protected async voidBrokenCommit(groupId: string, cause: unknown): Promise<void> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    const groupBytes = utf8(groupId);
    const held = this.hasMlsGroup(groupId);
    const local = held ? this.mlsEpoch(groupId) : 0;
    // With nothing held, only the start of a group can be undone.
    if (group.epoch <= local || (!held && group.epoch > 1)) return;
    console.warn("[zuna] undoing a commit nobody can apply", cause);
    try {
      await this.api.voidCommits(groupId, group.epoch, local, held ? this.mls.exportGroupInfo(groupBytes) : new Uint8Array(0), held ? this.sendKey(groupId).public : new Uint8Array(0));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403) throw error;
      // Being refused this says nothing about still being in the group. Someone else may yet be able to.
      this.warnOnce(`stuck/${groupId}/${group.epoch}`, "One of your conversations has a broken update that only one of its admins can undo. It will carry on once one of them opens Zuna.");
      return;
    }
    this.applyGroup(await this.api.group(groupId));
  }

  /** Who's told that a commit was undone: anyone it happened in front of, not a device reading about it later. */
  protected noteVoidedCommit(event: ApiEvent): void {
    const joined = this.joinedEpoch(event.group_id);
    if (joined === null || joined > event.epoch) return;
    const name = this.users.get(event.target_user ?? "")?.profile.displayName ?? "someone";
    this.warnOnce(`voided/${event.group_id}/${event.seq}`, `A broken update from ${name} in one of your conversations was undone, and the conversation carries on.`, event.target_user ?? "");
  }

  protected async applyCommit(event: ApiEvent): Promise<void> {
    const groupId = event.group_id;
    const groupBytes = utf8(groupId);
    if (!this.hasMlsGroup(groupId)) return;
    const local = this.mlsEpoch(groupId);
    if (event.epoch <= local) return;

    if (event.sender_device === this.account.deviceId) {
      // Our own commit, and we restarted before merging it. Its roster is this device's own.
      if (this.mls.hasPending(groupBytes)) {
        this.mls.mergePending(groupBytes);
        this.saveMls();
        const roster = this.rosterIn(groupId);
        if (roster) this.setRoster(groupId, roster);
        this.rememberCurrentEpochKey(groupId);
        return;
      }
      await this.repair(groupId);
      return;
    }
    if (event.epoch > local + 1) {
      await this.repair(groupId);
      return;
    }
    if (this.mls.hasPending(groupBytes)) {
      this.mls.clearPending(groupBytes);
      this.saveMls();
    }

    let processed: {
      epoch: number;
      senderCredential: Uint8Array;
      isExternal: boolean;
      addedCredentials: Uint8Array[];
      removedCredentials: Uint8Array[];
      selfRemoved: boolean;
    };
    const usersBefore = new Set(this.treeUsers(groupId));
    this.saveMls();
    let refusal: string | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        processed = this.mls.processCommit(groupBytes, decode(event.data)) as typeof processed;
        // A change to the roster is checked before it's kept: only an admin may make most of them.
        refusal = processed.selfRemoved ? null : this.rosterRefusal(groupId, this.rosterIn(groupId), parseCertificate(processed.senderCredential));
        if (!refusal) break;
        this.mls.rollback();
        if (attempt > 0) break;
        // What's known about who's in the group may be behind. Only what the server says now counts.
        this.applyGroup(await this.api.group(groupId));
      }
      if (!refusal) this.saveMls();
    } catch (error) {
      console.warn("[zuna] a commit couldn't be applied; rejoining", error);
      this.saveMls();
      await this.repair(groupId);
      return;
    }
    if (refusal) {
      const sender = parseCertificate(processed.senderCredential);
      const name = (sender && this.users.get(sender.userId)?.profile.displayName) ?? "Someone";
      this.warnOnce(`roster/${groupId}/${event.epoch}`, `${name} tried to change who's in one of your conversations, or who runs it, without being allowed to. It wasn't accepted.`, sender?.userId ?? "");
      await this.voidBrokenCommit(groupId, new Error(refusal));
      return;
    }
    const rosterNow = this.rosterIn(groupId);
    if (rosterNow && !processed.selfRemoved) this.setRoster(groupId, rosterNow);
    this.treeUsersCache.delete(groupId);
    if (processed.selfRemoved) {
      await this.afterBeingRemoved(groupId);
      return;
    }
    this.rememberCurrentEpochKey(groupId);
    this.uploadEpochKeysSoon();
    this.checkSendKey(groupId, processed.epoch, event.send_key);
    await this.checkTree(groupId);
    // Nobody is added to a channel: they come in by themselves, so that's when to look at whether they should have.
    if (processed.isExternal && this.groups.get(groupId)?.kind === "channel") this.scheduleReconcile(groupId);
    this.recordDepartures(groupId, processed.epoch, processed.removedCredentials);
    await this.checkCommitAuthority(event, processed);
    this.describeCommit(event, processed, usersBefore);
    this.announceConfirmedRemovals(groupId);
    this.retryUndecryptable(groupId);
  }

  /**
   * This device was taken out of a group's tree. If the server says this person
   * has left, so be it. If they're still a member, someone with no right to has
   * removed them: this device goes straight back in, and says so.
   */
  protected async afterBeingRemoved(groupId: string): Promise<void> {
    let stillMember = false;
    try {
      const group = await this.api.group(groupId);
      this.applyGroup(group);
      stillMember = group.members.some((member) => member.user_id === this.account.userId);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
    if (!stillMember) {
      this.markRemoved(groupId);
      return;
    }
    this.emit({
      type: "security",
      serverId: this.serverId,
      userId: this.account.userId,
      message: "A member removed this device from one of your conversations without permission. It has rejoined.",
    });
    await this.repair(groupId);
  }

  /**
   * MLS proves who made a commit, not whether they may. Only admins add people
   * or remove anyone who hasn't already left. A commit can't be taken back once
   * everyone has applied it, so this says what happened and the group heals: someone
   * added against the rules is removed as stale, and someone removed rejoins.
   */
  protected async checkCommitAuthority(
    event: ApiEvent,
    processed: { senderCredential: Uint8Array; isExternal: boolean; addedCredentials: Uint8Array[]; removedCredentials: Uint8Array[] },
  ): Promise<void> {
    const groupId = event.group_id;
    if (processed.addedCredentials.length === 0 && processed.removedCredentials.length === 0) return;
    const sender = parseCertificate(processed.senderCredential);
    const look = () => {
      const group = this.groups.get(groupId);
      const present = this.presentDevices(groupId);
      const senderIsAdmin = !!group && !!sender && this.isGroupAdmin(group, sender.userId);
      const addedWithoutRight = !senderIsAdmin && processed.addedCredentials.length > 0;
      const removedWithoutRight =
        !senderIsAdmin &&
        processed.removedCredentials.some((credential) => {
          const cert = parseCertificate(credential);
          if (!cert || !group) return false;
          // Rejoining replaces a device's own old leaf.
          if (processed.isExternal && cert.userId === sender?.userId && cert.deviceId === sender.deviceId) return false;
          // A real device still here means what went wasn't really it.
          if (present.has(`${cert.userId}/${cert.deviceId}`)) return false;
          const onRoster = group.members.some((member) => member.userId === cert.userId);
          const revoked = this.users.get(cert.userId)?.devices.get(cert.deviceId)?.revoked;
          return onRoster && !revoked;
        });
      return { addedWithoutRight, removedWithoutRight };
    };
    let found = look();
    if (!found.addedWithoutRight && !found.removedWithoutRight) return;
    // What's known here may be behind. Only what the server says now counts.
    try {
      this.applyGroup(await this.api.group(groupId));
      if (sender) await this.ensureUser(sender.userId, true);
      for (const credential of processed.removedCredentials) {
        const cert = parseCertificate(credential);
        if (cert) await this.ensureUser(cert.userId, true);
      }
    } catch (error) {
      console.warn("[zuna] checking a commit", error);
    }
    found = look();
    if (!found.addedWithoutRight && !found.removedWithoutRight) return;
    const name = sender ? (this.users.get(sender.userId)?.profile.displayName ?? "A member") : "A member";
    this.emit({
      type: "security",
      serverId: this.serverId,
      userId: sender?.userId ?? "",
      message: `${name} changed who's in one of your conversations without permission. Zuna is putting it right.`,
    });
    this.scheduleReconcile(groupId);
  }

  /**
   * Turns an applied commit into what people see. Everything here comes from
   * MLS-authenticated data, so the server can't quietly add someone to a chat.
   */
  protected describeCommit(
    event: ApiEvent,
    processed: { senderCredential: Uint8Array; isExternal: boolean; addedCredentials: Uint8Array[]; removedCredentials: Uint8Array[] },
    usersBefore: Set<string>,
  ): void {
    const groupId = event.group_id;
    const known = this.knownMembers(groupId);
    const senderCert = parseCertificate(processed.senderCredential);
    const inTree = new Set(this.treeUsers(groupId));
    // Anyone on the server comes and goes from a channel, with no notice each time.
    if (this.groups.get(groupId)?.kind === "channel") {
      this.setKnownMembers(groupId, inTree);
      return;
    }

    const addedUsers = new Set<string>();
    for (const credential of processed.addedCredentials) {
      const cert = parseCertificate(credential);
      if (cert && !known.has(cert.userId)) addedUsers.add(cert.userId);
    }
    if (addedUsers.size > 0 && senderCert) {
      this.addSystemRow(groupId, event.created_at, senderCert.userId, {
        type: "member_added",
        actorId: senderCert.userId,
        targetIds: [...addedUsers],
      }, event.seq);
    }

    if (processed.isExternal && senderCert) {
      // Someone's extra device joining needs no notice, but a person arriving
      // with no device in the group does, so a rejoin can never go unnoticed.
      if (!usersBefore.has(senderCert.userId)) {
        const group = this.groups.get(groupId);
        // A group's roster says who may be in it, and a DM can only hold its two people,
        // whether or not this device saw them there before: it may have joined while their
        // devices were out, or didn't check out. checkTree has already warned about anyone
        // else, and they're being removed.
        const belongs = group?.kind === "group" ? this.admitted(group, senderCert.userId) : !!group && this.dmPeople(group).includes(senderCert.userId);
        if (belongs) {
          this.addSystemRow(groupId, event.created_at, senderCert.userId, {
            type: "member_rejoined",
            actorId: senderCert.userId,
          }, event.seq);
        }
        addedUsers.add(senderCert.userId);
      }
      if (known.has(senderCert.userId)) this.resealMeta(groupId);
    }

    const removedUsers = new Set<string>();
    for (const credential of processed.removedCredentials) {
      const cert = parseCertificate(credential);
      if (cert && !inTree.has(cert.userId)) removedUsers.add(cert.userId);
    }
    // Those the server already told us about get their notice from that.
    const pending = this.groups.get(groupId)?.pendingRemovals ?? {};
    const unannounced = new Set([...removedUsers].filter((user) => !pending[user]));
    if (unannounced.size > 0 && senderCert && this.isRosterRemoval(groupId, unannounced) && !this.alreadyAnnouncedRemoval(groupId, unannounced)) {
      this.addSystemRow(groupId, event.created_at, senderCert.userId, {
        type: "member_removed",
        actorId: senderCert.userId,
        targetIds: [...unannounced],
      }, event.seq);
    }

    // Signing out of a last device empties someone's place but keeps them a
    // member. Only people who really left stop being known.
    const roster = new Set(this.groups.get(groupId)?.members.map((member) => member.userId));
    for (const user of addedUsers) known.add(user);
    for (const user of removedUsers) if (!roster.has(user)) known.delete(user);
    for (const user of inTree) known.add(user);
    this.setKnownMembers(groupId, known);
  }

  /** False when people merely signed out of their last device and are still members. */
  protected isRosterRemoval(groupId: string, users: Set<string>): boolean {
    const group = this.groups.get(groupId);
    return !!group && [...users].some((user) => !group.members.some((member) => member.userId === user));
  }

  /** A roster event already reported this, so the follow-up commit stays silent. */
  protected alreadyAnnouncedRemoval(groupId: string, users: Set<string>): boolean {
    const messages = this.db.all<{ id: string; body: Uint8Array | null }>(
      "SELECT id, body FROM messages WHERE group_id = ? AND id LIKE 'sys-%' ORDER BY row_id DESC LIMIT 20",
      [groupId],
    );
    return messages.some((row) => {
      if (!row.body) return false;
      const { system } = this.openJson<StoredBody>("message", `${groupId}/${row.id}`, row.body);
      const announced = system?.type === "member_left" ? [system.actorId] : system?.type === "member_removed" ? (system.targetIds ?? []) : [];
      return [...users].every((user) => announced.includes(user));
    });
  }

  /**
   * Gets this device back in step with a group. Rejoining fixes anything that went
   * wrong on this device. If nobody can rejoin either, because what the group moved
   * on to doesn't hold together, it's undone if this person is able to do that, and
   * otherwise waits for someone who is. What this device has isn't lost either way.
   * Only MLS refusing what the group moved on to says that: a server or a network
   * having a bad moment says nothing about the group, so it's just tried again later.
   */
  protected async repair(groupId: string): Promise<void> {
    try {
      await this.joinExternal(groupId);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) throw error;
      console.warn("[zuna] couldn't rejoin a conversation", error);
      if (!(error instanceof ApiError)) {
        try {
          await this.voidBrokenCommit(groupId, error);
          if (!this.hasMlsGroup(groupId) && this.groups.get(groupId)?.epoch === 0 && !this.startedHere(groupId)) {
            const group = await this.api.group(groupId);
            await this.initGroup(group, []);
          }
        } catch (voidError) {
          if (voidError instanceof ApiError && (voidError.status === 403 || voidError.status === 404)) throw voidError;
          console.warn("[zuna] couldn't undo a broken update", voidError);
        }
      }
    }
    this.retryUndecryptable(groupId);
  }

  // --- Reconciling MLS with the roster ---

  /**
   * Checks the send key the server holds for a group's current epoch against this device's own.
   * A wrong one, from whoever made the epoch or from the server, leaves nobody able to send, so a
   * member puts it right with a commit of its own, which carries one, after a random wait, as
   * reconciling does: everyone sees the same, and the others then have nothing left to do.
   */
  protected checkSendKey(groupId: string, epoch: number, sendKey: string | null | undefined): void {
    if (epoch === 0 || !this.hasMlsGroup(groupId) || this.mlsEpoch(groupId) !== epoch) return;
    const seen = `${epoch}:${sendKey ?? ""}`;
    if (this.sendKeysChecked.get(groupId) === seen) return;
    if (sendKey && equalBytes(decode(sendKey), this.sendKey(groupId).public)) {
      this.sendKeysChecked.set(groupId, seen);
      return;
    }
    if (this.sendKeyFixes.has(groupId) || this.stopped) return;
    console.warn("[zuna] the server holds a wrong send key for a conversation; putting it right");
    const timer = setTimeout(() => {
      this.sendKeyFixes.delete(groupId);
      void this.withLock(groupId, async () => {
        const group = await this.api.group(groupId);
        if (group.epoch !== epoch || !this.hasMlsGroup(groupId) || this.mlsEpoch(groupId) !== epoch) return;
        if (group.send_key && equalBytes(decode(group.send_key), this.sendKey(groupId).public)) return;
        await this.commitWithRetry(groupId, async () => ({ kind: "update" }));
      }).catch((error) => console.warn("[zuna] putting a send key right", error));
    }, Math.random() * RECONCILE_JITTER_MS);
    this.sendKeyFixes.set(groupId, timer);
  }

  protected scheduleReconcile(groupId: string): void {
    if (this.reconcileTimers.has(groupId) || this.stopped) return;
    // Everyone in the group sees the same change. The delay lets one client do
    // the work; the others see its commit and have nothing left to do.
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(groupId);
      void this.withLock(groupId, () => this.reconcile(groupId)).catch((error) => {
        console.warn("[zuna] reconcile failed", error);
      });
    }, Math.random() * RECONCILE_JITTER_MS);
    this.reconcileTimers.set(groupId, timer);
  }

  protected async staleLeaves(groupId: string): Promise<number[]> {
    const group = this.groups.get(groupId);
    if (!group || group.doubtful || !this.hasMlsGroup(groupId)) return [];
    const roster = new Set(group.members.map((member) => member.userId));
    const own = this.mls.ownLeafIndex(utf8(groupId));
    const stale: number[] = [];
    for (const member of this.treeMembers(groupId)) {
      if (member.leaf === own) continue;
      // Not caught out, only not checked yet. ensureTreeClean waits for that.
      if (member.unchecked && roster.has(member.userId)) continue;
      if (!member.genuine || !roster.has(member.userId) || !this.admitted(group, member.userId)) {
        stale.push(member.leaf);
        continue;
      }
      let device = this.users.get(member.userId)?.devices.get(member.deviceId);
      if (!device) {
        // Our list may be behind: only act on what the server says right now.
        device = (await this.ensureUser(member.userId, true))?.devices.get(member.deviceId);
      }
      if (device?.revoked) {
        stale.push(member.leaf);
      } else if (member.userId === this.account.userId && !this.ownDeviceAccepted(member.deviceId, device)) {
        // A valid certificate only takes someone's identity key. Nobody knows this
        // person's own devices better than this one, and whoever this is never signed in.
        stale.push(member.leaf);
        const warned = `${groupId}/own/${member.deviceId}`;
        if (!this.warnedLeaves.has(warned)) {
          this.warnedLeaves.add(warned);
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: member.userId,
            message: "A device claiming to be yours, which never signed in, tried to join one of your conversations. It's being removed.",
          });
        }
      }
    }
    return stale;
  }

  protected async reconcile(groupId: string): Promise<void> {
    if (this.stopped || this.groups.get(groupId)?.removedAt || !this.hasMlsGroup(groupId)) return;
    await this.learnTreeUsers(groupId);
    await this.takeOverIfNoAdmin(groupId);
    await this.removeStaleLeaves(groupId);
    // An old epoch is renewed as the group is synced, by whoever's wait ends first, rather
    // than just before something is sent, where a commit would say who sent what came next.
    if (!this.groups.get(groupId)?.doubtful) await this.rotateIfOld(groupId);
  }

  protected async removeStaleLeaves(groupId: string): Promise<void> {
    if ((await this.staleLeaves(groupId)).length === 0) return;
    // What's known about the roster may be behind, so ask before removing anyone.
    this.applyGroup(await this.api.group(groupId));
    if ((await this.staleLeaves(groupId)).length === 0) return;
    await this.commitWithRetry(groupId, async () => ({
      kind: "update",
      removeLeaves: await this.staleLeaves(groupId),
    }));
    this.announceConfirmedRemovals(groupId);
  }

  /** Whether this person should put themselves in the roster as admin: none of its admins is in the group, and the server made them its admin. */
  protected shouldTakeOver(groupId: string): boolean {
    const group = this.groups.get(groupId);
    const self = this.account.userId;
    const held = group?.kind === "group" ? this.rosterOf(group) : null;
    if (!group || !held || held.roster.admins.includes(self) || !held.roster.members.includes(self) || !group.serverAdmins?.includes(self)) return false;
    const listed = new Set(group.members.map((member) => member.userId));
    return !held.roster.admins.some((id) => listed.has(id));
  }

  /**
   * With none of a group's admins left in it, the server makes its longest-standing
   * member its admin, as it always has. That person's device then says so in the
   * roster, where the others accept it only in exactly that case.
   */
  protected async takeOverIfNoAdmin(groupId: string): Promise<void> {
    if (!this.shouldTakeOver(groupId)) return;
    const nobodyNeeded = new Error("no longer needed");
    await this.commitWithRetry(groupId, async () => {
      const held = this.rosterOf(this.groups.get(groupId)!);
      if (!held || !this.shouldTakeOver(groupId)) throw nobodyNeeded;
      return { kind: "update", roster: { admins: [this.account.userId], members: held.roster.members } };
    }).catch((error) => {
      if (error !== nobodyNeeded) throw error;
    });
  }
}
