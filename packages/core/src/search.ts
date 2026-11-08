// Full-text search over a local index that doesn't store readable words.
//
// The database holds keyed hashes of words and their prefixes, so someone who
// copies the file without the device's key gets no text. Decrypted snippets are
// produced at display time only.

import * as wasm from "@zuna/crypto";
import { toHex, utf8 } from "./encoding";

const MIN_PREFIX = 2;
const MAX_PREFIX = 16;
const NO_SALT = new Uint8Array(0);

/** Lowercases and strips accents, so "Résumé" is found by "resume". */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * Hashes already worked out, by key. Messages share most of their words and nearly
 * all their prefixes, so a catch-up hashes the same few thousand over and over: of
 * chat-like text, 96% of a message's tokens are in here, and indexing it takes a
 * tenth of the time. They're in memory only, where the key and the messages are
 * anyway, and only so many.
 */
const hashes = new WeakMap<Uint8Array, Map<string, string>>();
const MAX_HASHES = 20_000;

function hashToken(searchKey: Uint8Array, token: string): string {
  let known = hashes.get(searchKey);
  if (!known) hashes.set(searchKey, (known = new Map()));
  let hash = known.get(token);
  if (hash === undefined) {
    hash = `h${toHex(wasm.hkdfSha256(searchKey, NO_SALT, utf8(`zuna/search/v2|${token}`), 8))}`;
    if (known.size >= MAX_HASHES) known.delete(known.keys().next().value!);
    known.set(token, hash);
  }
  return hash;
}

/**
 * Which way the local indexes were built: 2 hashes words as they are now, 3
 * adds what each message holds, and 4 which ones mention this account or reply
 * to it. A new one means building them again.
 */
export const SEARCH_INDEX_VERSION = 4;

/** The keyed name a kind of attachment, or links, goes by in the local index. No word can have it. */
export const mediaTag = (searchKey: Uint8Array, kind: string) => hashToken(searchKey, `~${kind}`);

/** The tokens to store for a text: every word plus its prefixes. */
export function indexTokens(searchKey: Uint8Array, text: string): string {
  const unique = new Set<string>();
  for (const word of tokenize(text)) {
    unique.add(word);
    const end = Math.min(word.length, MAX_PREFIX);
    for (let i = MIN_PREFIX; i < end; i++) unique.add(word.slice(0, i));
  }
  return [...unique].map((token) => hashToken(searchKey, token)).join(" ");
}

/** The FTS5 match expression for a query, or null if it has nothing to search. */
export function queryTokens(searchKey: Uint8Array, query: string): string | null {
  const words = tokenize(query).map((word) => word.slice(0, MAX_PREFIX));
  if (words.length === 0) return null;
  return words.map((word) => `"${hashToken(searchKey, word)}"`).join(" AND ");
}
