// ServerSession, in part (see base.ts): the server's log of who holds which keys, read in full,
// checked against its signed heads, and what it says about each account (docs/KEY_TRANSPARENCY.md).

import { ApiError, decode, type ApiDevice } from "../api";
import { concat, equalBytes, fromBase64, toBase64 } from "../encoding";
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
  logKeyHash,
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
import { mark, t } from "../i18n";

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
/** How many times asking for an account's bodies fails before the person is told, and how long between tries. */
const BODIES_TRIES = 3;
const BODIES_RETRY_MS = 5000;
const BODIES_RETRY_MAX_MS = 5 * 60 * 1000;
/** How often the manifest is written only to carry a newer head. */
const HEAD_IN_MANIFEST_MS = 24 * 3600 * 1000;
/** A record of an account the log says is deleted, which was never there for this device (`log_records.opened`). */
const GONE = 2;

/** How many heads the log has still to hold are kept beside the furthest of them. */
const MARKS_KEPT = 8;

const LOG_STATE = "log";
const HEADS_SENT = "log_sent";

/** Where a head the log has to hold came from: the invite link, the account's other devices, or what signing in checked. */
type HeadFrom = "link" | "manifest" | "signin";

/** A head the log has to hold, which the server didn't choose once this device had it. */
interface Floor {
  era: number;
  size: number;
  root: string;
  from: HeadFrom;
}

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
  /** This account's devices as the log named them before it was last written again: any other in it since is asked about. */
  ownBefore?: string[];
  /**
   * A head the log has to hold, from the invite link, the manifest or signing in, until it's been
   * read that far: the furthest of those this device has, in the earliest era it has one of.
   */
  floor: Floor | null;
  /** The others of the floor's era, each short of it, or of its size with another root: held on the way to it, as it is. */
  marks?: Floor[];
  /**
   * The head a device signed in with, of the server's own era, when its manifest's is of an era
   * before: that era is read first, held to the manifest's, and then the server's, held to this.
   */
  floorAfter?: Floor;
  /**
   * This device came with a head the log has to hold, and hasn't read the log to it yet. Until it
   * has, and the log held it, nothing the log says counts: no key is taken from it, no device it
   * names is named, and nothing it says of anyone is said (`counted`, `settleLog`).
   */
  unheld?: boolean;
  /** The head the log last held, of those. */
  held?: { era: number; size: number; from: HeadFrom };
  /** The era held was read only to hold that head to, before the server's own later one, which hasn't begun yet (`readEraOfFloor`). */
  heldOnly?: boolean;
  /**
   * The era such a head was of, when the server's own was a later one: what it said is kept, for
   * every era after it to be held to (`log_kept_records`, `log_kept_names`). `owed` is the accounts
   * whose first key is still owed from it, and `checked` whether everyone it named was looked for
   * in the era read after it.
   */
  kept?: { era: number; from: HeadFrom; owed: string[]; checked: boolean };
  /**
   * The eras before this one that this device read, each as far as it holds it: its records are
   * kept (`log_past`), with the tree's frontier and the last signed head they came to, for a head
   * someone holds of that era to be held to (`comparePast`). `ended` is that the server has said
   * where the era ends, as it kept it, so a head of it longer than that is the server's log gone
   * back, or an era that went on for others after this device was shown the next. `longer` is such
   * a head, kept with `head` as what the server signed of the two.
   */
  past?: Record<string, PastEra>;
  /** Two signed heads that can't both be true, once there are. */
  proof: WireHead[] | null;
}

interface PastEra {
  frontier: { size: number; roots: string[] };
  head: WireHead | null;
  ended: boolean;
  longer?: WireHead;
}

/** What the log says of one account's keys and devices, as this device applied it. */
export interface LoggedAccount {
  account: { idx: number; username: string; root: string; hpke: string } | null;
  /** A second account entry for the same ID. */
  twice?: boolean;
  /** Made under a username an account before it held, so it counts for nothing. */
  void?: boolean;
  /**
   * Its first key is owed from the era this device's link or manifest was of, where its records
   * came without their bodies: nothing of it counts until that's come (`askForKept`).
   */
  owed?: boolean;
  deleted?: number;
  devices: Record<string, LoggedDevice>;
  /** Each generation's link, by the hash of its payload. */
  links: Record<string, string>;
  /** A second link for a generation, with another hash. */
  forked?: boolean;
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
  proof: mark("security.logProof"),
  back: mark("security.logBack"),
  link: mark("security.logLink"),
  manifest: mark("security.logManifest"),
  // The head a device signed in with is one the server gave it: a log that doesn't hold it went back.
  signin: mark("security.logBack"),
  serverKey: mark("security.logServerKey"),
  unfit: mark("security.logUnfit"),
  odd: mark("security.logOdd"),
  withheld: mark("security.logWithheld"),
  era: mark("security.logEra"),
  nameTaken: mark("security.logNameTaken"),
  ownLeftOut: mark("security.logOwnLeftOut"),
  ownHistory: mark("security.logOwnHistory"),
} as const;

const fromWire = (wire: WireHead | null): LogHead | null => (wire ? fromWireHead(wire) : null);

