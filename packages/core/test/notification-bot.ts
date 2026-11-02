// For apps/desktop/test/notification-check.mjs: someone to get notifications from, who
// does what they're told on standard input, one line of JSON at a time, and says what
// arrives. They're an ordinary client using the real protocol.
//
//   npx vite-node packages/core/test/notification-bot.ts <invite-link>

import { createInterface } from "node:readline";
import { TestApp, loadCrypto, png, waitFor } from "./helpers";

const [invite] = process.argv.slice(2) as [string];

loadCrypto();
const sam = await new TestApp("sam").open();
const preview = await sam.client.previewInvite(invite);
const result = await sam.client.register(preview, "samrivers", "notification-check-only-password", { displayName: "Sam Rivers" });
sam.serverId = result.serverId;
await sam.online();
await waitFor(() => sam.session.getUsers().some((user) => user.role === "owner"), "the owner to appear");
const owner = sam.session.getUsers().find((user) => user.role === "owner")!;
const key = `user:${owner.id}`;

// Says what came in, with what it answers, so the check can see a reply get here.
let seen = 0;
setInterval(() => {
  for (const event of sam.events.slice(seen)) {
    if (event.type === "message" && event.isNew && event.message.senderId === owner.id) {
      console.log(`Received ${JSON.stringify({ text: event.message.text, reply: event.message.reply?.id ?? null })}`);
    }
  }
  seen = sam.events.length;
}, 100);

const sent = new Map<string, string>();
let groupKey = "";

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { say?: string; sayInGroup?: string; delete?: string; group?: string };
  if (command.say) {
    const message = sam.session.sendMessage(key, { text: command.say });
    sent.set(command.say, message.id);
    console.log(`Said ${JSON.stringify({ text: command.say, id: message.id })}`);
  }
  if (command.group) {
    const picture = new Blob([new Uint8Array(png(256, 256, (x, y) => [40 + x / 2, 90, 60 + y / 2]))], { type: "image/png" });
    groupKey = `group:${await sam.session.createGroup(command.group, [owner.id], false, picture)}`;
    console.log("Grouped");
  }
  if (command.sayInGroup) {
    const message = sam.session.sendMessage(groupKey, { text: command.sayInGroup });
    console.log(`SaidInGroup ${JSON.stringify({ id: message.id })}`);
  }
  if (command.delete) {
    const groupId = sam.session.getConversations().find((item) => item.key === key)!.groupId!;
    await sam.session.deleteMessage(groupId, sent.get(command.delete)!);
    console.log(`Deleted ${JSON.stringify({ text: command.delete })}`);
  }
}
