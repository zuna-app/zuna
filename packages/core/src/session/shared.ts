// What every part of ServerSession shares: its timings and limits, the shapes of what it
// keeps, and helpers that need nothing of it.

import { decode, type ApiChannel, type ApiLink, type ApiMessage, type ApiSound, type TokenSize } from "../api";
import { coreToJson } from "../crypto";
import { planToJson, type SignedLink } from "../generations";
import { utf8 } from "../encoding";
import { manifestParts, type TrustManifest } from "../manifest";
import { MAX_TEXT_LENGTH, parseMessageBody, parseReaction, parseSystemEvent, type ChannelDetails, type GroupDetails, type SoundDetails } from "../validate";
import type { BotInfo, GroupMemberView, MessageBody, MessageStatus, Profile, ReactionView, Role, SystemEvent, TrustState } from "../types";

export const CHUNK_SIZE = 1 << 20;
/** How often a claim of someone's key packages is tried while the server says to slow down, and how far apart: it allows one every 2 seconds then. */
export const CLAIM_ATTEMPTS = 6;
export const CLAIM_WAIT_MS = 2100;
/** How long a message waits for its link's preview before it goes without one. */
export const PREVIEW_WAIT_MS = 4000;
/** How long `sendNow` waits for a message to go once its files are up. */
export const SEND_NOW_WAIT_MS = 60_000;
export const UPLOAD_CONCURRENCY = 3;
/** How many groups catch up at once after a reconnect. */
export const SYNC_CONCURRENCY = 4;
/** How many vault items are asked for at a time. */
export const VAULT_PAGE = 500;
/** How far a sound someone played may be from now, by their clock, and how long it's remembered so it plays once. */
export const PLAY_FRESH_MS = 5 * 60_000;
/**
 * How far a signal about what a room watches may be from now, by the server's clock as each
 * device knows it, and how long it's remembered so that one handed on again counts once.
 */
export const WATCH_FRESH_MS = 2 * 60_000;
/**
 * The devices that have been in a room longest answer someone coming in, this far apart in
 * that order, so that the one most likely to hold what's on answers first. Nobody hears
 * another's answer, as it goes only to the one who asked, so only these few do.
 */
export const WATCH_ANSWERERS = 3;
export const WATCH_ANSWER_STEP_MS = 400;
/** How often one device is told what's on when what it sent was behind, at most. */
export const WATCH_CORRECT_EVERY_MS = 1000;
/** How long putting a video on waits for its title and picture before it goes without them. */
export const WATCH_DETAILS_WAIT_MS = 6000;
/** How far a typing signal's time may be from this device's, so an old one sent again shows nobody typing. */
export const TYPING_FRESH_MS = 30_000;
export const KEY_PACKAGE_TARGET = 40;
export const KEY_PACKAGE_LOW = 15;
export const LAST_RESORT_MAX_AGE_MS = 21 * 24 * 3600 * 1000;
/** Keys rotate at least this often, which limits how long a stolen key stays useful. */
export const EPOCH_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const PAGE_SIZE = 50;
export const TYPING_THROTTLE_MS = 3000;
export const RECONCILE_JITTER_MS = 2500;
/** How long members wait to hand someone a channel's older keys, so that one of them does. */
export const GRANT_JITTER_MS = 2000;
export const MAX_COMMIT_ATTEMPTS = 6;
/** How long the messages of a chat you were removed from stay, unless you clear them first. */
export const REMOVED_KEPT_MS = 30 * 24 * 3600 * 1000;
/** How often to check whether a session that seemed to end is really over, such as after a proxy's hiccup. */
export const SIGNED_OUT_RETRY_MS = 5 * 60 * 1000;
/** Past this, the time a device signed and the time the server says it got the message look wrong. */
export const TIME_DIFFERS_MS = 24 * 3600 * 1000;
/**
 * How recent a message must be, and the one its device sent before it, for that one
 * to be looked for when it's missing. Twice this is well within the shortest time a
 * server may keep messages for, a day, so what's missing wasn't simply expired.
 */
