// ServerSession, in part (see base.ts): the server's log of who holds which keys, read in full,
// checked against its signed heads, and what it says about each account (docs/KEY_TRANSPARENCY_PLAN.md).

import { ApiError, decode, type ApiDevice } from "../api";
import { equalBytes, fromBase64, toBase64 } from "../encoding";
import { verifyEnrollment, type SlotKind } from "../generations";
import { mediaTag } from "../search";
import {
  Frontier,
  bodyFits,
  emptyRoot,
  entryHash,
  fromWireHead,
  headSigned,
  leafHash,
  nameTag,
  parseBody,
  readRecord,
  sealHash,
  toWireHead,
  userTag,
  type LogBody,
  type LogHead,
  type PinnedHead,
  type WireHead,
} from "../transparency";
import type { NewDevice } from "../types";
import { SessionChains } from "./chains";

/** Where the devices waiting for the person's answer are kept. */
const NEW_DEVICES = "new_devices";
/** How many records one request reads. */
const LOG_PAGE = 2000;
/** A frontier is kept every this many records, which is the most a root from before has to be worked out from. */
const LOG_CHECKPOINT = 256;
/** How often a message carries its sender's head to a conversation that has it already. */
const HEAD_RESENT_MS = 7 * 24 * 3600 * 1000;
/** Past this many accounts the log said something new about, they're all listed again at once. */
const LOG_REFRESH_ONE_BY_ONE = 20;
/** How often the manifest is written only to carry a newer head. */
const HEAD_IN_MANIFEST_MS = 24 * 3600 * 1000;

const LOG_STATE = "log";
const HEADS_SENT = "log_sent";

/** What this device holds of the log, sealed in kv. */
interface LogState {
  /** The key heads are signed with, as this device pinned it. */
  key: string | null;
  era: number;
  frontier: { size: number; roots: string[] };
  /** The newest signed head that the records held came to. */
  head: WireHead | null;
  /** Where this device's own entry is. Entries of this account's after it are new devices. */
  own: number | null;
  /** No alert for an entry below this, as for a log written again in a new era. */
  quietBelow: number;
  /** A head the log has to hold, from the invite link or the manifest, until it's been read that far. */
  floor: { era: number; size: number; root: string; from: "link" | "manifest" } | null;
  /** Two signed heads that can't both be true, once there are. */
  proof: WireHead[] | null;
}

/** What the log says of one account's keys and devices, as this device applied it. */
export interface LoggedAccount {
  account: { idx: number; username: string; root: string; hpke: string } | null;
  /** A second account entry for the same ID. */
  twice?: boolean;
  /** Made under a username an account before it held, so it counts for nothing. */
  void?: boolean;
  deleted?: number;
  devices: Record<string, LoggedDevice>;
  /** Each generation's link, by the hash of its payload. */
  links: Record<string, string>;
}

export interface LoggedDevice {
  idx: number;
  key: string;
  /** The hashes of every certificate it was logged with. */
  certs: string[];
  enroll: string;
  /** The hashes of its seal keys, the newest last, with the generation each says if the entry gave it. */
  seals: { hash: string; gen?: number }[];
  revoked?: number;
}

/** Whether the log names a device: it does, it says it's gone, it doesn't, or this device can't tell yet. */
export type LogStanding = "named" | "gone" | "absent" | "unknown";

const WARNINGS = {
  proof: "The server showed different people different records of who holds which keys. Someone may be posing as people you talk to. Compare emoji with the people who matter to you.",
  back: "The server's record of who holds which keys went back, or it's keeping part of it from this device. Compare emoji with the people who matter to you.",
  link: "The server's record of who holds which keys isn't the one the invite link you joined with saw. Someone may be posing as people on this server. Compare emoji with the people who matter to you.",
  manifest: "The server's record of who holds which keys isn't the one your other devices saw. Someone may be posing as people you talk to. Compare emoji with the people who matter to you.",
  serverKey: "The server signed its record of who holds which keys with another key than this device knows. Nothing new in it was taken.",
  unfit: "The server's record of who holds which keys doesn't fit together. Nothing new in it was taken.",
  odd: "Part of the server's record of who holds which keys doesn't make sense, and was ignored.",
  withheld: "The server is keeping back part of its record of someone's keys from this device.",
  era: "The server started its record of who holds which keys again, as after restoring a backup. Nothing this device trusts changed.",
  nameTaken: "The server signed someone else up under your username. Their account counts for nothing to the apps, but compare emoji with the people who matter to you.",
  ownLeftOut: "The server left this device out of its record of who holds which keys, so the people you write to won't accept it.",
  ownHistory: "The server showed this device a different history of your account's keys. Someone may be trying to take over your account.",
} as const;

const fromWire = (wire: WireHead | null): LogHead | null => (wire ? fromWireHead(wire) : null);

export abstract class SessionDirectory extends SessionChains {
  // --- Key transparency ---

