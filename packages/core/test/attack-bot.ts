// For apps/desktop-electron-legacy/test/attack-check.mjs: an account that sends what a modified
// client could, to see that the real app shrugs it off.
//
//   npx vite-node packages/core/test/attack-bot.ts <invite-link> <tracker-address>

import { sealEnvelope } from "../src/crypto";
import { TestApp, loadCrypto, waitFor } from "./helpers";

const [invite, tracker] = process.argv.slice(2) as [string, string];

loadCrypto();
const mallory = await new TestApp("mallory").open();
const preview = await mallory.client.previewInvite(invite);
const result = await mallory.client.register(preview, "mallory", "attack-check-only-password", { displayName: "Mallory" });
mallory.serverId = result.serverId;
await mallory.online();
await waitFor(() => mallory.session.getUsers().some((user) => user.role === "owner"), "the owner to appear");
const owner = mallory.session.getUsers().find((user) => user.role === "owner")!;
const key = `user:${owner.id}`;

mallory.session.sendMessage(key, { text: "hello from mallory" });
await waitFor(() => mallory.texts(key).includes("hello from mallory"), "the first message");
const groupId = mallory.session.getConversations().find((item) => item.key === key)!.groupId!;

const attachment = { fileId: "a".repeat(32), key: "", prefix: "", chunks: 1, name: "photo.png", mime: "image/png", size: 1, width: 10, height: 10 };
const bodies: unknown[] = [
  // Makes the conversation list's preview trip, and it's what's newest.
  { attachments: [{ fileId: "a".repeat(32) }] },
  // Makes the app contact someone's server, showing who read this and when.
  { text: "look at this", attachments: [{ ...attachment, thumb: `${tracker}/pixel.png?who=victim` }] },
  // Runs out of stack, or takes for ever.
  { text: "**a** ".repeat(16_000) },
  { text: `${"||".repeat(5000)}` },
  // Isn't text at all.
  { text: 12345 },
];

const session = mallory.session as any;
// Each says who it's from, as a modified client's would, or it wouldn't be shown at all.
const by = { user: session.account.userId, device: session.account.deviceId };
for (const [index, body] of bodies.entries()) {
  const id = String(index).padStart(32, "b");
  await session.withLock(groupId, () =>
    session.sealAndRetry(groupId, async (epoch: number, epochKey: Uint8Array) => {
      const envelope = sealEnvelope(epochKey, session.account.deviceSecret, "message", groupId, id, epoch, { ...(body as object), by }, { userId: by.user, deviceId: by.device });
      await session.api.sendMessage(groupId, { id, epoch, envelope });
    }),
  );
}
console.log("Attacks sent");
setInterval(() => undefined, 60_000);
