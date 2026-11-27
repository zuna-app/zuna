// ServerSession, in part (see base.ts): joining groups, and committing to them.

import * as wasm from "@zuna/crypto";
import { ApiError, decode, type ApiGroup, type CommitRequest } from "../api";
import { CONTENT_LABEL, SEND_LABEL, parseCertificate } from "../crypto";
import { equalBytes, fromBase64, toBase64, u64Bytes, utf8 } from "../encoding";
import { readRoster, sealCharter, sealRoster, type Roster } from "../roster";
import { reasonText, ROSTER_BEHIND, ROSTER_UNSAID } from "./groups";
import { MAX_COMMIT_ATTEMPTS, type GroupMeta, type TreeMember } from "./shared";
import { SessionGroups } from "./groups";
import { t } from "../i18n";

/** A commit's welcome, once, with every device it adds, or nothing for a commit that adds none. */
const welcomeFor = (welcome: Uint8Array | null, packages: { deviceId: string }[]): Pick<CommitRequest, "welcome" | "welcome_to"> =>
  welcome && packages.length > 0 ? { welcome, welcome_to: packages.map((item) => item.deviceId) } : {};

export abstract class SessionJoining extends SessionGroups {
  // --- Groups: joining ---

  protected async processWelcomes(): Promise<void> {
    // Each group a Welcome was used for, and whether its roster was taken on.
    const used = new Map<string, boolean>();
    // A Welcome whose roster couldn't be checked before, as when the server didn't answer or the app was
    // stopped in the middle, is checked again, whether or not the server still has it. One that can't be
    // yet waits for the next time, and keeps none of the others waiting.
    for (const groupId of [...this.welcomesUnchecked.keys()]) {
      await this.withLock(groupId, async () => {
        if (!this.welcomesUnchecked.has(groupId)) return;
        if (!this.groups.has(groupId)) this.applyGroup(await this.api.group(groupId));
        used.set(groupId, await this.afterJoining(groupId));
      }).catch((error) => console.warn("[zuna] checking a Welcome again", error));
    }
    const welcomes = await this.api.welcomes();
    for (const welcome of welcomes) {
      // Joined and checked under one hold of the group's lock, so that nothing else uses the group in between.
      await this.withLock(welcome.group_id, async () => {
        if (!(await this.consumeWelcome(welcome))) return;
        this.applyGroup(await this.api.group(welcome.group_id));
        used.set(welcome.group_id, await this.afterJoining(welcome.group_id));
      });
    }
    // One refused is caught up on too: the join that follows it takes the group as it is now.
    for (const groupId of used.keys()) {
      this.retryUndecryptable(groupId);
      this.backgroundSync(groupId);
    }
    if (used.size > 0) this.emitConversations();
    if ([...used.values()].some(Boolean)) await this.uploadEpochKeys();
  }

  /** Uses welcomes for one group. The caller must already hold that group's lock. */
  protected async processWelcomesFor(groupId: string): Promise<void> {
    const welcomes = await this.api.welcomes();
    let joined = false;
    for (const welcome of welcomes) {
      if (welcome.group_id === groupId && (await this.consumeWelcome(welcome))) joined = true;
    }
    if (joined) {
      await this.afterJoining(groupId);
      this.retryUndecryptable(groupId);
      this.uploadEpochKeysSoon();
    }
  }

  /**
   * Whoever else is in a group just joined by Welcome is checked before trusting it, and only then does
   * anything of the join count: when it began, its epoch's key, and so what goes into the vault. Whether
   * it was taken on. One that couldn't be checked, as when the server didn't answer, is checked again
   * the next time welcomes are, and meanwhile nothing is sealed to the group (`ensureTreeClean`).
   */
  protected async afterJoining(groupId: string): Promise<boolean> {
    const unchecked = this.welcomesUnchecked.has(groupId);
    if (unchecked && !this.hasMlsGroup(groupId)) {
      // Stopped between noting the Welcome and keeping what MLS made of it: there's nothing to check.
      this.forgetWelcome(groupId);
      return false;
    }
    if (!(await this.adoptJoinedRoster(groupId))) return false;
    if (unchecked) {
      const welcomed = this.welcomesUnchecked.get(groupId) ?? null;
      this.db.transaction(() => {
        this.forgetWelcome(groupId);
        // One whose record didn't open is taken as joined now, which is as careful as it gets.
        this.setJoinedEpoch(groupId, welcomed?.epoch ?? this.mlsEpoch(groupId));
        if (welcomed) this.saveEpochKey(groupId, welcomed.epoch, welcomed.key, "mls");
      });
      // Who was in the tree then, and the current epoch's key, if the group has moved on since.
      this.rememberCurrentEpochKey(groupId);
    }
    await this.checkTree(groupId);
    this.setKnownMembers(groupId, this.treeUsers(groupId));
    this.noteIfUnwanted(groupId);
    this.scheduleReconcile(groupId);
    return true;
  }

