// ServerSession, in part (see base.ts): replacing this account's keys, and catching up when another of its devices did.

import * as wasm from "@zuna/crypto";
import { ApiError, decode, encodeBody, type ApiAccount, type ApiUser } from "../api";
import {
  coreFromJson,
  coreToJson,
  createCertificate,
  openVaultCore,
  openVaultItem,
  parseCertificate,
  sealVaultCore,
  sealVaultItem,
  signProfileAtGeneration,
  type VaultCore,
} from "../crypto";
import {
  buildLink,
  carries,
  keyCommitment,
  openBundle,
  planFromJson,
  planToJson,
  readHeldLink,
  rootHash,
  sealBundle,
  sealToSlot,
  signSealProof,
  slotsHash,
  verifyLink,
  type Link,
  type LinkDevice,
  type RotationPlan,
  type SlotKind,
} from "../generations";
import { equalBytes, fromBase64, toBase64, utf8 } from "../encoding";
import { isManifestPart, type TrustManifest } from "../manifest";
import {
  VAULT_BATCH,
  MANIFEST_ATTEMPTS,
  sealedManifest,
  ACCOUNT_LOCK,
  ROTATION_INTENT,
  ROTATION_ATTEMPTS,
  ROTATION_STUCK_MS,
  MAX_REMOVAL_ROTATIONS,
  REMOVAL_ROTATION_WINDOW_MS,
  OLDER_HPKE_KEPT,
  rotationTiming,
  type RotationIntent,
  signedFromApi,
} from "./shared";
import { SessionDirectory } from "./directory";

export abstract class SessionRotation extends SessionDirectory {
  // --- Rotating the account's keys ---