/** Whether a record is about an account, which only its ID says. */
function isAbout(record: Uint8Array, userId: string): boolean {
  const parts = readRecord(record);
  return !!parts && equalBytes(userTag(userId, parts.nonce), parts.userTag);
}

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
  /**
   * Accounts this device knows whose records the log holds without their bodies. What it says of them
   * can't be read, so their devices count for nothing new: none of their leaves is encrypted to, and
   * none of their key packages taken, until the bodies come (`askForBodies`).
   */
  protected withheldUsers = new Set<string>();
  /** Accounts whose bodies are being asked for, and how many times in a row asking failed. */
  protected bodiesAsked = new Set<string>();
  protected bodiesFailed = new Map<string, number>();
  /** Unopened records were tested against the accounts known, this session. */
  protected withheldLooked = false;
  /** Accounts whose entries in the era kept are being asked for, and how many times in a row asking failed. */
  protected keptAsked = new Set<string>();
  protected keptFailed = new Map<string, number>();
  /** Eras before this one whose rest is being read, and how many times the server refused each. */
  protected pastReading = new Map<number, Promise<void>>();
  protected pastRefused = new Map<number, number>();
  /**
   * How many times the server refused to give the log while something it didn't write said there
   * was more of it than this device holds (`logOwes`), and the next try, while one waits.
   */
  protected logRefused = 0;
  protected logRetry: ReturnType<typeof setTimeout> | null = null;
  /**
   * The furthest head someone signed that's past what this device holds, while it is. `failed` is
   * that the log couldn't be read to compare it, so it's compared once the log has been.
   */
  protected headAhead: { wire: WireHead; era: number; size: number; from: string; failed: boolean } | null = null;
  /** The era a link's or manifest's head is of is being read, before the server's own: what it says is taken once it's all held. */
  protected floorEraReading = false;

  protected logState(): LogState {
    if (!this.logLoaded) {
      const stored = this.getKv<LogState>(LOG_STATE);
      this.logLoaded = stored ?? { key: null, era: 0, frontier: { size: 0, roots: [] }, head: null, own: null, quietBelow: 0, floor: null, proof: null };
      if (!stored && this.account.log) {
        // What the device signed in or joined with: the key, and a head the log has to hold.
        const pinned = this.account.log;
        this.logLoaded.key = pinned.key;
        if (pinned.size > 0) {
          this.logLoaded.floor = { era: pinned.era, size: pinned.size, root: pinned.root, from: pinned.signedIn ? "signin" : "link" };
          this.logLoaded.unheld = true;
        }
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
    if (!this.logRead || !state.key || state.unheld) return false;
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
      this.compareHeadAhead();
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
      let page: Awaited<ReturnType<typeof this.api.log>>;
      try {
        page = await this.api.log(state.era, state.frontier.size, LOG_PAGE);
      } catch (error) {
        this.noteLogRefused(error);
        throw error;
      }
      const head: LogHead = { era: page.head.era, size: page.head.size, root: decode(page.head.root), sig: decode(page.head.sig) };
      if (head.era !== page.era || !headSigned(key, head)) {
        this.logRead = false;
        return this.warnOnce("log/server-key", t(WARNINGS.serverKey));
      }
      if (page.era < state.era || (page.era === state.era && page.size < state.frontier.size)) {
        this.logRead = false;
        return this.warnOnce(`log/back/${page.era}/${page.size}`, t(WARNINGS.back));
      }
      // The server moved on to a later era before this device got to the head it has to hold in the
      // one it was reading: what it read of that counts for nothing, and it starts again from there.
      if (state.unheld && state.era > 0 && page.era > state.era) {
        this.forgetUnheld();
        continue;
      }
      // A device that has read nothing yet holds the log to the head its link or manifest carried.
      // One of an era before that head's is refused, and one of a later era is taken only once the
      // head's own era, as the server kept it, has been read to it and held to it.
      if (state.era === 0 && state.floor && state.floor.era !== page.era) {
        const { era, from } = state.floor;
        if (era < page.era && (await this.readEraOfFloor(key))) continue;
        this.refuseLog(from);
        // A link's head that can't be held stops here, and whoever joins can ask for another link. A
        // new device of an account has no other way in, and has its other devices' key for everyone
        // from the manifest, which the server's era is held to as it is: it's told, and reads on.
        if (from === "link" || era > page.era) return;
        const now = this.logState();
        now.floor = now.floorAfter ?? null;
        delete now.floorAfter;
        delete now.marks;
        // With no head left to hold the log to, it's taken as any device's first read is.
        if (!now.floor) delete now.unheld;
        this.saveLogState();
        continue;
      }
      if (page.era > state.era) {
        this.startLogEra(page.era, page.size);
      } else if (state.heldOnly) {
        // The server's own era after all: this device goes on in it as any other does.
        delete state.heldOnly;
        this.saveLogState();
      }
      // A page with nothing in it that says there's more would be asked for again and again.
      if (page.records.length === 0 && this.logState().frontier.size < page.size) return void this.refuseLog();
      const done = this.takeLogPage(page.records, head, page.size);
      if (!done) return;
      read = true;
      if (this.logState().frontier.size >= page.size) break;
    }
    this.logRead = true;
    this.logReadAt = Date.now();
    this.logRefused = 0;
    // Once a session too, as nothing remembers which accounts had records come without their bodies.
    if (read || !this.withheldLooked) {
      this.withheldLooked = true;
      this.lookForWithheld();
      this.askForOwed();
    }
    this.checkFloor();
    this.checkKept();
    if (this.logState().own === null && this.logState().frontier.size > 0) this.warnOnce("log/own", t(WARNINGS.ownLeftOut), this.account.userId);
  }

  /**
   * A new era signed with the key this device pinned: the log was written again, as after a server
   * restored a backup. It's read from the start, and held to the pins and chains kept apart from it.
   */
  protected startLogEra(era: number, size: number): void {
    const state = this.logState();
    // A device that only read an earlier era to hold its link's head to is still taking its first.
    const first = state.era === 0 || !!state.heldOnly;
    // What that era said stays, for this one and those after it to be held to: the records that came
    // without their bodies, and the usernames it gave.
    const keep = state.heldOnly && state.held ? { era: state.era, from: state.held.from, owed: [], checked: false } : null;
    // A log written again is quiet about what it said before, but not about a device of this account it never named.
    const ownBefore = first ? undefined : [...new Set([...(state.ownBefore ?? []), ...Object.keys(this.loggedAccount(this.account.userId)?.devices ?? {})])];
    // The era being left stays as a tree, as far as it was read, for a head of it someone holds. One
    // read only to hold a head to was read to where the server says it ends.
    const left = state.era > 0 && state.frontier.size > 0 ? state.era : null;
    const past = left === null ? state.past : { ...state.past, [left]: { frontier: state.frontier, head: state.head, ended: !!state.heldOnly } };
    this.db.transaction(() => {
      if (left !== null) {
        this.db.run("DELETE FROM log_past WHERE era = ?", [left]);
        this.db.run("INSERT INTO log_past(era, idx, record, frontier) SELECT ?, idx, record, frontier FROM log_records", [left]);
      }
      if (keep) {
        this.db.run("DELETE FROM log_kept_records");
        this.db.run("DELETE FROM log_kept_names");
        this.db.run("INSERT INTO log_kept_records(idx, record, gone) SELECT idx, record, CASE WHEN opened = 0 THEN 0 ELSE 1 END FROM log_records WHERE opened != 1");
        this.db.run("INSERT INTO log_kept_names(tag, sealed) SELECT tag, sealed FROM log_names");
      }
      // Who held each username in the era this device counted by stays too, beside what eras before
      // it said of names it doesn't give, for the one it's moving to to be held to (`nameWasTheirs`).
      if (!first) this.db.run("INSERT OR REPLACE INTO log_past_names(tag, sealed) SELECT tag, sealed FROM log_names");
      this.db.run("DELETE FROM log_records");
      this.db.run("DELETE FROM log_accounts");
      this.db.run("DELETE FROM log_names");
    });
    this.loggedAccounts.clear();
    this.logBumps.clear();
    this.standingCache.clear();
    this.withheldUsers.clear();
    this.withheldScannedUpTo = 0;
    this.keptRecords = null;
    // What the log says of a device decides whose leaves are stale, so every tree is checked again.
    this.cleanEpochs.clear();
    const floor = [state.floor, state.floorAfter].find((head) => head && head.era === era) ?? null;
    const marks = floor && floor === state.floor ? state.marks : undefined;
    this.logLoaded = {
      ...state,
      era,
      frontier: { size: 0, roots: [] },
      head: null,
      own: null,
      // What a log written again says of this account's devices isn't news.
      quietBelow: first ? 0 : size,
      ownBefore,
      floor,
      marks: marks?.length ? marks : undefined,
      floorAfter: state.floorAfter && state.floorAfter.era > era ? state.floorAfter : undefined,
      // An era with no head to hold it to is taken as it comes.
      unheld: state.unheld && floor ? true : undefined,
      heldOnly: undefined,
      kept: keep ?? state.kept,
      past,
    };
    this.saveLogState();
    if (!first) this.warnOnce(`log/era/${era}`, t(WARNINGS.era));
    // A device that moved on may not have read the era it left to its end: it learns where that was.
    if (left !== null && !past?.[left]?.ended) void this.readRestOfEra(left).catch((error) => console.warn("[zuna] reading the rest of an era of the log of keys", error));
  }

  /**
   * Reads the era the head a device's link or manifest carried is of, as the server kept it, before
   * the server's own later one: to that head and held to it, taking each account's first key from it
   * as any device that read it then did. The later era is then held to those keys, so a key the
   * server changed across the two is `changed`, and a backup restored, which changes none, says
   * nothing. What that era kept back, and the names it gave, are kept for the later one to be held
   * to as well (`startLogEra`). False, with this device back where it was, if the server didn't
   * keep that era, or it doesn't reach the head or hold it. A server can't hold a device here by
   * refusing the request either: it's asked again, and the third refusal is the link's warning.
   */
  protected async readEraOfFloor(key: Uint8Array): Promise<boolean> {
    const before = this.logState();
    const floor = before.floor!;
    let read = false;
    this.floorEraReading = true;
    try {
      this.startLogEra(floor.era, 0);
      for (;;) {
        const state = this.logState();
        const page = await this.api.log(floor.era, state.frontier.size, LOG_PAGE, true);
        const head: LogHead = { era: page.head.era, size: page.head.size, root: decode(page.head.root), sig: decode(page.head.sig) };
        if (page.era !== floor.era || head.era !== page.era || !headSigned(key, head) || page.size < state.frontier.size) return false;
        if (page.records.length === 0 && state.frontier.size < page.size) return false;
        if (!this.takeLogPage(page.records, head, page.size)) return false;
        if (this.logState().frontier.size >= page.size) break;
      }
      // A head the log went past is let go once it's held (`takeLogPage`): one still there wasn't reached.
      read = this.logState().floor === null;
      if (read) {
        // All of that era held, what it says is taken: each account's first key, as any device that read it then took it.
        this.db.transaction(() => {
          this.settleLog();
          this.logState().heldOnly = true;
          this.saveLogState();
        });
      }
      this.logRefused = 0;
      return read;
    } catch (error) {
      this.noteLogRefused(error);
      throw error;
    } finally {
      this.floorEraReading = false;
      if (!read) this.backToNothingRead(before);
    }
  }

  /**
   * What says there's more of the log than this device holds, which the server didn't write, or
   * can't take back: a head the log has to hold, from the device's link, its account's other devices
   * or signing in, or one someone signed in a message. Null when nothing does.
   */
  protected logOwes(): { key: string; text: string } | null {
    const state = this.logState();
    if (state.floor) return { key: `log/floor/${state.floor.from}`, text: t(WARNINGS[state.floor.from]) };
    const ahead = this.headAhead;
    if (ahead && (ahead.era > state.era || (ahead.era === state.era && ahead.size > state.frontier.size))) return { key: `log/back/${ahead.era}/${ahead.size}`, text: t(WARNINGS.back) };
    return null;
  }

  /**
   * Reading the log failed. While something says there's more of it than this device holds, a
   * server can't keep the rest back by failing the request: it's asked again, and one that answered
   * with a refusal three times, some seconds apart, is keeping it from this device, which says so
   * with the warning for a log that doesn't hold that head. A log that can't be read while nothing
   * says it goes further is only a server that's down.
   */
  protected noteLogRefused(error: unknown): void {
    if (this.stopped || this.logRetry || (error instanceof ApiError && error.status === 401)) return;
    const owed = this.logOwes();
    if (!owed) return;
    // Not being able to reach the server at all says nothing of it.
    if (error instanceof ApiError && error.status !== 0) this.logRefused++;
    if (this.logRefused >= BODIES_TRIES) this.warnOnce(owed.key, owed.text);
    this.logRetry = setTimeout(() => {
      this.logRetry = null;
      if (!this.stopped) void this.syncLog().catch((failure) => console.warn("[zuna] reading the log of keys", failure));
    }, Math.min(BODIES_RETRY_MS * 2 ** Math.max(this.logRefused - 1, 0), BODIES_RETRY_MAX_MS));
    (this.logRetry as { unref?: () => void }).unref?.();
  }

  /**
   * What this device read of the log, before the log held the head the device came with, is let go:
   * it's back to having read nothing, with the heads it has to hold as they are. Only what that read
   * wrote goes, which is the log's own tables, as nothing was taken from it (`settleLog`).
   */
  protected forgetUnheld(): void {
    const state = this.logState();
    this.backToNothingRead({ ...state, era: 0, frontier: { size: 0, roots: [] }, head: null, own: null, quietBelow: 0, ownBefore: undefined, held: undefined, heldOnly: undefined });
  }

  /** Puts this device back to having read none of the log, as it was before `readEraOfFloor`. */
  protected backToNothingRead(state: LogState): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM log_records");
      this.db.run("DELETE FROM log_accounts");
      this.db.run("DELETE FROM log_names");
    });
    this.loggedAccounts.clear();
    this.logBumps.clear();
    this.standingCache.clear();
    this.withheldUsers.clear();
    this.withheldScannedUpTo = 0;
    this.cleanEpochs.clear();
    this.logLoaded = { ...state };
    this.saveLogState();
  }

  /**
   * Checks a page of records against the signed head it came to, and if it holds, keeps it and
   * applies what its bodies say, all in one transaction. Says whether it did.
   */
  protected takeLogPage(records: { idx: number; record: string; body?: string | null }[], head: LogHead, size: number): boolean {
    const state = this.logState();
    const frontier = this.logFrontier();
    const floor = state.floor && state.floor.era === state.era ? state.floor : null;
    // Every head this log has to hold, the floor and those short of it, by where it's checked.
    const heads = floor ? [floor, ...(state.marks ?? [])] : [];
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
      } else if (equalBytes(userTag(this.account.userId, parts.nonce), parts.userTag)) {
        // Every entry of this account's own has to come with its body, as when signing in: one that
        // came bare and was asked for afterwards would be read as old news, a new device among them.
        return this.refuseLog();
      }
      frontier.append(leafHash(record));
      // A head this log has to hold is checked on the way past it.
      const broken = heads.find((held) => held.size === frontier.size && !equalBytes(frontier.root(), fromBase64(held.root)));
      if (broken) return this.refuseHead(broken);
      const checkpoint = frontier.size % LOG_CHECKPOINT === 0 ? concat(...frontier.roots) : null;
      rows.push({ idx: wire.idx, record, checkpoint, body });
    }
    if (frontier.size !== head.size || !equalBytes(frontier.root(), head.root)) return this.refuseLog();
    // The log ends before a head it has to hold.
    const beyond = frontier.size >= size ? heads.filter((held) => held.size > size) : [];
    if (beyond.length > 0) {
      // Before the head a link carried, nothing of it is taken: a log that's shorter than the one the
      // inviter read isn't that log, and whoever joins can ask for another link.
      if (state.unheld && beyond.some((held) => held.from === "link")) return this.refuseLog("link");
      // A new device of an account has no other way in, and a server restored from a backup is
      // shorter than its other devices saw: it's told, and takes the log as it is, held to the keys
      // they kept for everyone. The head stays, for when the log gets there.
      this.warnOnce(`log/floor/${floor!.from}`, t(WARNINGS[floor!.from]));
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
      if (floor && frontier.size >= floor.size) {
        state.floor = null;
        delete state.marks;
        state.held = { era: floor.era, size: floor.size, from: floor.from };
      } else if (state.marks) {
        // Those it went past are held.
        const left = state.marks.filter((held) => held.size > frontier.size);
        if (left.length > 0) state.marks = left;
        else delete state.marks;
      }
      // What the log says counts from where it held the head this device came with, or from where
      // it ended short of one that isn't a link's. An era read only to hold a head to is taken whole (`readEraOfFloor`).
      if ((state.floor === null || beyond.length > 0) && !this.floorEraReading) this.settleLog();
      this.saveLogState();
    });
    this.askForOwed();
    return true;
  }

  protected refuseLog(from?: HeadFrom): false {
    this.logRead = false;
    this.warnOnce(from ? `log/floor/${from}` : "log/unfit", t(from ? WARNINGS[from] : WARNINGS.unfit));
    return false;
  }

  /**
   * The log doesn't hold a head it has to: at that size its root is another. Nothing of the page is
   * taken, and on a device that hadn't got to the head it came with, what it read on the way there
   * goes too, as that was a log the head isn't of: it starts again, should the server give the one it is.
   */
  protected refuseHead(head: Floor): false {
    if (this.logState().unheld) this.forgetUnheld();
    return this.refuseLog(head.from);
  }

  /** Heads this log has to hold that it's already past: the root it had then has to be each one's. */
  protected checkFloor(): void {
    const state = this.logState();
    const floor = state.floor;
    if (!floor || floor.era !== state.era) return;
    const past = [floor, ...(state.marks ?? [])].filter((held) => held.size <= state.frontier.size);
    if (past.length === 0) return;
    const broken = past.find((held) => !equalBytes(this.rootAt(held.size), fromBase64(held.root)));
    if (broken && state.unheld) return void this.refuseHead(broken);
    this.db.transaction(() => {
      const left = (state.marks ?? []).filter((held) => !past.includes(held));
      if (left.length > 0) state.marks = left;
      else delete state.marks;
      if (past.includes(floor)) {
        // The furthest of them, so there are none left.
        state.floor = null;
        delete state.marks;
        if (!broken) state.held = { era: floor.era, size: floor.size, from: floor.from };
        this.settleLog();
      }
      this.saveLogState();
    });
    if (broken) this.refuseLog(broken.from);
  }

  /**
   * The log held the head this device came with, so what it says counts from here, and what it
   * said on the way is taken now: each account's first key, for a device with none for it, a key
   * that isn't the one held, the links it names, and any device of this account after this one's
   * own entry. While it hadn't, none of that was (`applyLogEntry`).
   */
  protected settleLog(): void {
    const state = this.logState();
    if (!state.unheld) return;
    delete state.unheld;
    const self = this.account.userId;
    for (const row of this.db.all<{ user_id: string }>("SELECT user_id FROM log_accounts")) {
      const userId = row.user_id;
      const account = this.loggedAccount(userId);
      if (!account) continue;
      if (userId !== self) {
        if (account.twice) this.noteLoggedRootChanged(userId);
        else if (account.account && !account.void && !account.owed) this.takeLoggedRoot(userId, fromBase64(account.account.root));
      } else if (state.own !== null) {
        for (const [deviceId, device] of Object.entries(account.devices)) {
          if (device.idx > state.own && device.revoked === undefined) this.noteNewDevice(deviceId);
        }
      }
      for (const [generation, hash] of Object.entries(account.links)) this.noteLoggedLink(userId, Number(generation), fromBase64(hash));
      if (account.forked) this.noteLoggedFork(userId);
      this.logTouched.add(userId);
      this.logBumps.set(userId, (this.logBumps.get(userId) ?? 0) + 1);
    }
    this.standingCache.clear();
    this.cleanEpochs.clear();
  }

  /**
   * The tree's root when it was `size` records long, worked out from the frontier kept at the
   * checkpoint before: this era's, or that of an era before it this device keeps (`log_past`).
   */
  protected rootAt(size: number, era = this.logState().era): Uint8Array {
    const state = this.logState();
    const own = era === state.era;
    const held = own ? state.frontier : state.past?.[era]?.frontier;
    if (size === 0) return emptyRoot();
    if (held && size === held.size) return (Frontier.from(held) ?? new Frontier()).root();
    const base = Math.floor(size / LOG_CHECKPOINT) * LOG_CHECKPOINT;
    let frontier = new Frontier();
    if (base > 0) {
      const row = own
        ? this.db.get<{ frontier: Uint8Array | null }>("SELECT frontier FROM log_records WHERE idx = ?", [base - 1])
        : this.db.get<{ frontier: Uint8Array | null }>("SELECT frontier FROM log_past WHERE era = ? AND idx = ?", [era, base - 1]);
      const roots: Uint8Array[] = [];
      for (let i = 0; row?.frontier && i + 32 <= row.frontier.length; i += 32) roots.push(row.frontier.slice(i, i + 32));
      frontier = new Frontier(base, roots);
    }
    const rows = own
      ? this.db.all<{ record: Uint8Array }>("SELECT record FROM log_records WHERE idx >= ? AND idx < ? ORDER BY idx", [base, size])
      : this.db.all<{ record: Uint8Array }>("SELECT record FROM log_past WHERE era = ? AND idx >= ? AND idx < ? ORDER BY idx", [era, base, size]);
    for (const row of rows) frontier.append(leafHash(row.record));
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

  /**
   * Whether a username is an account's, as this device knew before the log was written again: the
   * era it counted by last gave it to the account, and didn't say the account was deleted, or it's
   * this device's own account and name. An honest server writes an era again with every username
   * held as it was, and gives a name to another only once its holder is deleted, so an account
   * this era gave it to first, which isn't deleted, is one of the server's making.
   */
  protected nameWasTheirs(username: string, userId: string): boolean {
    if (userId === this.account.userId) return username.toLowerCase() === this.account.username.toLowerCase();
    const tag = this.nameKey(username);
    const row = this.db.get<{ sealed: Uint8Array }>("SELECT sealed FROM log_past_names WHERE tag = ?", [tag]);
    const holder = row ? this.openValue<{ user: string; deleted?: number } | null>("log-name", tag, row.sealed, null) : null;
    return !!holder && holder.user === userId && holder.deleted === undefined;
  }

  // What the era a link's or manifest's head was of said, kept across the server's later ones
  // (`readEraOfFloor`): its records that came without their bodies, and the usernames it gave.

  /**
   * The records kept from that era, as read from the table. `gone` is one of an account the log said
   * was deleted, which holds its username no longer, and is still what its first key is taken from.
   */
  protected keptRecords: { idx: number; record: Uint8Array; gone: number }[] | null = null;

  protected keptBare(): { idx: number; record: Uint8Array; gone: number }[] {
    if (!this.logState().kept) return [];
    this.keptRecords ??= this.db.all<{ idx: number; record: Uint8Array; gone: number }>("SELECT idx, record, gone FROM log_kept_records ORDER BY idx");
    return this.keptRecords;
  }

  /** The records kept from that era that are about an account. */
  protected keptFits(userId: string): { idx: number; record: Uint8Array; gone: number }[] {
    return this.keptBare().filter((row) => isAbout(row.record, userId));
  }

  /** This era's records before a place that came without their bodies, but for those of an account the log says is deleted. */
  protected bareBefore(idx: number): { idx: number; record: Uint8Array }[] {
    return this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0 AND idx < ?", [idx]);
  }

  protected keptNameHolder(username: string): { user: string; idx: number; deleted?: number } | null {
    const tag = this.nameKey(username);
    const row = this.db.get<{ sealed: Uint8Array }>("SELECT sealed FROM log_kept_names WHERE tag = ?", [tag]);
    return row ? this.openValue<{ user: string; idx: number; deleted?: number } | null>("log-name", tag, row.sealed, null) : null;
  }

  protected setKeptNameHolder(username: string, holder: { user: string; idx: number; deleted?: number }): void {
    const tag = this.nameKey(username);
    this.db.run("INSERT OR REPLACE INTO log_kept_names(tag, sealed) VALUES(?, ?)", [tag, this.sealJson("log-name", tag, holder)]);
  }

  /**
   * Whether a username an account is made under was another's before it, as far as this device can
   * tell: the era its link or manifest was of gave it to an account no era since says is deleted,
   * or a record from before, of that era or this one, that came without its body is filed under
   * the name and isn't this account's. The server keeps an entry back only about a private bot that
   * isn't there for this device, and says when one is deleted (`forgetDeleted`), so a name held
   * that way isn't free. The account counts for nothing then, and the person is told.
   */
  protected nameHeldBefore(userId: string, username: string, idx: number, before: { idx: number; record: Uint8Array }[]): boolean {
    const state = this.logState();
    const kept = state.kept;
    const holder = kept ? this.keptNameHolder(username) : null;
    if (kept && holder && holder.user !== userId && holder.deleted === undefined) {
      if (this.loggedAccount(holder.user)?.deleted === undefined) {
        this.warnOnce(`log/floor/${kept.from}`, t(WARNINGS[kept.from]));
        return true;
      }
      // This era says its holder is gone, so the name was free.
      this.setKeptNameHolder(username, { ...holder, deleted: idx });
    }
    const filedUnder = (record: Uint8Array): boolean => {
      const parts = readRecord(record);
      return !!parts && equalBytes(nameTag(username, parts.nonce), parts.nameTag) && !equalBytes(userTag(userId, parts.nonce), parts.userTag);
    };
    if (kept && this.keptBare().some((row) => !row.gone && filedUnder(row.record))) {
      this.warnOnce(`log/floor/${kept.from}`, t(WARNINGS[kept.from]));
      return true;
    }
    const here = before.find((row) => filedUnder(row.record));
    if (!here) return false;
    // Below the head this device's link or manifest carried, that's the record the server departs from.
    const head = state.floor ?? state.held;
    const from = head && head.era === state.era && here.idx < head.size ? head.from : null;
    if (from) this.warnOnce(`log/floor/${from}`, t(WARNINGS[from]));
    else this.warnOnce(`log/name-kept/${here.idx}`, t(WARNINGS.withheld), userId);
    return true;
  }

  /**
   * An account that held a username in this era, which the account it was held for comes after
   * (`nameWasTheirs`): it was made under a name another held, so it counts for nothing from here,
   * its devices with it, and the person is told. It held the name only because it came first.
   */
  protected unholdName(userId: string, owner: string): void {
    const account = this.loggedAccount(userId);
    if (account && !account.void) {
      account.void = true;
      this.unsavedAccounts.add(userId);
      this.logTouched.add(userId);
      this.logBumps.set(userId, (this.logBumps.get(userId) ?? 0) + 1);
      this.standingCache.clear();
      this.cleanEpochs.clear();
    }
    const self = this.account.userId;
    if (owner === self) this.warnOnce(`log/name/${userId}`, t(WARNINGS.nameTaken), self);
    else this.warnOnce("log/odd", t(WARNINGS.odd));
  }

  /**
   * The log says an account that was never there for this device is deleted. The records about it,
   * which came without their bodies, hold its username no longer, so another account may take it.
   * They're still what the account's first key is taken from, should a later era name it after all.
   */
  protected forgetDeleted(userId: string): void {
    for (const row of this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0")) {
      if (isAbout(row.record, userId)) this.db.run("UPDATE log_records SET opened = ? WHERE idx = ?", [GONE, row.idx]);
    }
    for (const row of this.keptFits(userId)) this.db.run("UPDATE log_kept_records SET gone = 1 WHERE idx = ?", [row.idx]);
    this.keptRecords = null;
  }

  /** An account whose first key is owed from the era kept, which is asked for once what's being applied is kept. */
  protected noteOwed(userId: string): void {
    const kept = this.logState().kept;
    if (kept && !kept.owed.includes(userId)) kept.owed.push(userId);
  }

  /** Asks for what the era kept says of each account whose first key is owed from it. */
  protected askForOwed(): void {
    const kept = this.logState().kept;
    if (!kept || this.stopped) return;
    for (const userId of kept.owed) {
      if (this.keptAsked.has(userId)) continue;
      this.keptAsked.add(userId);
      void this.askForKept(userId)
        .then(
          () => this.keptFailed.delete(userId),
          (error) => this.noteKeptFailed(userId, error),
        )
        .finally(() => this.keptAsked.delete(userId));
    }
  }

  /** Asking for an account's entries in the era kept failed: it's asked again, and the third refusal is the link's warning. */
  protected noteKeptFailed(userId: string, error: unknown): void {
    console.warn("[zuna] asking for an earlier era's entries about someone", error);
    const kept = this.logState().kept;
    // Not being able to reach the server at all says nothing of it.
    const refusals = (this.keptFailed.get(userId) ?? 0) + (error instanceof ApiError && error.status !== 0 ? 1 : 0);
    this.keptFailed.set(userId, refusals);
    if (kept && refusals >= BODIES_TRIES) this.warnOnce(`log/floor/${kept.from}`, t(WARNINGS[kept.from]));
    if (this.stopped) return;
    const timer = setTimeout(() => this.askForOwed(), Math.min(BODIES_RETRY_MS * 2 ** Math.max(refusals - 1, 0), BODIES_RETRY_MAX_MS));
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * Asks for what the era this device's link or manifest was of says of one account, whose records
   * there came without their bodies, now that a later era names it. The account's first key is that
   * era's, as it is for everyone whose entries there came whole, and this era's is held to it. A
   * server that doesn't give every one of those entries, each fitting its record, gets the link's
   * warning, and nothing of the account counts until it does.
   */
  protected async askForKept(userId: string): Promise<void> {
    const kept = this.logState().kept;
    if (!kept) return;
    const refused = () => this.warnOnce(`log/floor/${kept.from}`, t(WARNINGS[kept.from]));
    const places = this.keptFits(userId);
    // Nothing of that era is about it any more, so this era's word for its key stands.
    if (places.length === 0) return this.settleOwed(userId, null);
    let answer: { era: number; bodies: { idx: number; body: string }[] };
    try {
      answer = await this.readLogBodies(userId, kept.era, Math.max(...places.map((place) => place.idx)) + 1);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      // The server named the account to this device itself, in the era after.
      if (await this.stillThere(userId)) refused();
      return;
    }
    if (answer.era !== kept.era) return refused();
    const given = new Map(answer.bodies.map((item) => [item.idx, decode(item.body)]));
    let first: Extract<LogBody, { t: "account" }> | null = null;
    let deleted: number | undefined;
    for (const place of places) {
      const bytes = given.get(place.idx);
      const parts = readRecord(place.record);
      const body = bytes ? parseBody(bytes) : null;
      if (!bytes || !parts || !body || body.user !== userId || !bodyFits(parts, bytes, body)) return refused();
      if (body.t === "account") first ??= body;
      else if (body.t === "deleted") deleted = place.idx;
    }
    if (!first) return refused();
    await this.settleOwed(userId, { places, first, deleted });
  }

  /** What the era kept said of an account whose first key was owed from it, now that it's come, or null if it said nothing. */
  protected async settleOwed(
    userId: string,
    said: { places: { idx: number }[]; first: Extract<LogBody, { t: "account" }>; deleted: number | undefined } | null,
  ): Promise<void> {
    const state = this.logState();
    this.db.transaction(() => {
      const account = this.loggedAccount(userId);
      if (said) {
        this.takeLoggedRoot(userId, said.first.root);
        if (said.first.username && !this.keptNameHolder(said.first.username)) {
          this.setKeptNameHolder(said.first.username, { user: userId, idx: said.places[0]!.idx, ...(said.deleted === undefined ? {} : { deleted: said.deleted }) });
        }
        for (const place of said.places) this.db.run("DELETE FROM log_kept_records WHERE idx = ?", [place.idx]);
        this.keptRecords = null;
      } else if (account?.account && !account.void && !state.unheld) {
        this.takeLoggedRoot(userId, fromBase64(account.account.root));
      }
      if (account?.owed) {
        delete account.owed;
        this.unsavedAccounts.add(userId);
        this.saveLoggedAccounts();
      }
      if (state.kept) state.kept.owed = state.kept.owed.filter((id) => id !== userId);
      this.saveLogState();
      this.logBumps.set(userId, (this.logBumps.get(userId) ?? 0) + 1);
      this.standingCache.clear();
      this.cleanEpochs.clear();
    });
    // This era's key for them, if it isn't that one, is a key that changed.
    if (this.loggedRootDisagrees(userId)) this.noteLoggedRootChanged(userId);
    this.logTouched.add(userId);
    await this.refreshLogTouched();
  }

  /**
   * Once the era after the one kept has been read: everyone that era named, and didn't say was
   * deleted, has to be in this one, which a server's tables hold whatever it restored. An account
   * left out of it is the link's warning.
   */
  protected checkKept(): void {
    const state = this.logState();
    const kept = state.kept;
    if (!kept || kept.checked || !this.logRead) return;
    kept.checked = true;
    this.saveLogState();
    let bare: { record: Uint8Array }[] | null = null;
    for (const row of this.db.all<{ tag: string; sealed: Uint8Array }>("SELECT tag, sealed FROM log_kept_names")) {
      const holder = this.openValue<{ user: string; deleted?: number } | null>("log-name", row.tag, row.sealed, null);
      if (!holder || holder.deleted !== undefined || holder.user === this.account.userId || this.loggedAccount(holder.user)?.account) continue;
      // One whose records here came without their bodies is asked about as any such account is (`lookForWithheld`).
      bare ??= this.db.all<{ record: Uint8Array }>("SELECT record FROM log_records WHERE opened = 0");
      if (!bare.some((item) => isAbout(item.record, holder.user))) return this.warnOnce(`log/floor/${kept.from}`, t(WARNINGS[kept.from]));
    }
  }

  /** What an entry says, held to what came before it (the table in section 5.5 of the plan). */
  protected applyLogEntry(idx: number, body: LogBody): void {
    const self = this.account.userId;
    const state = this.logState();
    const account = this.loggedAccount(body.user) ?? { account: null, devices: {}, links: {} };
    const odd = () => this.warnOnce("log/odd", t(WARNINGS.odd));
    // Before the log has held the head this device came with, what it says is kept and nothing is
    // done about it: no key taken, nobody's key said to have changed, nothing asked (`settleLog`).
    const counts = !state.unheld;
    this.loggedAccounts.set(body.user, account);
    this.unsavedAccounts.add(body.user);
    this.logTouched.add(body.user);
    this.logBumps.set(body.user, (this.logBumps.get(body.user) ?? 0) + 1);
    this.cleanEpochs.clear();
    switch (body.t) {
      case "account": {
        if (account.account) {
          account.twice = true;
          if (counts) this.noteLoggedRootChanged(body.user);
          break;
        }
        // An account doesn't begin once the log has said it's gone.
        if (account.deleted !== undefined) {
          odd();
          break;
        }
        account.account = { idx, username: body.username, root: toBase64(body.root), hpke: toBase64(body.hpke) };
        const before = body.user === self ? [] : this.bareBefore(idx);
        if (body.username) {
          let holder = this.nameHolder(body.username);
          if (holder && holder.user !== body.user && holder.deleted === undefined && holder.user !== self && this.nameWasTheirs(body.username, body.user)) {
            // The name was this account's before, and the server wrote another account under it
            // ahead of this one: that one was made under a held name, and counts for nothing.
            this.unholdName(holder.user, body.user);
            holder = null;
          }
          if (holder && holder.user !== body.user && holder.deleted === undefined) {
            account.void = true;
            if (holder.user === self) this.warnOnce(`log/name/${body.user}`, t(WARNINGS.nameTaken), self);
          } else if (body.user !== self && this.nameHeldBefore(body.user, body.username, idx, before)) {
            // Nor is the name free while an account from before holds it that this device can't see
            // the end of: one the era its link was of named, or one whose entry was kept back from it.
            account.void = true;
          }
          // Only an account that counts holds its name, so one that doesn't can't keep it from the
          // account it was held for, which the server may write after it.
          if (!account.void) this.setNameHolder(body.username, { user: body.user, idx });
        }
        if (body.user === self) {
          if (!equalBytes(body.root, this.account.core.rootPublic) || body.username.toLowerCase() !== this.account.username.toLowerCase()) {
            this.warnOnce("log/own-account", t(WARNINGS.ownHistory), self);
          }
        } else if (account.void) {
          // It counts for nothing, so no key is held for it.
        } else if (state.kept && !this.pinnedIdentity(body.user) && this.keptFits(body.user).length > 0) {
          // The era this device's link was of had entries about this account, which came without
          // their bodies. Its first key is what they say, not this era's word for it.
          account.owed = true;
          this.noteOwed(body.user);
        } else if (before.some((row) => isAbout(row.record, body.user))) {
          // So did this era, before this entry, which isn't the account's first then. Its key is taken
          // once all of them have come, in their order (`askForBodies`), and nothing of it counts until then.
          account.owed = true;
        } else if (counts) {
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
          if (!equalBytes(body.key, this.account.devicePublic)) this.warnOnce("log/own-device", t(WARNINGS.ownHistory), self);
        } else if (!counts) {
          // Asked about once the log has held that head, if it's still there then.
        } else if (state.ownBefore && idx < state.quietBelow ? !state.ownBefore.includes(body.device) : state.own !== null && idx > state.own && idx >= state.quietBelow) {
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
          if (held !== hash) {
            account.forked = true;
            if (counts) this.noteLoggedFork(body.user);
          }
          break;
        }
        if (body.gen !== Object.keys(account.links).length + 1) {
          odd();
          break;
        }
        account.links[body.gen] = hash;
        if (counts) this.noteLoggedLink(body.user, body.gen, body.link);
        break;
      }
      case "deleted": {
        if (!account.account && account.deleted === undefined) {
          // An account that isn't there for this device, a private bot's: the server says that it's
          // gone and keeps the rest back. If it never was there, the records about it hold its
          // username no longer. One this device knows has them asked for, as ever (`lookForWithheld`).
          account.deleted = idx;
          if (!this.users.has(body.user) && !this.pinnedIdentity(body.user)) this.forgetDeleted(body.user);
          break;
        }
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
    if (equalBytes(nameTag(this.account.username, parts.nonce), parts.nameTag)) this.warnOnce(`log/name-hidden/${idx}`, t(WARNINGS.nameTaken), this.account.userId);
  }

  /** The IDs this device knows, its own first, which a record without its body is tested against. */
  protected knownIds(): string[] {
    const ids = new Set<string>([this.account.userId, ...this.users.keys()]);
    for (const row of this.db.all<{ user_id: string }>("SELECT user_id FROM pinned_identities")) ids.add(row.user_id);
    return [...ids];
  }

  /** Which of the IDs given each of these records is about, as the places of the records about each. */
  protected recordsAbout(rows: { idx: number; record: Uint8Array }[], ids: string[]): Map<string, number[]> {
    const wanted = new Map<string, number[]>();
    for (const row of rows) {
      const parts = readRecord(row.record);
      if (!parts) continue;
      for (const id of ids) {
        if (equalBytes(userTag(id, parts.nonce), parts.userTag)) {
          let list = wanted.get(id);
          if (!list) wanted.set(id, (list = []));
          list.push(row.idx);
        }
      }
    }
    return wanted;
  }

  /**
   * As a session starts, before the log can be read: whoever this device knows that records it holds
   * without their bodies are about counts for nothing new again, as it did when the session before
   * ended, so a server that then keeps the log from it doesn't have them encrypted to. They're asked
   * for once the log has been read (`lookForWithheld`).
   */
  protected holdWithheld(): void {
    const unopened = this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0");
    if (unopened.length === 0) return;
    for (const id of this.recordsAbout(unopened, this.knownIds()).keys()) this.withheldUsers.add(id);
    this.cleanEpochs.clear();
  }

  /** Every record held without its body, tested against the IDs given. Those it fits are asked for. */
  protected lookForWithheld(ids?: string[]): void {
    const fullScan = ids === undefined;
    const targets = ids ?? this.knownIds();
    const unopened = fullScan
      ? this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0 AND idx >= ?", [this.withheldScannedUpTo])
      : this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 0");
    if (unopened.length === 0) return;
    if (fullScan) {
      const last = unopened[unopened.length - 1]!.idx;
      if (last + 1 > this.withheldScannedUpTo) this.withheldScannedUpTo = last + 1;
    }
    const wanted = this.recordsAbout(unopened, targets);
    for (const [id, places] of wanted) {
      if (!this.withheldUsers.has(id)) {
        this.withheldUsers.add(id);
        this.cleanEpochs.clear();
      }
      if (this.bodiesAsked.has(id)) continue;
      this.bodiesAsked.add(id);
      void this.askForBodies(id, places)
        .then(
          () => this.bodiesFailed.delete(id),
          (error) => this.noteBodiesFailed(id, error),
        )
        .finally(() => this.bodiesAsked.delete(id));
    }
  }

  /**
   * Asking for an account's bodies failed. A server can't keep them back by failing the request: it's
   * asked again, and after a few tries, whatever went wrong, the person is warned.
   */
  protected noteBodiesFailed(userId: string, error: unknown): void {
    console.warn("[zuna] asking for the log's entries about someone", error);
    const failures = (this.bodiesFailed.get(userId) ?? 0) + 1;
    this.bodiesFailed.set(userId, failures);
    if (failures >= BODIES_TRIES) this.warnOnce(`log/withheld/${userId}`, t(WARNINGS.withheld), userId);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      if (!this.stopped && this.withheldUsers.has(userId)) this.lookForWithheld([userId]);
    }, Math.min(BODIES_RETRY_MS * 2 ** (failures - 1), BODIES_RETRY_MAX_MS));
    (timer as { unref?: () => void }).unref?.();
  }

  /** Whether this device shares a conversation with someone, where their devices would be encrypted to. */
  protected sharesAConversation(userId: string): boolean {
    for (const group of this.groups.values()) {
      if (!group.removedAt && group.members.some((member) => member.userId === userId)) return true;
    }
    return false;
  }

  /** Whether an account is there for this device, whatever the server says of its entries: it shares a conversation with it, or the server lists it. */
  protected async stillThere(userId: string): Promise<boolean> {
    return (
      this.sharesAConversation(userId) ||
      (await this.api.user(userId).then(
        () => true,
        (failure: unknown) => (failure instanceof ApiError && failure.status === 404 ? false : Promise.reject(failure)),
      ))
    );
  }

  /** The records already opened that fit an account, whose bodies the server has to give again. */
  protected openedFor(userId: string): number[] {
    const out: number[] = [];
    for (const row of this.db.all<{ idx: number; record: Uint8Array }>("SELECT idx, record FROM log_records WHERE opened = 1")) {
      const parts = readRecord(row.record);
      if (parts && equalBytes(userTag(userId, parts.nonce), parts.userTag)) out.push(row.idx);
    }
    return out;
  }

  /** Someone newly there for this device, such as a private bot it was just put in a chat with. */
  protected noteNewlyKnown(userId: string): void {
    if (this.logState().frontier.size > 0) this.lookForWithheld([userId]);
  }

  /**
   * Every body of one account's entries before `until`, a page at a time. A server that doesn't move on from
   * one page to the next, or answers from another era partway, isn't read further, and is asked again later.
   */
  protected async readLogBodies(userId: string, era: number | undefined, until: number): Promise<{ era: number; bodies: { idx: number; body: string }[] }> {
    const first = await this.api.logBodies(userId, era);
    const bodies = [...first.bodies];
    let more = first.more === true;
    while (more && bodies.length > 0 && bodies.at(-1)!.idx + 1 < until) {
      const after = bodies.at(-1)!.idx + 1;
      const page = await this.api.logBodies(userId, era, after);
      if (page.era !== first.era || page.bodies.length === 0 || page.bodies.some((item, i) => item.idx < (i === 0 ? after : page.bodies[i - 1]!.idx + 1))) {
        throw new Error("the server's answer about someone's log entries doesn't go on from where it was");
      }
      bodies.push(...page.bodies);
      more = page.more === true;
    }
    return { era: first.era, bodies };
  }

  /**
   * Asks for what the log says of one account, whose records came without their bodies. The
   * server may keep them back only from someone that account isn't there for at all.
   */
  protected async askForBodies(userId: string, places: number[]): Promise<void> {
    let answer: { era: number; bodies: { idx: number; body: string }[] };
    try {
      answer = await this.readLogBodies(userId, undefined, this.logState().frontier.size);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      if (await this.stillThere(userId)) this.warnOnce(`log/withheld/${userId}`, t(WARNINGS.withheld), userId);
      return;
    }
    const state = this.logState();
    if (answer.era !== state.era) return;
    const given = new Map(answer.bodies.map((item) => [item.idx, decode(item.body)]));
    // What's rebuilt is all the log says of the account, so leaving out one already read, such as a
    // device's removal, would take it back.
    if ([...places, ...this.openedFor(userId)].some((idx) => !given.has(idx))) return this.warnOnce(`log/withheld/${userId}`, t(WARNINGS.withheld), userId);
    const entries: { idx: number; body: LogBody }[] = [];
    for (const [idx, bytes] of [...given].sort((a, b) => a[0] - b[0])) {
      const row = this.db.get<{ record: Uint8Array }>("SELECT record FROM log_records WHERE idx = ?", [idx]);
      const parts = row && readRecord(row.record);
      const body = parseBody(bytes);
      // What's past the records held is read with them, later.
      if (!parts) continue;
      if (!body || body.user !== userId || !bodyFits(parts, bytes, body)) return this.warnOnce("log/unfit", t(WARNINGS.unfit));
      entries.push({ idx, body });
    }
    // All of what the log says of this account, in its order, from the start.
    this.db.transaction(() => {
      this.loggedAccounts.set(userId, null);
      this.logBumps.set(userId, (this.logBumps.get(userId) ?? 0) + 1);
      this.cleanEpochs.clear();
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
    this.withheldUsers.delete(userId);
    this.askForOwed();
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

  /**
   * What the log says of an account, for anything that goes by it. Nothing, on a device that hasn't
   * read the log to the head it came with: what it read on the way may not be the log that head is of.
   */
  protected counted(userId: string): LoggedAccount | null {
    return this.logState().unheld ? null : this.loggedAccount(userId);
  }

  /** Whether the log names a device of an account, with this signing key and a certificate of this hash. */
  protected logStanding(userId: string, deviceId: string, key: Uint8Array, certificate: Uint8Array): LogStanding {
    const account = this.counted(userId);
    // Nothing of an account counts while its first key is owed from the era before.
    if (account?.owed && !this.pinnedIdentity(userId)) return "unknown";
    const device = account?.devices[deviceId];
    if (account && !account.void && !account.twice && device && device.key === toBase64(key)) {
      if (device.revoked !== undefined) return "gone";
      if (device.certs.includes(toBase64(entryHash(certificate)))) return "named";
    }
    return this.logCurrent() ? "absent" : "unknown";
  }

  /** What changes when the log changes, for certificateStanding's answers to be worked out again. */
  protected logVersion(userId: string): string {
    const state = this.logState();
    return `${this.logCurrent() ? 1 : 0}:${state.unheld ? 0 : 1}:${state.era}:${this.logBumps.get(userId) ?? 0}`;
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
    return Object.keys(this.counted(userId)?.links ?? {}).length;
  }

  /** The hash of a generation's link, as the log has it. */
  protected loggedLink(userId: string, generation: number): Uint8Array | null {
    const hash = this.counted(userId)?.links[generation];
    return hash ? fromBase64(hash) : null;
  }

  /**
   * The key an account began with, as the log says, for a device with none for it to go by: not that
   * of an account made under a name another held, nor one this era gives where an earlier era's is
   * owed, nor any before the log has held the head this device came with.
   */
  protected loggedRoot(userId: string): Uint8Array | null {
    const account = this.counted(userId);
    const root = account && !account.void && !account.owed ? account.account?.root : null;
    return root ? fromBase64(root) : null;
  }

  /** Whether what the log says of an account can't be gone by yet: entries about it came without their bodies, in this era or the one before. */
  protected keptBack(userId: string): boolean {
    return this.withheldUsers.has(userId) || (this.counted(userId)?.owed === true && !this.pinnedIdentity(userId));
  }

  /** Whether the log says something about an account's first key that doesn't fit: a second account entry, or one that isn't its pin. */
  protected loggedRootDisagrees(userId: string): boolean {
    const account = this.counted(userId);
    if (!account?.account) return false;
    if (account.twice) return true;
    const pinned = this.pinnedIdentity(userId);
    return !!pinned && !equalBytes(pinned, fromBase64(account.account.root));
  }

  /** Whether an account was made under a name another held, which makes it count for nothing. */
  protected loggedVoid(userId: string): boolean {
    return this.counted(userId)?.void === true;
  }

  /**
   * What to seal this account's key to for one of its devices, held to the newest seal key the
   * log has for it. Null when the server offers one the log doesn't have, or an older one.
   */
  protected loggedSealKey(device: ApiDevice, seal: Uint8Array, generation: number): "newest" | "older" | "unlogged" | "unknown" {
    const logged = this.counted(this.account.userId)?.devices[device.id];
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
        message: t("security.keyChanged", { name: user.profile.displayName }),
      });
      const dm = this.dmWith(userId);
      if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_changed", actorId: userId, targetIds: [userId] });
      this.emit({ type: "users", serverId: this.serverId });
    });
  }

  /** Two links for one generation in the log: the server told two stories of someone's keys. */
  protected noteLoggedFork(userId: string): void {
    if (userId === this.account.userId) this.warnOnce("log/own-fork", t(WARNINGS.ownHistory), userId);
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

  /** What an invite link carries of the log: the key's hash, and the head this device holds, which whoever joins holds the log to. */
  protected headForLink(): PinnedHead | undefined {
    const state = this.logState();
    const head = this.heldHead();
    return head && state.key ? { keyHash: logKeyHash(fromBase64(state.key)), era: head.era, size: head.size, root: head.root } : undefined;
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
      return this.warnOnce("log/manifest-key", t(WARNINGS.manifest), this.account.userId);
    }
    if (log.era < state.era) {
      // Another device of this account is in an era this one left: its head is held to what this one read of it.
      const head = { era: log.era, size: log.size, root: fromBase64(log.root) };
      return void this.comparePast(head, null, this.account.userId).catch((error) => console.warn("[zuna] comparing a head of the log of keys", error));
    }
    const head: Floor = { era: log.era, size: log.size, root: log.root, from: "manifest" };
    if (log.era > state.era || log.size > state.frontier.size) {
      this.holdTo(head);
      if (state.era > 0) void this.syncLog().catch((error) => console.warn("[zuna] reading the log of keys", error));
      return;
    }
    if (!equalBytes(this.rootAt(log.size), fromBase64(log.root))) {
      // On a device that hadn't got to the head it came with, what it read isn't the log its other
      // devices saw: it goes, and whatever is read next is held to their head on the way.
      if (state.unheld) {
        this.forgetUnheld();
        this.holdTo(head);
      }
      this.logRead = false;
      this.warnOnce("log/floor/manifest", t(WARNINGS.manifest), this.account.userId);
    }
  }

  /**
   * A head the log has to hold, further than this device has read: it's kept with those the device
   * is still to reach, each checked as the log goes past it (`takeLogPage`). The furthest of them
   * is the floor, which the log has to get to. Two of one size with different roots can't both be
   * held: that's said at once, and no log is taken while it's so.
   */
  protected holdTo(head: Floor): void {
    const state = this.logState();
    const floor = state.floor;
    if (!floor || floor.era < head.era) {
      state.floor = head;
      delete state.marks;
    } else if (floor.era > head.era) {
      // The head this device signed in with is of a later era than the one its other devices
      // held: that era is read first, to their head, and the later one held to it (`readEraOfFloor`).
      if (state.era !== 0 || state.floorAfter) return;
      state.floor = head;
      state.floorAfter = floor;
      delete state.marks;
    } else {
      const others = [floor, ...(state.marks ?? [])];
      if (others.some((held) => held.size === head.size && held.root === head.root)) return;
      if (others.some((held) => held.size === head.size)) {
        this.logRead = false;
        this.warnOnce(`log/floor/${head.from}`, t(WARNINGS[head.from]), this.account.userId);
      }
      const marks = head.size > floor.size ? [...(state.marks ?? []), floor] : [...(state.marks ?? []), head];
      if (head.size > floor.size) state.floor = head;
      // Only the manifest brings more than one, and its older heads go first: never a link's, or the one signed in with.
      while (marks.length > MARKS_KEPT) marks.splice(Math.max(marks.findIndex((held) => held.from === "manifest"), 0), 1);
      state.marks = marks;
    }
    // Nothing read yet, so nothing counted before: what's read on the way to it counts once it's held.
    if (state.era === 0) state.unheld = true;
    this.saveLogState();
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
    // Only a head the log's key signed is kept from being compared again: one with another
    // signature, sent first, would keep the real one from ever being compared.
    if (!headSigned(fromBase64(key), head)) {
      const name = this.users.get(from)?.profile.displayName;
      return this.warnOnce(
        `log/their-key/${from}`,
        name ? t("security.logTheirKey", { name }) : t("security.logSomeonesKey"),
        from,
      );
    }
    this.headsCompared.add(seen);
    let state = this.logState();
    if (head.era < state.era) return this.comparePast(head, wire, from).catch((error) => this.headNotCompared(seen, error));
    if (head.era > state.era || head.size > state.frontier.size) {
      // Their head says the log goes further than this device holds, which a server that then
      // won't give the rest can't unsay (`noteLogRefused`).
      const ahead = this.headAhead;
      const mine = ahead && (ahead.era > head.era || (ahead.era === head.era && ahead.size >= head.size)) ? ahead : { wire, era: head.era, size: head.size, from, failed: false };
      this.headAhead = mine;
      try {
        await this.syncLog();
      } catch (error) {
        // Compared when it next comes, or once the log can be read.
        this.headsCompared.delete(seen);
        mine.failed = true;
        throw error;
      }
      if (this.headAhead === mine && mine.era === head.era && mine.size === head.size) this.headAhead = null;
      state = this.logState();
      if (head.era < state.era) return this.comparePast(head, wire, from).catch((error) => this.headNotCompared(seen, error));
      if (head.era > state.era || head.size > state.frontier.size) return this.warnOnce(`log/back/${head.era}/${head.size}`, t(WARNINGS.back));
    }
    if (equalBytes(this.rootAt(head.size), head.root)) return;
    // The server's own head at that size, signed, which with theirs is the proof.
    const own = await this.api.log(state.era, head.size - 1, 1).catch(() => null);
    const ours = own && own.era === state.era && own.head.size === head.size ? fromWireHead({ e: own.head.era, n: own.head.size, r: own.head.root, s: own.head.sig }) : null;
    if (ours && headSigned(fromBase64(key), ours) && !equalBytes(ours.root, head.root)) {
      state.proof = [toWireHead(ours), wire];
      this.saveLogState();
    }
    this.warnOnce("log/proof", t(WARNINGS.proof), from);
  }

  /** The log was read: a head someone signed that it couldn't be read for before is compared now. */
  protected compareHeadAhead(): void {
    const ahead = this.headAhead;
    if (!ahead?.failed || !this.logRead || this.stopped) return;
    this.headAhead = null;
    void this.compareHead(ahead.wire, ahead.from).catch((error) => console.warn("[zuna] comparing a head of the log of keys", error));
  }

  /** A head couldn't be compared, as the server couldn't be asked: it's compared when it next comes. */
  protected headNotCompared(seen: string, error: unknown): void {
    this.headsCompared.delete(seen);
    console.warn("[zuna] comparing a head of the log of keys", error);
  }

  /**
   * Someone's head of an era before this device's own, which the server left when it began the next:
   * from a message, signed with the log's key, or with no signature from this account's manifest. It
   * counts for something only if this device read that era, whose records it keeps.
   *
   * - **No longer than this device read of it:** the root it holds at that size has to be the same.
   *   Two roots for one size are the two logs they are within an era.
   * - **Longer:** the device first reads the rest of that era, as the server kept it, if it moved on
   *   before the end (`readRestOfEra`). A head past where the server says the era ended is one of two
   *   things, and the warning says both: the server's log went back, as a backup restored from before
   *   that head leaves it, or the era went on for the others, and the one after it was shown to this
   *   device alone. The head is kept, beside the last this device was given of that era.
   */
  protected async comparePast(head: LogHead, wire: WireHead | null, from: string): Promise<void> {
    const key = this.logState().key;
    if (!key || !this.logState().past?.[head.era]) return;
    const fromManifest = wire === null;
    if (head.size > this.logState().past![head.era]!.frontier.size) await this.readRestOfEra(head.era);
    const state = this.logState();
    const past = state.past?.[head.era];
    if (!past) return;
    if (head.size > past.frontier.size) {
      if (!past.ended) return;
      if (wire) {
        past.longer = wire;
        this.saveLogState();
      }
      if (fromManifest) return this.warnOnce("log/floor/manifest", t(WARNINGS.manifest), from);
      return this.warnOnce(`log/back/${head.era}`, t(WARNINGS.back));
    }
    if (equalBytes(this.rootAt(head.size, head.era), head.root)) return;
    if (fromManifest) return this.warnOnce("log/floor/manifest", t(WARNINGS.manifest), from);
    // The server's own head of that era at that size, signed, which with theirs is the proof.
    const own = await this.api.log(head.era, head.size - 1, 1, true).catch(() => null);
    const ours = own && own.era === head.era && own.head.size === head.size ? fromWireHead({ e: own.head.era, n: own.head.size, r: own.head.root, s: own.head.sig }) : null;
    if (ours && headSigned(fromBase64(key), ours) && !equalBytes(ours.root, head.root)) {
      state.proof = [toWireHead(ours), wire];
      this.saveLogState();
    }
    this.warnOnce("log/proof", t(WARNINGS.proof), from);
  }

  /**
   * Reads what's left of an era this device moved on from, as the server kept it, onto what the
   * device read of it: its records alone, as what they say was written again in the era after. It
   * says where the era ended, which a head someone holds of it is then held to. A server that has
   * no more of it, or none, has said so too. One that refuses three times has as well, and one that
   * can't be reached is asked again when a head next calls for it.
   */
  protected readRestOfEra(era: number): Promise<void> {
    const reading = this.pastReading.get(era);
    if (reading) return reading;
    const done = this.readRestOfEraOnce(era).finally(() => this.pastReading.delete(era));
    this.pastReading.set(era, done);
    return done;
  }

  protected async readRestOfEraOnce(era: number): Promise<void> {
    const key = await this.logKey();
    if (!key || !this.logState().past?.[era] || this.logState().past![era]!.ended) return;
    const ended = () => {
      const past = this.logState().past?.[era];
      if (!past) return;
      past.ended = true;
      this.saveLogState();
    };
    for (;;) {
      const past = this.logState().past?.[era];
      const frontier = past && Frontier.from(past.frontier);
      if (!past || !frontier) return;
      let page: Awaited<ReturnType<typeof this.api.log>>;
      try {
        page = await this.api.log(era, frontier.size, LOG_PAGE, true);
      } catch (error) {
        // Not being able to reach the server at all says nothing of it.
        const refusals = (this.pastRefused.get(era) ?? 0) + (error instanceof ApiError && error.status !== 0 && error.status !== 401 ? 1 : 0);
        this.pastRefused.set(era, refusals);
        if (refusals < BODIES_TRIES) throw error;
        return ended();
      }
      const head: LogHead = { era: page.head.era, size: page.head.size, root: decode(page.head.root), sig: decode(page.head.sig) };
      // It kept none of that era, or no more of it than this device read.
      if (page.era !== era || head.era !== era || !headSigned(key, head) || page.size <= frontier.size) return ended();
      const rows: { idx: number; record: Uint8Array; checkpoint: Uint8Array | null }[] = [];
      for (const wire of page.records) {
        const record = decode(wire.record);
        if (wire.idx !== frontier.size || !readRecord(record)) break;
        frontier.append(leafHash(record));
        rows.push({ idx: wire.idx, record, checkpoint: frontier.size % LOG_CHECKPOINT === 0 ? concat(...frontier.roots) : null });
      }
      // A rest that doesn't go on from what this device read isn't taken: the era is held to what it has.
      if (rows.length !== page.records.length || rows.length === 0 || frontier.size !== head.size || !equalBytes(frontier.root(), head.root)) {
        this.warnOnce("log/unfit", t(WARNINGS.unfit));
        return ended();
      }
      this.db.transaction(() => {
        for (const row of rows) this.db.run("INSERT OR REPLACE INTO log_past(era, idx, record, frontier) VALUES(?, ?, ?, ?)", [era, row.idx, row.record, row.checkpoint]);
        past.frontier = frontier.toJSON();
        past.head = toWireHead(head);
        this.saveLogState();
      });
      if (frontier.size >= page.size) return ended();
    }
  }

  /** The two heads that can't both be true, if this device has found them. */
  protected logProof(): WireHead[] | null {
    return this.logState().proof;
  }
}
