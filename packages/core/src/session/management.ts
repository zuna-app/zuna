// ServerSession, in part (see base.ts): the person's profile and account, verifying others, and managing groups.

import { decode } from "../api";
import { currentAuthKey, planPasswordChange, planRecoveryChange } from "../account";
import { safetyEmoji, sealHistoryGrant, sealProfile, signProfileAtGeneration, verifyHpkeKey } from "../crypto";
import type { Link } from "../generations";
import { equalBytes, fromBase64, toBase64 } from "../encoding";
import type { AvatarRef, DeviceView, GroupRole, Profile, SafetyCheck } from "../types";
import { rotationTiming, type GroupMeta, emptyProfile } from "./shared";
import { SessionSending } from "./sending";

export abstract class SessionManagement extends SessionSending {
  // --- Profile and account ---

  async updateProfile(changes: Partial<Profile>, avatarBlob?: Blob | null): Promise<void> {
    const self = this.users.get(this.account.userId);
    const profile: Profile = { ...(self?.profile ?? emptyProfile(this.account.username)), ...changes };
    let avatarFile: string | null | undefined = profile.avatar?.fileId ?? null;
    if (avatarBlob) {
      const ref = await this.uploadBlob(this.whole(avatarBlob));
      profile.avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
      avatarFile = ref.fileId;
    } else if (avatarBlob === null) {
      profile.avatar = null;
      avatarFile = null;
    }
    const { core, userId, username } = this.account;
    const sealed = sealProfile(core.communityKey, core.identitySecret, username, profile);
    const head = this.headOf(userId);
    await this.api.updateMe({
      profile: sealed,
      profile_sig: head ? signProfileAtGeneration(core.identitySecret, userId, head.gen, sealed) : undefined,
      avatar_file: avatarFile,
    });
  }

  async setHideLastSeen(hide: boolean): Promise<void> {
    await this.api.updateMe({ hide_last_seen: hide });
  }

