// Link previews on the phone. The host fetches pages natively, without
// cookies (WebBridge.swift), and shrinks pictures with ImageIO.

import type { WebAdapter } from "@zuna/core";

const g = globalThis as any;
const pending = new Map<number, { resolve: (page: { url: string; type: string; body: Uint8Array }) => void; reject: (error: Error) => void }>();
let nextFetch = 1;

g.__zunaWebDone = (id: number, url: string, type: string, body: Uint8Array | null, error: string | null) => {
  const fetch = pending.get(id);
  if (!fetch) return;
  pending.delete(id);
  if (error || !body) fetch.reject(new Error(error ?? "The page isn't available."));
  else fetch.resolve({ url, type, body });
};

export const nativeWeb: WebAdapter = {
  fetch: (url, maxBytes) =>
    new Promise((resolve, reject) => {
      const id = nextFetch++;
      pending.set(id, { resolve, reject });
      __zunaHost.webFetch(id, url, maxBytes);
    }),
  shrinkImage: async (body, maxSize) => __zunaHost.imageShrink(body, maxSize),
};
