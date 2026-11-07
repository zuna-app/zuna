// The other person in apps/desktop/test/linux-check.mjs: a real client in Node that joins the
// test server with the invite it's given, says on its standard output, a line of JSON at a
// time, what reaches it from the app, and answers each message with "Echo: " and its text, so
// the check can tell what the app sent and look for the answer in the app. A line of JSON on
// its standard input, {"send": "text"}, sends that to the app, and {"sendFile": {...}} a file,
// a voice or video message too, with what sendWithAttachments takes and the file's path, and
// {"avatar": "path"} makes a PNG its profile picture, {"quiet": true} stops the answers until
// {"quiet": false}, and {"read": true} reads the chat to its newest message.
//
//   cd packages/core && npx vite-node ../../apps/desktop/test/peer.ts <invite>

import { readFileSync } from "node:fs";
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
let quiet = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line) as { send?: string; sendFile?: { path: string; name: string; mime: string; duration?: number; width?: number; height?: number; voice?: boolean; round?: boolean }; avatar?: string; quiet?: boolean; read?: boolean };
  if (command.send) {
    sent.add(command.send);
    app.session.sendMessage(key, { text: command.send });
  }
  if (command.sendFile) {
    const { path, ...file } = command.sendFile;
    void app.session.sendWithAttachments(key, [{ blob: new Blob([readFileSync(path)], { type: file.mime }), ...file }], {}).then(() => say({ sentFile: file.name }));
  }
  if (command.avatar) {
    void app.session.updateProfile({}, new Blob([readFileSync(command.avatar)], { type: "image/png" })).then(() => say({ avatarSet: true }));
  }
  if (command.quiet !== undefined) quiet = command.quiet;
  if (command.read) void app.session.markChatRead(key).then(() => say({ read: true }));
});
say({ ready: true, userId: app.userId });

let seen = 0;
for (;;) {
  const texts = app.texts(key);
  for (const text of texts.slice(seen)) {
    if (text.startsWith("Echo: ") || text.startsWith("<") || sent.has(text)) continue;
    say({ received: text });
    if (!quiet) app.session.sendMessage(key, { text: `Echo: ${text}` });
  }
  seen = texts.length;
  await sleep(200);
}
