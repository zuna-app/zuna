// ServerSession, in part (see base.ts): each account's chain of generations: following it, and the standing of each device's certificate.

import { decode, type ApiDevice, type ApiUser } from "../api";
import { HPKE_PUBLIC_BYTES, parseCertificate, verifyCertificate, type DeviceCertificate } from "../crypto";
import { carries, rootHash, verifyEnrollment, verifyLink, verifySealProof, type Link } from "../generations";
import { equalBytes, fromBase64, toBase64 } from "../encoding";
import { CONTINUITY_MS, rotationTiming, type IdentityState, type SealedIdentityState, signedFromApi } from "./shared";
import { SessionVault } from "./vault";

/** What a certificate counts for (`certificateStanding`). */
export interface Standing {
  cert: DeviceCertificate;
  carried: boolean;
  logged: boolean;
  gone: boolean;
}

/** How long before links the log names, and the server hasn't handed over, are asked for again. */
const CHAIN_RETRY_MS = 30_000;

export abstract class SessionChains extends SessionVault {
  // --- Account generations ---

  protected saveAccount(): void {
    this.onAccountChanged?.(this.account);
  }

  /** Chains as kept here, each link checked again against the one before, back to the key pinned for that person. */
  protected loadChains(): void {
    const broken = new Set<string>();
    for (const row of this.db.all<{ user_id: string; payload: Uint8Array; by_prev: Uint8Array; by_new: Uint8Array; by_device: Uint8Array }>(
      "SELECT user_id, payload, by_prev, by_new, by_device FROM identity_chain ORDER BY user_id, generation",
    )) {
      if (broken.has(row.user_id)) continue;
      const root = this.pinnedIdentity(row.user_id);
      const before = this.chainOf(row.user_id).at(-1);
      const link =
        root &&
        verifyLink(
          { payload: row.payload, byPrev: row.by_prev, byNew: row.by_new, byDevice: row.by_device },
          { user: row.user_id, gen: (before?.gen ?? 0) + 1, prev: before?.hash ?? rootHash(row.user_id, root), prevIdentity: before?.identity ?? root },
        );
      if (link) {
        this.chains.set(row.user_id, [...this.chainOf(row.user_id), link]);
      } else {
        broken.add(row.user_id);
        this.warnOnce("local-tampered", "Something outside Zuna changed this device's list of who to trust. Compare emoji with the people who matter to you before trusting them.");
      }
    }
  }

  protected chainOf(userId: string): Link[] {
    return this.chains.get(userId) ?? [];
  }

  protected headOf(userId: string): Link | null {
    return this.chainOf(userId).at(-1) ?? null;
  }

  protected headGeneration(userId: string): number {
    return this.headOf(userId)?.gen ?? 0;
  }

  /**
   * Whether a certificate counts for someone: it's signed by their identity key of
   * the generation it names (the first key, for the very first), and if that's an
   * older one, its device has been on the list of every link since. That list is
   * what makes a certificate someone signs later with a stolen old key worth
   * nothing. And the server's log of keys names that device for that account, with
   * that signing key and a certificate of that hash, so what it shows one person it
   * shows everyone, the account's own devices too. `gone` is the log saying the device
   * was removed, whatever the server lists, which makes it revoked, not false. Null if it
   * isn't signed, is from further along than is known, or the log, read as far as the
   * server says it goes, doesn't name it. `logged` is false while this device can't
   * tell, when only what it counted before counts.
   */
  protected certificateStanding(userId: string, root: Uint8Array, certificate: Uint8Array): Standing | null {
    const chain = this.chainOf(userId);
    const key = [userId, toBase64(root), ...chain.map((link) => toBase64(link.hash)), toBase64(certificate), this.logVersion(userId)].join("|");
    const known = this.standingCache.get(key);
    if (known !== undefined) return known;
    let standing: Standing | null = null;
    const signed = this.workOutStanding(root, chain, certificate);
    if (signed) {
      const logged = this.logStanding(userId, signed.cert.deviceId, signed.cert.signatureKey, certificate);
      if (logged !== "absent") standing = { ...signed, logged: logged !== "unknown", gone: logged === "gone" };
    }
    if (this.standingCache.size >= 4096) this.standingCache.clear();
    this.standingCache.set(key, standing);
    return standing;
  }

