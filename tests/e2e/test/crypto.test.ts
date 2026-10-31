// The encryption core compiled natively for iOS against the WebAssembly build
// the desktop uses. Both come from the same Rust code, so this catches mistakes
// in what's between: UniFFI, the Swift bridge and the JavaScript shim (byte
// order, nulls, epochs as numbers, errors that must throw). The native side
// runs inside the iOS host's JavaScript context, exactly where the core calls it.

import * as wasm from "@zuna/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCrypto } from "../../../packages/core/test/helpers";
import { HostApp } from "../src/host";

let host: HostApp;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const utf8 = (text: string) => new TextEncoder().encode(text);
const pattern = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 255);

/** Bytes as a JavaScript expression in the host. */
const bytes = (value: Uint8Array) => `__l1.bytes(${JSON.stringify(b64(value))})`;

function decode(value: unknown): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if ("$b" in value) return new Uint8Array(Buffer.from((value as { $b: string }).$b, "base64"));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

/** Evaluates an expression in the host and returns its value, with bytes as Uint8Array. Throws what the host threw. */
async function native<T = any>(expression: string): Promise<T> {
  const raw = await host.evaluate(`__l1.run(() => (${expression}))`);
  const result = JSON.parse(raw) as { value?: unknown; error?: string };
  if (result.error !== undefined) throw new Error(result.error);
  return decode(result.value);
}

/** The same value through the WebAssembly build, in the same shape, for comparing with the host's. */
const plain = (value: unknown) => decode(JSON.parse(JSON.stringify(value, (_, item) => (item instanceof Uint8Array ? { $b: b64(item) } : item))));

beforeAll(async () => {
  loadCrypto();
  host = await new HostApp("crypto").open();
  const setup = await host.evaluate(`
    globalThis.__l1 = {
      bytes: (text) => __zunaHost.base64Decode(text),
      wire(value) {
        if (value instanceof Uint8Array) return { $b: __zunaHost.base64Encode(value) };
        if (Array.isArray(value)) return value.map((item) => __l1.wire(item));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, __l1.wire(item)]));
        return value === undefined ? null : value;
      },
      run(body) {
        try {
          return JSON.stringify({ value: __l1.wire(body()) });
        } catch (error) {
          return JSON.stringify({ error: String(error && error.message || error) });
        }
      },
      clients: {},
    };
    "ok"`);
  expect(setup).toBe("ok");
});

afterAll(async () => {
  await host?.close();
});