  protected logLoaded: LogState | null = null;
  protected loggedAccounts = new Map<string, LoggedAccount | null>();
  protected logReading: { again: boolean; done: Promise<void> } | null = null;
  /** The size the server last said its log is, in its era, so this device can tell whether it's behind. */
  protected logAnnounced: { era: number; size: number } | null = null;
  /** The log was read to what the server says it is, this session, and nothing in it was refused. */
  protected logRead = false;
  /** Heads already compared, so the same one from many messages is compared once. */
  protected headsCompared = new Set<string>();
  /** Accounts the log said something new about, since they were last looked at again. */
  protected logTouched = new Set<string>();
  /** How many times what the log says of each account has changed this session, for certificateStanding's answers. */
  protected logBumps = new Map<string, number>();
  /** When the log was last read as far as the server said it goes (ms). */
  protected logReadAt = 0;

  protected logState(): LogState {
    if (!this.logLoaded) {
      const stored = this.getKv<LogState>(LOG_STATE);
      this.logLoaded = stored ?? { key: null, era: 0, frontier: { size: 0, roots: [] }, head: null, own: null, quietBelow: 0, floor: null, proof: null };
      if (!stored && this.account.log) {
        // What the device signed in or joined with: the key, and a head the log has to hold.
        const pinned = this.account.log;
        this.logLoaded.key = pinned.key;
        if (pinned.size > 0) this.logLoaded.floor = { era: pinned.era, size: pinned.size, root: pinned.root, from: "link" };
      }
    }
    return this.logLoaded;
  }

  protected saveLogState(): void {
    this.setKv(LOG_STATE, this.logState());
  }

  protected logFrontier(): Frontier {
    return Frontier.from(this.logState().frontier) ?? new Frontier();
  }

  /** The key the log is checked with: pinned, from another device of this account, or failing those from the server's first answer. */
  protected async logKey(): Promise<Uint8Array | null> {
    const state = this.logState();
    if (state.key) return fromBase64(state.key);
    const info = await this.api.info();
    if (!info.log_key) return null;
    state.key = info.log_key;
    this.saveLogState();
    return fromBase64(state.key);
  }

  /** Whether this device has read the log as far as the server says it goes, so that what isn't in it isn't there. */
  protected logCurrent(): boolean {
    const state = this.logState();
    if (!this.logRead || !state.key) return false;
    const announced = this.logAnnounced;
    return !announced || announced.era < state.era || (announced.era === state.era && announced.size <= state.frontier.size);
  }

  /** The server says how far its log goes, in the list of people and in a frame of its own. */
  protected noteLogStatus(status: { era: number; size: number } | null | undefined): void {
    if (!status || !Number.isSafeInteger(status.era) || !Number.isSafeInteger(status.size)) return;
    const before = this.logAnnounced;
    if (before && (before.era > status.era || (before.era === status.era && before.size >= status.size))) return;
    this.logAnnounced = { era: status.era, size: status.size };
    const state = this.logState();
    if (status.era !== state.era || status.size > state.frontier.size) void this.syncLog().catch((error) => console.warn("[zuna] reading the log of keys", error));
  }