  protected workOutStanding(root: Uint8Array, chain: Link[], certificate: Uint8Array): { cert: DeviceCertificate; carried: boolean } | null {
    const parsed = parseCertificate(certificate);
    if (!parsed) return null;
    if (parsed.generation > chain.length) return null;
    const cert = verifyCertificate(parsed.generation === 0 ? root : chain[parsed.generation - 1]!.identity, certificate);
    if (!cert) return null;
    const device = { id: parsed.deviceId, key: parsed.signatureKey };
    return { cert, carried: chain.slice(parsed.generation).every((link) => carries(link, device)) };
  }

  protected identityState(userId: string): IdentityState {
    const row = this.db.get<{ sealed: Uint8Array | null }>("SELECT sealed FROM identity_state WHERE user_id = ?", [userId]);
    if (!row?.sealed) return { forked: 0, known_generation: 0, known_hash: null, trust_generation: 0 };
    // What doesn't open says there were two versions of their keys, which gives the loud warning.
    const stored = this.openValue<SealedIdentityState>("identity", userId, row.sealed, { forked: 1, known_generation: 0, known_hash: null, trust_generation: 0 });
    return { ...stored, known_hash: stored.known_hash ? fromBase64(stored.known_hash) : null };
  }

  /** Changes what's known about someone's chain, and marks what the manifest has to say again. */
  protected updateIdentityState(userId: string, change: Partial<IdentityState>, unsaved: { chain?: boolean; trust?: boolean } = {}): void {
    const next = { ...this.identityState(userId), ...change };
    const sealed = this.sealJson("identity", userId, { ...next, known_hash: next.known_hash ? toBase64(next.known_hash) : null });
    this.db.run("INSERT OR IGNORE INTO identity_state(user_id) VALUES(?)", [userId]);
    this.db.run("UPDATE identity_state SET sealed = ? WHERE user_id = ?", [sealed, userId]);
    if (unsaved.chain) this.db.run("UPDATE identity_state SET chain_uploaded = 0 WHERE user_id = ?", [userId]);
    if (unsaved.trust) this.db.run("UPDATE identity_state SET trust_uploaded = 0 WHERE user_id = ?", [userId]);
  }

  protected setVerifiedPosition(userId: string, generation: number): void {
    this.updateIdentityState(userId, { trust_generation: generation }, { trust: true });
  }

  /** What a sibling device says it has reached on someone's chain. Two versions of it means trouble. */
  protected noteChainPosition(userId: string, position: { gen: number; hash: string }): void {
    if (position.gen < 1) return;
    const held = this.chainOf(userId)[position.gen - 1];
    const expected = fromBase64(position.hash);
    if (held) {
      if (!equalBytes(held.hash, expected)) void this.noteFork(userId);
    } else if (position.gen > this.identityState(userId).known_generation) {
      this.updateIdentityState(userId, { known_generation: position.gen, known_hash: expected });
    }
  }

  protected noteVerifiedPosition(userId: string, generation: number): void {
    if (generation <= this.identityState(userId).trust_generation) return;
    this.updateIdentityState(userId, { trust_generation: generation });
    this.refreshTrust(userId);
  }

  /** Takes on a link that's been checked: from here, what it says about devices goes. */
  protected acceptLink(userId: string, link: Link): void {
    if (this.chainOf(userId).length >= link.gen) return;
    this.db.run("INSERT OR REPLACE INTO identity_chain(user_id, generation, payload, by_prev, by_new, by_device) VALUES(?, ?, ?, ?, ?, ?)", [
      userId,
      link.gen,
      link.payload,
      link.byPrev,
      link.byNew,
      link.byDevice,
    ]);
    this.updateIdentityState(userId, {}, { chain: true });
    this.chains.set(userId, [...this.chainOf(userId), link]);
  }

  protected followChain(userId: string): Promise<void> {
    const running = this.following.get(userId);
    if (running) return running;
    const run = this.readChain(userId).finally(() => this.following.delete(userId));
    this.following.set(userId, run);
    return run;
  }

