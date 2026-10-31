// The control channel's JSON encoding, matching apps/ios/core-bundle/src/wire.ts:
// bytes and blobs travel as tagged base64.

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return { $bytes: Buffer.from(item).toString("base64") };
    return item;
  });
}

export function decodeWire(json: string): any {
  return JSON.parse(json, (_key, item) => {
    if (item && typeof item === "object") {
      if (typeof item.$bytes === "string") return new Uint8Array(Buffer.from(item.$bytes, "base64"));
      if (item.$blob && typeof item.$blob.bytes === "string") {
        return new Blob([Buffer.from(item.$blob.bytes, "base64")], { type: item.$blob.type ?? "" });
      }
    }
    return item;
  });
}

/** Blobs can't go through JSON.stringify's replacer synchronously, so callers turn them into this first. */
export async function wireBlob(blob: Blob): Promise<{ $blob: { bytes: string; type: string } }> {
  return { $blob: { bytes: Buffer.from(await blob.arrayBuffer()).toString("base64"), type: blob.type } };
}
