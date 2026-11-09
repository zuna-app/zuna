// ServerSession, in part (see base.ts): sealing what's kept on this device, the locks MLS work runs under, and what's known of each user.

import * as wasm from "@zuna/crypto";
import { decode, type Api, type ApiChannel, type ApiSound, type ApiUser } from "../api";
import { openProfile, openProfileAtGeneration, parseCertificate } from "../crypto";
import { equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from "../encoding";
import type { TrustManifest } from "../manifest";
import { parseProfile } from "../validate";
import type { EmoteSet, Preferences, PushSettings, Role, ServerInfo, TrustState, UserView } from "../types";
import { DB_LABEL, ROTATION_INTENT, type CachedDevice, type RotationIntent, type CachedUser, type CachedGroup, emptyProfile, DELETED_PROFILE } from "./shared";
import { SessionBase } from "./base";

export abstract class SessionLocal extends SessionBase {
  // --- Sealing data at rest ---

  protected sealLocal(name: string, row: string, data: Uint8Array): Uint8Array {
    return wasm.aeadSeal(this.dbKey, data, DB_LABEL(name, row));
  }

  protected openLocal(name: string, row: string, data: Uint8Array): Uint8Array {
    return wasm.aeadOpen(this.dbKey, data, DB_LABEL(name, row));
  }

  protected sealJson(name: string, row: string, value: unknown): Uint8Array {
    return this.sealLocal(name, row, utf8(JSON.stringify(value)));
  }

  protected openJson<T>(name: string, row: string, data: Uint8Array): T {
    return JSON.parse(fromUtf8(this.openLocal(name, row, data)));
  }

  /**
   * A value this device keeps about whom to trust or what to believe, sealed to its
   * row, so that nothing outside Zuna can change it unnoticed. One that doesn't open
   * gives a warning, and the most careful answer.
   */
  protected openValue<T>(name: string, row: string, data: unknown, careful: T): T {
    try {
      if (!(data instanceof Uint8Array)) throw new Error("not sealed");
      return this.openJson<T>(name, row, data);
    } catch {
      this.warnOnce("local-tampered", "Something outside Zuna changed what this device keeps about whom to trust. Compare emoji with the people who matter to you before trusting them.");
      return careful;
    }
  }

  protected setKv(key: string, value: unknown): void {
    this.db.run("INSERT OR REPLACE INTO kv(k, v) VALUES(?, ?)", [key, this.sealJson("kv", key, value)]);
  }

  protected getKv<T>(key: string): T | null {
    const row = this.db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", [key]);
    return row ? this.openJson<T>("kv", key, row.v) : null;
  }

  protected saveMls(): void {
    const changes = this.mls.takeChanges() as { set: [Uint8Array, Uint8Array][]; deleted: Uint8Array[] };
    if (changes.set.length === 0 && changes.deleted.length === 0) return;
    this.db.transaction(() => {
      for (const [key, value] of changes.set) {
        this.db.run("INSERT OR REPLACE INTO mls_kv(k, v) VALUES(?, ?)", [key, this.sealLocal("mls", toBase64(key), value)]);
      }
      for (const key of changes.deleted) this.db.run("DELETE FROM mls_kv WHERE k = ?", [key]);
    });
    this.noticeVoiceEpoch();
  }

  protected loadCache(): void {
    for (const row of this.db.all<{ id: string; data: Uint8Array }>("SELECT id, data FROM users")) {
      const stored = this.openJson<any>("user", row.id, row.data);
      this.users.set(stored.id, {
        ...stored,
        deleted: stored.deleted === true,
        identityKey: fromBase64(stored.identityKey),
        hpkeKey: fromBase64(stored.hpkeKey),
        devices: new Map(
          stored.devices.map((device: any) => [device.id, { ...device, signatureKey: fromBase64(device.signatureKey) }]),
        ),
      });
    }
    for (const row of this.db.all<{ id: string; data: Uint8Array }>("SELECT id, data FROM groups")) {
      const group = this.openJson<CachedGroup>("group", row.id, row.data);
      this.groups.set(group.id, group);
    }
    // This account's own key comes from its vault, never from what the server says.
    this.db.run("INSERT OR IGNORE INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [this.account.userId, this.sealPin(this.account.userId, this.account.core.rootPublic)]);
    this.loadChains();
    this.rotationOpen = this.getKv<RotationIntent>(ROTATION_INTENT) !== null;
    this.prefs = { ...this.prefs, ...(this.getKv<Preferences>("prefs") ?? {}) };
    this.manifest = this.getKv<TrustManifest>("manifest");
    this.watchMutes();
    const push = this.getKv<(Omit<PushSettings, "key"> & { key: string }) | "off">("push");
    this.push = push && push !== "off" ? { ...push, key: fromBase64(push.key) } : push;
    this.usersCursor = this.getKv<number>("users_cursor") ?? 0;
    this.info = this.getKv<ServerInfo>("info");
    this.emoteSet = this.getKv<EmoteSet>("emotes") ?? this.emoteSet;
    const names = this.getKv<Record<string, string>>("device_names") ?? {};
    for (const [id, name] of Object.entries(names)) this.deviceNames.set(id, name);
    if (this.channelsOn) this.applyChannels(this.getKv<ApiChannel[]>("channels") ?? [], false);
    if (this.channelsOn || this.callsOn) this.applySounds(this.getKv<ApiSound[]>("sounds") ?? [], false);
  }

  protected persistUser(user: CachedUser): void {
    const stored = {
      ...user,
      identityKey: toBase64(user.identityKey),
      hpkeKey: toBase64(user.hpkeKey),
      devices: [...user.devices.values()].map((device) => ({ ...device, signatureKey: toBase64(device.signatureKey) })),
    };
    this.db.run("INSERT OR REPLACE INTO users(id, data) VALUES(?, ?)", [user.id, this.sealJson("user", user.id, stored)]);
  }

  protected persistGroup(group: CachedGroup): void {
    this.db.run(
      `INSERT INTO groups(id, kind, peer_id, data) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, peer_id = excluded.peer_id, data = excluded.data`,
      [group.id, group.kind, group.peerId, this.sealJson("group", group.id, group)],
    );
  }

  // --- Locks ---

  protected withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  // --- Users ---

  protected async syncUsers(): Promise<void> {
    const live = new Map<string, boolean>();
    this.presenceWhileListing = live;
    let response: Awaited<ReturnType<Api["users"]>>;
    try {
      response = await this.api.users(this.usersCursor);
    } finally {
      if (this.presenceWhileListing === live) this.presenceWhileListing = null;
    }
    this.online = new Set(response.online);
    for (const [id, online] of live) {
      if (online) this.online.add(id);
      else this.online.delete(id);
    }
    // One transaction for the page: a new device on a big server would otherwise commit thousands.
    this.db.transaction(() => {
      for (const user of response.users) this.applyUser(user);
      for (const [id, at] of Object.entries(response.seen)) this.noteLastSeen(id, at);
    });
    for (const user of response.users) {
      if (user.id !== this.account.userId && user.key_generation > this.headGeneration(user.id)) await this.followChain(user.id);
    }
    this.usersCursor = response.now - 5000;
    this.setKv("users_cursor", this.usersCursor);
    this.emit({ type: "users", serverId: this.serverId });
  }

  /**
   * When someone was last seen, as the server says now, kept for the next time the app
   * opens. It only moves on: what the server listed a moment ago can be older than what
   * came live meanwhile.
   */
  protected noteLastSeen(userId: string, at: number): void {
    const user = this.users.get(userId);
    if (!user || at <= (user.lastSeenAt ?? 0)) return;
    user.lastSeenAt = at;
    this.persistUser(user);
  }

  protected sealPin(userId: string, key: Uint8Array): Uint8Array {
    return this.sealJson("pin", userId, toBase64(key));
  }

  protected sealVerified(userId: string, key: Uint8Array): Uint8Array {
    return this.sealJson("verified", userId, toBase64(key));
  }

  /** A pin that doesn't open matches no key at all, so that person shows as changed. */
  protected openPinnedKey(userId: string, sealed: Uint8Array): Uint8Array {
    return fromBase64(this.openValue("pin", userId, sealed, toBase64(new Uint8Array(32))));
  }

  /** A verification that doesn't open counts as none. */
  protected openVerified(userId: string, sealed: Uint8Array): Uint8Array {
    return fromBase64(this.openValue("verified", userId, sealed, ""));
  }

  protected pinnedIdentity(userId: string): Uint8Array | null {
    const row = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM pinned_identities WHERE user_id = ?", [userId]);
    return row ? this.openPinnedKey(userId, row.identity_key) : null;
  }

  /** Every pin this device holds. */
  protected allPins(): { user_id: string; identity_key: Uint8Array }[] {
    return this.db
      .all<{ user_id: string; identity_key: Uint8Array }>("SELECT user_id, identity_key FROM pinned_identities ORDER BY user_id")
      .map((row) => ({ user_id: row.user_id, identity_key: this.openPinnedKey(row.user_id, row.identity_key) }));
  }

  /** Every verification this device holds, an empty key for one cleared. */
  protected allVerified(): { user_id: string; identity_key: Uint8Array }[] {
    return this.db
      .all<{ user_id: string; identity_key: Uint8Array }>("SELECT user_id, identity_key FROM verified ORDER BY user_id")
      .map((row) => ({ user_id: row.user_id, identity_key: this.openVerified(row.user_id, row.identity_key) }));
  }

  /** The key this account verified for someone, if it has. Clearing it leaves an empty one. */
  protected verifiedIdentity(userId: string): Uint8Array | null {
    const row = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM verified WHERE user_id = ?", [userId]);
    const key = row && this.openVerified(userId, row.identity_key);
    return key && key.length > 0 ? key : null;
  }

  protected trustOf(userId: string, current: Uint8Array): TrustState {
    const pinned = this.pinnedIdentity(userId);
    if (pinned && !equalBytes(pinned, current)) return "changed";
    if (this.identityState(userId).forked) return "changed";
    const verified = this.verifiedIdentity(userId);
    if (!verified) return "unverified";
    if (!equalBytes(verified, current)) return "changed";
    // What was verified may since have been replaced, by someone who may have stolen it.
    return this.identityState(userId).trust_generation >= this.headGeneration(userId) ? "verified" : "unverified";
  }

  /**
   * Trust on first use: the first identity key seen for a user is pinned. A later
   * change to that first key means the server is lying or the account was replaced,
   * which gets a loud warning. Keys an account moves on to come as a chain from that
   * first one (see followChain). Pins and verifications are shared through the
   * vault, so a new device already knows what this account's other devices do.
   */
  protected applyUser(api: ApiUser): CachedUser {
    const identityKey = decode(api.identity_key);
    const isSelf = api.id === this.account.userId;
    // Someone this account has verified is pinned to that key, whatever the server says now.
    const pinned = isSelf ? this.account.core.rootPublic : (this.pinnedIdentity(api.id) ?? this.verifiedIdentity(api.id));
    if (!this.pinnedIdentity(api.id)) {
      this.db.run("INSERT INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [api.id, this.sealPin(api.id, pinned ?? identityKey)]);
    }
    const previous = this.users.get(api.id);
    const changedNow = !!pinned && !equalBytes(pinned, identityKey) && previous?.trust !== "changed";
    const trustedKey = pinned ?? identityKey;

    const devices = new Map<string, CachedDevice>();
    for (const device of api.devices) {
      const certificate = decode(device.certificate);
      const standing = this.certificateStanding(api.id, trustedKey, certificate);
      if (!standing) {
        // From a generation this device hasn't got to yet, as far as it knows still the same device.
        const known = previous?.devices.get(device.id);
        if (known && (parseCertificate(certificate)?.generation ?? 0) > this.headGeneration(api.id)) devices.set(device.id, known);
        continue;
      }
      if (standing.cert.userId !== api.id || standing.cert.deviceId !== device.id) continue;
      // Certificates from an older generation only mean something if their device was
      // known before that generation ended. Someone with no history here can't tell.
      if (!standing.carried && previous && !previous.devices.has(device.id)) continue;
      devices.set(device.id, {
        id: device.id,
        signatureKey: standing.cert.signatureKey,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        revoked: device.revoked_at != null || !standing.carried,
        enrollProof: device.enroll_proof ?? null,
        sealKey: device.seal_key ?? null,
      });
    }

    if (isSelf) {
      for (const device of api.devices) {
        const key = devices.get(device.id)?.signatureKey;
        if (key && device.id !== this.account.deviceId) this.sealKeyOf(device, key);
      }
    }
    if (isSelf && previous) {
      for (const device of devices.values()) {
        if (!previous.devices.has(device.id) && device.id !== this.account.deviceId) {
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: api.id,
            message: "A new device just signed in to your account. If this wasn't you, change your password and remove that device in Settings.",
          });
        }
      }
    }

    const head = this.headOf(api.id);
    const opened = !api.profile
      ? null
      : head
        ? parseProfile(openProfileAtGeneration<unknown>(this.account.core.communityKey, head.identity, api.id, api.username, head.gen, decode(api.profile), decode(api.profile_sig)))
        : parseProfile(openProfile<unknown>(this.account.core.communityKey, trustedKey, api.username, decode(api.profile)));
    const user: CachedUser = {
      id: api.id,
      username: api.username,
      role: api.role,
      identityKey,
      hpkeKey: head?.hpke ?? decode(api.hpke_key),
      profile: api.deleted ? DELETED_PROFILE : (opened ?? previous?.profile ?? emptyProfile(api.username)),
      // Hidden, or the account gone, it's nothing. Otherwise it only moves on, as in noteLastSeen.
      lastSeenAt: api.last_seen_at === null ? null : Math.max(api.last_seen_at, previous?.lastSeenAt ?? 0),
      hidesLastSeen: api.hide_last_seen,
      banned: api.banned,
      deleted: api.deleted,
      trust: this.trustOf(api.id, identityKey),
      devices,
    };
    this.users.set(api.id, user);
    this.persistUser(user);
    if (isSelf && user.role !== this.account.role) {
      this.account = { ...this.account, role: user.role };
    }
    if (changedNow) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: api.id,
        message: `The security key of ${user.profile.displayName} changed. Their messages can't be trusted until you verify them again.`,
      });
      const dm = this.dmWith(api.id);
      if (dm) this.addSystemRow(dm.id, Date.now(), api.id, { type: "identity_changed", actorId: api.id, targetIds: [api.id] });
    }
    if (isSelf) {
      this.checkRemovals(api);
    } else if (api.key_generation > this.headGeneration(api.id)) {
      void this.followChain(api.id).catch((error) => console.warn("[zuna] following a chain of keys", error));
    }
    return user;
  }

  protected async ensureUser(userId: string, refresh = false): Promise<CachedUser | null> {
    if (!refresh) {
      const cached = this.users.get(userId);
      if (cached) return cached;
    }
    try {
      return await this.fetchUser(userId);
    } catch {
      return this.users.get(userId) ?? null;
    }
  }

  /** Someone as the server has them now, and their chain followed to it. Throws when they can't be fetched. */
  protected async fetchUser(userId: string): Promise<CachedUser> {
    const api = await this.api.user(userId);
    const user = this.applyUser(api);
    if (userId === this.account.userId || api.key_generation <= this.headGeneration(userId)) return user;
    await this.followChain(userId);
    return this.users.get(userId) ?? user;
  }

  protected toUserView(user: CachedUser): UserView {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.profile.displayName || user.username,
      bio: user.profile.bio ?? "",
      avatar: user.profile.avatar ?? null,
      online: this.online.has(user.id),
      lastSeenAt: user.lastSeenAt,
      hidesLastSeen: user.hidesLastSeen,
      banned: user.banned,
      deleted: user.deleted,
      trust: user.trust,
      isSelf: user.id === this.account.userId,
    };
  }

  getUsers(): UserView[] {
    return [...this.users.values()].map((user) => this.toUserView(user));
  }

  getSelf(): { userId: string; username: string; role: Role; deviceId: string } {
    return {
      userId: this.account.userId,
      username: this.account.username,
      role: this.users.get(this.account.userId)?.role ?? this.account.role,
      deviceId: this.account.deviceId,
    };
  }

  getInfo(): ServerInfo | null {
    return this.info;
  }
}