  protected rotateSoon(delay: number): void {
    clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = undefined;
      void this.rotateForRemovals();
    }, delay);
  }

  protected async rotateForRemovals(): Promise<void> {
    if (this.stopped) return;
    // Only the server says a device was removed, and each rotation costs every contact
    // a link to follow. Replacing keys only ever waits a little: it's never skipped.
    const recent = (this.getKv<number[]>("removal_rotations") ?? []).filter((at) => Date.now() - at < REMOVAL_ROTATION_WINDOW_MS);
    if (recent.length >= MAX_REMOVAL_ROTATIONS) {
      this.warnOnce("removal-rotations", "The server keeps saying devices were removed from your account, so Zuna has slowed down replacing your keys. If you haven't been removing devices, your server may be misbehaving.");
      this.rotateSoon(REMOVAL_ROTATION_WINDOW_MS / MAX_REMOVAL_ROTATIONS);
      return;
    }
    const before = this.account.core.generation;
    try {
      await this.withLock(ACCOUNT_LOCK, () => this.rotateLocked({}, true));
      if (this.account.core.generation !== before) this.setKv("removal_rotations", [...recent, Date.now()]);
      this.setKv("rotation_stuck_since", 0);
      this.sealOlderSoon(0);
    } catch (error) {
      console.warn("[zuna] rotating this account's keys", error);
      if (this.stopped || (error instanceof ApiError && error.status === 401)) return;
      const since = this.getKv<number>("rotation_stuck_since") || Date.now();
      this.setKv("rotation_stuck_since", since);
      if (Date.now() - since > ROTATION_STUCK_MS && !this.getKv<boolean>("rotation_stuck_said")) {
        this.setKv("rotation_stuck_said", true);
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId: "",
          message: "Zuna hasn't been able to finish replacing your account's keys after a device was removed. It keeps trying.",
        });
      }
      this.rotateSoon(rotationTiming.retryMs);
    }
  }

  /** Moves this account to a new generation of keys, doing what the plan says as part of it. */
  async rotate(plan: RotationPlan = {}): Promise<void> {
    await this.withLock(ACCOUNT_LOCK, () => this.rotateLocked(plan, false));
    this.sealOlderSoon(0);
  }

  protected async rotateLocked(plan: RotationPlan, onlyForRemovals: boolean): Promise<void> {
    for (let attempt = 0; attempt < ROTATION_ATTEMPTS; attempt++) {
      const unfinished = await this.settleIntent(true);
      if (unfinished) await this.rotateLocked(unfinished, false);
      await this.catchUp();
      if (onlyForRemovals && this.uncoveredRemovals(await this.api.user(this.account.userId)).length === 0) {
        this.removalsUncovered = false;
        return;
      }
      await this.syncVault();
      const intent = await this.prepareRotation(plan);
      try {
        await this.sendIntent(intent);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
        this.closeIntent();
        if (error instanceof ApiError && (error.code === "stale_generation" || error.code === "devices_changed" || error.code === "stale_version")) continue;
        throw error;
      }
    }
    throw new Error("This account's keys are changing too often right now. Please try again.");
  }

  /** Makes the next generation and writes it down, so a crash from here on carries on with these same keys. */
  protected async prepareRotation(plan: RotationPlan): Promise<RotationIntent> {
    const { userId, username, deviceId, devicePublic, deviceSecret, accountKey: oldKey, core } = this.account;
    const generation = core.generation + 1;
    const me = await this.api.user(userId);
    // A device listed is in the log already, so it's read after the list: no sibling that just signed in is taken for a false one.
    await this.syncLog().catch((error) => console.warn("[zuna] reading the log of keys", error));
    const accountKey = wasm.randomBytes(32);
    const identity = wasm.signingKeygen();
    const hpke = wasm.hpkeKeygen();

    // Any device with a good certificate that's new to this one gets the usual alert now, before it could be carried.
    this.applyUser(me);
    const devices: LinkDevice[] = [];
    const removed: string[] = [];
    for (const device of me.devices) {
      if (device.revoked_at != null) continue;
      if (device.id === deviceId) {
        devices.push({ id: deviceId, key: devicePublic });
        continue;
      }
      const key = this.certifiedKey(device);
      if (key && this.ownDeviceAccepted(device.id, { signatureKey: key, enrollProof: device.enroll_proof })) devices.push({ id: device.id, key });
      else removed.push(device.id);
    }
    if (removed.length > 0) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: "The server listed a device for your account that never signed in. It was removed.",
      });
    }

    // The manifest goes along sealed under the new key, and its number into the core, so a new device knows not to settle for less.
    const manifest = this.nextManifest();
    const slots = { ...core.slots };
    const newSlots = new Map((plan.slots ?? []).map((slot) => [slot.kind, slot]));
    for (const slot of newSlots.values()) slots[slot.kind] = { seal: slot.seal, sign: slot.sign };
    const kinds = Object.keys(slots) as SlotKind[];

    const next: VaultCore = {
      identityPublic: identity.publicKey,
      identitySecret: identity.secretKey,
      hpkePublic: hpke.publicKey,
      hpkeSecret: hpke.secretKey,
      communityKey: core.communityKey,
      generation,
      rootPublic: core.rootPublic,
      rootSecret: core.rootSecret,
      olderKeys: { ...core.olderKeys, [core.generation]: oldKey },
      olderHpkeSecrets: [...core.olderHpkeSecrets, core.hpkeSecret].slice(-OLDER_HPKE_KEPT),
      closedBelow: core.closedBelow,
      slots,
      manifest: manifest.v,
    };
    const head = this.headOf(userId);
    const signed = buildLink(
      {
        user: userId,
        gen: generation,
        prev: head?.hash ?? rootHash(userId, core.rootPublic),
        identity: identity.publicKey,
        hpke: hpke.publicKey,
        keyCommit: keyCommitment(accountKey, userId, generation),
        slotsHash: slotsHash(slots),
        devices,
        removed,
        signer: deviceId,
      },
      core.identitySecret,
      identity.secretKey,
      deviceSecret,
    );
    const link = readHeldLink(signed)!;

    const bundles: { device_id: string; data: Uint8Array }[] = [];
    for (const { id, key } of devices) {
      const seal = this.sealKeyOf(me.devices.find((item) => item.id === id)!, key);
      if (seal) bundles.push({ device_id: id, data: sealBundle(seal, userId, id, generation, link.hash, accountKey) });
    }
    const request = {
      expected_generation: core.generation,
      link: { generation, payload: signed.payload, by_prev: signed.byPrev, by_new: signed.byNew, by_device: signed.byDevice },
      vault_core: sealVaultCore(accountKey, next, userId),
      profile_sig: me.profile ? signProfileAtGeneration(identity.secretKey, userId, generation, decode(me.profile)) : undefined,
      slots: kinds.map((kind) => {
        const sealedKey = sealToSlot(slots[kind]!.seal, kind, username, generation, link.hash, accountKey);
        const made = newSlots.get(kind);
        return made
          ? { kind, seal_key: made.seal, sign_key: made.sign, sealed_secret: made.sealedSecret, sealed_key: sealedKey }
          : { kind, sealed_key: sealedKey };
      }),
      bundles,
      items: this.trustItems(accountKey, generation, manifest),
      password: plan.password,
      recovery: plan.recovery,
    };
    const intent: RotationIntent = {
      generation,
      request: encodeBody(request) as RotationIntent["request"],
      accountKey: toBase64(accountKey),
      core: coreToJson(next),
      plan: planToJson(plan),
      once: !!plan.once,
    };
    this.setKv(ROTATION_INTENT, intent);
    this.rotationOpen = true;
    return intent;
  }

  /** What the vault holds that isn't epoch keys, sealed under the new key in one go: the manifest, which decides who this account trusts, and the names of its devices. */
  protected trustItems(accountKey: Uint8Array, generation: number, manifest: TrustManifest): { id: string; data: Uint8Array; version?: number }[] {
    const seal = (id: string, data: Uint8Array) => ({ id, data: sealVaultItem(accountKey, id, data, generation) });
    const items: { id: string; data: Uint8Array; version?: number }[] = sealedManifest(manifest).map(({ id, data, version }) => ({ ...seal(id, data), version }));
    for (const [id, name] of this.deviceNames) items.push(seal(`device:${id}`, utf8(name)));
    return items;
  }

  protected closeIntent(): void {
    this.db.run("DELETE FROM kv WHERE k = ?", [ROTATION_INTENT]);
    this.rotationOpen = false;
  }

  protected async sendIntent(intent: RotationIntent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.api.rotate(intent.request);
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "stale_version" || attempt >= MANIFEST_ATTEMPTS) throw error;
        // Another device saved the manifest meanwhile. This one goes on top of it, with the same keys.
        await this.syncVault();
        intent = this.withNextManifest(intent);
        this.setKv(ROTATION_INTENT, intent);
      }
    }
    await this.installIntent(intent);
  }

  /** A rotation that carries the manifest after the newest one, and that number in its core. */
  protected withNextManifest(intent: RotationIntent): RotationIntent {
    const { userId } = this.account;
    const accountKey = fromBase64(intent.accountKey);
    const manifest = this.nextManifest();
    const core = { ...coreFromJson(intent.core), manifest: manifest.v };
    const sealed = sealedManifest(manifest).map(({ id, data, version }) => ({ id, data: toBase64(sealVaultItem(accountKey, id, data, intent.generation)), version }));
    const items = ((intent.request.items as { id: string }[] | undefined) ?? []).filter((entry) => !isManifestPart(entry.id));
    return {
      ...intent,
      core: coreToJson(core),
      request: {
        ...intent.request,
        vault_core: toBase64(sealVaultCore(accountKey, core, userId)),
        items: [...items, ...sealed],
      },
    };
  }

  protected async installIntent(intent: RotationIntent): Promise<void> {
    const wire = intent.request.link;
    const link = readHeldLink({ payload: fromBase64(wire.payload), byPrev: fromBase64(wire.by_prev), byNew: fromBase64(wire.by_new), byDevice: fromBase64(wire.by_device) });
    if (!link) throw new Error("a rotation in progress couldn't be read");
    await this.install(fromBase64(intent.accountKey), coreFromJson(intent.core), [link]);
  }

  /**
   * Finishes a rotation a restart interrupted. The server says whether it went
   * through, and if it did, whether it was this device's. If nothing happened it's
   * sent again as the same bytes, unless nobody would learn the key it sets. If
   * something else got in first, what it was for is returned, to be done again on
   * top of that: the rest of it never happened.
   */
  protected async settleIntent(rethrow = false): Promise<RotationPlan | null> {
    const intent = this.getKv<RotationIntent>(ROTATION_INTENT);
    if (!intent) return null;
    const overtaken = () => {
      this.closeIntent();
      return intent.once ? null : planFromJson(intent.plan);
    };
    try {
      const { core, userId } = this.account;
      if (core.generation >= intent.generation) {
        // Stopped between the two databases.
        if (core.generation === intent.generation && toBase64(core.identityPublic) === intent.core.identityPublic) await this.installIntent(intent);
        else this.closeIntent();
        return null;
      }
      const state = await this.api.account();
      if (state.generation >= intent.generation) {
        const [link] = await this.api.identityLinks(userId, intent.generation - 1);
        if (link?.payload !== intent.request.link.payload) return overtaken();
        await this.installIntent(intent);
        return null;
      }
      if (intent.once) {
        this.closeIntent();
        return null;
      }
      await this.sendIntent(intent);
      return null;
    } catch (error) {
      if (error instanceof ApiError && (error.code === "stale_generation" || error.code === "devices_changed" || error.code === "stale_version")) return overtaken();
      if (error instanceof ApiError && !error.retryable && error.status !== 401) {
        this.closeIntent();
        return null;
      }
      if (rethrow || (error instanceof ApiError && error.status === 401)) throw error;
      console.warn("[zuna] finishing a rotation", error);
      return null;
    }
  }

  /** Takes on a generation: keys first, since everything after is only bookkeeping that can be redone. */
  protected async install(accountKey: Uint8Array, core: VaultCore, links: Link[]): Promise<void> {
    const { userId } = this.account;
    this.account = { ...this.account, accountKey, core };
    this.saveAccount();
    this.db.transaction(() => {
      for (const link of links) this.acceptLink(userId, link);
      this.db.run("DELETE FROM kv WHERE k = ?", [ROTATION_INTENT]);
    });
    this.rotationOpen = false;
    this.removalsUncovered = false;
    this.setKv("rotation_stuck_since", 0);
    this.setKv("rotation_stuck_said", false);
    try {
      await this.replaceSealKey();
      const me = await this.api.user(userId);
      await this.ensureCertificate(me);
      this.applyUser(await this.api.user(userId));
      this.rescheduleAffectedByDeviceChange(userId);
      await this.saveTrust();
      // The manifest so far is sealed under the old key, which nothing believes now.
      await this.writeManifest();
      await this.uploadEpochKeys();
      await this.topUpKeyPackages();
    } catch (error) {
      console.warn("[zuna] after a rotation", error);
    }
    this.emit({ type: "users", serverId: this.serverId });
  }

  /** A copy of a device taken once should stop being useful, so the key each rotation seals to changes. */
  protected async replaceSealKey(): Promise<void> {
    const seal = wasm.hpkeKeygen();
    this.account = { ...this.account, sealPublic: seal.publicKey, sealSecret: seal.secretKey, sealOlder: this.account.sealSecret };
    this.saveAccount();
    await this.publishSealKey();
  }

  protected async publishSealKey(): Promise<void> {
    const { userId, deviceId, deviceSecret, sealPublic, core } = this.account;
    await this.api.setSealKey(deviceId, sealPublic, core.generation, signSealProof(deviceSecret, userId, deviceId, core.generation, sealPublic));
  }

  /** Makes sure the server has this device's seal key, and a certificate from this generation. */
  protected async prepareDevice(): Promise<void> {
    const { userId, deviceId } = this.account;
    const me = await this.api.user(userId);
    const own = me.devices.find((device) => device.id === deviceId);
    if (own && !equalBytes(decode(own.seal_key), this.account.sealPublic)) await this.publishSealKey();
    await this.ensureCertificate(me);
  }

  /** A certificate from this generation, whichever way this device has got here. */
  protected async ensureCertificate(me: ApiUser): Promise<void> {
    const { userId, deviceId, devicePublic, core, certificate } = this.account;
    const parsed = parseCertificate(certificate);
    if (parsed?.generation !== core.generation) {
      const next = createCertificate(core.identitySecret, { userId, deviceId, signatureKey: devicePublic, generation: core.generation });
      this.account = { ...this.account, certificate: next };
      this.saveAccount();
      this.mls.setCredential(next);
    }
    const own = me.devices.find((device) => device.id === deviceId);
    if (own && !equalBytes(decode(own.certificate), this.account.certificate)) {
      await this.api.setCertificate(deviceId, this.account.certificate);
    }
  }

  protected syncAccountSoon(): void {
    if (this.stopped) return;
    void this.syncAccount().catch((error) => console.warn("[zuna] catching up on this account's keys", error));
  }

  /** Catches up with which generation of keys this account is at. */
  protected async syncAccount(): Promise<void> {
    await this.withLock(ACCOUNT_LOCK, async () => {
      const unfinished = await this.settleIntent();
      if (unfinished) await this.rotateLocked(unfinished, false);
      await this.catchUp();
    });
  }

  protected async catchUp(): Promise<void> {
    await this.prepareDevice();
    const state = await this.api.account();
    this.accountKnown = true;
    const { core, userId } = this.account;
    // Signing in gets the keys, and the chain that leads to them comes from the server.
    if (this.headGeneration(userId) < core.generation) {
      await this.readChain(userId);
      const head = this.headOf(userId);
      if (head?.gen === core.generation && !equalBytes(head.identity, core.identityPublic)) await this.noteFork(userId);
    }
    if (state.generation > core.generation) await this.followRotation(state);
    else if (state.generation === core.generation) this.refreshCore(state);
    await this.deliverBundles(state);
    if (this.account.core.generation > 0 && (state.older_items > 0 || this.account.core.closedBelow < this.account.core.generation)) {
      this.sealOlderSoon(Math.random() * rotationTiming.takeoverMs);
    }
    this.checkRemovals(await this.api.user(userId));
  }

  /**
   * Follows a rotation another device made. Anyone can seal to a public key, and
   * someone with the old identity key can write a link, so all of this has to hold:
   * the links follow from what's held, the first was signed by a device this one
   * accepts (later ones are authorized by that one's key), this device is on the
   * newest, and the key it was given is the key that link commits to.
   */
  protected async followRotation(state: ApiAccount): Promise<void> {
    const { userId, deviceId, devicePublic, core } = this.account;
    const wires = await this.api.identityLinks(userId, core.generation);
    const links: Link[] = [];
    for (const wire of wires) {
      const before = links.at(-1) ?? this.headOf(userId);
      const link = verifyLink(signedFromApi(wire), {
        user: userId,
        gen: (before?.gen ?? 0) + 1,
        prev: before?.hash ?? rootHash(userId, core.rootPublic),
        prevIdentity: before?.identity ?? core.rootPublic,
      });
      if (!link) return this.noteFork(userId);
      if (links.length === 0 && !(await this.signerAccepted(link))) return this.noteFork(userId);
      links.push(link);
    }
    const head = links.at(-1);
    if (!head || head.gen !== state.generation) return;
    if (!carries(head, { id: deviceId, key: devicePublic })) {
      this.signedOut("device_revoked");
      return;
    }
    // A device that couldn't be sealed to waits for another to do it.
    if (state.bundle?.generation !== head.gen) return;
    const accountKey = this.openOwnBundle(head, decode(state.bundle.data));
    if (!accountKey || !equalBytes(head.keyCommit, keyCommitment(accountKey, userId, head.gen))) return this.noteFork(userId);
    let next: VaultCore;
    try {
      next = openVaultCore(accountKey, decode(state.vault_core), head.gen, userId);
    } catch {
      return this.noteFork(userId);
    }
    const fits = next.generation === head.gen && equalBytes(next.identityPublic, head.identity) && equalBytes(next.hpkePublic, head.hpke) && equalBytes(slotsHash(next.slots), head.slotsHash);
    if (!fits) return this.noteFork(userId);
    await this.install(accountKey, next, links);
    void this.syncVault().catch((error) => console.warn("[zuna] vault", error));
  }

  protected openOwnBundle(head: Link, sealed: Uint8Array): Uint8Array | null {
    const { userId, deviceId, sealSecret, sealOlder } = this.account;
    for (const secret of [sealSecret, sealOlder]) {
      if (!secret) continue;
      try {
        return openBundle(secret, userId, deviceId, head.gen, head.hash, sealed);
      } catch {
        // Sealed to the other key, or to nobody.
      }
    }
    return null;
  }

  protected async signerAccepted(link: Link): Promise<boolean> {
    const { userId, deviceId } = this.account;
    const signer = link.devices.find((device) => device.id === link.signer);
    if (!signer) return false;
    if (signer.id === deviceId) return true;
    const head = this.headOf(userId);
    if (head && carries(head, signer)) return true;
    const proof = (await this.api.user(userId)).devices.find((device) => device.id === signer.id)?.enroll_proof;
    return this.ownDeviceAccepted(signer.id, { signatureKey: signer.key, enrollProof: proof });
  }

  /** A new core at this generation, when it closes. */
  protected refreshCore(state: ApiAccount): void {
    const { accountKey, core, userId } = this.account;
    if (core.generation === 0) return;
    let next: VaultCore;
    try {
      next = openVaultCore(accountKey, decode(state.vault_core), core.generation, userId);
    } catch {
      return;
    }
    if (next.generation !== core.generation || !equalBytes(next.identityPublic, core.identityPublic)) return;
    const head = this.headOf(userId);
    if (head && !equalBytes(slotsHash(next.slots), head.slotsHash)) return;
    const merged: VaultCore = { ...core, closedBelow: Math.max(core.closedBelow, next.closedBelow), olderKeys: next.olderKeys };
    if (JSON.stringify(coreToJson(merged)) === JSON.stringify(coreToJson(core))) return;
    this.account = { ...this.account, core: merged };
    this.saveAccount();
  }

  /** Seals the account key for a device that couldn't be sealed to when this generation was made. */
  protected async deliverBundles(state: ApiAccount): Promise<void> {
    const { userId, deviceId, accountKey, core } = this.account;
    const head = this.headOf(userId);
    if (!head || state.generation !== core.generation || state.missing_bundles.length === 0) return;
    const me = await this.api.user(userId);
    const bundles: { device_id: string; data: Uint8Array }[] = [];
    for (const id of state.missing_bundles) {
      const device = me.devices.find((item) => item.id === id);
      if (!device || id === deviceId || device.revoked_at != null) continue;
      const key = this.certifiedKey(device);
      const seal = key && this.ownDeviceAccepted(id, { signatureKey: key, enrollProof: device.enroll_proof }) ? this.sealKeyOf(device, key) : null;
      if (seal) bundles.push({ device_id: id, data: sealBundle(seal, userId, id, head.gen, head.hash, accountKey) });
    }
    if (bundles.length > 0) await this.api.putBundles(head.gen, bundles);
  }

  protected sealOlderSoon(delay: number): void {
    if (this.sealingTimer || this.sealing || this.stopped) return;
    this.sealingTimer = setTimeout(() => {
      this.sealingTimer = undefined;
      void this.sealOlderItems().catch((error) => console.warn("[zuna] sealing older vault items", error));
    }, delay);
  }

  /**
   * Seals what's left in the vault under the current key, so someone who has an
   * older one and only later gets the server's data finds nothing to open, and then
   * closes the generation: from then on, nothing older is believed. Only epoch keys
   * carry over. Everything else was sealed with the rotation, and an older copy of
   * it may be something planted under a stolen key.
   */
  protected async sealOlderItems(): Promise<void> {
    if (this.sealing) return;
    this.sealing = true;
    try {
      const { accountKey, core, userId } = this.account;
      if (core.generation === 0 || core.closedBelow >= core.generation) return;
      for (;;) {
        const items = await this.api.olderVaultItems(VAULT_BATCH);
        if (items.length === 0) break;
        const sealed: { id: string; data: Uint8Array }[] = [];
        const remove: string[] = [];
        for (const item of items) {
          const key = core.olderKeys[item.generation];
          if (!key || !item.id.startsWith("ek:")) {
            remove.push(item.id);
            continue;
          }
          try {
            const data = openVaultItem(key, item.id, decode(item.data), item.generation);
            sealed.push({ id: item.id, data: sealVaultItem(accountKey, item.id, data, core.generation) });
          } catch {
            remove.push(item.id);
          }
        }
        await this.api.resealVault(core.generation, sealed, remove);
      }
      const closed: VaultCore = { ...core, closedBelow: core.generation, olderKeys: {} };
      await this.api.closeGeneration(core.generation, sealVaultCore(accountKey, closed, userId));
      if (this.account.core.generation === core.generation) {
        this.account = { ...this.account, core: closed };
        this.saveAccount();
      }
    } finally {
      this.sealing = false;
    }
  }
}
