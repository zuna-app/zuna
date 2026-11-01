// Development tool: people to talk to, with conversations already going. They're
// ordinary clients using the real protocol, and they stay online to reply.
//
// For one run on any server, keeping nothing afterwards:
//
//   npx vite-node packages/core/test/dev-bots.ts <invite-link>
//
// `npm run dev:server` sets ZUNA_DEV_WORLD to a folder instead. Its first run sets
// up the whole server, and later runs bring the same people back.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBase64 } from "../src/encoding";
import { TestApp, loadCrypto, png, sleep, waitFor } from "./helpers";

const CODE_SAMPLE = `Here's the retry logic:
\`\`\`rust
async fn fetch_with_retry(url: &str, attempts: u32) -> Result<String, Error> {
    for attempt in 0..attempts {
        match client.get(url).send().await {
            Ok(response) => return response.text().await,
            Err(_) if attempt + 1 < attempts => sleep(backoff(attempt)).await,
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}
\`\`\`
Should cover the **flaky** network case. See https://example.com/notes`;

/** A photo of the lake: sky, a hill and water, the hill where `ridge` puts it. */
function lakePhoto(name: string, ridge: number) {
  const scene = (width: number, height: number) =>
    png(width, height, (x, y) => {
      const u = x / width;
      const v = y / height;
      const hill = 0.5 - 0.12 * Math.sin(u * Math.PI * 2 + ridge);
      if (v < hill) return [Math.round(110 + 90 * v), Math.round(150 + 70 * v), 215];
      if (v < 0.62) return [52, Math.round(96 + 30 * u), 60];
      return [40, Math.round(84 + 40 * (v - 0.62)), Math.round(130 + 60 * (v - 0.62))];
    });
  return {
    blob: new Blob([new Uint8Array(scene(480, 360))], { type: "image/png" }),
    name,
    mime: "image/png",
    width: 480,
    height: 360,
    thumb: `data:image/png;base64,${toBase64(scene(32, 24))}`,
  };
}

const PEOPLE = [
  ["sam", "Sam Chen"],
  ["jordan", "Jordan Blake"],
  ["priya", "Priya Nair"],
  ["marek", "Marek Kowalski"],
  ["lena", "Lena Fischer"],
] as const;

const SERVER_NAME = "Zuna Test Server";
const OWNER = { username: "alex", displayName: "Alex Rivera", password: "dev-only-owner-password" };

async function joinBots(invite: string, world?: string): Promise<TestApp[]> {
  const bots: TestApp[] = [];
  for (const [username, displayName] of PEOPLE) {
    const app = await new TestApp(username, world && join(world, username)).open();
    const preview = await app.client.previewInvite(invite);
    const result = await app.client.register(preview, username, "dev-only-bot-password", { displayName, bio: "A friendly test bot." });
    app.serverId = result.serverId;
    await app.online();
    bots.push(app);
    console.log(`${displayName} is online`);
  }
  return bots;
}

async function startConversations(bots: TestApp[]): Promise<void> {
  const [sam, jordan, priya, marek] = bots as [TestApp, TestApp, TestApp, TestApp];

  const owner = () => sam.session.getUsers().find((user) => user.role === "owner")!;
  await waitFor(() => !!owner(), "the owner to appear");
  const ownerId = owner().id;
  const ownerKey = `user:${ownerId}`;

  const emote = (app: TestApp, text: string) => app.session.emotesIn(text);
  const words = sam.session.getEmotes().emotes.map((item) => item.name);
  const someEmotes = words.slice(0, 3).join(" ");

  sam.session.sendMessage(ownerKey, { text: "Hey! Did you get the server running?" });
  await sleep(150);
  sam.session.sendMessage(ownerKey, { text: "This is **way** nicer than I expected. Everything's encrypted, right?" });
  await sleep(150);
  if (someEmotes) sam.session.sendMessage(ownerKey, { text: someEmotes, emotes: emote(sam, someEmotes) });
  await sleep(150);
  jordan.session.sendMessage(ownerKey, { text: CODE_SAMPLE });
  await sleep(150);
  priya.session.sendMessage(ownerKey, { text: "Can you check `config.yaml` when you get a chance? ||It's the spoiler you were hoping for.||" });

  const groupId = await sam.session.createGroup("Weekend trip", [ownerId, jordan.userId, priya.userId, marek.userId], false);
  await waitFor(() => jordan.session.getConversations().some((item) => item.groupId === groupId), "jordan to join");
  await waitFor(() => priya.session.getConversations().some((item) => item.groupId === groupId), "priya to join");
  await waitFor(() => marek.session.getConversations().some((item) => item.groupId === groupId), "marek to join");
  const groupKey = `group:${groupId}`;
  const lines: [TestApp, string][] = [
    [sam, "Okay so who's bringing what?"],
    [jordan, "I can drive. Leaving around 9?"],
    [priya, "Works for me. I'll sort out the food."],
    [marek, "I'll bring the tent and the speaker 🎶"],
    [sam, "Perfect. Booking the campsite now."],
    [jordan, "> Booking the campsite now.\nThe one by the lake?"],
    [sam, "Yes! It has a nice view at sunrise."],
  ];
  let firstId = "";
  for (const [author, text] of lines) {
    const sent = author.session.sendMessage(groupKey, { text });
    firstId ||= sent.id;
    await sleep(120);
  }
  await waitFor(() => sam.texts(groupKey).length >= lines.length, "the group's messages");
  await sam.session.toggleReaction(groupId, firstId, "🔥");
  await jordan.session.toggleReaction(groupId, firstId, "🔥");
  await priya.session.toggleReaction(groupId, firstId, "😂");
  await sam.session.setPinned(groupId, firstId, true);
  jordan.session.sendMessage(groupKey, { text: "Love it. I'll bring coffee too", replyTo: firstId });
  await sleep(120);
  await sam.session.sendWithAttachments(groupKey, [lakePhoto("lake-morning.png", 0), lakePhoto("lake-evening.png", 2)], { text: "From last year 🏕️" });
  const list = new TextEncoder().encode("Tent\nSleeping bags\nCoffee\nSpeaker\n");
  await jordan.session.sendWithAttachments(groupKey, [{ blob: new Blob([list], { type: "text/plain" }), name: "packing-list.txt", mime: "text/plain" }], {});
  marek.session.sendMessage(groupKey, { text: "The forecast: https://example.com/weather/lake" });
}

