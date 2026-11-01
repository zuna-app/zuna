// The core's worker in a browser. A page can't read other sites, so pages for link
// previews come through the host, zuna-web. A host with previews off starts this
// worker under another name (platform.ts).

import { serveCoreWorker } from "@zuna/ui/worker";

const previews = self.name === "zuna-core";

serveCoreWorker(
  previews
    ? async (url, maxBytes) => {
        const response = await fetch(`/_zuna/preview?url=${encodeURIComponent(url)}&max=${maxBytes}`, {
          // A page on another site can't send this without asking first, and zuna-web never says yes.
          headers: { "x-zuna-preview": "1" },
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("The page isn't available.");
        return {
          url: response.headers.get("x-zuna-url") ?? url,
          type: response.headers.get("content-type") ?? "",
          body: new Uint8Array(await response.arrayBuffer()),
        };
      }
    : undefined,
);
