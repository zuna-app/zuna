// What the core's cryptography refuses to read (crypto.ts), from bytes made by hand: certificates,
// profiles, envelopes and grants that are cut short, of another version or kind, or hold what isn't
// JSON, and the encodings (encoding.ts) as an engine without Uint8Array's own base64 and hex runs
// them. No server takes part.

import * as wasm from "@zuna/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEVICE_SIGNATURE_BYTES,
  LASTING_SIGNATURE_BYTES,
  checkEnvelope,
  coreFromJson,
  coreToJson,
  createCertificate,
  lastingKeyFromSeed,
  newDeviceKey,
  newLastingKey,
  openEnvelope,
  openHistoryGrant,
  openProfile,
  openProfileAtGeneration,
  openSignal,
  parseCertificate,
  readSigned,
  readSignedGroupDetails,
  sealEnvelope,
  sealHistoryGrant,
  sealProfile,
  sealSignal,
  signGroupDetails,
  signProfileAtGeneration,
  signalEpoch,
  verifyCertificate,
  type VaultCore,
} from "../src/crypto";
import { concat, fromRecoveryText, toRecoveryText, u32Bytes, u64Bytes, utf8 } from "../src/encoding";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

const GROUP = "group-1";
const signer = { userId: "u1", deviceId: "d1" };

describe("certificates and profiles that don't read", () => {
  it("makes keys only from a seed of 32 bytes, and certificates only for a device's key", () => {
    expect(() => lastingKeyFromSeed(new Uint8Array(31))).toThrow("A key's seed is 32 bytes.");
    const identity = newLastingKey();
    const device = newDeviceKey();
    expect(() => createCertificate(identity.secretKey, { userId: "u".repeat(256), deviceId: "d", signatureKey: device.publicKey })).toThrow("That isn't a device a certificate can be made for.");
    expect(() => createCertificate(identity.secretKey, { userId: "u", deviceId: "d", signatureKey: identity.publicKey })).toThrow("That isn't a device a certificate can be made for.");
  });

  it("reads a certificate only of its version, its exact length and a device's key", () => {
    const identity = newLastingKey();
    const device = newDeviceKey();
    const certificate = createCertificate(identity.secretKey, { userId: "u1", deviceId: "d1", signatureKey: device.publicKey, generation: 2 });
    expect(parseCertificate(certificate)).toMatchObject({ userId: "u1", deviceId: "d1", generation: 2 });
    expect(verifyCertificate(identity.publicKey, certificate)).toMatchObject({ userId: "u1" });
    // Checked only against a lasting key.
    expect(verifyCertificate(device.publicKey, certificate)).toBeNull();
    expect(parseCertificate(new Uint8Array([certificate[0]!]))).toBeNull();
    expect(parseCertificate(concat(new Uint8Array([99]), certificate.subarray(1)))).toBeNull();
    // A name longer than what follows it.
    expect(parseCertificate(new Uint8Array([certificate[0]!, 200, 1, 2, 3]))).toBeNull();
    expect(parseCertificate(certificate.subarray(0, certificate.length - 1))).toBeNull();
    // The right length, but the key in it isn't a device's.
    const keyAt = 2 + 2 + 1 + 2 + 4;
    const lasting = certificate.slice();
    lasting[keyAt] = 2;
    expect(parseCertificate(lasting)).toBeNull();
  });

  it("opens a profile only when it's whole, signed and sealed for the server's members", () => {
    const identity = newLastingKey();
    const community = wasm.randomBytes(32);
    const sealed = sealProfile(community, identity.secretKey, "Ada", { displayName: "Ada" });
    expect(openProfile(community, identity.publicKey, "ada", sealed)).toEqual({ displayName: "Ada" });
    expect(openProfile(community, identity.publicKey, "ada", sealed.subarray(0, LASTING_SIGNATURE_BYTES - 1))).toBeNull();
    expect(openProfile(wasm.randomBytes(32), identity.publicKey, "ada", sealed)).toBeNull();
    const head = signProfileAtGeneration(identity.secretKey, "u1", 3, sealed);
    expect(openProfileAtGeneration(community, identity.publicKey, "u1", "ada", 3, sealed, head)).toEqual({ displayName: "Ada" });
    expect(openProfileAtGeneration(community, identity.publicKey, "u1", "ada", 3, sealed.subarray(0, 10), head)).toBeNull();
    expect(openProfileAtGeneration(community, identity.publicKey, "u1", "ada", 4, sealed, head)).toBeNull();
    // Signed, but not sealed under this server's key.
    expect(openProfileAtGeneration(wasm.randomBytes(32), identity.publicKey, "u1", "ada", 3, sealed, head)).toBeNull();
  });

  it("reads a manifest's number from a vault core only when it's a whole number", () => {
    const bytes = () => wasm.randomBytes(8);
    const core: VaultCore = {
      identityPublic: bytes(),
      identitySecret: bytes(),
      hpkePublic: bytes(),
      hpkeSecret: bytes(),
      communityKey: bytes(),
      generation: 1,
      rootPublic: bytes(),
      rootSecret: bytes(),
      olderKeys: { 0: bytes() },
      olderHpkeSecrets: [bytes()],
      closedBelow: 0,
      slots: {},
      manifest: 5,
    };
    const json = coreToJson(core);
    expect(coreFromJson(json).manifest).toBe(5);
    expect(coreFromJson({ ...json, manifest: "5" }).manifest).toBe(0);
    expect(coreFromJson({ ...json, manifest: undefined }).manifest).toBe(0);
    expect(coreFromJson(json).olderKeys[0]).toEqual(core.olderKeys[0]);
  });
});