/**
 * Sets up a new server the way its owner would. The owner's device here is only
 * for setup: signing in from the app adds a new device, which reads this history
 * through the keys stored in the owner's encrypted vault.
 */
async function createWorld(world: string): Promise<TestApp[]> {
  const setupLink = process.env.ZUNA_DEV_SETUP_LINK;
  if (!setupLink) throw new Error("The server didn't provide a setup link.");
  const owner = await new TestApp("Test server setup", join(world, "owner")).open();
  const preview = await owner.client.previewInvite(setupLink);
  const { serverId, recoveryKey } = await owner.client.register(preview, OWNER.username, OWNER.password, { displayName: OWNER.displayName });
  owner.serverId = serverId;
  await owner.online();
  await owner.session.updateServerSettings({ name: SERVER_NAME });
  const invite = await owner.session.createInvite(0, 0);
  // Without internet access the server simply has no emotes yet, and that's fine.
  await waitFor(() => owner.session.getEmotes().emotes.length > 0, "the emote set", 15_000).catch(() => undefined);

  const bots = await joinBots(invite, world);
  await startConversations(bots);

  const person = (username: string) => bots.find((bot) => bot.name === username)!;
  await waitFor(() => owner.texts(`user:${person("sam").userId}`).length >= 2, "the owner to receive Sam's messages");
  await waitFor(() => owner.texts(`user:${person("jordan").userId}`).length >= 1, "the owner to receive Jordan's message");
  await waitFor(() => owner.texts(`user:${person("priya").userId}`).length >= 1, "the owner to receive Priya's message");
  await waitFor(() => {
    const group = owner.session.getConversations().find((item) => item.kind === "group");
    return !!group && group.title === "Weekend trip" && owner.texts(group.key).length >= 11;
  }, "the owner to receive the group");
  await (owner.session as any).uploadEpochKeys();
  owner.client.stop();

  // Written last, so that a setup cut short is noticed and starts over.
  writeFileSync(
    join(world, "world.json"),
    JSON.stringify(
      {
        name: SERVER_NAME,
        url: preview.url,
        username: OWNER.username,
        password: OWNER.password,
        recoveryKey,
        invite,
        people: PEOPLE.map(([, displayName]) => displayName),
      },
      null,
      2,
    ),
  );
  return bots;
}

async function reopenBots(world: string): Promise<TestApp[]> {
  const bots: TestApp[] = [];
  for (const [username] of PEOPLE) {
    const app = await new TestApp(username, join(world, username)).open();
    await app.online();
    bots.push(app);
  }
  return bots;
}

function keepAnswering(bots: TestApp[]): void {
  const seen = new Set<string>();
  for (const bot of bots) {
    const respond = bot.events;
    setInterval(async () => {
      for (const event of respond.splice(0)) {
        if (event.type !== "message" || !event.isNew) continue;
        const message = event.message;
        if (message.senderId === bot.userId || message.system || seen.has(`${bot.name}:${message.id}`)) continue;
        seen.add(`${bot.name}:${message.id}`);
        const conversation = bot.session.getConversations().find((item) => item.groupId === message.groupId);
        if (!conversation) continue;
        // "count to 80" fills the chat with that many messages, for a chat with a lot unread.
        // In a group Lena answers, and every twentieth mentions whoever asked.
        const count = /^count to (\d+)$/.exec(message.text)?.[1];
        if (count && (conversation.kind === "dm" || bot.name === "lena")) {
          const asker = bot.session.getUsers().find((user) => user.id === message.senderId)?.username;
          await sleep(1000);
          for (let i = 1; i <= Math.min(Number(count), 500); i++) {
            const mention = conversation.kind === "group" && i % 20 === 0;
            bot.session.sendMessage(conversation.key, mention ? { text: `Count ${i} @${asker}`, mentions: [message.senderId] } : { text: `Count ${i}` });
            await sleep(20);
          }
          continue;
        }
        // They read groups too, so a message's menu has someone to list as having read it.
        await bot.session.markRead(message.groupId, message.seq ?? 0);
        if (conversation.kind !== "dm") continue;
        await sleep(400);
        bot.session.sendTyping(message.groupId);
        await sleep(1500);
        bot.session.sendMessage(conversation.key, { text: `You said: ${message.text || "(an attachment)"}`, replyTo: message.id });
      }
    }, 300);
  }
}

async function main() {
  loadCrypto();
  const world = process.env.ZUNA_DEV_WORLD;
  let bots: TestApp[];
  if (!world) {
    const invite = process.argv[2];
    if (!invite) throw new Error("Usage: dev-bots.ts <invite-link>");
    bots = await joinBots(invite);
    await startConversations(bots);
  } else if (existsSync(join(world, "world.json"))) {
    bots = await reopenBots(world);
  } else {
    bots = await createWorld(world);
  }
  console.log("Bots are ready. Message any of them from the app. Press Ctrl+C to stop.");
  keepAnswering(bots);
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
