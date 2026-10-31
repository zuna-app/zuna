// Stands in for @zuna/crypto (the desktop's WebAssembly build) with the same
// exports, backed by the same Rust code compiled natively and installed by the
// host as __zunaCrypto.

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const native = __zunaCrypto;

export const randomBytes = (len: number): Uint8Array => native.randomBytes(len);
export const argon2id = (
  password: Uint8Array,
  salt: Uint8Array,
  memoryKib: number,
  iterations: number,
  parallelism: number,
  outLen: number,
): Uint8Array => native.argon2id(password, salt, memoryKib, iterations, parallelism, outLen);
export const hkdfSha256 = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array =>
  native.hkdfSha256(ikm, salt, info, len);
export const sha256 = (data: Uint8Array): Uint8Array => native.sha256(data);
export const aeadSeal = (key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array => native.aeadSeal(key, plaintext, aad);
export const aeadOpen = (key: Uint8Array, data: Uint8Array, aad: Uint8Array): Uint8Array => native.aeadOpen(key, data, aad);
export const streamSeal = (key: Uint8Array, prefix: Uint8Array, index: number, last: boolean, plaintext: Uint8Array): Uint8Array =>
  native.streamSeal(key, prefix, index, last, plaintext);
export const streamOpen = (key: Uint8Array, prefix: Uint8Array, index: number, last: boolean, ciphertext: Uint8Array): Uint8Array =>
  native.streamOpen(key, prefix, index, last, ciphertext);
export const signingKeygen = (): KeyPair => native.signingKeygen();
export const sign = (secret: Uint8Array, message: Uint8Array): Uint8Array => native.sign(secret, message);
export const verify = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean =>
  native.verify(publicKey, message, signature);
export const hpkeKeygen = (): KeyPair => native.hpkeKeygen();
export const hpkeSeal = (recipient: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array =>
  native.hpkeSeal(recipient, info, aad, plaintext);
export const hpkeOpen = (secret: Uint8Array, info: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array =>
  native.hpkeOpen(secret, info, aad, sealed);
export const safetyDigest = (keyA: Uint8Array, keyB: Uint8Array): Uint8Array => native.safetyDigest(keyA, keyB);

/** One device's MLS state, with the same methods and results as the WebAssembly class. */
export class MlsClient {
  private readonly handle: number;

  constructor(devicePublic: Uint8Array, deviceSecret: Uint8Array, credential: Uint8Array, state: unknown[]) {
    this.handle = native.mlsNew(devicePublic, deviceSecret, credential, state);
  }

  private call(method: string, ...args: unknown[]): any {
    return native.mls(this.handle, method, ...args);
  }

  free(): void {
    native.mlsFree(this.handle);
  }

  takeChanges(): { set: [Uint8Array, Uint8Array][]; deleted: Uint8Array[] } {
    return this.call("takeChanges");
  }
  rollback(): void {
    this.call("rollback");
  }
  hasGroup(groupId: Uint8Array): boolean {
    return this.call("hasGroup", groupId);
  }
  generateKeyPackage(lastResort: boolean): Uint8Array {
    return this.call("generateKeyPackage", lastResort);
  }
  keyPackageCredential(keyPackage: Uint8Array): Uint8Array {
    return this.call("keyPackageCredential", keyPackage);
  }
  keyPackageSignatureKey(keyPackage: Uint8Array): Uint8Array {
    return this.call("keyPackageSignatureKey", keyPackage);
  }
  createGroup(groupId: Uint8Array): number {
    return this.call("createGroup", groupId);
  }
  commitChanges(groupId: Uint8Array, keyPackages: unknown[], removeLeaves: Uint32Array): unknown {
    return this.call("commitChanges", groupId, keyPackages, removeLeaves);
  }
  mergePending(groupId: Uint8Array): number {
    return this.call("mergePending", groupId);
  }
  clearPending(groupId: Uint8Array): void {
    this.call("clearPending", groupId);
  }
  hasPending(groupId: Uint8Array): boolean {
    return this.call("hasPending", groupId);
  }
  processCommit(groupId: Uint8Array, commit: Uint8Array): unknown {
    return this.call("processCommit", groupId, commit);
  }
  joinFromWelcome(welcome: Uint8Array): unknown {
    return this.call("joinFromWelcome", welcome);
  }
  joinExternal(groupId: Uint8Array, groupInfo: Uint8Array): unknown {
    return this.call("joinExternal", groupId, groupInfo);
  }
  exportGroupInfo(groupId: Uint8Array): Uint8Array {
    return this.call("exportGroupInfo", groupId);
  }
  epoch(groupId: Uint8Array): number {
    return this.call("epoch", groupId);
  }
  ownLeafIndex(groupId: Uint8Array): number {
    return this.call("ownLeafIndex", groupId);
  }
  members(groupId: Uint8Array): unknown {
    return this.call("members", groupId);
  }
  exportSecret(groupId: Uint8Array, label: string, context: Uint8Array, len: number): Uint8Array {
    return this.call("exportSecret", groupId, label, context, len);
  }
  exportPendingSecret(groupId: Uint8Array, label: string, context: Uint8Array, len: number): Uint8Array {
    return this.call("exportPendingSecret", groupId, label, context, len);
  }
  deleteGroup(groupId: Uint8Array): void {
    this.call("deleteGroup", groupId);
  }
}

/** Native code needs no loading; these exist so imports match the WebAssembly package. */
export default async function initCrypto(): Promise<void> {}
export const initCryptoSync = (): void => undefined;
export const initSync = initCryptoSync;
