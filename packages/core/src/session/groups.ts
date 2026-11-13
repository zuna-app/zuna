// ServerSession, in part (see base.ts): epoch keys, key packages, and what this device keeps of each group.

import * as wasm from "@zuna/crypto";
import { ApiError, decode, type ApiGroup } from "../api";
import {
  CONTENT_LABEL,
  SEND_LABEL,
  checkEnvelope,
  openSignal,
  readSigned,
  readSignedGroupDetails,
  sealSignal,
  signGroupDetails,
  type DeviceCertificate,
  type Signer,
  subkey,
} from "../crypto";
import { equalBytes, fromBase64, toBase64, u64Bytes, utf8 } from "../encoding";
import { foundingSigner, readFounding, readRoster, rosterHash, rosterJump, rosterStep, sealRoster, type Founding, type Roster, type RosterContext, type SignedRoster } from "../roster";
import { sealedRows } from "../sendable";
import { parseGroupDetails, parseReadState } from "../validate";
import {
  CLAIM_ATTEMPTS,
  CLAIM_WAIT_MS,
  KEY_PACKAGE_TARGET,
  KEY_PACKAGE_LOW,
  LAST_RESORT_MAX_AGE_MS,
  REMOVED_KEPT_MS,
  KEY_NOT_UPLOADED,
  KEY_UPLOADED,
  KEY_UNPROVEN,
  KEY_VOIDED,
  KIND_WARNING,
  type GroupMeta,
  type CachedGroup,
} from "./shared";
import { SessionRotation } from "./rotation";

const KIND_NAMES = { group: "a group", dm: "a direct message", channel: "a channel" } as const;

export abstract class SessionGroups extends SessionRotation {
  // --- Epoch keys ---

  protected epochCacheKey(groupId: string, epoch: number): string {
    return `${groupId}:${epoch}`;
  }

  /**
   * Stores an epoch's key. What MLS itself gives is always right. A key from this
   * account's vault or from a grant only fills a gap, and a granted one isn't
   * passed on to the vault until it has opened a properly signed message.
   */
  protected saveEpochKey(groupId: string, epoch: number, key: Uint8Array, source: "mls" | "vault" | "grant"): void {
    if (source === "mls") {
      this.epochKeys.set(this.epochCacheKey(groupId, epoch), key);
      this.db.run(
        `INSERT OR REPLACE INTO epoch_keys(group_id, epoch, key, uploaded, created_at) VALUES(?, ?, ?, ?, ?)`,
        [groupId, epoch, this.sealLocal("epoch", `${groupId}:${epoch}`, key), KEY_NOT_UPLOADED, Date.now()],
      );
      return;
    }
    // A key from an undone epoch of the same number is no reason to turn the account's own copy away.
    if (source === "vault" && this.db.get("SELECT 1 FROM epoch_keys WHERE group_id = ? AND epoch = ? AND uploaded = ?", [groupId, epoch, KEY_VOIDED])) {
      this.db.run("DELETE FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, epoch]);
      this.epochKeys.delete(this.epochCacheKey(groupId, epoch));
    }
    this.db.run(
      `INSERT OR IGNORE INTO epoch_keys(group_id, epoch, key, uploaded, created_at) VALUES(?, ?, ?, ?, ?)`,
      [groupId, epoch, this.sealLocal("epoch", `${groupId}:${epoch}`, key), source === "vault" ? KEY_UPLOADED : KEY_UNPROVEN, Date.now()],
    );
  }

  /** A granted key opened a properly signed message, so it's real enough to keep for other devices. */
  protected keyProvedItself(groupId: string, epoch: number): void {
    this.db.run("UPDATE epoch_keys SET uploaded = ? WHERE group_id = ? AND epoch = ? AND uploaded = ?", [KEY_NOT_UPLOADED, groupId, epoch, KEY_UNPROVEN]);
  }

  protected joinedEpoch(groupId: string): number | null {
    const row = this.db.get<{ epoch: Uint8Array }>("SELECT epoch FROM joined_epochs WHERE group_id = ?", [groupId]);
    // Joined at the very start, as far as anything that doesn't open says, so every message is checked.
    const sealed = sealedRows.joined;
    return row ? this.openValue(sealed.name, sealed.row(groupId), row.epoch, sealed.careful) : null;
  }

  protected setJoinedEpoch(groupId: string, epoch: number): void {
    this.db.run("INSERT OR REPLACE INTO joined_epochs(group_id, epoch) VALUES(?, ?)", [groupId, this.sealJson("joined", groupId, epoch)]);
  }

  protected epochKey(groupId: string, epoch: number): Uint8Array | null {
    const cacheKey = this.epochCacheKey(groupId, epoch);
    const cached = this.epochKeys.get(cacheKey);
    if (cached) return cached;
    const row = this.db.get<{ key: Uint8Array }>("SELECT key FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, epoch]);
    if (!row) return null;
    const key = this.openLocal("epoch", `${groupId}:${epoch}`, row.key);
    this.epochKeys.set(cacheKey, key);
    return key;
  }

  /**
   * Makes sure the key held for the current epoch is the one MLS gives. Nothing
   * is ever encrypted under a key from anywhere else, so a key someone planted
   * in advance is found out as soon as its epoch arrives, instead of being used.
   */
  protected rememberCurrentEpochKey(groupId: string): number {
    const groupBytes = utf8(groupId);
    const epoch = this.mls.epoch(groupBytes);
    // An epoch an external join may yet lose has no key to keep: one kept here would stand in the way of the
    // real one, for that epoch's messages and anything sealed under it, and nothing is sealed under it meanwhile.
    if (this.confirmedEpochs.get(groupId) === epoch || this.externalJoins.has(groupId)) return epoch;
    this.noteArrivals(groupId);
    const real = this.mls.exportSecret(groupBytes, CONTENT_LABEL, u64Bytes(epoch), 32);
    const stored = this.epochKey(groupId, epoch);
    if (!stored || !equalBytes(stored, real)) {
      const voided = !!this.db.get("SELECT 1 FROM epoch_keys WHERE group_id = ? AND epoch = ? AND uploaded = ?", [groupId, epoch, KEY_VOIDED]);
      this.saveEpochKey(groupId, epoch, real, "mls");
      if (stored && !voided) {
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId: "",
          message: "A wrong key had been planted for one of your conversations. It was replaced with the real one.",
        });
      }
    }
    this.confirmedEpochs.set(groupId, epoch);
    return epoch;
  }