  getDevices(): DeviceView[] {
    const self = this.users.get(this.account.userId);
    if (!self) return [];
    return [...self.devices.values()]
      .filter((device) => !device.revoked)
      .map((device) => ({
        id: device.id,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        isCurrent: device.id === this.account.deviceId,
        name: this.deviceNames.get(device.id) ?? "Device",
      }))
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastSeenAt - a.lastSeenAt);
  }

  /** Removes one of the account's other devices, and its access to every group. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.api.revokeDevice(deviceId);
    const self = await this.ensureUser(this.account.userId, true);
    const device = self?.devices.get(deviceId);
    if (device) device.revoked = true;
    for (const group of this.groups.values()) this.scheduleReconcile(group.id);
    this.rotateSoon(rotationTiming.gatherMs);
  }

  /**
   * The person says whether a new device of their account was them (`getNewDevices`). If it
   * wasn't, it's removed, as `revokeDevice` does, which replaces the account's keys too. Whoever
   * signed in on it still knows the secret it signed in with, which only changing keeps out.
   */
  async answerNewDevice(deviceId: string, mine: boolean): Promise<void> {
    if (!mine) {
      const device = this.users.get(this.account.userId)?.devices.get(deviceId);
      if (device && !device.revoked) await this.revokeDevice(deviceId);
      // One the server keeps out of this device's list has nothing to remove, and counts for
      // nobody once the account's keys are replaced without it.
      else this.rotateSoon(rotationTiming.gatherMs);
    }
    this.dropNewDevice(deviceId);
  }

  async changePassword(current: string, next: string): Promise<void> {
    const { username, core } = this.account;
    await this.rotate(await planPasswordChange(this.api, username, current, next, core));
  }

  async regenerateRecoveryKey(current: string): Promise<string> {
    const { username, core } = this.account;
    const { plan, recoveryKey } = await planRecoveryChange(this.api, username, current, core);
    await this.rotate(plan);
    return recoveryKey;
  }

  async signOut(): Promise<void> {
    await this.api.logout().catch((error) => console.warn("[zuna] logout", error));
    this.stop();
  }

  /**
   * Deletes this account on the server, once the password proves it's the person
   * asking. What they sent stays with everyone who has it, under "Deleted account".
   * ZunaClient.deleteAccount also erases this device's copy.
   */
  async deleteAccount(password: string): Promise<void> {
    const authKey = await currentAuthKey(this.api, this.account.username, password);
    this.deletingAccount = true;
    try {
      await this.api.deleteAccount(authKey);
    } catch (error) {
      this.deletingAccount = false;
      throw error;
    }
    this.stop();
  }

  // --- Identity verification ---

  safetyCheck(userId: string): SafetyCheck | null {
    const user = this.users.get(userId);
    if (!user) return null;
    // Only the keys in use now show that two people hold the same chain.
    const theirs = this.forkHeads.get(userId) ?? this.headOf(userId)?.identity ?? user.identityKey;
    return {
      emoji: safetyEmoji(this.account.core.identityPublic, theirs),
      trust: user.trust,
      covers: `heads:${toBase64(theirs)}`,
    };
  }

  /**
   * The person compared the emoji `covers` names, so that key is the only one this
   * goes by, whatever the server says by now. If nothing shown fits it any more,
   * nothing changes, and the emoji have to be compared again.
   */
  async markVerified(userId: string, covers: string): Promise<void> {
    const root = this.pinnedIdentity(userId);
    if (!root || !this.users.has(userId)) return;
    const [scheme, encoded] = covers.split(":");
    const outdated = new Error("What you compared isn't what the server shows now. Compare the emoji again.");
    if (scheme !== "heads") throw outdated;
    const compared = fromBase64(encoded ?? "");
    let pin = root;
    let chain: Link[] | null = null;
    if (!equalBytes(compared, this.headOf(userId)?.identity ?? root)) {
      // Only a chain ending in exactly that key can replace what's held.
      const shown = this.identityState(userId).forked ? await this.readWholeChain(userId, root).catch(() => null) : null;
      if (shown && equalBytes(shown.at(-1)?.identity ?? root, compared)) {
        chain = shown;
      } else {
        // Otherwise it's a first key that isn't the one known, which leaves a chain from that one with nothing to follow from.
        if (this.chainOf(userId).length > 0) throw outdated;
        pin = compared;
      }
    }
    const user = this.users.get(userId);
    if (!user || !equalBytes(user.identityKey, pin)) throw outdated;

    const repinned = !equalBytes(pin, root);
    const forked = !!this.identityState(userId).forked;
    this.db.transaction(() => {
      if (chain) {
        this.db.run("DELETE FROM identity_chain WHERE user_id = ?", [userId]);
        this.chains.delete(userId);
        for (const link of chain) this.acceptLink(userId, link);
      }
      if (forked) this.updateIdentityState(userId, { forked: 0, known_generation: 0, known_hash: null }, { chain: true });
      if (repinned) this.db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [this.sealPin(userId, pin), userId]);
      this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, this.sealVerified(userId, pin)]);
      this.noteUnsavedTrust({ verified: userId });
      this.setVerifiedPosition(userId, this.headGeneration(userId));
    });
    this.forkHeads.delete(userId);
    if (chain || forked || repinned) {
      const fresh = await this.api.user(userId).catch(() => null);
      if (fresh) this.applyUser(fresh);
      this.rescheduleAffectedByDeviceChange(userId);
    }
    this.refreshTrust(userId);
    this.emit({ type: "users", serverId: this.serverId });
    await this.saveTrust().catch((error) => console.warn("[zuna] saving a verification", error));
  }

  async clearVerification(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    // An empty key says it was cleared, which the manifest carries to other devices.
    this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, this.sealVerified(userId, new Uint8Array(0))]);
    this.noteUnsavedTrust({ verified: userId });
    user.trust = this.trustOf(userId, user.identityKey);
    this.persistUser(user);
    this.emit({ type: "users", serverId: this.serverId });
    await this.writeManifest();
  }

  // --- Group management ---

  async createGroup(name: string, memberIds: string[], historyVisible: boolean, avatarBlob?: Blob): Promise<string> {
    let avatar: AvatarRef | null = null;
    if (avatarBlob) {
      const ref = await this.uploadBlob(this.whole(avatarBlob), undefined, true);
      avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
    }
    const created = await this.api.createGroup(historyVisible);
    if (created.group.kind !== "group" || created.group.created_by !== this.account.userId) {
      throw new Error("The group wasn't created: the server's answer doesn't hold together.");
    }
    const groupId = created.group.id;
    this.applyGroup(created.group);
    await this.withLock(groupId, async () => {
      await this.initGroup(created.group, memberIds, { name, avatar, historyVisible });
      this.addSystemRow(groupId, Date.now(), this.account.userId, { type: "group_created", actorId: this.account.userId });
    });
    this.emitConversations();
    return groupId;
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.withLock(groupId, async () => {
      await this.commitWithRetry(groupId, async () => {
        const group = await this.api.group(groupId);
        const cached = this.applyGroup(group);
        const held = this.rosterOf(cached);
        if (!held || !held.roster.admins.includes(this.account.userId)) throw new Error("Only an admin of this group can add people.");
        // Someone the server lists but the roster doesn't was never let in, so they're added like anyone else.
        const missing = userIds.filter((id) => !group.members.some((member) => member.user_id === id) || !held.roster.members.includes(id));
        const packages: { deviceId: string; data: Uint8Array }[] = [];
        for (const userId of missing) packages.push(...(await this.claimKeyPackages(userId, groupId)));
        if (packages.length === 0) throw new Error("Those people have no devices available to add.");
        let grants: { user_id: string; data: Uint8Array }[] | undefined;
        if (this.sharesHistory(cached)) {
          // Hand older epoch keys to each new member, sealed so that only they can read them.
          grants = [];
          const keys = this.allEpochKeys(groupId);
          for (const userId of missing) {
            const user = await this.ensureUser(userId, true);
            // A bot reads what's said from when it was added, and gets nothing from before.
            if (!user || user.bot) continue;
            const apiUser = await this.api.user(userId);
            // A chain's newest link names this key itself, and was checked when it came.
            if (!this.headOf(userId) && !verifyHpkeKey(this.pinnedIdentity(userId) ?? user.identityKey, user.hpkeKey, decode(apiUser.hpke_key_sig))) continue;
            const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
            grants.push({ user_id: userId, data: sealHistoryGrant(user.hpkeKey, groupId, userId, signer, this.account.deviceSecret, keys) });
          }
        }
        const roster = { admins: held.roster.admins, members: [...held.roster.members, ...missing.filter((id) => !held.roster.members.includes(id))] };
        return { kind: "members", keyPackages: packages, addUsers: missing, grants, roster };
      });
      const known = this.knownMembers(groupId);
      for (const id of userIds) known.add(id);
      this.setKnownMembers(groupId, known);
      this.addSystemRow(groupId, Date.now(), this.account.userId, {
        type: "member_added",
        actorId: this.account.userId,
        targetIds: userIds,
      });
    });
    this.emitConversations();
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.withLock(groupId, async () => {
      await this.commitWithRetry(groupId, async () => {
        const held = this.rosterOf(this.groups.get(groupId)!);
        return {
          kind: "members",
          removeLeaves: this.treeMembers(groupId)
            .filter((member) => member.userId === userId)
            .map((member) => member.leaf),
          removeUsers: [userId],
          roster: held ? { admins: held.roster.admins.filter((id) => id !== userId), members: held.roster.members.filter((id) => id !== userId) } : undefined,
        };
      });
      const known = this.knownMembers(groupId);
      known.delete(userId);
      this.setKnownMembers(groupId, known);
      this.addSystemRow(groupId, Date.now(), this.account.userId, {
        type: "member_removed",
        actorId: this.account.userId,
        targetIds: [userId],
      });
    });
    this.emitConversations();
  }

  async leaveGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    const self = this.account.userId;
    // Off the roster first, so that nobody can bring this person back without an admin.
    if (group?.kind === "group" && !group.removedAt && this.hasMlsGroup(groupId) && this.rosterOf(group)?.roster.members.includes(self)) {
      await this.withLock(groupId, () =>
        this.commitWithRetry(groupId, async () => {
          const held = this.rosterOf(this.groups.get(groupId)!)!;
          return { kind: "update", roster: { admins: held.roster.admins.filter((id) => id !== self), members: held.roster.members.filter((id) => id !== self) } };
        }),
      ).catch((error) => console.warn("[zuna] leaving a group's roster", error));
    }
    await this.api.leaveGroup(groupId);
    this.removeGroupLocally(groupId);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.api.deleteGroup(groupId);
    this.removeGroupLocally(groupId);
  }

  async updateGroupMeta(groupId: string, changes: GroupMeta, avatarBlob?: Blob | null, historyVisible?: boolean): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;
    const meta: GroupMeta = { ...group.meta, ...changes };
    if (historyVisible !== undefined) meta.historyVisible = historyVisible;
    if (avatarBlob) {
      const ref = await this.uploadBlob(this.whole(avatarBlob), undefined, true);
      meta.avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
    } else if (avatarBlob === null) {
      meta.avatar = null;
    }
    const version = (group.metaVersion ?? 0) + 1;
    await this.withLock(groupId, async () => {
      await this.ensureTreeClean(groupId);
      const epoch = this.rememberCurrentEpochKey(groupId);
      const key = this.epochKey(groupId, epoch)!;
      await this.api.setGroupMeta(groupId, this.sealGroupDetails(groupId, key, epoch, meta, version), epoch, historyVisible);
    });
    const current = this.groups.get(groupId) ?? group;
    const timerChanged = (meta.disappearAfter ?? 0) !== this.disappearAfter(current);
    current.meta = meta;
    current.metaVersion = version;
    this.persistGroup(current);
    if (timerChanged) this.noteTimerChange(groupId, this.account.userId, meta.disappearAfter ?? 0);
    this.emitConversations();
  }

  /** Makes someone a group's admin, or not, in its roster, which the server's list then follows. */
  async setGroupRole(groupId: string, userId: string, role: GroupRole): Promise<void> {
    await this.withLock(groupId, () =>
      this.commitWithRetry(groupId, async () => {
        const held = this.rosterOf(this.groups.get(groupId)!);
        if (!held?.roster.admins.includes(this.account.userId)) throw new Error("Only an admin of this group can change who its admins are.");
        if (!held.roster.members.includes(userId)) throw new Error("They aren't in this group.");
        const admins = role === "admin" ? [...new Set([...held.roster.admins, userId])] : held.roster.admins.filter((id) => id !== userId);
        return { kind: "update", roster: { admins, members: held.roster.members } };
      }),
    );
    this.emitConversations();
  }
}
