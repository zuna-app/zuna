// Hybrid signatures, Ed25519 and ML-DSA-65 made from one seed and checked together, exactly
// as crypto/src/hybrid.rs makes a lasting key's, with Node's own crypto: what signs a verified
// plugin and the marketplace's index. test/hybrid.test.ts holds it to the shared vectors in
// crypto/src/testdata.

import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as nodeSign, verify as nodeVerify } from "node:crypto";

/** A lasting key: Ed25519 and ML-DSA-65. */
export const LASTING = 2;
const LABEL = Buffer.from("zuna/hybrid-sig/v1");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ML_DSA_65_PKCS8 = Buffer.from("3034020100300b060960864801650304031204228020", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ML_DSA_PUBLIC = 1952;
const ML_DSA_SIGNATURE = 3309;
export const PUBLIC_LEN = 1 + 32 + ML_DSA_PUBLIC;
export const SIGNATURE_LEN = 1 + 64 + ML_DSA_SIGNATURE;

const LASTING_BYTE = Buffer.from([LASTING]);
/** @param {Uint8Array} u8 */
const asBuffer = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
/** @type {Map<string, { ed: import("node:crypto").KeyObject, ml: import("node:crypto").KeyObject | null }>} */
const publicKeyCache = new Map();

/** @param {Buffer} seed @param {string} algorithm */
function derive(seed, algorithm) {
  return Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), `zuna/hybrid-key/v1|lasting|${algorithm}`, 32));
}

/** Both private keys of a secret: its kind's byte, then its 32-byte seed. @param {Uint8Array} secret */
function keys(secret) {
  const bytes = asBuffer(secret);
  if (bytes.length !== 33 || bytes[0] !== LASTING) throw new Error("A plugin signing key is a lasting key's secret: 2, then 32 bytes.");
  const seed = bytes.subarray(1);
  const ed25519 = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, derive(seed, "ed25519")]), format: "der", type: "pkcs8" });
  const mlDsa = createPrivateKey({ key: Buffer.concat([ML_DSA_65_PKCS8, derive(seed, "ml-dsa")]), format: "der", type: "pkcs8" });
  const edPublic = createPublicKey(ed25519).export({ format: "der", type: "spki" }).subarray(-32);
  const mlPublic = Buffer.from(/** @type {any} */ (createPublicKey(mlDsa).export({ format: "jwk" })).pub, "base64url");
  if (mlPublic.length !== ML_DSA_PUBLIC) throw new Error("This Node's ML-DSA-65 keys aren't FIPS 204's.");
  return { ed25519, mlDsa, public: Buffer.concat([LASTING_BYTE, edPublic, mlPublic]) };
}

/** A new secret. */
export function generate() {
  return Buffer.concat([LASTING_BYTE, randomBytes(32)]);
}

/** A secret's public key. @param {Uint8Array} secret */
export function publicKey(secret) {
  return keys(secret).public;
}

/** @param {Buffer} publicKey @param {Uint8Array} message */
function input(publicKey, message) {
  return Buffer.concat([LABEL, LASTING_BYTE, createHash("sha256").update(publicKey).digest(), asBuffer(message)]);
}

/** Signs with both of a secret's keys. @param {Uint8Array} secret @param {Uint8Array} message */
export function sign(secret, message) {
  const key = keys(secret);
  const signed = input(key.public, message);
  return Buffer.concat([LASTING_BYTE, nodeSign(null, signed, key.ed25519), nodeSign(null, signed, key.mlDsa)]);
}

/** Whether both halves hold. @param {Uint8Array} publicKey @param {Uint8Array} message @param {Uint8Array} signature */
export function verify(publicKey, message, signature) {
  const pub = asBuffer(publicKey);
  const sig = asBuffer(signature);
  if (pub.length !== PUBLIC_LEN || pub[0] !== LASTING || sig.length !== SIGNATURE_LEN || sig[0] !== LASTING) return false;
  const signed = input(pub, message);
  try {
    const cacheKey = pub.toString("base64");
    let parsed = publicKeyCache.get(cacheKey);
    if (!parsed) {
      const ed = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub.subarray(1, 33)]), format: "der", type: "spki" });
      parsed = { ed, ml: null };
      if (publicKeyCache.size >= 32) publicKeyCache.clear();
      publicKeyCache.set(cacheKey, parsed);
    }
    if (!nodeVerify(null, signed, parsed.ed, sig.subarray(1, 65))) return false;
    parsed.ml ??= createPublicKey({ key: { kty: "AKP", alg: "ML-DSA-65", pub: pub.subarray(33).toString("base64url") }, format: "jwk" });
    return nodeVerify(null, signed, parsed.ml, sig.subarray(65));
  } catch {
    return false;
  }
}

/** Reads a key file as keygen writes it: comment lines, then the secret in base64. @param {string} text */
export function readKeyFile(text) {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error("The key file has no key in it.");
  return Buffer.from(line, "base64");
}