  /** Reads what's new in the log, one read at a time, and looks again at whoever it said something new about. */
  protected syncLog(): Promise<void> {
    if (this.logReading) {
      this.logReading.again = true;
      return this.logReading.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await this.syncLogOnce();
        } while (entry.again && !this.stopped);
      } finally {
        this.logReading = null;
      }
      await this.refreshLogTouched();
    })();
    this.logReading = entry;
    return entry.done;
  }

  protected async syncLogOnce(): Promise<void> {
    const key = await this.logKey();
    if (!key) return;
    let read = false;
    for (;;) {
      const state = this.logState();
      const page = await this.api.log(state.era, state.frontier.size, LOG_PAGE);
      const head: LogHead = { era: page.head.era, size: page.head.size, root: decode(page.head.root), sig: decode(page.head.sig) };
      if (head.era !== page.era || !headSigned(key, head)) {
        this.logRead = false;
        return this.warnOnce("log/server-key", WARNINGS.serverKey);
      }
      if (page.era < state.era || (page.era === state.era && page.size < state.frontier.size)) {
        this.logRead = false;
        return this.warnOnce(`log/back/${page.era}/${page.size}`, WARNINGS.back);
      }
      if (page.era > state.era) this.startLogEra(page.era, page.size);
      // A page with nothing in it that says there's more would be asked for again and again.
      if (page.records.length === 0 && this.logState().frontier.size < page.size) return void this.refuseLog();
      const done = this.takeLogPage(page.records, head, page.size);
      if (!done) return;
      read = true;
      if (this.logState().frontier.size >= page.size) break;
    }
    this.logRead = true;
    this.logReadAt = Date.now();
    if (read) this.lookForWithheld();
    this.checkFloor();
    if (this.logState().own === null && this.logState().frontier.size > 0) this.warnOnce("log/own", WARNINGS.ownLeftOut, this.account.userId);
  }

  /**
   * A new era signed with the key this device pinned: the log was written again, as after a server
   * restored a backup. It's read from the start, and held to the pins and chains kept apart from it.
   */
  protected startLogEra(era: number, size: number): void {
    const state = this.logState();
    const first = state.era === 0;
    this.db.transaction(() => {
      this.db.run("DELETE FROM log_records");
      this.db.run("DELETE FROM log_accounts");
      this.db.run("DELETE FROM log_names");
    });
    this.loggedAccounts.clear();
    this.logBumps.clear();
    this.standingCache.clear();
    this.logLoaded = {
      ...state,
      era,
      frontier: { size: 0, roots: [] },
      head: null,
      own: null,
      // What a log written again says of this account's devices isn't news.
      quietBelow: first ? 0 : size,
      floor: state.floor && state.floor.era === era ? state.floor : null,
    };
    this.saveLogState();
    if (!first) this.warnOnce(`log/era/${era}`, WARNINGS.era);
  }

  /**
   * Checks a page of records against the signed head it came to, and if it holds, keeps it and
   * applies what its bodies say, all in one transaction. Says whether it did.
   */
  protected takeLogPage(records: { idx: number; record: string; body?: string | null }[], head: LogHead, size: number): boolean {
    const state = this.logState();
    const frontier = this.logFrontier();
    const floor = state.floor && state.floor.era === state.era ? state.floor : null;
    const rows: { idx: number; record: Uint8Array; checkpoint: Uint8Array | null; body: LogBody | null }[] = [];
    for (const wire of records) {
      const record = decode(wire.record);
      const parts = readRecord(record);
      if (wire.idx !== frontier.size || !parts) return this.refuseLog();
      let body: LogBody | null = null;
      if (wire.body) {
        const bytes = decode(wire.body);
        body = parseBody(bytes);
        if (!body || !bodyFits(parts, bytes, body)) return this.refuseLog();
      }
      frontier.append(leafHash(record));
      // A head this log has to hold is checked on the way past it.
      if (floor && frontier.size === floor.size && !equalBytes(frontier.root(), fromBase64(floor.root))) return this.refuseLog(floor.from);
      const checkpoint = frontier.size % LOG_CHECKPOINT === 0 ? new Uint8Array(frontier.roots.flatMap((root) => [...root])) : null;
      rows.push({ idx: wire.idx, record, checkpoint, body });
    }
    if (frontier.size !== head.size || !equalBytes(frontier.root(), head.root)) return this.refuseLog();
    if (floor && size < floor.size && frontier.size >= size) {
      this.logRead = false;
      this.warnOnce(`log/floor/${floor.size}`, WARNINGS[floor.from]);
    }
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run("INSERT OR REPLACE INTO log_records(idx, record, frontier, opened) VALUES(?, ?, ?, ?)", [row.idx, row.record, row.checkpoint, row.body ? 1 : 0]);
        if (row.body) this.applyLogEntry(row.idx, row.body);
        else this.lookAtUnopened(row.idx, row.record);
      }
      this.saveLoggedAccounts();
      state.frontier = frontier.toJSON();
      state.head = toWireHead(head);
      if (floor && frontier.size >= floor.size) state.floor = null;
      this.saveLogState();
    });
    return true;
  }

  protected refuseLog(from?: "link" | "manifest"): false {
    this.logRead = false;
    this.warnOnce(from ? `log/floor/${from}` : "log/unfit", from ? WARNINGS[from] : WARNINGS.unfit);
    return false;
  }

  /** A head this log has to hold that it's already past: the root it had then has to be the head's. */
  protected checkFloor(): void {
    const state = this.logState();
    const floor = state.floor;
    if (!floor || floor.era !== state.era || floor.size > state.frontier.size) return;
    state.floor = null;
    this.saveLogState();
    if (!equalBytes(this.rootAt(floor.size), fromBase64(floor.root))) {
      this.logRead = false;
      this.warnOnce(`log/floor/${floor.from}`, WARNINGS[floor.from]);
    }
  }

  /** The tree's root when it was `size` records long, worked out from the frontier kept at the checkpoint before. */
  protected rootAt(size: number): Uint8Array {
    const state = this.logState();
    if (size === 0) return emptyRoot();
    if (size === state.frontier.size) return this.logFrontier().root();
    const base = Math.floor(size / LOG_CHECKPOINT) * LOG_CHECKPOINT;
    let frontier = new Frontier();
    if (base > 0) {
      const row = this.db.get<{ frontier: Uint8Array | null }>("SELECT frontier FROM log_records WHERE idx = ?", [base - 1]);
      const roots: Uint8Array[] = [];
      for (let i = 0; row?.frontier && i + 32 <= row.frontier.length; i += 32) roots.push(row.frontier.slice(i, i + 32));
      frontier = new Frontier(base, roots);
    }
    for (const row of this.db.all<{ record: Uint8Array }>("SELECT record FROM log_records WHERE idx >= ? AND idx < ? ORDER BY idx", [base, size])) {
      frontier.append(leafHash(row.record));
    }
    return frontier.size === size ? frontier.root() : new Uint8Array(32);
  }

  // What the log says of each account, kept sealed, one row each, and read as it's needed.

  protected loggedAccount(userId: string): LoggedAccount | null {
    if (!this.loggedAccounts.has(userId)) {
      const row = this.db.get<{ sealed: Uint8Array }>("SELECT sealed FROM log_accounts WHERE user_id = ?", [userId]);
      // What doesn't open counts as nothing logged, which waits for the log to be read again.
      this.loggedAccounts.set(userId, row ? this.openValue<LoggedAccount | null>("log-account", userId, row.sealed, null) : null);
    }
    return this.loggedAccounts.get(userId) ?? null;
  }

  /** Accounts changed by the entries applied and not saved yet. */
  protected unsavedAccounts = new Set<string>();

  protected saveLoggedAccounts(): void {
    for (const userId of this.unsavedAccounts) {
      const account = this.loggedAccounts.get(userId);
      if (account) this.db.run("INSERT OR REPLACE INTO log_accounts(user_id, sealed) VALUES(?, ?)", [userId, this.sealJson("log-account", userId, account)]);
    }
    this.unsavedAccounts.clear();
  }

  protected nameKey(username: string): string {
    return mediaTag(this.searchKey, `log-name/${username.toLowerCase()}`);
  }

  protected nameHolder(username: string): { user: string; idx: number; deleted?: number } | null {
    const tag = this.nameKey(username);
    const row = this.db.get<{ sealed: Uint8Array }>("SELECT sealed FROM log_names WHERE tag = ?", [tag]);
    return row ? this.openValue<{ user: string; idx: number; deleted?: number } | null>("log-name", tag, row.sealed, null) : null;
  }

  protected setNameHolder(username: string, holder: { user: string; idx: number; deleted?: number }): void {
    const tag = this.nameKey(username);
    this.db.run("INSERT OR REPLACE INTO log_names(tag, sealed) VALUES(?, ?)", [tag, this.sealJson("log-name", tag, holder)]);
  }

  /** What an entry says, held to what came before it (the table in section 5.5 of the plan). */
  protected applyLogEntry(idx: number, body: LogBody): void {
    const self = this.account.userId;
    const state = this.logState();
    const account = this.loggedAccount(body.user) ?? { account: null, devices: {}, links: {} };
    const odd = () => this.warnOnce("log/odd", WARNINGS.odd);
    this.loggedAccounts.set(body.user, account);
    this.unsavedAccounts.add(body.user);
    this.logTouched.add(body.user);
    this.logBumps.set(body.user, (this.logBumps.get(body.user) ?? 0) + 1);
    switch (body.t) {
      case "account": {
        if (account.account) {
          account.twice = true;
          this.noteLoggedRootChanged(body.user);
          break;
        }
        account.account = { idx, username: body.username, root: toBase64(body.root), hpke: toBase64(body.hpke) };
        if (body.username) {
          const holder = this.nameHolder(body.username);
          if (holder && holder.user !== body.user && holder.deleted === undefined) {
            account.void = true;
            if (holder.user === self) this.warnOnce(`log/name/${body.user}`, WARNINGS.nameTaken, self);
          } else {
            this.setNameHolder(body.username, { user: body.user, idx });
          }
        }
        if (body.user === self) {
          if (!equalBytes(body.root, this.account.core.rootPublic) || body.username.toLowerCase() !== this.account.username.toLowerCase()) {
            this.warnOnce("log/own-account", WARNINGS.ownHistory, self);
          }
        } else {
          this.takeLoggedRoot(body.user, body.root);
        }
        break;
      }
      case "device": {
        if (!account.account || account.deleted !== undefined || account.devices[body.device]) {
          odd();
          break;
        }
        account.devices[body.device] = { idx, key: toBase64(body.key), certs: [toBase64(body.cert)], enroll: toBase64(body.enroll), seals: [{ hash: toBase64(body.seal) }] };
        if (body.user !== self) break;
        if (body.device === this.account.deviceId) {
          state.own = idx;
          if (!equalBytes(body.key, this.account.devicePublic)) this.warnOnce("log/own-device", WARNINGS.ownHistory, self);
        } else if (state.own !== null && idx > state.own && idx >= state.quietBelow) {
          // From the entry, so the server can't leave a new device of this account unsaid.
          this.noteNewDevice(body.device);
        }
        break;
      }
      case "certificate":
      case "seal": {
        const device = account.devices[body.device];
        if (!device || device.revoked !== undefined) {
          odd();
          break;
        }
        if (body.t === "certificate") {
          const cert = toBase64(body.cert);
          if (!device.certs.includes(cert)) device.certs.push(cert);
        } else {
          device.seals.push({ hash: toBase64(body.seal), gen: body.gen });
        }
        break;
      }
      case "revoked": {
        const device = account.devices[body.device];
        if (!device) odd();
        else device.revoked ??= idx;
        // Removed, here or anywhere else, so there's nothing left to ask about it.
        if (body.user === self) this.dropNewDevice(body.device);
        break;
      }
      case "link": {
        const hash = toBase64(body.link);
        const held = account.links[body.gen];
        if (held) {
          if (held !== hash) this.noteLoggedFork(body.user);
          break;
        }
        if (body.gen !== Object.keys(account.links).length + 1) {
          odd();
          break;
        }
        account.links[body.gen] = hash;
        this.noteLoggedLink(body.user, body.gen, body.link);
        break;
      }
      case "deleted": {
        if (!account.account || account.deleted !== undefined) {
          odd();
          break;
        }
        account.deleted = idx;
        const name = account.account.username;
        const holder = name ? this.nameHolder(name) : null;
        if (holder && holder.user === body.user) this.setNameHolder(name, { ...holder, deleted: idx });
        break;
      }
    }
  }

  // Devices that signed in to this account after this one, which the person is asked about, each
  // on every one of the account's devices that was there before it, until they say whether it was
  // them. An answer isn't passed to the account's other devices: whoever signed in could give it.

  protected newDeviceList(): { id: string; at: number; secret?: SlotKind }[] {
    return this.getKv<{ id: string; at: number; secret?: SlotKind }[]>(NEW_DEVICES) ?? [];
  }

  protected noteNewDevice(deviceId: string): void {
    const list = this.newDeviceList();
    if (list.some((item) => item.id === deviceId)) return;
    this.setKv(NEW_DEVICES, [...list, { id: deviceId, at: Date.now() }]);
    this.emitNewDevices();
  }

  protected dropNewDevice(deviceId: string): void {
    const list = this.newDeviceList();
    if (!list.some((item) => item.id === deviceId)) return;
    this.setKv(NEW_DEVICES, list.filter((item) => item.id !== deviceId));
    this.emitNewDevices();
  }

  protected emitNewDevices(): void {
    this.emit({ type: "new_devices", serverId: this.serverId, devices: this.getNewDevices() });
  }

  /** The devices this device asks the person about, oldest first (`answerNewDevice`). */
  getNewDevices(): NewDevice[] {
    const self = this.users.get(this.account.userId);
    const list = this.newDeviceList();
    let learned = false;
    const devices = list.flatMap((item) => {
      const device = self?.devices.get(item.id);
      if (device?.revoked) return [];
      // Kept once it's known, as the slot it opened may be replaced before the person answers.
      if (!item.secret && device) {
        const secret = this.enrolledWith(item.id, device);
        if (secret) [item.secret, learned] = [secret, true];
      }
      return [{ id: item.id, name: this.deviceNames.get(item.id) ?? "Device", createdAt: device?.createdAt ?? item.at, secret: item.secret ?? null }];
    });
    if (learned) this.setKv(NEW_DEVICES, list);
    return devices;
  }

  /** Which of the account's secrets a device of it signed in with, from the proof it gave, if this device can tell. */
  protected enrolledWith(deviceId: string, device: { signatureKey: Uint8Array; enrollProof?: string | null }): SlotKind | null {
    const proof = decode(device.enrollProof);
    if (proof.length === 0) return null;
    const { core, userId } = this.account;
    for (const kind of ["password", "recovery"] as const) {
      const slot = core.slots[kind];
      if (slot && verifyEnrollment(slot.sign, userId, deviceId, device.signatureKey, proof)) return kind;
    }
    return null;
  }

  /** A record that came without its body: if it's about someone this device knows, the server is keeping it back. */
  protected lookAtUnopened(idx: number, record: Uint8Array): void {
    const parts = readRecord(record);
    if (!parts) return;
    // Someone hidden from this device, under this account's own name.
    if (equalBytes(nameTag(this.account.username, parts.nonce), parts.nameTag)) this.warnOnce(`log/name-hidden/${idx}`, WARNINGS.nameTaken, this.account.userId);
  }

  /** The IDs this device knows, its own first, which a record without its body is tested against. */
  protected knownIds(): string[] {
    const ids = new Set<string>([this.account.userId, ...this.users.keys()]);
    for (const row of this.db.all<{ user_id: string }>("SELECT user_id FROM pinned_identities")) ids.add(row.user_id);
    return [...ids];
  }

  /** Every record held without its body, tested against the IDs given. Those it fits are asked for. */
  protected lookForWithheld(ids: string[] = this.knownIds()): void {
    const unopened = this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0");
    if (unopened.length === 0) return;
    const wanted = new Map<string, number[]>();
    for (const row of unopened) {
      const parts = readRecord(row.record);
      if (!parts) continue;
      for (const id of ids) {
        if (equalBytes(userTag(id, parts.nonce), parts.userTag)) wanted.set(id, [...(wanted.get(id) ?? []), row.idx]);
      }
    }
    for (const [id, places] of wanted) void this.askForBodies(id, places).catch((error) => console.warn("[zuna] asking for the log's entries about someone", error));
  }

  /** Someone newly there for this device, such as a private bot it was just put in a chat with. */
  protected noteNewlyKnown(userId: string): void {
    if (this.logState().frontier.size > 0) this.lookForWithheld([userId]);
  }

  /**
   * Asks for what the log says of one account, whose records came without their bodies. The
   * server may keep them back only from someone that account isn't there for at all.
   */
  protected async askForBodies(userId: string, places: number[]): Promise<void> {
    let answer: { era: number; bodies: { idx: number; body: string }[] };
    try {
      answer = await this.api.logBodies(userId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      const listed = await this.api.user(userId).then(
        () => true,
        (failure: unknown) => (failure instanceof ApiError && failure.status === 404 ? false : Promise.reject(failure)),
      );
      if (listed) this.warnOnce(`log/withheld/${userId}`, WARNINGS.withheld, userId);
      return;
    }
    const state = this.logState();
    if (answer.era !== state.era) return;
    const given = new Map(answer.bodies.map((item) => [item.idx, decode(item.body)]));
    if (places.some((idx) => !given.has(idx))) this.warnOnce(`log/withheld/${userId}`, WARNINGS.withheld, userId);
    const entries: { idx: number; body: LogBody }[] = [];
    for (const [idx, bytes] of [...given].sort((a, b) => a[0] - b[0])) {
      const row = this.db.get<{ record: Uint8Array }>("SELECT record FROM log_records WHERE idx = ?", [idx]);
      const parts = row && readRecord(row.record);
      const body = parseBody(bytes);
      // What's past the records held is read with them, later.
      if (!parts) continue;
      if (!body || body.user !== userId || !bodyFits(parts, bytes, body)) return this.warnOnce("log/unfit", WARNINGS.unfit);
      entries.push({ idx, body });
    }
    // All of what the log says of this account, in its order, from the start.
    this.db.transaction(() => {
      this.loggedAccounts.set(userId, null);
      this.logBumps.set(userId, (this.logBumps.get(userId) ?? 0) + 1);
      this.db.run("DELETE FROM log_accounts WHERE user_id = ?", [userId]);
      const quiet = state.quietBelow;
      state.quietBelow = state.frontier.size;
      for (const entry of entries) {
        this.applyLogEntry(entry.idx, entry.body);
        this.db.run("UPDATE log_records SET opened = 1 WHERE idx = ?", [entry.idx]);
      }
      state.quietBelow = quiet;
      this.saveLoggedAccounts();
      this.saveLogState();
    });
    await this.refreshLogTouched();
  }

  /** Looks again at whoever the log said something new about, as what counts for them may have changed. */
  protected async refreshLogTouched(): Promise<void> {
    const touched = [...this.logTouched].filter((id) => this.users.has(id) || id === this.account.userId);
    this.logTouched.clear();
    if (touched.length > LOG_REFRESH_ONE_BY_ONE) {
      // Everyone, as the first read of a log says something of all of them: one list, not a request each.
      const response = await this.api.users(0).catch(() => null);
      if (response) this.db.transaction(() => response.users.forEach((user) => this.applyUser(user)));
    }
    for (const userId of touched) {
      if (touched.length <= LOG_REFRESH_ONE_BY_ONE) {
        try {
          await this.fetchUser(userId);
        } catch {
          // Looked at again when they're next listed.
        }
      }
      this.rescheduleAffectedByDeviceChange(userId);
    }
    if (touched.length > 0) {
      this.emit({ type: "users", serverId: this.serverId });
      this.emitConversations();
    }
    // When a new device signed in, as the server says, now that its entry is in the list.
    if (touched.includes(this.account.userId) && this.newDeviceList().length > 0) this.emitNewDevices();
  }

  // --- What the log says, for the checks that go by it ---

  /** Whether the log names a device of an account, with this signing key and a certificate of this hash. */
  protected logStanding(userId: string, deviceId: string, key: Uint8Array, certificate: Uint8Array): LogStanding {
    const account = this.loggedAccount(userId);
    const device = account?.devices[deviceId];
    if (account && !account.void && !account.twice && device && device.key === toBase64(key)) {
      if (device.revoked !== undefined) return "gone";
      if (device.certs.includes(toBase64(entryHash(certificate)))) return "named";
    }
    return this.logCurrent() ? "absent" : "unknown";
  }

  /** What changes when the log changes, for certificateStanding's answers to be worked out again. */
  protected logVersion(userId: string): string {
    return `${this.logCurrent() ? 1 : 0}:${this.logState().era}:${this.logBumps.get(userId) ?? 0}`;
  }

  /**
   * Reads the log again if it may not have what the server listed at `since` (ms): a device a
   * person just added is in the log before it's in any list, but this device may not have read it yet.
   */
  protected async syncLogIfBehind(since: number): Promise<void> {
    if (this.logReading || this.logReadAt < since) await this.syncLog().catch((error) => console.warn("[zuna] reading the log of keys", error));
  }

  /** The newest generation the log has a link for, for an account. */
  protected loggedGeneration(userId: string): number {
    return Object.keys(this.loggedAccount(userId)?.links ?? {}).length;
  }

  /** The hash of a generation's link, as the log has it. */
  protected loggedLink(userId: string, generation: number): Uint8Array | null {
    const hash = this.loggedAccount(userId)?.links[generation];
    return hash ? fromBase64(hash) : null;
  }

  /** The key an account began with, as the log says. */
  protected loggedRoot(userId: string): Uint8Array | null {
    const root = this.loggedAccount(userId)?.account?.root;
    return root ? fromBase64(root) : null;
  }

  /** Whether the log says something about an account's first key that doesn't fit: a second account entry, or one that isn't its pin. */
  protected loggedRootDisagrees(userId: string): boolean {
    const account = this.loggedAccount(userId);
    if (!account?.account) return false;
    if (account.twice) return true;
    const pinned = this.pinnedIdentity(userId);
    return !!pinned && !equalBytes(pinned, fromBase64(account.account.root));
  }

  /** Whether an account was made under a name another held, which makes it count for nothing. */
  protected loggedVoid(userId: string): boolean {
    return this.loggedAccount(userId)?.void === true;
  }

  /**
   * What to seal this account's key to for one of its devices, held to the newest seal key the
   * log has for it. Null when the server offers one the log doesn't have, or an older one.
   */
  protected loggedSealKey(device: ApiDevice, seal: Uint8Array, generation: number): "newest" | "older" | "unlogged" | "unknown" {
    const logged = this.loggedAccount(this.account.userId)?.devices[device.id];
    if (!logged) return this.logCurrent() ? "unlogged" : "unknown";
    const offered = toBase64(sealHash(seal, generation, decode(device.seal_proof)));
    // The same key registered again is still the newest.
    if (logged.seals.at(-1)?.hash === offered) return "newest";
    return logged.seals.some((item) => item.hash === offered) ? "older" : "unlogged";
  }

  /** A device with no pin for someone takes it from their account entry, never from the list of people. */
  protected takeLoggedRoot(userId: string, root: Uint8Array): void {
    const pinned = this.pinnedIdentity(userId);
    if (!pinned) {
      this.db.run("INSERT INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [userId, this.sealPin(userId, root)]);
      this.standingCache.clear();
    } else if (!equalBytes(pinned, root)) {
      this.noteLoggedRootChanged(userId);
    }
  }

  /** The log says someone's first key is other than the one held for them, which is today's `changed`. */
  protected noteLoggedRootChanged(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    queueMicrotask(() => {
      const before = user.trust;
      user.trust = this.trustOf(userId, user.identityKey);
      if (before === user.trust || user.trust !== "changed") return;
      this.persistUser(user);
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: `The security key of ${user.profile.displayName} changed. Their messages can't be trusted until you verify them again.`,
      });
      const dm = this.dmWith(userId);
      if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_changed", actorId: userId, targetIds: [userId] });
      this.emit({ type: "users", serverId: this.serverId });
    });
  }

  /** Two links for one generation in the log: the server told two stories of someone's keys. */
  protected noteLoggedFork(userId: string): void {
    if (userId === this.account.userId) this.warnOnce("log/own-fork", WARNINGS.ownHistory, userId);
    else queueMicrotask(() => void this.noteFork(userId).catch(() => undefined));
  }

  /**
   * A generation's link, as the log names it. One this device holds has to be it, and one it
   * doesn't is followed, as the server can't keep a rotation from a contact under one head.
   */
  protected noteLoggedLink(userId: string, generation: number, hash: Uint8Array): void {
    const held = this.chainOf(userId)[generation - 1];
    if (held) {
      if (!equalBytes(held.hash, hash)) this.noteLoggedFork(userId);
      return;
    }
    if (userId === this.account.userId) {
      this.syncAccountSoon();
    } else if (this.pinnedIdentity(userId)) {
      queueMicrotask(() => void this.followChain(userId).catch((error) => console.warn("[zuna] following a chain of keys", error)));
    }
  }

  // --- Heads, compared where the server can't change them ---

  /** The newest signed head this device holds, for a message to carry or the manifest to keep. */
  protected heldHead(): LogHead | null {
    return this.logRead ? fromWire(this.logState().head) : null;
  }

  /** What a message to a conversation carries of this device's head: only one newer than it last carried there, or a week on. */
  protected headForMessage(groupId: string): WireHead | undefined {
    const head = this.heldHead();
    if (!head) return undefined;
    const sent = this.getKv<Record<string, { e: number; n: number; at: number }>>(HEADS_SENT) ?? {};
    const last = sent[groupId];
    if (last && last.e === head.era && last.n >= head.size && Date.now() - last.at < HEAD_RESENT_MS) return undefined;
    sent[groupId] = { e: head.era, n: head.size, at: Date.now() };
    this.setKv(HEADS_SENT, sent);
    return toWireHead(head);
  }

  /** What an invite link carries of the log: the key, and the head this device holds, which whoever joins holds the log to. */
  protected headForLink(): PinnedHead | undefined {
    const state = this.logState();
    const head = this.heldHead();
    return head && state.key ? { key: fromBase64(state.key), era: head.era, size: head.size, root: head.root } : undefined;
  }

  /** What the manifest says of the log: the key, and the head this device holds. */
  protected headForManifest(): { key: string; era: number; size: number; root: string } | undefined {
    const state = this.logState();
    const head = this.heldHead();
    return head && state.key ? { key: state.key, era: head.era, size: head.size, root: toBase64(head.root) } : undefined;
  }

  /** Whether the manifest should be written only to carry a newer head: at most daily. */
  protected manifestHeadBehind(held: { era: number; size: number } | undefined): boolean {
    const head = this.heldHead();
    if (!head) return false;
    if (!held || held.era !== head.era) return true;
    if (held.size >= head.size) return false;
    const at = this.getKv<number>("log_manifest_at") ?? 0;
    return Date.now() - at >= HEAD_IN_MANIFEST_MS;
  }

  protected noteManifestHeadWritten(): void {
    this.setKv("log_manifest_at", Date.now());
  }

  /** The log's key and a head, as another device of this account kept them in the manifest. */
  protected takeManifestHead(log: { key: string; era: number; size: number; root: string }): void {
    const state = this.logState();
    if (!state.key) {
      state.key = log.key;
      this.saveLogState();
    } else if (state.key !== log.key) {
      return this.warnOnce("log/manifest-key", WARNINGS.manifest, this.account.userId);
    }
    if (log.era < state.era) return;
    if (log.era > state.era || log.size > state.frontier.size) {
      if (!state.floor || state.floor.era < log.era || state.floor.size < log.size) {
        state.floor = { era: log.era, size: log.size, root: log.root, from: "manifest" };
        this.saveLogState();
      }
      if (state.era > 0) void this.syncLog().catch((error) => console.warn("[zuna] reading the log of keys", error));
      return;
    }
    if (!equalBytes(this.rootAt(log.size), fromBase64(log.root))) {
      this.logRead = false;
      this.warnOnce("log/floor/manifest", WARNINGS.manifest, this.account.userId);
    }
  }

  /**
   * Someone's head, from a message only they could sign. Signed by the key this device pinned, it
   * has to fit the log held, or be ahead of it and fit once that's read. Two roots for one size,
   * both signed, are proof that the server keeps two logs.
   */
  protected async compareHead(wire: WireHead, from: string): Promise<void> {
    const head = fromWireHead(wire);
    const key = this.logState().key;
    if (!head || !key) return;
    const seen = `${head.era}/${head.size}/${toBase64(head.root)}`;
    if (this.headsCompared.has(seen)) return;
    this.headsCompared.add(seen);
    if (!headSigned(fromBase64(key), head)) {
      const name = this.users.get(from)?.profile.displayName || "Someone";
      return this.warnOnce(
        `log/their-key/${from}`,
        `${name}'s app holds a record of who holds which keys that this server didn't sign for you. Either the server gave them another key, or their app made it up.`,
        from,
      );
    }
    let state = this.logState();
    if (head.era < state.era) return;
    if (head.era > state.era || head.size > state.frontier.size) {
      await this.syncLog();
      state = this.logState();
      if (head.era < state.era) return;
      if (head.era > state.era || head.size > state.frontier.size) return this.warnOnce(`log/back/${head.era}/${head.size}`, WARNINGS.back);
    }
    if (equalBytes(this.rootAt(head.size), head.root)) return;
    // The server's own head at that size, signed, which with theirs is the proof.
    const own = await this.api.log(state.era, head.size - 1, 1).catch(() => null);
    const ours = own && own.era === state.era && own.head.size === head.size ? fromWireHead({ e: own.head.era, n: own.head.size, r: own.head.root, s: own.head.sig }) : null;
    if (ours && headSigned(fromBase64(key), ours) && !equalBytes(ours.root, head.root)) {
      state.proof = [toWireHead(ours), wire];
      this.saveLogState();
    }
    this.warnOnce("log/proof", WARNINGS.proof, from);
  }

  /** The two heads that can't both be true, if this device has found them. */
  protected logProof(): WireHead[] | null {
    return this.logState().proof;
  }
}