export const EARLIER_LOOKED_FOR_MS = 10 * 3600 * 1000;
/** How long to wait before looking, so that what's still arriving can arrive. */
export const EARLIER_LOOK_DELAY_MS = 3000;
export const SEARCH_REBUILD_BATCH = 200;
export const VAULT_BATCH = 200;
/** What this device changed that its next manifest has to carry, over whatever another device wrote meanwhile. */
export const UNSAVED_TRUST = "unsaved_trust";
/** How often a device tries again to write the manifest after another's got in first. */
export const MANIFEST_ATTEMPTS = 5;
/** The longest a timer waits, well short of where setTimeout overflows, after which it looks again. */
export const LONGEST_WAIT_MS = 24 * 3600 * 1000;
/** Parts of a manifest in more than one vault item that came without the rest yet, by its number and hash. */
export const MANIFEST_PARTS = "manifest_parts";

/** A manifest's parts for a rotation, which can't go without it. */
export function sealedManifest(manifest: TrustManifest): { id: string; data: Uint8Array; version: number }[] {
  const parts = manifestParts(manifest);
  if (!parts) throw new Error("Your account trusts more people than it can store, so its keys can't be replaced.");
  return parts;
}
/** What's sealed at rest names its table and row, so it can't be moved to another row or table. */
export const DB_LABEL = (name: string, row: string) => utf8(`zuna/local/${name}|${row}`);
/** Keeps changes to this account's keys one at a time. Group IDs are hex, so it can't be one of those. */
export const ACCOUNT_LOCK = "account";
export const ROTATION_INTENT = "rotation_intent";
export const ROTATION_ATTEMPTS = 6;
/** After this long failing to rotate, the person is told. */
export const ROTATION_STUCK_MS = 24 * 3600 * 1000;
export const MAX_REMOVAL_ROTATIONS = 5;
export const REMOVAL_ROTATION_WINDOW_MS = 3600 * 1000;
/** Enough for anyone to have heard about a rotation by the time a key is forgotten, in a core with a size limit. */
export const OLDER_HPKE_KEPT = 16;
/** A device that has held a leaf this long, as this device saw it, has continuity with what came before. */
export const CONTINUITY_MS = 7 * 24 * 3600 * 1000;

/**
 * How long a call's or voice channel's media key may last. Its frames are encrypted
 * with AES-GCM under nonces only an RTP timestamp and a 16-bit counter tell apart,
 * and video's timestamp comes round again after about 13 hours, so a key gets a
 * new epoch well before that while someone is in the room with it.
 */
export const voiceTiming = {
  maxEpochAgeMs: 6 * 3600_000,
  checkEveryMs: 10 * 60_000,
  /** Everyone in the room notices together, so each waits a while to let one go first. */
  jitterMs: 60_000,
};

/** How long things wait before a rotation. Tests shorten these. */
/** How long a key issues tokens for, as the server's `TokenPeriod`. */
export const TOKEN_PERIOD_MS = 6 * 3600 * 1000;
/** What a small token pays for, as the server's `SmallTokenBytes`. */
export const TOKEN_SMALL_BYTES = 32 << 10;
export const TOKEN_SIZES: TokenSize[] = ["small", "large"];
/** How many of each size a device asks for at once, and under how many it asks for more. */
export const TOKEN_BATCH: Record<TokenSize, number> = { small: 100, large: 10 };
export const TOKEN_LOW: Record<TokenSize, number> = { small: 40, large: 4 };
export const tokenTiming = {
  /** How long after running low a device fetches more: a random while, at a time of its own. */
  topUpMs: [60_000, 600_000] as [number, number],
};

export const rotationTiming = {
  /** Removals close together share one rotation. */
  gatherMs: 2000,
  /** Another device takes over after up to this long, if nobody has rotated by then. */
  takeoverMs: 30_000,
  retryMs: 60_000,
};

/** Values of `epoch_keys.uploaded`. A granted key waits until it has proved itself. */
export const KEY_NOT_UPLOADED = 0;
export const KEY_UPLOADED = 1;
export const KEY_UNPROVEN = 2;
/**
 * From an epoch a commit that was undone began. The group's later epoch of the same
 * number is another, so this key isn't passed on, and the account's own copy of that
 * later one replaces it. It still opens whatever it opened.
 */
export const KEY_VOIDED = 3;

/** What a person is told when the server calls a conversation something other than what it is. */
export const KIND_WARNING = "The server tried to pass one of your conversations off as a different kind of conversation. Zuna didn't go along with it.";

export interface CachedDevice {
  id: string;
  signatureKey: Uint8Array;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  /** As the server said, and for whoever uses them to check. */
  enrollProof?: string | null;
  sealKey?: string | null;
}