  /**
   * The current epoch's send key, which sealed requests are signed with, as every member of
   * the epoch can make it. It comes straight from the MLS exporter, as a call's key does, and
   * is never stored or handed on, so holding old content keys gives no way to write.
   */
  protected sendKey(groupId: string): { epoch: number; secret: Uint8Array; public: Uint8Array } {
    const groupBytes = utf8(groupId);
    const epoch = this.mls.epoch(groupBytes);
    const secret = this.mls.exportSecret(groupBytes, SEND_LABEL, u64Bytes(epoch), 32);
    return { epoch, secret, public: wasm.signingPublic(secret) };
  }

  protected allEpochKeys(groupId: string): Record<number, string> {
    const rows = this.db.all<{ epoch: number; key: Uint8Array }>("SELECT epoch, key FROM epoch_keys WHERE group_id = ?", [groupId]);
    return Object.fromEntries(rows.map((row) => [row.epoch, toBase64(this.openLocal("epoch", `${groupId}:${row.epoch}`, row.key))]));
  }

  // --- Key packages ---

  protected async topUpKeyPackages(): Promise<void> {
    const status = await this.api.keyPackageStatus();
    const needOneTime = status.count < KEY_PACKAGE_LOW ? KEY_PACKAGE_TARGET - status.count : 0;
    // A device without one counts as stale too, as the server says 0 for when it was made.
    const lastResortStale = Date.now() - status.last_resort_at > LAST_RESORT_MAX_AGE_MS;
    if (needOneTime === 0 && !lastResortStale) return;
    const packages: Uint8Array[] = [];
    for (let i = 0; i < needOneTime; i++) packages.push(this.mls.generateKeyPackage(false));
    const lastResort = lastResortStale ? this.mls.generateKeyPackage(true) : undefined;
    this.saveMls();
    await this.api.addKeyPackages(packages, lastResort);
  }

