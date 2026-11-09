// RPC messages cross into Swift (and over the test control channel) as JSON.
// Bytes and blobs, which JSON can't hold, travel as tagged base64; files on
// disk travel as tagged paths. An argument left out in the middle of a call
// travels as {"$undefined": true}, since JSON's null can mean something else
// (in updateGroupMeta, null removes the picture).

import { NativeFile } from "./files";
import { BlobPolyfill } from "./polyfills";

/** Uint8Array's own base64, or the host's where the engine has none (polyfills.ts). */
const base64 = (bytes: Uint8Array): string => (bytes as unknown as { toBase64(): string }).toBase64();

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    // Nearly everything is a string, a number or a plain object, so those go through
    // before the instanceof tests.
    if (typeof item !== "object" || item === null) return item;
    if (item instanceof Uint8Array) return { $bytes: base64(item) };
    if (item instanceof BlobPolyfill) return { $blob: { bytes: base64(item.raw), type: item.type } };
    if (item instanceof NativeFile) return { $file: { path: item.path, type: item.type } };
    if (item instanceof Error) return { name: item.name, message: item.message };
    return item;
  });
}

export function decodeWire(json: string): any {
  return JSON.parse(json, (_key, item) => {
    if (item && typeof item === "object") {
      if (item.$undefined === true) return undefined;
      if (typeof item.$bytes === "string") return __zunaHost.base64Decode(item.$bytes);
      if (item.$file && typeof item.$file.path === "string") return new NativeFile(item.$file.path, item.$file.type ?? "");
      if (item.$blob && typeof item.$blob.bytes === "string") {
        return new BlobPolyfill([__zunaHost.base64Decode(item.$blob.bytes)], { type: item.$blob.type ?? "" });
      }
    }
    return item;
  });
}
