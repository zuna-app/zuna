// A stand-in for 7TV, so emote tests run without the internet. The test server
// is pointed at it with ZUNA_7TV_API and ZUNA_7TV_CDN, and serves its "global"
// set: a static emote, an animated one and a zero-width one.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { root } from "./paths";

export const FAKE_SET_NAME = "Zuna test emotes";

export const FAKE_EMOTES = [
  { id: "01ZUNATESTSTATIC000000001", name: "zunaHappy", animated: false, zeroWidth: false, file: "static" },
  { id: "01ZUNATESTANIMATED0000001", name: "zunaDance", animated: true, zeroWidth: false, file: "animated" },
  { id: "01ZUNATESTZEROWIDTH000001", name: "zunaRing", animated: false, zeroWidth: true, file: "zero-width" },
] as const;

const fixtures = join(root, "tests", "e2e", "fixtures", "emotes");

export const emoteFixture = (file: string, scale: number) => readFileSync(join(fixtures, `${file}-${scale}x.webp`));

export interface Fake7TV {
  api: string;
  cdn: string;
  close(): Promise<void>;
}

export async function startFake7TV(): Promise<Fake7TV> {
  const set = {
    id: "global",
    name: FAKE_SET_NAME,
    emotes: FAKE_EMOTES.map((emote) => ({
      id: emote.id,
      name: emote.name,
      // Bit 0 on the set entry marks a zero-width emote, as on 7TV.
      flags: emote.zeroWidth ? 1 : 0,
      data: {
        animated: emote.animated,
        flags: 0,
        owner: { username: "zuna", display_name: "Zuna" },
        host: { files: [1, 2, 3, 4].map((scale) => ({ name: `${scale}x.webp`, width: 28 * scale, height: 28 * scale })) },
      },
    })),
  };

  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (/^\/v3\/emote-sets\/[^/]+$/.test(url)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(set));
      return;
    }
    const file = url.match(/^\/cdn\/emote\/([^/]+)\/([1-4])x\.webp$/);
    const emote = file && FAKE_EMOTES.find((item) => item.id === file[1]);
    if (emote) {
      response.writeHead(200, { "content-type": "image/webp" });
      response.end(emoteFixture(emote.file, Number(file![2])));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    api: `http://127.0.0.1:${port}/v3`,
    cdn: `http://127.0.0.1:${port}/cdn`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