/** A rotation under way, kept so a crash can finish it with the same keys. */
export interface IdentityState {
  forked: number;
  known_generation: number;
  known_hash: Uint8Array | null;
  trust_generation: number;
}

export type SealedIdentityState = Omit<IdentityState, "known_hash"> & { known_hash: string | null };

export interface RotationIntent {
  generation: number;
  /** As it's sent, so sending it again is the same request. */
  request: { link: { payload: string; by_prev: string; by_new: string; by_device: string } } & Record<string, unknown>;
  accountKey: string;
  core: ReturnType<typeof coreToJson>;
  /** What it's for besides new keys, to do again if another rotation gets in first. */
  plan: ReturnType<typeof planToJson>;
  once: boolean;
}

export interface CachedUser {
  id: string;
  username: string;
  role: Role;
  identityKey: Uint8Array;
  hpkeKey: Uint8Array;
  profile: Profile;
  lastSeenAt: number | null;
  hidesLastSeen: boolean;
  banned: boolean;
  deleted: boolean;
  trust: TrustState;
  devices: Map<string, CachedDevice>;
  /** Set for a bot, as the server says: whose it is, and who may see and add it. */
  bot?: BotInfo | null;
}

/** The setup links this device made for bots still to sign up: the key that checks each one's proof, and what it's called. */
export const BOT_SETUPS = "bot_setups";
export type BotSetups = Record<string, { key: string; name: string }>;

export type GroupMeta = GroupDetails;

export interface CachedGroup {
  id: string;
  kind: "dm" | "group" | "channel";
  peerId: string | null;
  epoch: number;
  seq: number;
  meta: GroupMeta;
  metaBlob: string | null;
  metaEpoch: number | null;
  /** The newest version of the group's signed details seen, so an older copy isn't taken for new. */
  metaVersion?: number;
  createdAt: number;
  members: GroupMemberView[];
  readStates: Record<string, string | null>;
  readBy: Record<string, number>;
  ownRead: number;
  /**
   * How far the server is known to have this person's read position. Behind
   * `ownRead`, it's sent again. A chat this device has never marked read has
   * none, and nothing is sent again for it until it does.
   */
  readSent?: number;
  /** When the server said this device's person is no longer in this conversation. */
  removedAt?: number | null;
  /** People the server says left, not yet shown, until MLS confirms their keys are gone. */
  pendingRemovals?: Record<string, { actor: string; seq: number; at: number }>;
  /** A DM the server listed more than two people in, seen before anyone's known to be its other person. It's not used. */
  doubtful?: boolean;
  /** In a channel: who's waiting for a member to hand them its older keys. */
  historyWanted?: string[];
  /**
   * A group's roster as MLS last gave this device (see roster.ts), or a DM's or a channel's
   * charter, kept when the MLS state isn't, so whatever comes next is held to it. A DM or
   * channel started before charters has none.
   */
  roster?: string;
  /** The version before it, which a group whose newest change was undone goes back to. */
  rosterBefore?: string;
  /** Who the server lists as admins. It only decides what the server does, and who takes over a group left without one. */
  serverAdmins?: string[];
}

/** A channel as the server listed it, and what its sealed details turned out to say. */
export interface CachedChannel {
  api: ApiChannel;
  details: ChannelDetails | null;
  /** The newest version of its details seen, so an older copy isn't taken for new. */
  version: number;
}

/** A sound as the server listed it, and what its sealed details turned out to say. */
export interface CachedSound {
  api: ApiSound;
  details: SoundDetails | null;
  /** The newest version of its details seen, so an older copy isn't taken for new. */
  version: number;
}

/** One leaf of a group's MLS tree, and whether it really is the device it says. */
export interface TreeMember {
  leaf: number;
  /** Who its certificate names, which proves nothing unless `genuine`. */
  userId: string;
  deviceId: string;
  /** Its certificate is signed by that person's identity key, for the signing key it really uses. */
  genuine: boolean;
  /** No key is known for that person yet, so nothing has been checked. It isn't genuine, but it isn't caught out either. */
  unchecked?: boolean;
  /** In a DM, someone who isn't one of its two people. */
  outsider?: boolean;
}