describe("primitives", () => {
  it("derive the same keys and digests", async () => {
    const password = utf8("correct horse battery staple");
    const salt = pattern(16, 3);
    expect(await native(`__zunaCrypto.argon2id(${bytes(password)}, ${bytes(salt)}, 1024, 2, 1, 32)`)).toEqual(wasm.argon2id(password, salt, 1024, 2, 1, 32));

    const ikm = pattern(32, 7);
    const info = utf8("zuna/test/v1");
    expect(await native(`__zunaCrypto.hkdfSha256(${bytes(ikm)}, ${bytes(salt)}, ${bytes(info)}, 64)`)).toEqual(wasm.hkdfSha256(ikm, salt, info, 64));
    // An empty salt and the longest output HKDF-SHA-256 allows.
    expect(await native(`__zunaCrypto.hkdfSha256(${bytes(ikm)}, new Uint8Array(0), ${bytes(info)}, 8160)`)).toEqual(
      wasm.hkdfSha256(ikm, new Uint8Array(0), info, 8160),
    );

    for (const data of [new Uint8Array(0), pattern(1, 1), pattern(100_000, 9)]) {
      expect(await native(`__zunaCrypto.sha256(${bytes(data)})`)).toEqual(wasm.sha256(data));
    }

    const keyA = pattern(32, 11);
    const keyB = pattern(32, 12);
    const digest = wasm.safetyDigest(keyA, keyB);
    expect(await native(`__zunaCrypto.safetyDigest(${bytes(keyA)}, ${bytes(keyB)})`)).toEqual(digest);
    expect(await native(`__zunaCrypto.safetyDigest(${bytes(keyB)}, ${bytes(keyA)})`)).toEqual(wasm.safetyDigest(keyB, keyA));
  });

  it("open each other's sealed data and refuse tampered data", async () => {
    const key = pattern(32, 21);
    const aad = utf8("message:42");
    const message = pattern(5000, 22);

    const fromWasm = wasm.aeadSeal(key, message, aad);
    expect(await native(`__zunaCrypto.aeadOpen(${bytes(key)}, ${bytes(fromWasm)}, ${bytes(aad)})`)).toEqual(message);
    const fromNative = await native<Uint8Array>(`__zunaCrypto.aeadSeal(${bytes(key)}, ${bytes(message)}, ${bytes(aad)})`);
    expect(wasm.aeadOpen(key, fromNative, aad)).toEqual(message);
    expect(fromNative).not.toEqual(fromWasm);

    const tampered = fromWasm.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(native(`__zunaCrypto.aeadOpen(${bytes(key)}, ${bytes(tampered)}, ${bytes(aad)})`)).rejects.toThrow();
    await expect(native(`__zunaCrypto.aeadOpen(${bytes(key)}, ${bytes(fromWasm)}, ${bytes(utf8("message:43"))})`)).rejects.toThrow();
    // An empty message seals and opens too.
    expect(await native(`__zunaCrypto.aeadOpen(${bytes(key)}, ${bytes(wasm.aeadSeal(key, new Uint8Array(0), aad))}, ${bytes(aad)})`)).toEqual(new Uint8Array(0));
  });

  it("stream files in chunks either way", async () => {
    const key = pattern(32, 31);
    const prefix = pattern(15, 32);
    const chunks = [pattern(65_536, 1), pattern(65_536, 2), pattern(1000, 3)];
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const sealed = wasm.streamSeal(key, prefix, index, last, chunk);
      expect(await native(`__zunaCrypto.streamOpen(${bytes(key)}, ${bytes(prefix)}, ${index}, ${last}, ${bytes(sealed)})`)).toEqual(chunk);
      const back = await native<Uint8Array>(`__zunaCrypto.streamSeal(${bytes(key)}, ${bytes(prefix)}, ${index}, ${last}, ${bytes(chunk)})`);
      expect(wasm.streamOpen(key, prefix, index, last, back)).toEqual(chunk);
    }
    // A chunk can't move, and the last one can't pass for a middle one.
    const sealed = wasm.streamSeal(key, prefix, 2, true, chunks[2]!);
    await expect(native(`__zunaCrypto.streamOpen(${bytes(key)}, ${bytes(prefix)}, 1, true, ${bytes(sealed)})`)).rejects.toThrow();
    await expect(native(`__zunaCrypto.streamOpen(${bytes(key)}, ${bytes(prefix)}, 2, false, ${bytes(sealed)})`)).rejects.toThrow();
    await expect(native(`__zunaCrypto.streamSeal(${bytes(key)}, new Uint8Array(19), 0, true, new Uint8Array(1))`)).rejects.toThrow("15 bytes");
  });

  it("verify each other's signatures", async () => {
    const message = utf8("device list v7");
    const wasmKeys = wasm.signingKeygen();
    const signature = wasm.sign(wasmKeys.secretKey, message);
    expect(await native(`__zunaCrypto.verify(${bytes(wasmKeys.publicKey)}, ${bytes(message)}, ${bytes(signature)})`)).toBe(true);
    expect(await native(`__zunaCrypto.verify(${bytes(wasmKeys.publicKey)}, ${bytes(utf8("device list v8"))}, ${bytes(signature)})`)).toBe(false);

    const nativeKeys = await native<{ publicKey: Uint8Array; secretKey: Uint8Array }>(`__zunaCrypto.signingKeygen()`);
    expect(Object.keys(nativeKeys).sort()).toEqual(["publicKey", "secretKey"]);
    expect(nativeKeys.publicKey.length).toBe(wasmKeys.publicKey.length);
    expect(nativeKeys.secretKey.length).toBe(wasmKeys.secretKey.length);
    const nativeSignature = await native<Uint8Array>(`__zunaCrypto.sign(${bytes(nativeKeys.secretKey)}, ${bytes(message)})`);
    expect(wasm.verify(nativeKeys.publicKey, message, nativeSignature)).toBe(true);
    // Ed25519 signatures are deterministic.
    expect(nativeSignature).toEqual(wasm.sign(nativeKeys.secretKey, message));
  });

  it("seal to each other's HPKE keys", async () => {
    const info = utf8("zuna/vault/v1");
    const aad = pattern(8, 41);
    const message = pattern(300, 42);

    const nativeKeys = await native<{ publicKey: Uint8Array; secretKey: Uint8Array }>(`__zunaCrypto.hpkeKeygen()`);
    const toNative = wasm.hpkeSeal(nativeKeys.publicKey, info, aad, message);
    expect(await native(`__zunaCrypto.hpkeOpen(${bytes(nativeKeys.secretKey)}, ${bytes(info)}, ${bytes(aad)}, ${bytes(toNative)})`)).toEqual(message);

    const wasmKeys = wasm.hpkeKeygen();
    const toWasm = await native<Uint8Array>(`__zunaCrypto.hpkeSeal(${bytes(wasmKeys.publicKey)}, ${bytes(info)}, ${bytes(aad)}, ${bytes(message)})`);
    expect(wasm.hpkeOpen(wasmKeys.secretKey, info, aad, toWasm)).toEqual(message);
    await expect(native(`__zunaCrypto.hpkeOpen(${bytes(nativeKeys.secretKey)}, ${bytes(utf8("other"))}, ${bytes(aad)}, ${bytes(toNative)})`)).rejects.toThrow();
  });

  it("report bad input as errors, not crashes", async () => {
    await expect(native(`__zunaCrypto.aeadSeal(new Uint8Array(3), ${bytes(utf8("x"))}, new Uint8Array(0))`)).rejects.toThrow();
    expect(() => wasm.aeadSeal(new Uint8Array(3), utf8("x"), new Uint8Array(0))).toThrow();
    expect(await native(`__zunaCrypto.verify(new Uint8Array(5), new Uint8Array(0), new Uint8Array(64))`)).toBe(false);
  });
});

