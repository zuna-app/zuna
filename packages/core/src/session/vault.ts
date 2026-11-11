// ServerSession, in part (see base.ts): the account's vault on the server, and the signed manifest of whom it trusts.

import { ApiError, decode } from "../api";
import { openHistoryGrant, openVaultItem, sealVaultItem } from "../crypto";
import { equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from "../encoding";
import { isManifestPart, joinManifestParts, manifestParts, parseManifest, readManifestPart, type ManifestPart, type TrustManifest } from "../manifest";
import { parsePreferences } from "../validate";
import { VAULT_PAGE, VAULT_BATCH, UNSAVED_TRUST, MANIFEST_ATTEMPTS, MANIFEST_PARTS, KEY_NOT_UPLOADED, KEY_UPLOADED, type CachedUser } from "./shared";
import { SessionLocal } from "./local";

export abstract class SessionVault extends SessionLocal {
  // --- Vault ---

  protected async syncVault(): Promise<void> {
    let cursor = this.getKv<number>("vault_cursor") ?? 0;
    const touchedGroups = new Set<string>();
    let named = false;
    fetching: for (;;) {
      const items = await this.api.vaultItems(cursor, VAULT_PAGE);
      if (items.length === 0) break;
      for (const item of items) {
        const { generation } = item;
        // Sealed under a key this device doesn't have yet, so it stays unread until then.
        if (generation > this.account.core.generation) {
          this.syncAccountSoon();
          break fetching;
        }
        cursor = Math.max(cursor, item.seq);
        const key = this.vaultKeyFor(item.id, generation);
        if (!key) continue;
        let data: Uint8Array;
        try {
          data = openVaultItem(key, item.id, decode(item.data), generation);
        } catch {
          console.warn("[zuna] a vault item could not be opened", item.id);
          continue;
        }
        if (item.id.startsWith("ek:")) {
          const [, groupId, epoch] = item.id.split(":");
          if (Number.isSafeInteger(Number(epoch)) && data.length === 32) {
            this.saveEpochKey(groupId!, Number(epoch), data, "vault");
            touchedGroups.add(groupId!);
          }
        } else if (isManifestPart(item.id)) {
          // Who this account trusts comes from here alone, so nothing in it can be left out by itself.
          this.takeManifestPart(item.id, data);
        } else if (item.id.startsWith("device:")) {
          this.deviceNames.set(item.id.slice("device:".length), fromUtf8(data));
          this.setKv("device_names", Object.fromEntries(this.deviceNames));
          named = true;
        }
      }
      this.setKv("vault_cursor", cursor);
      // A page short of full was the last, with no need to ask for an empty one to be sure.
      if (items.length < VAULT_PAGE) break;
    }
    for (const groupId of touchedGroups) this.retryUndecryptable(groupId);
    // A new device names itself in the vault, which is how the person asked about it knows it.
    if (named) this.emitNewDevices();
  }

  protected refreshTrust(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    const trust = this.trustOf(userId, user.identityKey);
    if (trust === "changed" && user.trust !== "changed") {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: `The security key of ${user.profile.displayName} doesn't match the one your account knows. Their messages can't be trusted until you verify them again.`,
      });
    }
    user.trust = trust;
    this.persistUser(user);
  }

  /**
   * The key an item of this generation opens with, if it's to be believed at all.
   * Old keys may be in the wrong hands, so what decides who this account trusts is
   * only ever read at the current generation. Epoch keys only ever fill gaps, so
   * they can wait to be sealed again, until the generation closes.
   */
  protected vaultKeyFor(id: string, generation: number): Uint8Array | null {
    const { accountKey, core } = this.account;
    if (generation === core.generation) return accountKey;
    if (generation < core.closedBelow || !id.startsWith("ek:")) return null;
    return core.olderKeys[generation] ?? null;
  }

  /** Puts items in the vault, unless this isn't the time. Returns whether it did. */
  protected async putItems(items: { id: string; data: Uint8Array; version?: number }[]): Promise<boolean> {
    const { accountKey, core } = this.account;
    const sealed = items.map(({ id, data, version }) => ({ id, data: sealVaultItem(accountKey, id, data, core.generation), version }));
    if (this.removalsUncovered || this.rotationOpen) return false;
    try {
      await this.api.putVaultItems(core.generation, sealed);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "stale_generation") throw error;
      this.syncAccountSoon();
      return false;
    }
  }

  protected async putVault(id: string, data: Uint8Array): Promise<void> {
    await this.putItems([{ id, data }]);
  }

  /** Shares what this device trusts with this account's other devices, through the manifest. */
  protected async saveTrust(): Promise<void> {
    if (this.manifestBehind()) await this.writeManifest();
  }

  // --- Vault manifest ---

  /**
   * Keeps a part of a manifest until every part of the same write is in, then takes the
   * manifest (manifest.ts). Parts wait in the database, as the vault's cursor has moved past
   * those already read. A manifest in one item, as nearly every account's is, is taken at once.
   */
  protected takeManifestPart(id: string, data: Uint8Array): void {
    const part = readManifestPart(id, data);
    if (!part) return;
    if (part.parts === 1) {
      const whole = joinManifestParts([part]);
      if (whole) this.applyManifest(whole, part.v);
      return;
    }
    const waiting = this.getKv<Record<string, { v: number; part: number; parts: number; hash: string; bytes: string }[]>>(MANIFEST_PARTS) ?? {};
    const key = `${part.v}/${part.hash}`;
    const held = (waiting[key] ?? []).filter((other) => other.part !== part.part);
    held.push({ ...part, bytes: toBase64(part.bytes) });
    const parts: ManifestPart[] = held.map((other) => ({ ...other, bytes: fromBase64(other.bytes) }));
    const whole = parts.length === part.parts ? joinManifestParts(parts) : null;
    if (whole || parts.length >= part.parts) delete waiting[key];
    else waiting[key] = held;
    if (whole) this.applyManifest(whole, part.v);
    // A manifest no newer than the one held would be refused, so its parts aren't worth keeping.
    const now = this.manifest?.v ?? 0;
    for (const other of Object.keys(waiting)) if (Number(other.split("/")[0]) <= now) delete waiting[other];
    this.setKv(MANIFEST_PARTS, waiting);
  }

  /**
   * Which items a device gets from the vault is the server's choice, and an older
   * copy of an item still opens. So the manifest holds every pin and verification and
   * the preferences, with a number only ever raised, and is only ever taken whole, from
   * every part of one write. Withholding one pin or verification then does nothing, a
   * device that has seen a manifest refuses an older one, and each rotation seals the
   * number into the vault core, so a new device knows how far back is too far.
   */
  protected applyManifest(data: Uint8Array, v: number): void {
    let manifest: TrustManifest | null;
    try {
      manifest = parseManifest(JSON.parse(fromUtf8(data)));
    } catch {
      manifest = null;
    }
    // Its parts name its number too, and must agree.
    if (!manifest || manifest.v !== v) return;
    const held = this.manifest?.v ?? 0;
    if (manifest.v < held) {
      this.warnOnce(`manifest/${manifest.v}`, "The server sent an older copy of the keys your account trusts. It was ignored.");
      return;
    }
    // Two devices writing at once give the same number, so the same number can still be news.
    if (manifest.v === held && JSON.stringify(manifest) === JSON.stringify(this.manifest)) return;
    // Only who changes needs their trust worked out again: a manifest lists everyone.
    const touched = new Set<string>();
    this.db.transaction(() => {
      const unsaved = this.unsavedTrust();
      for (const [userId, encoded] of Object.entries(manifest.verified)) {
        // A change made here that isn't in a manifest yet is newer than whatever another device wrote.
        if (unsaved.verified.includes(userId)) continue;
        const key = fromBase64(encoded);
        const held = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM verified WHERE user_id = ?", [userId]);
        const before = held && this.openVerified(userId, held.identity_key);
        if (before && equalBytes(before, key)) continue;
        this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, this.sealVerified(userId, key)]);
        if (key.length > 0) this.db.run("INSERT OR REPLACE INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [userId, this.sealPin(userId, key)]);
        touched.add(userId);
      }
      for (const [userId, encoded] of Object.entries(manifest.pins)) {
        if (this.pinnedIdentity(userId)) continue;
        this.db.run("INSERT INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [userId, this.sealPin(userId, fromBase64(encoded))]);
        touched.add(userId);
      }
    });
    for (const [userId, encoded] of Object.entries(manifest.pins)) {
      const pinned = this.pinnedIdentity(userId);
      // Two devices of one account holding different keys for someone means one was shown a key that isn't theirs.
      if (pinned && !equalBytes(pinned, fromBase64(encoded)) && !(userId in manifest.verified)) {
        const name = this.users.get(userId)?.profile.displayName || "someone";
        this.warnOnce(`pin/${userId}`, `Another of your devices holds a different security key for ${name}. Compare emoji with them before trusting their messages.`, userId);
      }
    }
    for (const [userId, position] of Object.entries(manifest.chains)) this.noteChainPosition(userId, position);
    for (const [userId, generation] of Object.entries(manifest.trust)) this.noteVerifiedPosition(userId, generation);
    // The log's key and a head another device of this account checked, which this one goes by.
    if (manifest.log) this.takeManifestHead(manifest.log);
    this.manifest = manifest;
    this.setKv("manifest", manifest);
    if (manifest.prefs && !this.unsavedTrust().prefs) {
      this.prefs = { ...this.prefs, ...parsePreferences(manifest.prefs) };
      this.setKv("prefs", this.prefs);
      this.emit({ type: "preferences", serverId: this.serverId });
      this.watchMutes();
      this.resendPush();
    }
    for (const userId of touched) this.refreshTrust(userId);
  }

  /** Whether this device holds a pin or verification the manifest doesn't list as it is here. */
  protected manifestBehind(): boolean {
    const manifest = this.manifest;
    if (!manifest) return true;
    const pins = this.db.all<{ user_id: string }>("SELECT user_id FROM pinned_identities");
    if (pins.some((row) => !(row.user_id in manifest.pins))) return true;
    if (this.allVerified().some((row) => manifest.verified[row.user_id] !== toBase64(row.identity_key))) return true;
    if (this.manifestHeadBehind(manifest.log)) return true;
    return !!this.db.get("SELECT 1 FROM identity_state WHERE chain_uploaded = 0 OR trust_uploaded = 0 LIMIT 1");
  }

  /** What this device holds, as the manifest after the one it has. */
  protected nextManifest(): TrustManifest {
    const entries = (rows: { user_id: string; identity_key: Uint8Array }[]) => Object.fromEntries(rows.map((row) => [row.user_id, toBase64(row.identity_key)]));
    const chains: TrustManifest["chains"] = {};
    for (const userId of this.chains.keys()) {
      const head = this.headOf(userId);
      if (head) chains[userId] = { gen: head.gen, hash: toBase64(head.hash) };
    }
    const trust: TrustManifest["trust"] = {};
    for (const { user_id } of this.db.all<{ user_id: string }>("SELECT user_id FROM identity_state")) {
      const generation = this.identityState(user_id).trust_generation;
      if (generation > 0) trust[user_id] = generation;
    }
    const log = this.headForManifest() ?? this.manifest?.log;
    return {
      v: (this.manifest?.v ?? 0) + 1,
      pins: entries(this.allPins()),
      verified: entries(this.allVerified()),
      chains,
      trust,
      prefs: this.prefs,
      ...(log ? { log } : {}),
    };
  }

  /** Writes what this device holds as the next manifest, one at a time. */
  protected writeManifest(): Promise<void> {
    this.manifestWrite = this.manifestWrite
      .then(async () => {
        for (let attempt = 0; attempt < MANIFEST_ATTEMPTS; attempt++) {
          if (await this.writeManifestOnce()) return;
        }
        console.warn("[zuna] the manifest kept being written by another device first");
      })
      .catch((error) => console.warn("[zuna] saving the manifest", error));
    return this.manifestWrite;
  }

  /**
   * Writes the next manifest on top of the newest one any of this account's devices
   * wrote, so nothing they changed is lost. Its number has to be above the stored
   * one's, so if another device's got in first, this says so and it's tried again.
   */
  protected async writeManifestOnce(): Promise<boolean> {
    await this.syncVault().catch((error) => console.warn("[zuna] reading the vault before saving the manifest", error));
    // Many asks can be waiting by now, and the first may have said it all.
    const unsaved = this.unsavedTrust();
    if (!this.manifestBehind() && unsaved.verified.length === 0 && !unsaved.prefs) return true;
    const written = this.db
      .all<{ user_id: string }>("SELECT user_id FROM identity_state WHERE chain_uploaded = 0 OR trust_uploaded = 0")
      .map(({ user_id }) => ({ user_id, trust_generation: this.identityState(user_id).trust_generation }));
    const manifest = this.nextManifest();
    const parts = manifestParts(manifest);
    if (!parts) {
      this.warnOnce("manifest/size", "Your account trusts more people than its vault can list, so what you verify here doesn't reach your other devices.");
      return true;
    }
    try {
      if (!(await this.putItems(parts))) return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale_version") return false;
      throw error;
    }
    this.manifest = manifest;
    this.setKv("manifest", manifest);
    if (manifest.log) this.noteManifestHeadWritten();
    const now = this.unsavedTrust();
    this.setKv(UNSAVED_TRUST, { verified: now.verified.filter((id) => !unsaved.verified.includes(id)), prefs: now.prefs && !unsaved.prefs });
    // A position that moved on while this was on its way is written next time.
    this.db.transaction(() => {
      for (const row of written) {
        if ((manifest.chains[row.user_id]?.gen ?? 0) === this.headGeneration(row.user_id) && this.identityState(row.user_id).trust_generation === row.trust_generation) {
          this.db.run("UPDATE identity_state SET chain_uploaded = 1, trust_uploaded = 1 WHERE user_id = ?", [row.user_id]);
        }
      }
    });
    return true;
  }

  /** What this device changed about who it trusts, or its preferences, that no manifest it wrote has yet. */
  protected unsavedTrust(): { verified: string[]; prefs: boolean } {
    return this.getKv<{ verified: string[]; prefs: boolean }>(UNSAVED_TRUST) ?? { verified: [], prefs: false };
  }

  protected noteUnsavedTrust(change: { verified?: string; prefs?: boolean }): void {
    const unsaved = this.unsavedTrust();
    if (change.verified && !unsaved.verified.includes(change.verified)) unsaved.verified.push(change.verified);
    if (change.prefs) unsaved.prefs = true;
    this.setKv(UNSAVED_TRUST, unsaved);
  }

  /** A new device shown less than the vault core says the manifest had reached was shown an older copy, or none. */
  protected checkManifestFloor(): void {
    const floor = this.account.core.manifest ?? 0;
    if (floor > (this.manifest?.v ?? 0)) {
      this.warnOnce("manifest/floor", "Not everything your account trusts arrived from the server, so people you've verified may show as unverified here. Compare emoji with them again before trusting them.");
    }
  }

  protected async saveDeviceName(): Promise<void> {
    this.deviceNames.set(this.account.deviceId, this.deviceName);
    this.setKv("device_names", Object.fromEntries(this.deviceNames));
    await this.putVault(`device:${this.account.deviceId}`, utf8(this.deviceName)).catch(() => undefined);
  }

  /**
   * Puts every key not yet in the vault there, a batch at a time, one upload at a time: a call
   * while one runs asks it to look again, rather than putting the same keys up twice.
   */
  protected uploadEpochKeys(): Promise<void> {
    if (this.uploadingKeys) {
      this.uploadingKeys.again = true;
      return this.uploadingKeys.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          while ((await this.uploadKeyBatch()) && !this.stopped) {
            // A full batch, so there may be more.
          }
        } while (entry.again && !this.stopped);
      } finally {
        this.uploadingKeys = null;
      }
    })();
    this.uploadingKeys = entry;
    return entry.done;
  }

  /** For whatever needn't wait on it: a failure is logged, and the next upload tries again. */
  protected uploadEpochKeysSoon(): void {
    void this.uploadEpochKeys().catch((error) => console.warn("[zuna] putting keys in the vault", error));
  }

  /** One batch of keys into the vault. True when it was full, so there may be more. */
  protected async uploadKeyBatch(): Promise<boolean> {
    const rows = this.db.all<{ group_id: string; epoch: number; key: Uint8Array }>(
      "SELECT group_id, epoch, key FROM epoch_keys WHERE uploaded = ? LIMIT ?",
      [KEY_NOT_UPLOADED, VAULT_BATCH],
    );
    if (rows.length === 0) return false;
    const items = rows.map((row) => ({ id: `ek:${row.group_id}:${row.epoch}`, data: this.openLocal("epoch", `${row.group_id}:${row.epoch}`, row.key) }));
    if (!(await this.putItems(items))) return false;
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run("UPDATE epoch_keys SET uploaded = ? WHERE group_id = ? AND epoch = ?", [KEY_UPLOADED, row.group_id, row.epoch]);
      }
    });
    return rows.length === VAULT_BATCH;
  }

  /**
   * Keys for older messages, from an admin adding this person with history. They
   * only ever fill in epochs from before this device came into the group: for
   * later ones, the only key that counts is the one MLS gives (see
   * rememberCurrentEpochKey).
   */
  protected async processHistoryGrants(): Promise<void> {
    const grants = await this.api.historyGrants();
    for (const grant of grants) {
      const joined = this.joinedEpoch(grant.group_id);
      // Kept until this device is in the group and can tell what it may fill in.
      if (joined === null) continue;
      try {
        const opened = this.openGrant(grant.group_id, decode(grant.data));
        if (await this.grantAuthentic(grant.group_id, opened)) {
          for (const [epoch, key] of Object.entries(opened.keys)) {
            const number = Number(epoch);
            if (!Number.isSafeInteger(number) || number < 0 || number >= joined || typeof key !== "string") continue;
            const bytes = fromBase64(key);
            if (bytes.length === 32) this.saveEpochKey(grant.group_id, number, bytes, "grant");
          }
          this.retryUndecryptable(grant.group_id);
        } else {
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: opened.signer.userId,
            message: "Keys for a conversation's history weren't signed by one of its admins, so they were ignored.",
          });
        }
      } catch (error) {
        // Not being able to check it just now is no reason to throw that history away.
        if (error instanceof ApiError && (error.retryable || error.status === 401)) {
          console.warn("[zuna] a history grant couldn't be checked yet", error);
          continue;
        }
        console.warn("[zuna] a history grant could not be opened", error);
      }
      await this.api.deleteHistoryGrant(grant.id);
    }
    if (grants.length > 0) await this.uploadEpochKeys();
  }

  /** Someone who hasn't heard about a rotation yet may have sealed this to an older key. */
  protected openGrant(groupId: string, sealed: Uint8Array): ReturnType<typeof openHistoryGrant> {
    const { core, userId } = this.account;
    for (const secret of core.olderHpkeSecrets) {
      try {
        return openHistoryGrant(secret, groupId, userId, sealed);
      } catch {
        // Not this one.
      }
    }
    return openHistoryGrant(core.hpkeSecret, groupId, userId, sealed);
  }

  protected async grantAuthentic(groupId: string, grant: ReturnType<typeof openHistoryGrant>): Promise<boolean> {
    const group = this.applyGroup(await this.api.group(groupId));
    // Everyone in a channel may read all of it, so any of them can hand on its keys.
    const signer = group.members.some((member) => member.userId === grant.signer.userId);
    if (group.kind === "channel" ? !signer : !this.isGroupAdmin(group, grant.signer.userId)) return false;
    // Fetched afresh. When the server can't be reached that's thrown, so a signer
    // who couldn't be looked up isn't taken for a device that isn't theirs.
    let user: CachedUser | null;
    try {
      user = await this.fetchUser(grant.signer.userId);
    } catch (error) {
      if (error instanceof ApiError && (error.retryable || error.status === 401)) throw error;
      user = this.users.get(grant.signer.userId) ?? null;
    }
    const device = user?.devices.get(grant.signer.deviceId);
    return !!device && grant.signedBy(device.signatureKey);
  }
}