export interface MessageRow {
  row_id: number;
  group_id: string;
  id: string;
  seq: number | null;
  updated_seq: number;
  sender_user: string;
  sender_device: string;
  epoch: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pinned_at: number | null;
  pinned_by: string | null;
  pin_revision: number | null;
  status: MessageStatus;
  body: Uint8Array | null;
  raw: Uint8Array | null;
  /** The reactions to a message that hasn't opened yet, as they came, sealed, so they're there once it does. */
  raw_reactions: Uint8Array | null;
  /** The public half of the key only its author's devices can make, as the server holds it, which changing or deleting it takes. */
  item_key: Uint8Array | null;
  unproven_delete_at: number | null;
  expires_at: number | null;
}

export interface StoredBody extends MessageBody {
  reactions?: ReactionView[];
  /** This account's own reactions, with the item keys the server holds for them, which taking one back takes. */
  mine?: { id: string; key: string; item: string }[];
  system?: SystemEvent;
}

export type OutboxEntry =
  /** `previewUrl`: the link whose preview was still being made when the message was sent. */
  | { kind: "message"; id: string; body: MessageBody; previewUrl?: string }
  | { kind: "edit"; id: string; groupId: string; body: MessageBody };

export type Mutex = Promise<unknown>;

export const emptyProfile = (username: string): Profile => ({ displayName: username });
// What's shown of someone who deleted their account, in place of all that was known of them.
export const DELETED_PROFILE: Profile = { displayName: "Deleted account" };

export const MESSAGE_ID = /^[0-9a-f]{32}$/;
/** The longest slow mode a server allows, in seconds. */
export const MAX_SLOW_MODE = 6 * 3600;
/** How many reactions one person puts on a message, which apps hold as the server can't tell whose they are. */
export const MAX_REACTIONS_BY_PERSON = 32;
/** How much sooner after its author's last a message in a channel with slow mode may come, for the network, before it's hidden. */
export const SLOW_MODE_MARGIN_MS = 2000;

/** A channel's slow mode as the server says, in seconds, within what it allows. */
export const slowModeOf = (api: ApiChannel | undefined): number => {
  const seconds = api?.slow_mode ?? 0;
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, MAX_SLOW_MODE) : 0;
};

/** What the server says about a message, which has to at least have the right shape. */
export const validApiMessage = (message: ApiMessage): boolean =>
  MESSAGE_ID.test(message?.id ?? "") &&
  Number.isSafeInteger(message.seq) &&
  Number.isSafeInteger(message.updated_seq) &&
  Number.isSafeInteger(message.epoch) &&
  Number.isSafeInteger(message.created_at) &&
  Array.isArray(message.reactions);


/** A message as this device stored it: what can be shown, or null if that's nothing. */
export function readStoredBody(row: Pick<MessageRow, "id">, stored: StoredBody): StoredBody | null {
  const body: StoredBody | null = parseMessageBody(stored);
  if (!body) return null;
  // Only this device writes notices, and it gives them their own kind of ID.
  if (row.id.startsWith("sys-")) {
    const system = parseSystemEvent(stored.system);
    if (system) body.system = system;
  }
  if (Array.isArray(stored.reactions)) {
    body.reactions = stored.reactions.flatMap((item) => {
      const reaction = parseReaction(item);
      return reaction && Array.isArray(item.userIds) ? [{ ...reaction, userIds: item.userIds.filter((id) => typeof id === "string") }] : [];
    });
  }
  if (Array.isArray(stored.mine)) {
    body.mine = stored.mine.filter((item) => typeof item?.id === "string" && typeof item.key === "string" && typeof item.item === "string");
  }
  return body;
}

/**
 * When a disappearing message goes, if it does: how long its sender's app said
 * after it was sent. The earlier of the server's time and the sender's own counts,
 * so neither can make it last longer than it says.
 */
/** Runs `task` over `items`, at most `limit` at a time, and starts no more once one has failed, whose error it then throws. */
export async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function expiryOf(createdAt: number, body: MessageBody): number | null {
  if (!body.expiresIn) return null;
  return Math.min(createdAt, body.sentAt ?? createdAt) + body.expiresIn * 1000;
}

export function assertSendable(body: MessageBody): void {
  if ((body.text?.length ?? 0) > MAX_TEXT_LENGTH) throw new Error("That message is too long. Try sending it as a file.");
}

export const signedFromApi = (wire: ApiLink): SignedLink => ({
  payload: decode(wire.payload),
  byPrev: decode(wire.by_prev),
  byNew: decode(wire.by_new),
  byDevice: decode(wire.by_device),
});
