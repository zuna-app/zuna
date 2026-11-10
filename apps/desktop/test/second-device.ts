// Another device of someone already on the test server, for apps/desktop/test/mac-voice-check.mjs:
// a real client in Node that signs in with their password. It has no media of its own, so it's
// in a voice channel only as far as the server can tell, which is what the app goes by. A line
// of JSON on its standard input, {"voice": "<channel ID>"}, says it's in that voice channel,
// and {"voice": null} that it left; on its standard output, {"ended": "<reason>"} says the
// server took it out.
//
//   cd packages/core && npx vite-node ../../apps/desktop/test/second-device.ts <server address> <username> <password>

import { createInterface } from "node:readline";
import { TestApp, loadCrypto, sleep } from "../../../packages/core/test/helpers";

const say = (value: unknown) => console.log(JSON.stringify(value));

loadCrypto();
const [address, username, password] = process.argv.slice(2);
if (!address || !username || !password) throw new Error("Give the second device a server's address, a username and a password.");
const app = await new TestApp("second device").open();
await app.login(address, username, password);

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line) as { voice?: string | null };
  if (command.voice !== undefined) app.session.setVoiceState(command.voice, command.voice ? { muted: false, deafened: false, camera: false, screen: false } : null);
});
say({ ready: true, deviceId: app.session.getSelf().deviceId });

let seen = 0;
for (;;) {
  for (const event of app.events.slice(seen)) {
    if (event.type === "voice_ended") say({ ended: event.reason });
  }
  seen = app.events.length;
  await sleep(200);
}
