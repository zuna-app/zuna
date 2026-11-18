// The App Store screenshots' world: a server called Basecamp with people who have
// faces, and Alex Morgan on the simulator, whose side of each chat is sent through the app's own
// control channel. Run from packages/core with vite-node; it stays running so everyone shows online.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep, waitFor } from "../../packages/core/test/helpers";
import { ASSETS, DATA } from "./paths";

const HERE = DATA;
const SETUP = readFileSync(join(HERE, "setup-link.txt"), "utf8").trim();
const PHONE_PORT = Number(process.env.PHONE_PORT ?? 9575);
/** Between one chat's last message and the next chat's first, so the list's times differ. */
const GAP = Number(process.env.GAP_MS ?? 60_000);

const png = (name: string) => new Blob([readFileSync(join(ASSETS, `${name}.png`))], { type: "image/png" });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function photo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thumb-"));
  execFileSync("sips", ["-Z", "32", join(ASSETS, `${name}.png`), "--out", join(dir, "t.png")], { stdio: "ignore" });
  return { blob: png(name), name: `${name.replace("photo-", "IMG_")}.png`, mime: "image/png", width: 1600, height: 1200, thumb: `data:image/png;base64,${b64(readFileSync(join(dir, "t.png")))}` };
}

function voice(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  execFileSync("say", ["-v", "Samantha", "-o", join(dir, "v.aiff"), text]);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", join(dir, "v.aiff"), join(dir, "v.m4a")]);
  const info = execFileSync("afinfo", [join(dir, "v.m4a")], { encoding: "utf8" });
  const duration = Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 8);
  const bars = Array.from({ length: 48 }, (_, i) => Math.round(60 + 150 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)) + (i % 5) * 9));
  return { blob: new Blob([readFileSync(join(dir, "v.m4a"))], { type: "audio/mp4" }), name: "voice.m4a", mime: "audio/mp4", duration, voice: true, waveform: b64(new Uint8Array(bars)) };
}