  /**
   * Reads someone's chain of identity keys, each link checked against the one
   * before, going back to the key first pinned for them. The first valid link for
   * a generation stays. Another one for the same generation means someone with an
   * old key and the server's help is telling a different story, which is what the
   * loud warning is for.
   */
  protected async readChain(userId: string): Promise<void> {
    const root = this.pinnedIdentity(userId);
    if (!root) return;
    let accepted = false;
    let lapsed = false;
    for (;;) {
      const chain = this.chainOf(userId);
      const wires = await this.api.identityLinks(userId, Math.max(chain.length - 1, 0));
      let advanced = false;
      for (const wire of wires) {
        const signed = signedFromApi(wire);
        const held = this.chainOf(userId);
        if (wire.generation <= held.length) {
          if (!equalBytes(signed.payload, held[wire.generation - 1]!.payload)) return this.noteFork(userId);
          continue;
        }
        const before = held.at(-1);
        const link = verifyLink(signed, {
          user: userId,
          gen: held.length + 1,
          prev: before?.hash ?? rootHash(userId, root),
          prevIdentity: before?.identity ?? root,
        });
        if (!link) return this.noteFork(userId);
        // The log names each generation's link, and one it names otherwise is a second story.
        const logged = this.loggedLink(userId, link.gen);
        if (logged && !equalBytes(logged, link.hash)) return this.noteFork(userId);
        // One the log doesn't name isn't taken, however far this device thinks it has read: the
        // server says how long its log is, and the link is followed when the log gets to it. This
        // account's own, up to the generation its core is of, are the ones signing in held to the
        // log already, and lead to the key that core names (catchUp).
        const own = userId === this.account.userId && link.gen <= this.account.core.generation;
        if (!logged && !own) break;
        const state = this.identityState(userId);
        if (state.known_generation === link.gen && state.known_hash && !equalBytes(state.known_hash, link.hash)) return this.noteFork(userId);
        // What was verified was the key this replaces, so it only carries over from a
        // device that has been around too long to be someone's quick invention.
        if (this.verifiedIdentity(userId) && state.trust_generation === link.gen - 1) {
          if (this.hasContinuity(userId, link)) this.setVerifiedPosition(userId, link.gen);
          else lapsed = true;
        }
        this.acceptLink(userId, link);
        accepted = true;
        advanced = true;
      }
      if (!advanced || wires.length < 200) break;
    }
    // A generation the log has a link for that the server won't hand over is known to be missing,
    // and asked for again, rather than its devices' new certificates being taken for false ones.
    if (this.loggedGeneration(userId) > this.chainOf(userId).length) this.askForChainAgain(userId);
    if (!accepted) return;
    this.applyUser(await this.api.user(userId));
    if (lapsed) {
      const dm = this.dmWith(userId);
      if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_rotated", actorId: userId });
    }
    this.rescheduleAffectedByDeviceChange(userId);
    this.emit({ type: "users", serverId: this.serverId });
    this.emitConversations();
    await this.saveTrust().catch(() => undefined);
  }

  /** Asks for someone's links again in a while, as the log says there's one this device hasn't been given. */
  protected askForChainAgain(userId: string): void {
    if (this.chainRetries.has(userId) || this.stopped) return;
    this.chainRetries.set(
      userId,
      setTimeout(() => {
        this.chainRetries.delete(userId);
        void this.followChain(userId).catch((error) => console.warn("[zuna] following a chain of keys", error));
      }, CHAIN_RETRY_MS),
    );
  }

  protected chainRetries = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Whether a link was signed by a device of theirs this one has known for long enough: by its ID
   * and by the key it's known by, as an ID alone is anyone's to write beside a key of their own.
   */
  protected hasContinuity(userId: string, link: Link): boolean {
    const deviceId = link.signer;
    const known = this.users.get(userId)?.devices.get(deviceId)?.signatureKey;
    const signed = link.devices.find((device) => device.id === deviceId)?.key;
    if (!known || !signed || !equalBytes(known, signed)) return false;
    const row = this.db.get<{ at: Uint8Array }>("SELECT at FROM device_first_leaf WHERE user_id = ? AND device_id = ?", [userId, deviceId]);
    return !!row && Date.now() - this.openValue("first-leaf", `${userId}/${deviceId}`, row.at, Date.now()) >= CONTINUITY_MS;
  }

