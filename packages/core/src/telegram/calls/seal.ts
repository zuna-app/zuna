// Sealing one signalling message of a Telegram call under the call's key, as Telegram's apps seal
// theirs (docs/TELEGRAM_CALLS_PLAN.md, "The protocol between the apps"). It's MTProto 2.0's way:
// the message is numbered, a hash of it under part of the key is its message key, and AES-256 in
// counter mode under a key and IV made from both encrypts it. The caller and the answerer each
// take a part of the key of their own, so neither's packets open as the other's own, and a hash
// that doesn't match, or a number seen before, is dropped.

import * as wasm from "@zuna/crypto";
import { concat, equalBytes, readU32, u32Bytes } from "../../encoding";

/** How big a call's key is, as TDLib gives it in `callStateReady.encryption_key`. */
const KEY_LENGTH = 256;
/** The largest number a message may have: Telegram's apps keep the top two bits for flags. */
const MOST_COUNTER = 0x3fffffff;
/** How many of the latest numbers are remembered, and how far behind the largest one may be. */
const KEEP_COUNTERS = 64;
/** A message key, a number, and at least a byte. */
const LEAST_PACKET = 21;
const MOST_PACKET = 128 * 1024;
/** Where signalling's parts of the key start, past media's. */
const SIGNALLING = 128;

export class CallSeal {
  private readonly key: Uint8Array;
  private counter = 0;
  /** The largest numbers that opened, from the smallest up. */
  private readonly seen: number[] = [];

  /** key: the call's 256-byte key from callStateReady.encryption_key; outgoing: this side is the caller. */
  constructor(
    key: Uint8Array,
    private readonly outgoing: boolean,
  ) {
    if (key.length !== KEY_LENGTH) throw new Error("a Telegram call's key is 256 bytes");
    this.key = key.slice();
  }

  /** Numbers and seals one message. */
  seal(message: Uint8Array): Uint8Array {
    if (this.counter >= MOST_COUNTER) throw new Error("this call has sealed as many messages as it can");
    const plain = concat(u32Bytes(++this.counter), message);
    const x = (this.outgoing ? 0 : 8) + SIGNALLING;
    const messageKey = this.messageKey(x, plain);
    const { key, iv } = this.aesKeyIv(x, messageKey);
    return concat(messageKey, wasm.aes256Ctr(key, iv, plain));
  }

  /** Opens one, or null: wrong size, wrong hash, or a number already seen or too old. */
  open(packet: Uint8Array): Uint8Array | null {
    if (packet.length < LEAST_PACKET || packet.length > MOST_PACKET) return null;
    // The other side's part of the key.
    const x = (this.outgoing ? 8 : 0) + SIGNALLING;
    const messageKey = packet.subarray(0, 16);
    const { key, iv } = this.aesKeyIv(x, messageKey);
    const plain = wasm.aes256Ctr(key, iv, packet.subarray(16));
    if (!equalBytes(this.messageKey(x, plain), messageKey)) return null;
    // The top two bits are flags, which say nothing of the number.
    const counter = readU32(plain) & MOST_COUNTER;
    if (!this.register(counter)) return null;
    return plain.slice(4);
  }

  /** The middle half of a hash of the message under the sender's part of the key. */
  private messageKey(x: number, plain: Uint8Array): Uint8Array {
    return wasm.sha256(concat(this.key.subarray(88 + x, 88 + x + 32), plain)).slice(8, 24);
  }

  /** MTProto 2.0's AES key and IV, from the message key and the sender's part of the key. */
  private aesKeyIv(x: number, messageKey: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
    const a = wasm.sha256(concat(messageKey, this.key.subarray(x, x + 36)));
    const b = wasm.sha256(concat(this.key.subarray(40 + x, 40 + x + 36), messageKey));
    return {
      key: concat(a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)),
      iv: concat(b.subarray(0, 4), a.subarray(8, 16), b.subarray(24, 28)),
    };
  }

  /**
   * Whether a number is new, which it is unless it opened before or is 64 or more behind the
   * largest that did, and remembers it if so. Numbers that fall out of its window are forgotten,
   * as Telegram's apps forget them, so a message can come out of order but never count twice.
   */
  private register(counter: number): boolean {
    const seen = this.seen;
    const largest = seen.length ? seen[seen.length - 1]! : 0;
    let at = 0;
    while (at < seen.length && seen[at]! < counter) at++;
    if (seen[at] === counter || counter + KEEP_COUNTERS <= largest) return false;
    let gone = 0;
    while (gone < seen.length && seen[gone]! + KEEP_COUNTERS <= counter) gone++;
    seen.splice(0, gone);
    seen.splice(at - gone, 0, counter);
    return true;
  }
}