describe("envelopes made by hand", () => {
  const key = new Uint8Array(32).fill(7);
  const aad = (itemId: string, epoch: number) => concat(utf8(`zuna/message/v1|${GROUP}|${itemId}|`), u64Bytes(epoch));
  /** Sealed as an envelope is, around whatever inner bytes are given, with the length padding says. */
  const sealed = (inner: Uint8Array, length = inner.length) => {
    const padded = new Uint8Array(Math.ceil((inner.length + 4) / 256) * 256);
    padded.set(u32Bytes(length), 0);
    padded.set(inner, 4);
    return wasm.aeadSeal(key, padded, aad("m1", 1));
  };
  const named = (version: number, user: string, device: string, rest: Uint8Array) => concat(new Uint8Array([version, user.length]), utf8(user), new Uint8Array([device.length]), utf8(device), rest);
  const open = (bytes: Uint8Array) => openEnvelope(key, "message", GROUP, "m1", 1, bytes);

  it("refuses to seal for an account or device whose ID is too long", () => {
    const device = newDeviceKey();
    expect(() => sealEnvelope(key, device.secretKey, "message", GROUP, "m1", 1, {}, { userId: "u".repeat(256), deviceId: "d" })).toThrow("That account or device ID is too long.");
  });

  it("opens nothing whose padding, version or names don't add up", () => {
    const body = utf8("{}");
    const whole = named(4, "u1", "d1", concat(new Uint8Array(DEVICE_SIGNATURE_BYTES), body));
    expect(open(sealed(whole))?.signer).toEqual(signer);
    expect(open(sealed(whole, 5000))).toBeNull();
    expect(open(sealed(named(3, "u1", "d1", concat(new Uint8Array(DEVICE_SIGNATURE_BYTES), body))))).toBeNull();
    expect(open(sealed(new Uint8Array([4])))).toBeNull();
    expect(open(sealed(new Uint8Array([4, 10, 1, 2])))).toBeNull();
    expect(open(sealed(named(4, "u1", "d1", new Uint8Array(10))))).toBeNull();
  });

  it("calls an envelope whose words aren't JSON nobody's, whatever device it names", () => {
    const device = newDeviceKey();
    const inner = named(4, "u1", "d1", concat(new Uint8Array(DEVICE_SIGNATURE_BYTES), utf8("not json")));
    const opened = open(sealed(inner));
    expect(opened?.value).toBeUndefined();
    expect(checkEnvelope(key, "message", GROUP, "m1", 1, sealed(inner), () => device.publicKey)).toEqual({ state: "forged" });
    // A real one, for a device the key given is someone else's.
    const real = sealEnvelope(key, device.secretKey, "message", GROUP, "m1", 1, { text: "hi" }, signer);
    expect(checkEnvelope(key, "message", GROUP, "m1", 1, real, () => newDeviceKey().publicKey)).toEqual({ state: "forged" });
    expect(checkEnvelope(key, "message", GROUP, "m1", 1, real, () => undefined)).toEqual({ state: "unknown", signer });
    expect(checkEnvelope(key, "message", GROUP, "m1", 1, real, () => device.publicKey)).toEqual({ state: "signed", signer, value: { text: "hi" } });
  });

  it("says a signal's epoch, and reads no signal or framed envelope that isn't one", () => {
    const signal = sealSignal(key, "typing", GROUP, 7, { typing: true });
    expect(signalEpoch(signal)).toBe(7);
    expect(openSignal(key, "typing", GROUP, signal)).toEqual({ typing: true });
    expect(openSignal(key, "typing", GROUP, new Uint8Array(3))).toBeNull();
    expect(openSignal(key, "read", GROUP, signal)).toBeNull();
    expect(readSigned(new Uint8Array([3, 0, 0]))).toBeNull();
    expect(readSigned(new Uint8Array([2, 0, 0, 0, 1, 9]))).toBeNull();
    expect(readSigned(new Uint8Array([3, 0, 0, 0, 1, 9]))).toEqual({ epoch: 1, envelope: new Uint8Array([9]) });
  });
});

