// The log of keys' pieces as the server and invite links give them, each held to what it can be.

import { beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KEY, DEVICE_PUBLIC_BYTES, HPKE_PUBLIC_BYTES, LASTING_KEY, LASTING_PUBLIC_BYTES, LASTING_SIGNATURE_BYTES } from "../src/crypto";
import { toBase64, toBase64Url, utf8 } from "../src/encoding";
import { Frontier, HASH_BYTES, RECORD_BYTES, emptyRoot, fromWireHead, linkHead, parseBody, parseLinkHead, readRecord, toWireHead } from "../src/transparency";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

const USER = "0123456789abcdef0123456789abcdef";
const DEVICE = "fedcba9876543210fedcba9876543210";
const bytes = (length: number, first = 7) => {
  const out = new Uint8Array(length).fill(9);
  out[0] = first;
  return out;
};
const b64 = (length: number, first = 7) => toBase64(bytes(length, first));
const body = (fields: Record<string, unknown>) => parseBody(utf8(JSON.stringify({ v: 1, user: USER, ...fields })));

describe("an entry's body", () => {
  const account = { t: "account", username: "ann", root: b64(LASTING_PUBLIC_BYTES, LASTING_KEY), hpke: b64(HPKE_PUBLIC_BYTES), hpke_sig: b64(LASTING_SIGNATURE_BYTES) };
  const device = { t: "device", device: DEVICE, key: b64(DEVICE_PUBLIC_BYTES, DEVICE_KEY), cert: b64(HASH_BYTES), enroll: b64(HASH_BYTES), seal: b64(HASH_BYTES) };

  it("reads each kind there is", () => {
    expect(body(account)).toMatchObject({ t: "account", user: USER, username: "ann" });
    expect(body(device)).toMatchObject({ t: "device", device: DEVICE });
    expect(body({ t: "certificate", device: DEVICE, cert: b64(HASH_BYTES) })).toMatchObject({ t: "certificate" });
    expect(body({ t: "seal", device: DEVICE, gen: 0, seal: b64(HASH_BYTES) })).toMatchObject({ t: "seal", gen: 0 });
    expect(body({ t: "revoked", device: DEVICE })).toEqual({ t: "revoked", user: USER, device: DEVICE });
    expect(body({ t: "link", gen: 1, link: b64(HASH_BYTES) })).toMatchObject({ t: "link", gen: 1 });
    expect(body({ t: "deleted" })).toEqual({ t: "deleted", user: USER });
  });

  it("refuses anything that isn't one of them as it should be", () => {
    for (const raw of [utf8("not json"), utf8("null"), utf8(JSON.stringify({ v: 2, user: USER, t: "deleted" })), utf8(JSON.stringify({ v: 1, user: "short", t: "deleted" }))]) {
      expect(parseBody(raw)).toBeNull();
    }
    for (const fields of [
      { t: "unknown" },
      { ...account, username: 5 },
      { ...account, username: "x".repeat(65) },
      { ...account, root: b64(LASTING_PUBLIC_BYTES, DEVICE_KEY) },
      { ...account, root: 5 },
      { ...account, hpke: "not base64!" },
      { ...account, hpke_sig: b64(10) },
      { ...device, key: b64(DEVICE_PUBLIC_BYTES, LASTING_KEY) },
      { ...device, device: "short" },
      { ...device, cert: b64(10) },
      { t: "certificate", device: DEVICE },
      { t: "seal", device: DEVICE, gen: -1, seal: b64(HASH_BYTES) },
      { t: "seal", device: DEVICE, gen: 1.5, seal: b64(HASH_BYTES) },
      { t: "seal", gen: 0, seal: b64(HASH_BYTES) },
      { t: "revoked" },
      { t: "link", gen: 0, link: b64(HASH_BYTES) },
      { t: "link", gen: 1 },
    ]) {
      expect(body(fields), JSON.stringify(fields).slice(0, 60)).toBeNull();
    }
  });
});

describe("the rest of the log's pieces", () => {
  it("reads a frontier only if its roots are as many as its size has bits, of a hash each", () => {
    const one = toBase64(bytes(HASH_BYTES));
    expect(Frontier.from({ size: 3, roots: [one, one] })?.clone().size).toBe(3);
    for (const value of [{ size: -1, roots: [] }, { size: 1.5, roots: [] }, { size: 3, roots: [one] }, { size: 1, roots: [toBase64(bytes(5))] }, { size: 1, roots: "x" }, null]) {
      expect(Frontier.from(value as never)).toBeNull();
    }
  });

  it("reads a record only of the right length", () => {
    expect(readRecord(new Uint8Array(RECORD_BYTES))).not.toBeNull();
    expect(readRecord(new Uint8Array(RECORD_BYTES - 1))).toBeNull();
  });

  it("reads a head as the server sends it, and writes one", () => {
    const head = { era: 1, size: 2, root: bytes(HASH_BYTES), sig: bytes(LASTING_SIGNATURE_BYTES) };
    expect(fromWireHead(toWireHead(head))).toEqual(head);
    expect(toWireHead({ era: 1, size: 0, root: emptyRoot() }).s).toBe("");
    const wire = toWireHead(head);
    for (const value of [null, "head", { ...wire, e: 0 }, { ...wire, n: -1 }, { ...wire, e: 1.5 }, { ...wire, r: 5 }, { ...wire, s: 5 }, { ...wire, r: toBase64(bytes(5)) }, { ...wire, s: "not base64!" }]) {
      expect(fromWireHead(value)).toBeNull();
    }
  });

  it("reads the head an invite link carries", () => {
    const pinned = { keyHash: bytes(32), era: 3, size: 10, root: bytes(HASH_BYTES) };
    expect(parseLinkHead(linkHead(pinned))).toEqual(pinned);
    expect(parseLinkHead(null)).toBeNull();
    expect(parseLinkHead("")).toBeNull();
    expect(parseLinkHead("!!not base64url!!")).toBeNull();
    expect(parseLinkHead(toBase64Url(bytes(10)))).toBeNull();
    expect(parseLinkHead(linkHead({ ...pinned, era: 0 }))).toBeNull();
  });
});
