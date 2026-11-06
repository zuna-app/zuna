// The core's worker on the desktop. A worker can't read other sites, so pages for
// link previews come through the main process (zuna-web:).

import { serveCoreWorker } from "@zuna/ui/worker";

serveCoreWorker(async (url, maxBytes) => {
  const response = await fetch(`zuna-web://fetch/?url=${encodeURIComponent(url)}&max=${maxBytes}`);
  if (!response.ok) throw new Error("The page isn't available.");
  return {
    url: response.headers.get("x-zuna-url") ?? url,
    type: response.headers.get("content-type") ?? "",
    body: new Uint8Array(await response.arrayBuffer()),
  };
});