describe("history grants and signed details made by hand", () => {
  const hpke = () => wasm.hpkeKeygen() as { publicKey: Uint8Array; secretKey: Uint8Array };
  const grant = (recipient: Uint8Array, value: unknown) => wasm.hpkeSeal(recipient, utf8("zuna/history-grant/v3"), utf8(GROUP), utf8(JSON.stringify(value)));

  it("opens a grant only of its version, with its fields and keys of their kinds", () => {
    const { publicKey, secretKey } = hpke();
    const device = newDeviceKey();
    const real = sealHistoryGrant(publicKey, GROUP, "u2", signer, device.secretKey, { 1: "a2V5" });
    const opened = openHistoryGrant(secretKey, GROUP, "u2", real);
    expect(opened).toMatchObject({ signer, keys: { 1: "a2V5" } });
    expect(opened.signedBy(device.publicKey)).toBe(true);
    expect(openHistoryGrant(secretKey, GROUP, "u3", real).signedBy(device.publicKey)).toBe(false);
    for (const value of [{ v: 2, keys: "{}", user: "u", device: "d", signature: "" }, { v: 3, keys: {}, user: "u", device: "d", signature: "" }, { v: 3, keys: "{}", user: 1, device: "d", signature: "" }, null]) {
      expect(() => openHistoryGrant(secretKey, GROUP, "u2", grant(publicKey, value))).toThrow("That history grant isn't valid.");
    }
    for (const keys of ["5", "null"]) {
      expect(() => openHistoryGrant(secretKey, GROUP, "u2", grant(publicKey, { v: 3, keys, user: "u", device: "d", signature: "" }))).toThrow("That history grant isn't valid.");
    }
  });

  it("reads signed details only with each field of its kind and details that are JSON", () => {
    const device = newDeviceKey();
    const signed = signGroupDetails(GROUP, { name: "Trip" }, 2, signer, device.secretKey) as { signed: Record<string, unknown> };
    const read = readSignedGroupDetails(GROUP, signed);
    expect(read).toMatchObject({ details: { name: "Trip" }, version: 2, signer });
    expect(read!.signedBy(device.publicKey)).toBe(true);
    expect(readSignedGroupDetails(GROUP, signed, "channel")!.signedBy(device.publicKey)).toBe(false);
    expect(readSignedGroupDetails(GROUP, null)).toBeNull();
    expect(readSignedGroupDetails(GROUP, { signed: "x" })).toBeNull();
    expect(readSignedGroupDetails(GROUP, { signed: { ...signed.signed, version: "2" } })).toBeNull();
    expect(readSignedGroupDetails(GROUP, { signed: { ...signed.signed, signature: 5 } })).toBeNull();
    expect(readSignedGroupDetails(GROUP, { signed: { ...signed.signed, details: "{not json" } })).toBeNull();
  });
});

describe("encodings, with and without the engine's own", () => {
  const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  const statics = Uint8Array as unknown as Record<string, unknown>;
  const saved = { toBase64: proto.toBase64, toHex: proto.toHex, fromBase64: statics.fromBase64, fromHex: statics.fromHex };

  afterEach(() => {
    for (const name of ["toBase64", "toHex"] as const) if (saved[name]) proto[name] = saved[name];
    for (const name of ["fromBase64", "fromHex"] as const) if (saved[name]) statics[name] = saved[name];
    vi.resetModules();
  });

  it("encodes the same through binary strings as an engine without Uint8Array's base64 and hex does", async () => {
    const native = await import("../src/encoding");
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);
    const expected = { base64: native.toBase64(bytes), hex: native.toHex(bytes.subarray(0, 4)) };
    delete proto.toBase64;
    delete proto.toHex;
    delete statics.fromBase64;
    delete statics.fromHex;
    vi.resetModules();
    const fallback = await import("../src/encoding");
    expect(fallback.toBase64(bytes)).toBe(expected.base64);
    expect(fallback.toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(fallback.fromBase64(fallback.toBase64(bytes))).toEqual(bytes);
    expect(fallback.toHex(bytes.subarray(0, 4))).toBe(expected.hex);
    expect(expected.hex).toBe("001f3e5d");
    expect(fallback.fromHex("001f3e5d")).toEqual(bytes.subarray(0, 4));
    expect(fallback.toBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(fallback.fromBase64Url("-_8")).toEqual(new Uint8Array([251, 255]));
    expect(fallback.readU32(fallback.u32Bytes(0xdeadbeef))).toBe(0xdeadbeef);
  });

  it("writes recovery text with no leftover bits when the bytes come in fives", () => {
    const five = new Uint8Array([1, 2, 3, 4, 5]);
    const text = toRecoveryText(five);
    expect(text.replace(/-/g, "")).toHaveLength(8);
    expect(fromRecoveryText(text)).toEqual(five);
  });
});
