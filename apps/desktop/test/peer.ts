// The other person in apps/desktop/test/linux-check.mjs: a real client in Node that joins the
// test server with the invite it's given, says on its standard output, a line of JSON at a
// time, what reaches it from the app, and answers each message with "Echo: " and its text, so
// the check can tell what the app sent and look for the answer in the app. A line of JSON on
// its standard input, {"send": "text"}, sends that to the app.
//
//   cd packages/core && npx vite-node ../../apps/desktop/test/peer.ts <invite>

import { createInterface } from "node:readline";
import { TestApp, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";

const say = (value: unknown) => console.log(JSON.stringify(value));

loadCrypto();
const invite = process.argv[2];
if (!invite) throw new Error("Give the peer an invite link.");
const app = await new TestApp("casey").open();
const preview = await app.client.previewInvite(invite);
const result = await app.client.register(preview, "casey", "linux-check-peer-password", { displayName: "Casey Park", bio: "The Linux check's other person." });
app.serverId = result.serverId;
await app.online();
const owner = () => app.session.getUsers().find((user) => user.role === "owner");
await waitFor(() => !!owner(), "the owner to appear");
const key = `user:${owner()!.id}`;

const sent = new Set<string>();
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line) as { send?: string };
  if (command.send) {
    sent.add(command.send);
    app.session.sendMessage(key, { text: command.send });
  }
});
say({ ready: true, userId: app.userId });

let seen = 0;
for (;;) {
  const texts = app.texts(key);
  for (const text of texts.slice(seen)) {
    if (text.startsWith("Echo: ") || text.startsWith("<") || sent.has(text)) continue;
    say({ received: text });
    app.session.sendMessage(key, { text: `Echo: ${text}` });
  }
  seen = texts.length;
  await sleep(200);
}