  /**
   * A bot keeps its owner's rules itself. Brought into a group by someone its owner
   * doesn't let add it, which only a server that lies allows, it leaves. Whoever added
   * it is whoever signed the roster it came in on, which nobody else can have.
   */
  protected noteIfUnwanted(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!this.account.bot || group?.kind !== "group") return;
    const by = this.rosterOf(group)?.roster.by.userId;
    if (by && this.botMayBeAddedBy(by)) return;
    // Once whatever holds the group's lock is done with it, as leaving takes it too.
    setTimeout(() => {
      if (!this.stopped) void this.leaveGroup(groupId).catch((error) => console.warn("[zuna] leaving a group this bot shouldn't be in", error));
    }, 0);
  }

  /** Whether this account, a bot's, may be added to a group by someone: its owner always, and for a listed bot whoever its owner chose. */
  protected botMayBeAddedBy(userId: string): boolean {
    const rules = this.account.bot;
    if (!rules || userId === rules.ownerId) return true;
    if (!rules.listed) return false;
    const role = this.users.get(userId)?.role;
    return rules.add === "anyone" || (rules.add === "admins" && (role === "owner" || role === "admin"));
  }

  /** Whether this device holds a chat's keys now, so that it can read what's said there and send. */
  holdsKeys(groupId: string): boolean {
    const group = this.groups.get(groupId);
    return !!group && !group.removedAt && this.hasMlsGroup(groupId);
  }

  /**
   * Whether this account hears what's said in a chat. Everyone does, but a private bot in
   * a direct message: that's for its owner, and for people in a group with it. Anyone
   * else got there through a server that showed them a bot that isn't theirs to see.
   */
  hearsChat(groupId: string): boolean {
    const rules = this.account.bot;
    const group = this.groups.get(groupId);
    if (!rules || rules.listed || group?.kind !== "dm" || !group.peerId || group.peerId === rules.ownerId) return true;
    const peer = group.peerId;
    // In a group with it by its roster, which the server can't write.
    return [...this.groups.values()].some((other) => other.kind === "group" && !other.removedAt && !!this.rosterOf(other)?.roster.members.includes(peer) && other.members.some((member) => member.userId === peer));
  }

  /**
   * Takes on the roster a group joined by Welcome came with. Whoever added this device
   * vouches for it, but it can't go back on a version this device already held. If it
   * doesn't hold up, the group is left again.
   */
  protected async adoptJoinedRoster(groupId: string): Promise<boolean> {
    const bytes = this.rosterIn(groupId);
    const signer = this.unknownRosterSigner(groupId, bytes);
    if (signer) await this.ensureUser(signer, true);
    const refusal = this.rosterRefusal(groupId, bytes, null);
    if (refusal) {
      // One that only waits for this account's own word, or that's only older than it, is left for the join that follows it.
      if (refusal !== ROSTER_UNSAID && refusal !== ROSTER_BEHIND) this.warnOnce(`roster/${groupId}/${this.mlsEpoch(groupId)}`, t("security.untrustedInvitation", { reason: reasonText(refusal) }));
      this.forgetMlsState(groupId);
      return false;
    }
    if (bytes) this.setRoster(groupId, bytes);
    return true;
  }

  /**
   * A Welcome used and not yet checked: in memory, and on this device alone, sealed, for a restart in the
   * middle of the check. Nothing reads it as the group's: it isn't a joined epoch or an epoch key, so it
   * goes into no vault and stands for nobody's arrival.
   */
  protected rememberWelcome(groupId: string, epoch: number, key: Uint8Array): void {
    this.welcomesUnchecked.set(groupId, { epoch, key });
    this.db.run("INSERT OR REPLACE INTO welcomes_unchecked(group_id, data) VALUES(?, ?)", [groupId, this.sealJson("welcome", groupId, { epoch, key: toBase64(key) })]);
  }

  protected forgetWelcome(groupId: string): void {
    this.welcomesUnchecked.delete(groupId);
    this.db.run("DELETE FROM welcomes_unchecked WHERE group_id = ?", [groupId]);
  }

  /** Joins from a welcome and removes it. Returns whether this device joined. */
  protected async consumeWelcome(welcome: { id: number; group_id: string; data: string }): Promise<boolean> {
    let joined = false;
    if (!this.hasMlsGroup(welcome.group_id)) {
      try {
        const result = this.mls.joinFromWelcome(decode(welcome.data), utf8(welcome.group_id)) as { epoch: number };
        // Held apart until its roster is taken on (`afterJoining`), and noted before MLS keeps the join,
        // so that a device stopped in between still has both, or finds nothing to check.
        const key = this.mls.exportSecret(utf8(welcome.group_id), CONTENT_LABEL, u64Bytes(result.epoch), 32);
        this.rememberWelcome(welcome.group_id, result.epoch, key);
        this.saveMls();
        joined = true;
      } catch (error) {
        // Likely a stale welcome. The group is still reachable by an external join.
        console.warn("[zuna] couldn't use a welcome", error);
        this.saveMls();
      }
    }
    await this.api.deleteWelcome(welcome.id);
    return joined;
  }

  /**
   * Every leaf of a group's tree, and whether it is what it claims. This is the
   * one check on who holds a group's keys: its certificate has to be signed by the
   * identity key known for that person, for the very signing key the leaf uses, and
   * each device has one leaf. Certificates are public, so without that last part
   * anyone could use a real person's certificate with keys of their own.
   */
  protected treeMembers(groupId: string): TreeMember[] {
    const members = this.mls.members(utf8(groupId)) as { leafIndex: number; credential: Uint8Array; signatureKey: Uint8Array }[];
    const group = this.groups.get(groupId);
    const people = group?.kind === "dm" ? this.dmPeople(group) : null;
    const out: TreeMember[] = members.map((member) => {
      const cert = parseCertificate(member.credential);
      if (!cert) return { leaf: member.leafIndex, userId: "", deviceId: "", genuine: false };
      const found = { leaf: member.leafIndex, userId: cert.userId, deviceId: cert.deviceId };
      if (people && !people.includes(cert.userId)) return { ...found, genuine: false, outsider: true };
      // Someone not known yet is looked up by checkTree, which runs on any change to the tree.
      // Until that's worked, nothing about this leaf has been checked, so it counts for nothing.
      const pinned = this.pinnedIdentity(cert.userId);
      // An account made under a name another held counts for nothing, so no key is held for it, and its leaf is a false one.
      if (!pinned && this.loggedVoid(cert.userId)) return { ...found, genuine: false };
      if (!pinned) return { ...found, genuine: false, unchecked: true };
      // What the log says of them came without its body, and may be that this device was removed.
      if (this.keptBack(cert.userId)) return { ...found, genuine: false, unchecked: true };
      const standing = this.certificateStanding(cert.userId, pinned, member.credential);
      // A certificate from a generation the log has a link for, which the server hasn't handed over,
      // is a real device's: it waits for the link rather than being removed over it.
      if (!standing && cert.generation > this.headGeneration(cert.userId) && this.loggedGeneration(cert.userId) >= cert.generation) {
        return { ...found, genuine: false, unchecked: true };
      }
      // While the log can't be read as far as the server says it goes, only a device counted before counts.
      if (standing && !standing.logged) {
        const known = this.users.get(cert.userId)?.devices.get(cert.deviceId);
        if (!known || !equalBytes(known.signatureKey, standing.cert.signatureKey)) return { ...found, genuine: false, unchecked: true };
      }
      const genuine = !!standing?.carried && equalBytes(standing.cert.signatureKey, member.signatureKey);
      return standing?.gone ? { ...found, genuine, gone: true } : { ...found, genuine };
    });
    // A device ID is only someone's together with whose it is: another account can claim the same one.
    const seen = new Set<string>();
    for (const member of [...out].reverse()) {
      if (!member.genuine) continue;
      const device = `${member.userId}/${member.deviceId}`;
      if (seen.has(device)) member.genuine = false;
      seen.add(device);
    }
    return out;
  }

  protected treeUsers(groupId: string): string[] {
    return [...new Set(this.treeMembers(groupId).filter((member) => member.genuine).map((member) => member.userId))];
  }

  /** Looks up anyone in a group's tree not known yet, so they can be checked. */
  protected async learnTreeUsers(groupId: string): Promise<void> {
    const asked = Date.now();
    const members = this.mls.members(utf8(groupId)) as { credential: Uint8Array }[];
    // A leaf the log doesn't name yet has the log read to its newest head first: a device is in it
    // before it can join anything, so on an honest server it's there.
    const unnamed = members.some((member) => {
      const cert = parseCertificate(member.credential);
      const pinned = cert && this.pinnedIdentity(cert.userId);
      return !!cert && (!pinned || !this.certificateStanding(cert.userId, pinned, member.credential)?.logged);
    });
    if (unnamed) await this.syncLogIfBehind(asked);
    for (const member of members) {
      const cert = parseCertificate(member.credential);
      if (!cert) continue;
      // A certificate from a generation not seen yet says there's more of that person's chain to
      // read. If it's this person's own, this device is what's behind, and it catches up first.
      if (cert.userId === this.account.userId && cert.generation > this.headGeneration(cert.userId)) await this.syncAccount();
      else if (!this.pinnedIdentity(cert.userId) || cert.generation > this.headGeneration(cert.userId)) await this.ensureUser(cert.userId, true);
    }
  }

  /** Notes who's in a tree shared with this device, which is the only proof of how long a device has been around. */
  protected noteLeaves(groupId: string, members: TreeMember[] = this.treeMembers(groupId)): void {
    const missing = members.filter((member) => member.genuine && !this.recordedFirstLeaves.has(`${member.userId}/${member.deviceId}`));
    if (missing.length === 0) return;
    const now = Date.now();
    this.db.transaction(() => {
      for (const member of missing) {
        const key = `${member.userId}/${member.deviceId}`;
        this.db.run("INSERT OR IGNORE INTO device_first_leaf(user_id, device_id, at) VALUES(?, ?, ?)", [member.userId, member.deviceId, this.sealJson("first-leaf", key, now)]);
        this.recordedFirstLeaves.add(key);
      }
    });
  }

  /**
   * Checks a group's tree after anything that may have changed it, and warns about
   * any leaf that isn't what it claims. Those get removed by the next reconcile,
   * and at the latest before this device encrypts anything else (ensureTreeClean).
   */
  protected async checkTree(groupId: string): Promise<TreeMember[]> {
    this.treeUsersCache.delete(groupId);
    this.cleanEpochs.delete(groupId);
    await this.learnTreeUsers(groupId);
    const members = this.treeMembers(groupId);
    this.noteLeaves(groupId, members);
    const own = this.mls.ownLeafIndex(utf8(groupId));
    const bad = members.filter((member) => !member.genuine && !member.unchecked && member.leaf !== own);
    const group = this.groups.get(groupId);
    const unadmitted = group ? members.filter((member) => member.genuine && member.leaf !== own && !this.admitted(group, member.userId)) : [];
    for (const member of unadmitted) {
      const warned = `${groupId}/${member.leaf}/${this.mlsEpoch(groupId)}`;
      if (this.warnedLeaves.has(warned)) continue;
      this.warnedLeaves.add(warned);
      const owner = this.users.get(member.userId)?.profile.displayName;
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: member.userId,
        message: owner ? t("security.joinedWithoutAdmin", { name: owner }) : t("security.someoneJoinedWithoutAdmin"),
      });
      this.addSystemRow(groupId, Date.now(), member.userId, { type: "unexpected_join", actorId: member.userId });
    }
    for (const member of bad) {
      const warned = `${groupId}/${member.leaf}/${this.mlsEpoch(groupId)}`;
      if (this.warnedLeaves.has(warned)) continue;
      this.warnedLeaves.add(warned);
      const owner = member.userId ? this.users.get(member.userId)?.profile.displayName : null;
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: member.userId,
        message: member.outsider
          ? owner
            ? t("security.outsiderInDirectMessage", { name: owner })
            : t("security.someoneOutsiderInDirectMessage")
          : owner
            ? t("security.impostorDevice", { name: owner })
            : t("security.invalidCertificate"),
      });
      if (member.userId && this.groups.get(groupId)?.kind !== "channel") {
        this.addSystemRow(groupId, Date.now(), member.userId, { type: "unexpected_join", actorId: member.userId });
      }
    }
    if (bad.length > 0 || unadmitted.length > 0) this.scheduleReconcile(groupId);
    return bad;
  }

  protected knownMembers(groupId: string): Set<string> {
    const row = this.db.get<{ known_members: string }>("SELECT known_members FROM groups WHERE id = ?", [groupId]);
    return new Set(row ? (JSON.parse(row.known_members) as string[]) : []);
  }

  protected setKnownMembers(groupId: string, members: Iterable<string>): void {
    this.db.run("UPDATE groups SET known_members = ? WHERE id = ?", [JSON.stringify([...members]), groupId]);
  }

  /**
   * Joins a group without help from any member, for new or repaired devices.
   * Whatever state this device had stays until the server accepts the join, so
   * group info nobody can use, or a join that's refused, costs nothing.
   */
  protected async joinExternal(groupId: string): Promise<boolean> {
    const groupBytes = utf8(groupId);
    let learned = false;
    // A bot that wasn't on this group's roster before comes in on one, as by a Welcome, and asks who added it.
    const held = this.groups.get(groupId)?.roster;
    const wasOn = !!held && !!readRoster(groupId, fromBase64(held))?.roster.members.includes(this.account.userId);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      const latest = await this.api.groupInfo(groupId);
      if (!latest.group_info) return false;
      this.saveMls();
      let result: { commit: Uint8Array; epoch: number };
      let roster: Uint8Array | undefined;
      // Until the server takes the join, what runs meanwhile, such as typing or a voice room's signals, sees MLS
      // at the epoch the join makes, and keeps no key of it (`externalJoins`).
      this.externalJoins.add(groupId);
      try {
        result = this.mls.joinExternal(groupBytes, decode(latest.group_info)) as { commit: Uint8Array; epoch: number };
        // The group's roster has to follow from the one this device last held, before anyone hears of the join.
        roster = this.rosterIn(groupId);
        const refusal = this.rosterRefusal(groupId, roster, null);
        if (refusal) {
          this.mls.rollback();
          // Nothing is wrong: it's joined once another of this account's devices has said who's in it.
          if (refusal === ROSTER_UNSAID) return false;
          const signer = this.unknownRosterSigner(groupId, roster);
          if (signer && !learned) {
            learned = true;
            await this.ensureUser(signer, true);
            continue;
          }
          this.warnOnce(`roster/${groupId}/${result.epoch}`, t("security.couldntRejoin", { reason: reasonText(refusal) }));
          throw new Error(t("errors.untrustedState", { reason: reasonText(refusal) }));
        }
        const groupInfo = this.mls.exportGroupInfo(groupBytes);
        try {
          await this.api.commit(groupId, {
            expected_epoch: latest.epoch,
            commit: result.commit,
            group_info: groupInfo,
            // The join has already taken this device's state to the epoch it makes.
            send_key: wasm.signingPublic(this.mls.exportSecret(groupBytes, SEND_LABEL, u64Bytes(result.epoch), 32)),
            kind: "external",
          });
        } catch (error) {
          this.mls.rollback();
          if (error instanceof ApiError && error.code === "stale_epoch") continue;
          throw error;
        }
        this.saveMls();
      } finally {
        this.externalJoins.delete(groupId);
      }
      if (roster) this.setRoster(groupId, roster);
      this.setJoinedEpoch(groupId, result.epoch);
      this.rememberCurrentEpochKey(groupId);
      await this.checkTree(groupId);
      this.noteArrivalsAtJoin(groupId);
      if (!wasOn) this.noteIfUnwanted(groupId);
      this.uploadEpochKeysSoon();
      return true;
    }
    return false;
  }

  /**
   * Whoever is in a tree this device joins is known from then on. Who may be there isn't
   * this device's memory to judge: a group's roster says who was let in, a DM can only
   * hold its two people, and anyone can come into a channel, and checkTree has already
   * warned about anyone else.
   */
  protected noteArrivalsAtJoin(groupId: string): void {
    this.setKnownMembers(groupId, new Set([...this.knownMembers(groupId), ...this.treeUsers(groupId)]));
  }

  /** Makes sure this device can use the group, starting it if nobody has yet. */
  protected async ensureReady(groupId: string): Promise<void> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    this.refuseDoubtful(groupId);
    if (group.epoch === 0) {
      this.refuseRewind(groupId);
      await this.initGroup(group, []);
      return;
    }
    if (!this.hasMlsGroup(groupId)) {
      await this.joinExternal(groupId);
      await this.pullChanges(groupId);
    } else if (this.mlsEpoch(groupId) !== group.epoch) {
      await this.pullChanges(groupId);
    }
  }

  /** Leaves of other people's devices that look genuine, which the server doesn't list among their devices. */
  protected unlistedLeaves(groupId: string, members: TreeMember[] = this.treeMembers(groupId)): number[] {
    const roster = new Set(this.groups.get(groupId)?.members.map((member) => member.userId));
    return members
      .filter((member) => member.genuine && !member.gone && member.userId !== this.account.userId && roster.has(member.userId) && !this.users.get(member.userId)?.devices.has(member.deviceId))
      .map((member) => member.leaf);
  }

  /**
   * Removes anyone from the tree who shouldn't be in it, before this device
   * encrypts anything else: someone who just left or was banned, and any leaf that
   * isn't what it claims. What's sent next is under a key they don't have. A check
   * is remembered for its epoch, so sending stays quick.
   */
  /** Whether a leaf of someone in the group couldn't be checked yet, which nothing goes to until it is. */
  protected uncheckedInTree(groupId: string, members: TreeMember[]): boolean {
    const roster = new Set(this.groups.get(groupId)?.members.map((member) => member.userId));
    return members.some((member) => member.unchecked && roster.has(member.userId));
  }

  /**
   * The leaves a commit this device makes for something else takes out too, beside those it
   * removes itself, as carefully as `ensureTreeClean` would: only once the server has said who's in
   * the group now, as what's known here may be behind, and none while a leaf can't be checked or
   * one the server doesn't list may have gone in a way this device hasn't heard of. Then, or if the
   * server can't be asked, the commit goes as it was, and `ensureTreeClean` takes them out later.
   */
  protected async staleBeside(groupId: string, planned: number[]): Promise<number[]> {
    const extra = (leaves: number[]) => leaves.filter((leaf) => !planned.includes(leaf));
    try {
      if (extra(await this.staleLeaves(groupId)).length === 0) return [];
      this.applyGroup(await this.api.group(groupId));
      await this.checkTree(groupId);
      const members = this.treeMembers(groupId);
      if (this.uncheckedInTree(groupId, members) || this.unlistedLeaves(groupId, members).length > 0) return [];
      return extra(await this.staleLeaves(groupId, members));
    } catch (error) {
      console.warn("[zuna] looking for stale leaves to take out with a commit", error);
      return [];
    }
  }

  protected async ensureTreeClean(groupId: string): Promise<void> {
    if (!this.hasMlsGroup(groupId)) return;
    if (this.welcomesUnchecked.has(groupId)) throw new ApiError(0, "unchecked_member", t("errors.couldntCheckMembersYet"));
    const cached = this.groups.get(groupId);
    if (cached?.kind === "group" && !this.rosterOf(cached)) {
      throw new ApiError(0, "unchecked_member", t("errors.couldntCheckMembers"));
    }
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      if (this.cleanEpochs.get(groupId) === this.mlsEpoch(groupId)) return;
      await this.checkTree(groupId);
      // Nothing goes to a leaf nobody could check. This can wait until the server answers.
      const members = this.treeMembers(groupId);
      if (this.uncheckedInTree(groupId, members)) {
        throw new ApiError(0, "unchecked_member", t("errors.couldntCheckMembersYet"));
      }
      if ((await this.staleLeaves(groupId, members)).length === 0) {
        // A device of someone else's that the server no longer lists may have been removed in a way this
        // device hasn't heard of yet: nothing goes to it until the server says what became of it.
        if (this.unlistedLeaves(groupId, members).length > 0) throw new ApiError(0, "unchecked_member", t("errors.couldntCheckMembersYet"));
        this.cleanEpochs.set(groupId, this.mlsEpoch(groupId));
        return;
      }
      // What's known about the roster may be behind, so ask before removing anyone.
      this.applyGroup(await this.api.group(groupId));
      if ((await this.staleLeaves(groupId)).length === 0) continue;
      await this.commitWithRetry(groupId, async () => ({ kind: "update", removeLeaves: await this.staleLeaves(groupId) }));
    }
    throw new Error(t("errors.couldntSecureThisConversationRight"));
  }

  /**
   * Starts a group's MLS state. Two people may race to start a DM. The server
   * accepts one, and the loser receives a Welcome from the winner. Who gets the
   * keys is who the person asked for: the server's list is never what decides it.
   */
  protected async initGroup(group: ApiGroup, extraUsers: string[], meta?: GroupMeta): Promise<void> {
    const cached = this.groups.get(group.id);
    const selfId = this.account.userId;
    if (cached?.kind !== "dm" && cached?.kind !== "channel" && group.created_by !== selfId) throw new Error(t("errors.thisConversationHasntBeenStarted"));
    const targets = cached?.kind === "dm" ? this.dmPeople(cached) : [...new Set([selfId, ...extraUsers])];

    const groupBytes = utf8(group.id);
    if (!cached) throw new Error(t("errors.thisConversationHasntBeenStarted"));
    // A group starts with its creator as its admin, and whoever they asked for let in. A DM or a
    // channel starts with a charter, which says what it is, and a DM's who it's between, for good.
    const by = { userId: selfId, deviceId: this.account.deviceId };
    const roster =
      cached.kind === "group"
        ? sealRoster({ group: group.id, version: 1, admins: [selfId], members: targets, prev: "", by }, this.account.deviceSecret)
        : sealCharter({ group: group.id, kind: cached.kind, people: cached.kind === "dm" ? targets : [], by }, this.account.deviceSecret);
    this.mls.deleteGroup(groupBytes);
    this.mls.createGroup(groupBytes, roster);
    this.saveMls();

    // Every device comes into a channel by itself, if its app shows channels at all.
    const packages: { deviceId: string; data: Uint8Array }[] = [];
    for (const userId of cached?.kind === "channel" ? [] : targets) {
      packages.push(...(await this.claimKeyPackages(userId, group.id, this.account.deviceId)));
    }
    const pending = this.mls.commitChanges(groupBytes, packages.map((item) => item.data) as unknown as any[], new Uint32Array(0)) as {
      commit: Uint8Array;
      welcome: Uint8Array | null;
      groupInfo: Uint8Array | null;
    };
    this.saveMls();

    const newEpoch = 1;
    const key = this.mls.exportPendingSecret(groupBytes, CONTENT_LABEL, u64Bytes(newEpoch), 32);
    try {
      await this.api.commit(group.id, {
        expected_epoch: 0,
        commit: pending.commit,
        group_info: pending.groupInfo!,
        send_key: wasm.signingPublic(this.mls.exportPendingSecret(groupBytes, SEND_LABEL, u64Bytes(newEpoch), 32)),
        kind: "init",
        add_users: extraUsers,
        ...welcomeFor(pending.welcome, packages),
        meta: meta ? this.sealGroupDetails(group.id, key, newEpoch, meta, 1) : undefined,
        meta_epoch: meta ? newEpoch : undefined,
      });
    } catch (error) {
      this.mls.deleteGroup(groupBytes);
      this.saveMls();
      if (error instanceof ApiError && error.code === "stale_epoch") {
        // Another member started the group first; their welcome is waiting for us.
        await this.processWelcomesFor(group.id);
        if (!this.hasMlsGroup(group.id)) await this.joinExternal(group.id);
        await this.pullChanges(group.id);
        return;
      }
      throw error;
    }
    this.mls.mergePending(groupBytes);
    this.saveMls();
    if (roster) this.setRoster(group.id, roster);
    this.setJoinedEpoch(group.id, newEpoch);
    this.noteArrivals(group.id);
    this.saveEpochKey(group.id, newEpoch, key, "mls");
    this.treeUsersCache.delete(group.id);
    this.setKnownMembers(group.id, targets);
    this.noteLeaves(group.id);
    this.uploadEpochKeysSoon();
    const started = await this.api.group(group.id);
    this.applyGroup(started);
    if (meta) {
      const current = this.groups.get(group.id);
      if (current) {
        current.meta = meta;
        current.metaVersion = 1;
        this.persistGroup(current);
      }
    }
  }

  /**
   * Builds and sends one commit, retrying from the latest state if another
   * member's commit got in first. `build` runs fresh for each attempt.
   */
  protected async commitWithRetry(
    groupId: string,
    build: () => Promise<{
      keyPackages?: { deviceId: string; data: Uint8Array }[];
      removeLeaves?: number[];
      addUsers?: string[];
      removeUsers?: string[];
      meta?: GroupMeta;
      grants?: { user_id: string; data: Uint8Array }[];
      /** A new version of a group's roster, signed as this device. */
      roster?: Pick<Roster, "admins" | "members">;
      kind: string;
    }>,
  ): Promise<void> {
    const groupBytes = utf8(groupId);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      await this.pullChanges(groupId);
      const plan = await build();
      // Whoever shouldn't hold the group's keys goes in this commit too, whatever it's for, so the
      // epoch it makes, and what's sealed for that epoch with it, reaches none of them. Each leaf once.
      // A device leaving takes nobody out on its way: it won't hold the keys it would keep from them.
      const leaving = !!plan.roster && !plan.roster.members.includes(this.account.userId);
      const planned = plan.removeLeaves ?? [];
      const removeLeaves = [...new Set([...planned, ...(leaving ? [] : await this.staleBeside(groupId, planned))])];
      const epoch = this.mlsEpoch(groupId);
      const packages = plan.keyPackages ?? [];
      const roster = plan.roster ? this.nextRoster(groupId, plan.roster) : null;
      const pending = this.mls.commitChanges(
        groupBytes,
        packages.map((item) => item.data) as unknown as any[],
        Uint32Array.from(removeLeaves),
        roster,
      ) as { commit: Uint8Array; welcome: Uint8Array | null; groupInfo: Uint8Array | null };
      this.saveMls();
      const newEpoch = epoch + 1;
      const key = this.mls.exportPendingSecret(groupBytes, CONTENT_LABEL, u64Bytes(newEpoch), 32);
      const group = this.groups.get(groupId);
      const meta = plan.meta ?? group?.meta;
      // Sealing metadata for the new epoch lets newly added members read it. That's for admins, who signed it.
      const shouldSealMeta = !!group && !!meta && Object.keys(meta).length > 0 && this.isGroupAdmin(group, this.account.userId);
      try {
        await this.api.commit(groupId, {
          expected_epoch: epoch,
          commit: pending.commit,
          group_info: pending.groupInfo!,
          send_key: wasm.signingPublic(this.mls.exportPendingSecret(groupBytes, SEND_LABEL, u64Bytes(newEpoch), 32)),
          kind: plan.kind,
          add_users: plan.addUsers,
          remove_users: plan.removeUsers,
          ...welcomeFor(pending.welcome, packages),
          meta: shouldSealMeta ? this.sealGroupDetails(groupId, key, newEpoch, meta, Math.max(group.metaVersion ?? 0, 1)) : undefined,
          meta_epoch: shouldSealMeta ? newEpoch : undefined,
          history_grants: plan.grants,
          // The server's own list of admins follows the roster, when it lets this person change it.
          admins: plan.roster && group?.serverAdmins?.includes(this.account.userId) ? plan.roster.admins : undefined,
        });
      } catch (error) {
        this.mls.clearPending(groupBytes);
        this.saveMls();
        if (error instanceof ApiError && error.code === "stale_epoch") continue;
        throw error;
      }
      this.mls.mergePending(groupBytes);
      this.saveMls();
      if (roster) this.setRoster(groupId, roster);
      this.noteArrivals(groupId);
      this.saveEpochKey(groupId, newEpoch, key, "mls");
      this.treeUsersCache.delete(groupId);
      this.confirmedEpochs.set(groupId, newEpoch);
      this.noteLeaves(groupId);
      this.uploadEpochKeysSoon();
      if (removeLeaves.length > 0) this.announceConfirmedRemovals(groupId);
      return;
    }
    throw new Error(t("errors.theConversationIsVeryBusy"));
  }
}