/** The app on the simulator, through its control channel: the core's own calls, as its screens make them. */
class Phone {
  private ws!: WebSocket;
  private next = 1;
  private waiting = new Map<number, (message: any) => void>();
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PHONE_PORT}`);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.kind === "reply" || message.kind === "host-result") this.waiting.get(message.id)?.(message);
    };
  }
  call(serverId: string | null, method: string, ...args: unknown[]): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (message) => (message.ok ? resolve(message.value) : reject(new Error(`${method}: ${message.error?.message}`))));
      this.ws.send(JSON.stringify({ kind: "call", id, serverId, method, args }));
    });
  }
}
const blobArg = (name: string) => ({ $blob: { bytes: b64(readFileSync(join(ASSETS, `${name}.png`))), type: "image/png" } });

const PEOPLE = [
  ["maya", "Maya Lindqvist", "Trail runner. Always planning the next trip."],
  ["theo", "Theo Park", "Board games, bad puns, good coffee."],
  ["nadia", "Nadia Haddad", "Cooking for whoever shows up."],
  ["kai", "Kai Okafor", "Photos from wherever I am."],
  ["elena", "Elena Rossi", "Weather nerd ☀️"],
  ["jonas", "Jonas Weber", "Runs the server. Mostly."],
  ["aiko", "Aiko Tanaka", "Climbing on weekends."],
  ["leo", "Leo Martins", "GM of Thursday nights 🎲"],
  ["sofia", "Sofia Duarte", "Bikes and maps."],
  ["ben", "Ben Carter", "Here for the photos."],
] as const;

async function main() {
  await loadCrypto();
  // The owner sets the server up, as its first person would.
  const [ownerName, ownerDisplay, ownerBio] = PEOPLE[0];
  const maya = await new TestApp(ownerName, join(HERE, "world", ownerName)).open();
  const setup = await maya.client.previewInvite(SETUP);
  const { serverId } = await maya.client.register(setup, ownerName, "showcase-only-password", { displayName: ownerDisplay, bio: ownerBio });
  maya.serverId = serverId;
  await maya.online();
  maya.client.setActive(true);
  await maya.session.updateProfile({ displayName: ownerDisplay, bio: ownerBio }, png(`avatar-${ownerName}`));
  await maya.session.updateServerSettings({ name: "Basecamp" });
  await maya.session.updateServerIcon(png("icon-basecamp"));
  const general = await maya.session.createChannel({ type: "text", name: "general", topic: "Plans, photos and everything else" });
  await maya.session.createChannel({ type: "text", name: "trips", topic: "Where to next?" });
  await maya.session.createChannel({ type: "text", name: "game-night", topic: "Thursdays at 8" });
  await maya.session.createChannel({ type: "text", name: "photos", topic: "Your best shots" });
  await maya.session.createChannel({ type: "voice", name: "Campfire", bitrate: 96 });
  await maya.session.createChannel({ type: "voice", name: "Game night", userLimit: 8 });
  const invite = await maya.session.createInvite(0, 0);
  writeFileSync(join(HERE, "invite.txt"), invite);
  console.log("Basecamp is set up");

  const people: Record<string, TestApp> = { maya };
  for (const [username, displayName, bio] of PEOPLE.slice(1)) {
    const app = await new TestApp(username, join(HERE, "world", username)).open();
    const preview = await app.client.previewInvite(invite);
    const result = await app.client.register(preview, username, "showcase-only-password", { displayName, bio });
    app.serverId = result.serverId;
    await app.online();
    app.client.setActive(true);
    await app.session.updateProfile({ displayName, bio }, png(`avatar-${username}`));
    people[username] = app;
    console.log(`${displayName} joined`);
  }
  const { theo, nadia, kai, elena, aiko, leo, ben, sofia, jonas } = people as Record<string, TestApp>;

  // Alex, on the simulator.
  const phone = new Phone();
  await phone.connect();
  const preview = await phone.call(null, "previewInvite", invite);
  const alexServer = (await phone.call(null, "register", preview, "alex", "showcase-only-password", { displayName: "Alex Morgan", bio: "Usually behind the camera." })).serverId as string;
  await phone.call(alexServer, "updateProfile", { displayName: "Alex Morgan", bio: "Usually behind the camera." }, blobArg("avatar-alex"));
  writeFileSync(join(HERE, "alex-server.txt"), alexServer);
  const alexUser = () => maya.session.getUsers().find((user) => user.username === "alex");
  await waitFor(() => !!alexUser(), "Alex to join", 30_000);
  const alexId = alexUser()!.id;
  console.log("Alex joined on the phone");

  const phoneHas = async (key: string) => {
    for (let i = 0; i < 100; i++) {
      const list = (await phone.call(alexServer, "getConversations")) as { key: string }[];
      if (list.some((item) => item.key === key)) return;
      await sleep(300);
    }
    throw new Error(`the phone never got ${key}`);
  };
  const alexSays = async (key: string, text: string) => {
    await phoneHas(key);
    await phone.call(alexServer, "sendMessage", key, { text });
    await sleep(400);
  };
  const dm = (app: TestApp) => `user:${alexId}`;
  const say = async (app: TestApp, key: string, text: string, extra: Record<string, unknown> = {}) => {
    const sent = app.session.sendMessage(key, { text, ...extra });
    await sleep(350);
    return sent.id;
  };

  // #general, before anything else, so it's where the channel list starts.
  for (const app of Object.values(people)) {
    await waitFor(() => !!app.session.getChannels().find((item) => item.id === general)?.conversation?.ready, `${app.name} in #general`, 30_000);
  }
  const g = `group:${general}`;
  const hello = await say(jonas, g, "Server's updated. Voice should be smoother now 🎧");
  await say(sofia, g, "Can confirm, Campfire sounded great last night.");
  await sofia.session.sendWithAttachments(g, [photo("photo-ridge")], { text: "Yesterday's ride, top of the pass" });
  await sleep(400);
  const nice = await say(aiko, g, "Okay that view is unreal");
  await say(leo, g, "Game night Thursday, 8pm in **Game night** voice 🎲");
  for (const [app, emoji] of [[theo, "🎉"], [kai, "🎉"], [nadia, "🙌"], [elena, "🎉"]] as const) await app.session.toggleReaction(general, hello, emoji);
  await sofia.session.toggleReaction(general, nice, "❤️");

  // Oldest first, so the newest chat ends up on top.
  await say(ben, dm(ben), "Thanks for the photos from Saturday!");
  await say(ben, dm(ben), "The one with the lake is going on my wall");
  await alexSays(`user:${ben.userId}`, "Haha glad you like it, I'll send the full size");
  await sleep(GAP);

  const games = await theo.session.createGroup("Thursday game night 🎲", [alexId, kai.userId, leo.userId, ben.userId], false);
  const gk = `group:${games}`;
  await say(leo, gk, "Campaign night or board games?");
  await say(kai, gk, "Board games, I'm still recovering from last week's dragon");
  await alexSays(gk, "Board games! I'll bring Cascadia");
  await say(theo, gk, "Who's hosting this week?");
  await sleep(GAP);

  await say(elena, dm(elena), "Did you see the forecast for Saturday? ☀️");
  await alexSays(`user:${elena.userId}`, "Clear skies all day!");
  await say(elena, dm(elena), "Sunrise at 6:12. Worth the early alarm.");
  await sleep(GAP);

  await say(nadia, dm(nadia), "Here's the recipe I promised 🍝");
  await say(nadia, dm(nadia), "Double the garlic. Trust me.");
  await alexSays(`user:${nadia.userId}`, "Making it tonight, thank you!!");
  await sleep(GAP);

  await theo.session.sendWithAttachments(dm(theo), [voice("Hey Alex! Quick one, can you grab the second tent from my place before Saturday? It's in the hallway closet. Thanks!")], {});
  await sleep(GAP);

  // The weekend trip: photos, a reply, reactions and a pin.
  const trip = await maya.session.createGroup("Tatras weekend 🏔️", [alexId, theo.userId, nadia.userId, kai.userId], false, png("photo-sunrise"));
  const tk = `group:${trip}`;
  const plan = await say(maya, tk, "Okay team, the plan: Friday night drive, hut on Saturday, summit on Sunday 🏔️");
  await say(theo, tk, "I can drive. Leaving at 6?");
  await alexSays(tk, "6 works. I'll bring the camera and the stove");
  await say(nadia, tk, "I've got food covered. Anyone vegetarian?");
  await alexSays(tk, "Me! Thanks Nadia 🙏");
  await kai.session.sendWithAttachments(tk, [photo("photo-sunrise"), photo("photo-tent")], { text: "From last year. Same spot?" });
  await sleep(500);
  const yes = await say(maya, tk, "Same spot. Booked the hut for Saturday 🎉", { replyTo: plan });
  for (const [app, emoji] of [[theo, "🔥"], [nadia, "🔥"], [kai, "🎉"]] as const) await app.session.toggleReaction(trip, plan, emoji);
  await theo.session.toggleReaction(trip, yes, "🙌");
  await maya.session.setPinned(trip, plan, true);
  await sleep(GAP);

  // The newest: Maya, two unread.
  await say(maya, dm(maya), "Sending you the route now 🗺️");
  await say(maya, dm(maya), "It's about 14 km, mostly along the ridge. Bring layers!");

  console.log("The world is ready. Everyone stays online until this stops.");
  for (const app of Object.values(people)) app.client.setActive(true);
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