describe("MLS between a desktop and a phone", () => {
  const groupId = pattern(16, 51);
  const label = "zuna/test";
  const context = utf8("context");
  let desktop: wasm.MlsClient;
  /** The phone's MLS state as the core would persist it, rebuilt from every takeChanges. */
  const phoneState = new Map<string, [Uint8Array, Uint8Array]>();
  let phoneKeys: { publicKey: Uint8Array; secretKey: Uint8Array };

  const phone = (method: string, ...args: string[]) => native(`__zunaCrypto.mls(__l1.clients.phone, ${JSON.stringify(method)}${args.map((arg) => `, ${arg}`).join("")})`);

  async function persistPhone() {
    const changes = await phone("takeChanges");
    expect(Object.keys(changes).sort()).toEqual(["deleted", "set"]);
    for (const [key, value] of changes.set as [Uint8Array, Uint8Array][]) phoneState.set(b64(key), [key, value]);
    for (const key of changes.deleted as Uint8Array[]) phoneState.delete(b64(key));
  }

  async function expectSameSecret() {
    const fromDesktop = desktop.exportSecret(groupId, label, context, 32);
    expect(await phone("exportSecret", bytes(groupId), JSON.stringify(label), bytes(context), "32")).toEqual(fromDesktop);
  }

  beforeAll(async () => {
    const desktopKeys = wasm.signingKeygen();
    desktop = new wasm.MlsClient(desktopKeys.publicKey, desktopKeys.secretKey, utf8("alice"), []);
    phoneKeys = await native(`__zunaCrypto.signingKeygen()`);
    await native(`__l1.clients.phone = __zunaCrypto.mlsNew(${bytes(phoneKeys.publicKey)}, ${bytes(phoneKeys.secretKey)}, ${bytes(utf8("bob"))}, [])`);
  });

  it("joins a group the desktop created, from its Welcome", async () => {
    const keyPackage = await phone("generateKeyPackage", "false");
    await persistPhone();
    expect(desktop.keyPackageCredential(keyPackage)).toEqual(utf8("bob"));
    expect(await phone("keyPackageCredential", bytes(keyPackage))).toEqual(utf8("bob"));

    expect(desktop.createGroup(groupId)).toBe(0);
    const pending = desktop.commitChanges(groupId, [keyPackage], new Uint32Array(0)) as { commit: Uint8Array; welcome: Uint8Array | null; groupInfo: Uint8Array | null };
    expect(pending.welcome).toBeInstanceOf(Uint8Array);
    expect(desktop.mergePending(groupId)).toBe(1);

    const joined = await phone("joinFromWelcome", bytes(pending.welcome!));
    await persistPhone();
    expect(joined).toEqual({ groupId, epoch: 1 });
    expect(await phone("hasGroup", bytes(groupId))).toBe(true);
    expect(await phone("epoch", bytes(groupId))).toBe(1);
    expect(await phone("ownLeafIndex", bytes(groupId))).toBe(1);
    expect(await phone("members", bytes(groupId))).toEqual(plain(desktop.members(groupId)));
    await expectSameSecret();
  });

  it("commits from the phone, which the desktop processes", async () => {
    // An update with nothing to add or remove: no Welcome, as null like the WebAssembly build.
    const pending = await phone("commitChanges", bytes(groupId), "[]", "new Uint32Array(0)");
    expect(Object.keys(pending).sort()).toEqual(["commit", "groupInfo", "welcome"]);
    expect(pending.welcome).toBeNull();
    expect(await phone("hasPending", bytes(groupId))).toBe(true);
    const nextSecret = await phone("exportPendingSecret", bytes(groupId), JSON.stringify(label), bytes(context), "32");

    const processed = desktop.processCommit(groupId, pending.commit) as Record<string, unknown>;
    expect(processed).toMatchObject({ epoch: 2, senderCredential: utf8("bob"), isExternal: false, selfRemoved: false });
    expect(await phone("mergePending", bytes(groupId))).toBe(2);
    await persistPhone();
    expect(desktop.exportSecret(groupId, label, context, 32)).toEqual(nextSecret);
    await expectSameSecret();
  });

  it("adds a third device from the phone, and keeps the epoch in step", async () => {
    const carolKeys = wasm.signingKeygen();
    const carol = new wasm.MlsClient(carolKeys.publicKey, carolKeys.secretKey, utf8("carol"), []);
    const keyPackage = carol.generateKeyPackage(false);
    const pending = await phone("commitChanges", bytes(groupId), `[${bytes(keyPackage)}]`, "new Uint32Array(0)");
    expect(pending.welcome).toBeInstanceOf(Uint8Array);
    expect(pending.groupInfo).toBeInstanceOf(Uint8Array);
    expect(await phone("mergePending", bytes(groupId))).toBe(3);
    await persistPhone();

    const processed = desktop.processCommit(groupId, pending.commit) as { addedCredentials: Uint8Array[] };
    expect(processed.addedCredentials).toEqual([utf8("carol")]);
    expect((carol.joinFromWelcome(pending.welcome!) as { epoch: number }).epoch).toBe(3);
    expect(carol.exportSecret(groupId, label, context, 32)).toEqual(desktop.exportSecret(groupId, label, context, 32));
    await expectSameSecret();

    // The group info lets another device join on its own, and the phone follows.
    const daveKeys = wasm.signingKeygen();
    const dave = new wasm.MlsClient(daveKeys.publicKey, daveKeys.secretKey, utf8("dave"), []);
    const external = dave.joinExternal(groupId, await phone("exportGroupInfo", bytes(groupId))) as { commit: Uint8Array; epoch: number };
    expect(external.epoch).toBe(4);
    const seen = await phone("processCommit", bytes(groupId), bytes(external.commit));
    expect(seen).toMatchObject({ epoch: 4, senderCredential: utf8("dave"), isExternal: true, selfRemoved: false });
    desktop.processCommit(groupId, external.commit);
    await persistPhone();
    await expectSameSecret();
  });

  it("restores the phone's state from what it persisted", async () => {
    const state = [...phoneState.values()].map(([key, value]) => `[${bytes(key)}, ${bytes(value)}]`).join(", ");
    await native(`__l1.clients.restored = __zunaCrypto.mlsNew(${bytes(phoneKeys.publicKey)}, ${bytes(phoneKeys.secretKey)}, ${bytes(utf8("bob"))}, [${state}])`);
    await native(`__zunaCrypto.mlsFree(__l1.clients.phone)`);
    await native(`__l1.clients.phone = __l1.clients.restored`);
    expect(await phone("epoch", bytes(groupId))).toBe(4);
    await expectSameSecret();
  });

  it("learns that the desktop removed it", async () => {
    const pending = desktop.commitChanges(groupId, [], new Uint32Array([1])) as { commit: Uint8Array };
    desktop.mergePending(groupId);
    const processed = await phone("processCommit", bytes(groupId), bytes(pending.commit));
    expect(processed).toMatchObject({ epoch: 5, selfRemoved: true, removedCredentials: [utf8("bob")] });
    await phone("deleteGroup", bytes(groupId));
    expect(await phone("hasGroup", bytes(groupId))).toBe(false);
    // Calls on a group the phone doesn't have throw, as in the WebAssembly build.
    await expect(phone("epoch", bytes(groupId))).rejects.toThrow();
    expect(() => desktop.epoch(pattern(16, 99))).toThrow();
  });
});