  /**
   * The server lets one person take another's key packages only so often, so
   * that nobody can use up someone's one-time packages. Past that, as when
   * adding the same person to many groups at once, it waits for the next one.
   */
  protected async claimWithPatience(userId: string, groupId: string): Promise<{ device_id: string; data: string }[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.api.claimKeyPackages(userId, groupId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || attempt >= CLAIM_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, CLAIM_WAIT_MS));
      }
    }
  }

  /**
   * Claims key packages for a user's devices, to bring them into the chat `groupId`,
   * keeping only ones their identity key vouches for.
   */
  protected async claimKeyPackages(userId: string, groupId: string, exceptDevice?: string): Promise<{ deviceId: string; data: Uint8Array }[]> {
    const user = await this.ensureUser(userId, true);
    if (!user) return [];
    const pinned = this.pinnedIdentity(userId) ?? user.identityKey;
    const claimed = await this.claimWithPatience(userId, groupId);
    const valid: { deviceId: string; data: Uint8Array }[] = [];
    for (const item of claimed) {
      if (item.device_id === exceptDevice) continue;
      const data = decode(item.data);
      let credential: Uint8Array;
      try {
        credential = this.mls.keyPackageCredential(data);
      } catch {
        continue;
      }
      // Certificates are public, so one in a package proves nothing unless the
      // package really signs with the key that certificate names.
      const standing = this.certificateStanding(userId, pinned, credential);
      const known = user.devices.get(item.device_id);
      const genuine =
        !!standing?.carried &&
        standing.cert.userId === userId &&
        standing.cert.deviceId === item.device_id &&
        !!known &&
        !known.revoked &&
        equalBytes(this.mls.keyPackageSignatureKey(data), standing.cert.signatureKey);
      if (!genuine) {
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId,
          message: `The server offered a device for ${user.profile.displayName} that isn't really theirs. It was not added.`,
        });
        continue;
      }
      valid.push({ deviceId: item.device_id, data });
    }
    return valid;
  }

  // --- Groups: state ---

  protected dmWith(userId: string): CachedGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.kind === "dm" && group.peerId === userId) return group;
    }
    return undefined;
  }

  protected warnOnce(key: string, message: string, userId = ""): void {
    if (this.warnedLeaves.has(key)) return;
    this.warnedLeaves.add(key);
    this.emit({ type: "security", serverId: this.serverId, userId, message });
  }

  /** The two people of a DM, or the one, for saved messages. */
  protected dmPeople(group: CachedGroup): string[] {
    return [...new Set([this.account.userId, group.peerId ?? this.account.userId])];
  }

  /** Whether this device has been part of a group, so that a server saying it never started is wrong. */
  protected startedHere(groupId: string): boolean {
    if (this.joinedEpoch(groupId) !== null) return true;
    if (this.db.get("SELECT 1 FROM epoch_keys WHERE group_id = ? LIMIT 1", [groupId])) return true;
    return this.hasMlsGroup(groupId) && this.mlsEpoch(groupId) > 0;
  }

  /**
   * Starting a group over would mean believing the server about who's in it, with
   * nothing to compare it with, so a group that has already started never does.
   */
  protected refuseRewind(groupId: string): void {
    if (!this.startedHere(groupId)) return;
    this.warnOnce(`rewind/${groupId}`, "The server claimed one of your conversations never started, which can't be right. Zuna didn't start it over, so that conversation won't work until the server stops claiming this.");
    throw new Error("This conversation can't be used right now because the server sent an invalid response about it.");
  }

  protected refuseDoubtful(groupId: string): void {
    if (this.groups.get(groupId)?.doubtful) throw new Error("This conversation can't be used: the server listed more than two people in a direct message.");
  }

  protected applyGroup(api: ApiGroup): CachedGroup {
    const previous = this.groups.get(api.id);
    const selfId = this.account.userId;
    // What a conversation is, and for a DM who it's with, is settled when it's first seen: from
    // what this account's vault kept its keys under, when it holds any, which the server can't
    // write. Only where there's nothing else does the server's word count, and the conversation's
    // own MLS state is held to it as soon as this device joins (rosterRefusal). A DM is between two people.
    const vaulted = this.vaultKind(api.id);
    const known = vaulted && vaulted !== "disputed" ? vaulted : null;
    const kind = previous?.kind ?? known?.kind ?? api.kind;
    if (kind !== api.kind) this.warnOnce(`kind/${api.id}`, KIND_WARNING);
    const others = [...new Set(api.members.map((member) => member.user_id))].filter((id) => id !== selfId);
    let peerId: string | null = null;
    let doubtful = false;
    if (kind === "dm") {
      if (previous && !previous.doubtful) {
        peerId = previous.peerId;
      } else if (known?.peerId) {
        peerId = known.peerId;
      } else {
        // Someone banned or gone is off the list, but not out of the conversation.
        peerId = others[0] ?? api.dm_users?.find((id) => id !== selfId) ?? previous?.peerId ?? selfId;
        doubtful = others.length > 1;
      }
      if (others.some((id) => id !== peerId)) {
        this.warnOnce(`dm-roster/${api.id}`, "The server listed someone else in one of your direct messages. They were removed, and the conversation's keys are being changed so they can't read it.");
      }
    }
    let listed = api.members.filter((member) => kind !== "dm" || member.user_id === selfId || member.user_id === peerId);
    if (kind === "channel") {
      // Nobody without the community key can be on a channel's roster, and leaving them
      // off it means they're taken out of its tree, whatever the server says.
      const held = listed.filter((member) => this.holdsCommunityKey(api.id, member.user_id, member.proof));
      if (held.length !== listed.length) this.warnOnce(`channel-roster/${api.id}/${listed.length - held.length}`, "The server listed someone in a channel who isn't really part of this server. They were removed, and the conversation's keys are being changed so they can't read it.");
      listed = held;
    }
    const group: CachedGroup = {
      id: api.id,
      kind,
      peerId,
      epoch: api.epoch,
      seq: api.seq,
      meta: previous?.meta ?? {},
      metaBlob: api.meta,
      metaEpoch: api.meta_epoch,
      metaVersion: previous?.metaVersion ?? 0,
      createdAt: api.created_at,
      members: listed.map((member) => ({ userId: member.user_id, role: member.role, joinedAt: member.joined_at })),
      roster: previous?.roster,
      rosterBefore: previous?.rosterBefore,
      serverAdmins: listed.filter((member) => member.role === "admin").map((member) => member.user_id),
      readStates: Object.fromEntries(listed.map((member) => [member.user_id, member.read_state])),
      readBy: previous?.readBy ?? {},
      ownRead: previous?.ownRead ?? 0,
      readSent: previous?.readSent,
      // The server listing us as a member means we're in it after all.
      removedAt: null,
      pendingRemovals: previous?.pendingRemovals,
      doubtful,
      historyWanted: listed.filter((member) => member.history_wanted).map((member) => member.user_id),
    };
    this.showRosterRoles(group);
    this.groups.set(api.id, group);
    this.checkSendKey(api.id, api.epoch, api.send_key);
    this.refreshGroupSecrets(group);
    this.persistGroup(group);
    if (group.historyWanted?.length) this.scheduleHistoryGrants(group.id);
    return group;
  }

  /** This device, as what it signs names it. */
  protected get signer(): Signer {
    return { userId: this.account.userId, deviceId: this.account.deviceId };
  }

  /** A group's admins are whoever its roster names, which MLS holds. A channel's are the server's. */
  protected isGroupAdmin(group: CachedGroup, userId: string): boolean {
    if (group.kind === "group") return !!this.rosterOf(group)?.roster.admins.includes(userId);
    return group.members.find((member) => member.userId === userId)?.role === "admin";
  }

  protected rosterOf(group: CachedGroup): SignedRoster | null {
    if (!group.roster) return null;
    const cached = this.rosters.get(group.id);
    if (cached?.text === group.roster) return cached.signed;
    const signed = readRoster(group.id, fromBase64(group.roster));
    this.rosters.set(group.id, { text: group.roster, signed });
    return signed;
  }

  /**
   * Whether someone was let into a group: its roster names them. Being on the server's
   * list isn't enough, since the server can put anyone there. Before this device holds
   * a roster nobody is turned away, but it doesn't send anything either (ensureTreeClean).
   */
  protected admitted(group: CachedGroup, userId: string): boolean {
    if (group.kind !== "group") return true;
    const roster = this.rosterOf(group);
    return !roster || roster.roster.members.includes(userId);
  }

  /** In a group, the roles shown are the roster's. */
  protected showRosterRoles(group: CachedGroup): void {
    const roster = group.kind === "group" ? this.rosterOf(group) : null;
    if (!roster) return;
    group.members = group.members.map((member) => ({ ...member, role: roster.roster.admins.includes(member.userId) ? "admin" : "member" }));
  }

  protected rosterIn(groupId: string): Uint8Array | undefined {
    return this.mls.roster(utf8(groupId)) ?? undefined;
  }

  protected setRoster(groupId: string, bytes: Uint8Array): void {
    const group = this.groups.get(groupId);
    if (!group || (group.roster && equalBytes(fromBase64(group.roster), bytes))) return;
    group.rosterBefore = group.roster;
    group.roster = toBase64(bytes);
    this.showRosterRoles(group);
    this.persistGroup(group);
  }

  protected rosterContext(group: CachedGroup, prev: SignedRoster, next: SignedRoster): RosterContext {
    const listed = new Set(group.members.map((member) => member.userId));
    return { adminPresent: prev.roster.admins.some((id) => listed.has(id)), signerServerAdmin: !!group.serverAdmins?.includes(next.roster.by.userId) };
  }

  /** Who signed a roster or charter, if this device doesn't know their device yet. */
  protected unknownRosterSigner(groupId: string, bytes: Uint8Array | undefined): string | null {
    const founding = bytes && readFounding(groupId, bytes);
    const by = founding ? foundingSigner(founding) : null;
    return by && !this.users.get(by.userId)?.devices.has(by.deviceId) ? by.userId : null;
  }

  /**
   * Why a conversation's MLS context can't become `bytes`, what MLS now holds, or null if it can.
   * A group's has its roster, and a DM's or a channel's its charter (roster.ts), which say what it
   * is: what this device holds it as has to be that, whatever the server calls it. It runs between
   * applying a change and keeping it, so it only uses what's already known. `committer` made the
   * change; without one, it came with a conversation joined, or joined again.
   */
  protected rosterRefusal(groupId: string, bytes: Uint8Array | undefined, committer: DeviceCertificate | null): string | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const founding = bytes ? readFounding(groupId, bytes) : null;
    if (founding && founding.kind !== group.kind) return `it's ${KIND_NAMES[founding.kind]} rather than ${KIND_NAMES[group.kind]}`;
    if (group.kind !== "group") return this.charterRefusal(group, bytes, founding);
    const held = this.rosterOf(group);
    if (!bytes) return held ? "it took the group's roster away" : "the group has no roster";
    if (held && equalBytes(bytes, held.bytes)) return null;
    const next = readRoster(groupId, bytes);
    if (!next) return "its roster isn't one";
    const { userId, deviceId } = next.roster.by;
    const device = this.users.get(userId)?.devices.get(deviceId);
    if (!device || device.revoked || !next.signedBy(device.signatureKey)) return "its roster isn't signed by a device of whoever it names";
    if (committer && (committer.userId !== userId || committer.deviceId !== deviceId)) return "its roster was signed by someone other than whoever made the change";
    if (!held) return null;
    // A change this device took on may have been undone since, as one nobody else could apply.
    if (!committer && group.rosterBefore && equalBytes(bytes, fromBase64(group.rosterBefore))) return null;
    const context = this.rosterContext(group, held, next);
    return committer ? rosterStep(held, next, context) : rosterJump(held, next, context);
  }

  /**
   * Why a DM's or a channel's charter can't be `bytes`. It's written once, when the conversation
   * starts, so it never changes from the one this device holds. A DM's names its two people, and
   * one of them signed it. One started before charters has none, and its keys only ever go with
   * what this account's vault kept them under (`vaultKind`).
   */
  protected charterRefusal(group: CachedGroup, bytes: Uint8Array | undefined, founding: Founding | null): string | null {
    const held = group.roster ? fromBase64(group.roster) : null;
    if (held) return bytes && equalBytes(bytes, held) ? null : "what it says it is was changed";
    if (!bytes) return null;
    if (!founding || founding.kind === "group") return "what it says it is can't be read";
    const { charter } = founding.signed;
    if (group.kind === "dm") {
      const people = this.dmPeople(group);
      if (charter.people.length !== people.length || people.some((id) => !charter.people.includes(id))) return "it's between other people";
      if (!charter.people.includes(charter.by.userId)) return "neither of its people started it";
    }
    // Whoever started it may have signed out of that device since: it was theirs when it signed, as for a message.
    const key = this.deviceKey(charter.by);
    return key && founding.signed.signedBy(key) ? null : "it isn't signed by a device of whoever it names";
  }

  /** The next version of a group's roster, signed by this device. */
  protected nextRoster(groupId: string, change: Pick<Roster, "admins" | "members">): Uint8Array {
    const group = this.groups.get(groupId);
    const held = group && this.rosterOf(group);
    if (!held) throw new Error("Couldn't check who's in this group yet. Please try again.");
    const by = { userId: this.account.userId, deviceId: this.account.deviceId };
    return sealRoster({ group: groupId, version: held.roster.version + 1, admins: change.admins, members: change.members, prev: rosterHash(held.bytes), by }, this.account.deviceSecret);
  }

  /** Decrypts whatever group metadata and read positions the keys held allow. */
  protected refreshGroupSecrets(group: CachedGroup): void {
    if (group.metaBlob && group.metaEpoch !== null) {
      const key = this.epochKey(group.id, group.metaEpoch);
      if (key) this.acceptGroupDetails(group, openSignal<unknown>(key, "meta", group.id, fromBase64(group.metaBlob)));
    }
    for (const [userId, state] of Object.entries(group.readStates)) {
      if (state) this.applyReadState(group, userId, fromBase64(state));
    }
  }

  /**
   * Takes on a group's details if an admin's device signed them and they aren't
   * older than what's held. Anyone with an epoch key could write some, and the
   * server could serve old ones. What doesn't hold up, an admin's app replaces.
   */
  protected acceptGroupDetails(group: CachedGroup, opened: unknown): void {
    if (opened === null) return;
    const signed = readSignedGroupDetails(group.id, opened);
    if (!signed) {
      this.resealIfAdmin(group);
      return;
    }
    if (signed.version < (group.metaVersion ?? 0)) return;
    const device = this.users.get(signed.signer.userId)?.devices.get(signed.signer.deviceId);
    if (!device) {
      // Not known yet. Looked up, and read again once that's done.
      void this.ensureUser(signed.signer.userId, true)
        .then((user) => {
          if (user?.devices.has(signed.signer.deviceId) && this.groups.get(group.id) === group) {
            this.refreshGroupSecrets(group);
            this.persistGroup(group);
            this.emitConversations();
          }
        })
        .catch(() => undefined);
      return;
    }
    const details = parseGroupDetails(signed.details);
    if (!details || !this.isGroupAdmin(group, signed.signer.userId) || !signed.signedBy(device.signatureKey)) {
      this.resealIfAdmin(group);
      return;
    }
    const timerChanged = (details.disappearAfter ?? 0) !== this.disappearAfter(group);
    group.meta = details;
    group.metaVersion = signed.version;
    if (timerChanged) this.noteTimerChange(group.id, signed.signer.userId, details.disappearAfter ?? 0);
  }

  protected resealIfAdmin(group: CachedGroup): void {
    if (group.kind === "group" && !group.removedAt && this.isGroupAdmin(group, this.account.userId) && this.hasMlsGroup(group.id)) {
      setTimeout(() => this.resealMeta(group.id), 0);
    }
  }

  /** Seals a group's details for an epoch, signed by this device. Whether history is shared goes with them. */
  protected sealGroupDetails(groupId: string, key: Uint8Array, epoch: number, meta: GroupMeta, version: number): Uint8Array {
    const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
    const group = this.groups.get(groupId);
    const details: GroupMeta = { ...meta, historyVisible: meta.historyVisible ?? (group ? this.sharesHistory(group) : false) };
    return sealSignal(key, "meta", groupId, epoch, signGroupDetails(groupId, details, version, signer, this.account.deviceSecret));
  }

  /**
   * Whether someone added to a group gets its history. That's an admin's signed
   * choice, never the server's word, so without the details an admin signed, it's no.
   */
  protected sharesHistory(group: CachedGroup): boolean {
    return group.meta.historyVisible ?? false;
  }

  /**
   * A member who joined without a Welcome can't open metadata sealed for an
   * older epoch, so an admin seals it again to keep the group's name visible.
   */
  protected resealMeta(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || Object.keys(group.meta).length === 0 || group.removedAt) return;
    if (!this.isGroupAdmin(group, this.account.userId) || !this.hasMlsGroup(groupId) || this.resealing.has(groupId)) return;
    const epoch = this.rememberCurrentEpochKey(groupId);
    const version = Math.max(group.metaVersion ?? 0, 1);
    group.metaVersion = version;
    this.persistGroup(group);
    const sealed = this.sealGroupDetails(groupId, this.epochKey(groupId, epoch)!, epoch, group.meta, version);
    this.resealing.add(groupId);
    void this.api
      .setGroupMeta(groupId, sealed, epoch)
      .catch((error) => console.warn("[zuna] resealing group details", error))
      .finally(() => this.resealing.delete(groupId));
  }

  protected applyReadState(group: CachedGroup, userId: string, sealed: Uint8Array): void {
    if (sealed.length < 5) return;
    let seq: number | null = null;
    const signed = readSigned(sealed);
    if (signed) {
      const key = this.epochKey(group.id, signed.epoch);
      if (!key) return;
      const checked = checkEnvelope<unknown>(key, "read", group.id, userId, signed.epoch, signed.envelope, (signer) => this.deviceKey(signer));
      seq = checked.state === "signed" && checked.signer.userId === userId ? parseReadState(checked.value) : null;
    } else {
      // Unsigned, it can only be this account's own, sealed to its key so its other
      // devices keep up.
      if (sealed[0] !== 1 || userId !== this.account.userId) return;
      const body = sealed.subarray(1);
      // A position sealed to this account stays as it was until it's next written, so
      // it may be under an older key. The worst a stolen one can do is mark things read.
      for (const key of [this.account.accountKey, ...Object.values(this.account.core.olderKeys)]) {
        if (seq === null) seq = parseReadState(openSignal<unknown>(subkey(key, "read"), "read", group.id, body));
      }
    }
    if (seq === null) return;
    if (userId === this.account.userId) {
      group.ownRead = Math.max(group.ownRead, seq);
      // It came from the server, so the server has it.
      if (group.readSent !== undefined) group.readSent = Math.max(group.readSent, seq);
    } else {
      group.readBy[userId] = Math.max(group.readBy[userId] ?? 0, seq);
    }
  }

  /**
   * The server says this person is no longer in a conversation. This device stops
   * taking part, but keeps what it has: the server's word is no reason to erase
   * anything, and it may turn out to be wrong. It goes when the person clears it,
   * or after a while.
   */
  protected markRemoved(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.removedAt) return;
    group.removedAt = Date.now();
    this.persistGroup(group);
    this.forgetMlsState(groupId);
    this.forgetCall(groupId);
    this.emitConversations();
  }

  protected forgetMlsState(groupId: string): void {
    this.confirmedEpochs.delete(groupId);
    this.cleanEpochs.delete(groupId);
    this.treeUsersCache.delete(groupId);
    const timer = this.reconcileTimers.get(groupId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(groupId);
    try {
      this.mls.deleteGroup(utf8(groupId));
      this.saveMls();
    } catch (error) {
      console.warn("[zuna] removing group state", error);
    }
  }

  /** Erases a conversation from this device, because the person asked. */
  protected removeGroupLocally(groupId: string): void {
    this.groups.delete(groupId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM search WHERE rowid IN (SELECT row_id FROM messages WHERE group_id = ?)", [groupId]);
      this.db.run("DELETE FROM media WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM messages WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM groups WHERE id = ?", [groupId]);
      this.db.run("DELETE FROM epoch_keys WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM joined_epochs WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM epoch_starts WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM device_departures WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM device_arrivals WHERE group_id = ?", [groupId]);
    });
    this.forgetMlsState(groupId);
    this.emitConversations();
  }

  /** Clears a conversation this person was removed from, from this device. */
  forgetConversation(groupId: string): void {
    if (this.groups.get(groupId)?.removedAt) this.removeGroupLocally(groupId);
  }

  protected forgetOldRemovedGroups(): void {
    for (const group of [...this.groups.values()]) {
      if (group.removedAt && Date.now() - group.removedAt > REMOVED_KEPT_MS) this.removeGroupLocally(group.id);
    }
  }

  protected emitConversations(): void {
    this.emit({ type: "conversations", serverId: this.serverId });
  }

  protected hasMlsGroup(groupId: string): boolean {
    return this.mls.hasGroup(utf8(groupId));
  }

  protected mlsEpoch(groupId: string): number {
    return this.mls.epoch(utf8(groupId));
  }
}