  /** Two versions of someone's chain. What's held stays, and the existing warning says what this means. */
  protected async noteFork(userId: string): Promise<void> {
    if (this.identityState(userId).forked) return;
    this.updateIdentityState(userId, { forked: 1 });
    const root = this.pinnedIdentity(userId);
    if (root) {
      const shown = await this.readWholeChain(userId, root).catch(() => null);
      // A shorter version of what's held changes nothing, so what's held stays what's compared.
      const held = this.chainOf(userId);
      const onlyHeld = !shown?.length || shown.every((link, index) => {
        const mine = held[index];
        return !!mine && equalBytes(mine.hash, link.hash);
      });
      if (shown && !onlyHeld) this.forkHeads.set(userId, shown.at(-1)!.identity);
    }
    if (userId === this.account.userId) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: "The server showed this device a different history of your account's keys. Someone may be trying to take over your account.",
      });
      return;
    }
    this.refreshTrust(userId);
    const dm = this.dmWith(userId);
    if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_changed", actorId: userId, targetIds: [userId] });
    this.emit({ type: "users", serverId: this.serverId });
  }

  /** The chain the server shows now, checked from the start, without holding on to it. */
  protected async readWholeChain(userId: string, root: Uint8Array): Promise<Link[]> {
    const links: Link[] = [];
    for (;;) {
      const wires = await this.api.identityLinks(userId, links.length);
      for (const wire of wires) {
        const before = links.at(-1);
        const link = verifyLink(signedFromApi(wire), {
          user: userId,
          gen: links.length + 1,
          prev: before?.hash ?? rootHash(userId, root),
          prevIdentity: before?.identity ?? root,
        });
        if (!link) throw new Error("that chain doesn't hold together");
        links.push(link);
      }
      if (wires.length < 200) return links;
    }
  }

  /**
   * Whether this account's other devices should count a device. A list signed by a
   * link says so for those on it. Otherwise it has to show it came from someone who
   * opened a slot, which a stolen identity key can't do.
   */
  protected ownDeviceAccepted(deviceId: string, device: { signatureKey: Uint8Array; enrollProof?: string | null } | undefined): boolean {
    if (!device) return false;
    const { core, userId } = this.account;
    const head = this.headOf(userId);
    if (head && carries(head, { id: deviceId, key: device.signatureKey })) return true;
    const proof = decode(device.enrollProof);
    return proof.length > 0 && Object.values(core.slots).some((slot) => verifyEnrollment(slot.sign, userId, deviceId, device.signatureKey, proof));
  }

  /**
   * The key a device of this account really signs with, if the server's entry for it
   * holds up. Certificates are public and the rest of an entry is the server's word,
   * so all of it is held to what the certificate says.
   */
  protected certifiedKey(device: ApiDevice): Uint8Array | null {
    const { userId, core } = this.account;
    const standing = this.certificateStanding(userId, core.rootPublic, decode(device.certificate));
    if (!standing?.carried || standing.gone || standing.cert.userId !== userId || standing.cert.deviceId !== device.id) return null;
    return equalBytes(standing.cert.signatureKey, decode(device.signature_key)) ? standing.cert.signatureKey : null;
  }

  /**
   * What to seal this account's key to for one of its devices, if that device signed
   * it and it's the newest the log of keys has for that device. A server could
   * otherwise offer an old one again, and a copy of the device taken back then would
   * go on working. While the log can't be read, it's held to what this device has
   * seen, which one that's never seen a newer one can't tell.
   */
  protected sealKeyOf(device: ApiDevice, key: Uint8Array): Uint8Array | null {
    const { userId } = this.account;
    const seal = decode(device.seal_key);
    if (seal.length !== HPKE_PUBLIC_BYTES) return null;
    const seen = this.getKv<Record<string, number>>("seal_seen") ?? {};
    const newest = seen[device.id] ?? -1;
    const generation = device.seal_generation;
    if (generation == null || !verifySealProof(key, userId, device.id, generation, seal, decode(device.seal_proof))) return null;
    const logged = this.loggedSealKey(device, seal, generation);
    if (logged === "older" || (logged === "unknown" && generation < newest)) {
      this.warnOnce(`old-seal/${device.id}/${generation}`, "The server offered an old key for one of your devices. It wasn't used.", userId);
      return null;
    }
    if (logged === "unlogged") return null;
    if (generation > newest) this.setKv("seal_seen", { ...seen, [device.id]: generation });
    return seal;
  }

  /** Devices gone from this account that no generation covers yet, so someone holds keys they shouldn't. */
  protected uncoveredRemovals(api: ApiUser): string[] {
    const { userId, deviceId } = this.account;
    const head = this.headOf(userId);
    return api.devices
      .filter((device) => {
        if (device.revoked_at == null || device.id === deviceId) return false;
        if (head) {
          const cert = parseCertificate(decode(device.certificate));
          if (cert?.deviceId === device.id && carries(head, { id: device.id, key: cert.signatureKey })) return true;
          return cert?.generation === head.gen;
        }
        return true;
      })
      .map((device) => device.id);
  }

  protected checkRemovals(api: ApiUser): void {
    if (this.stopped || !this.accountKnown) return;
    const uncovered = this.uncoveredRemovals(api).length > 0;
    this.removalsUncovered = uncovered;
    if (uncovered && !this.rotationTimer) this.rotateSoon(Math.random() * rotationTiming.takeoverMs);
  }
}
