// Two more servers for the server list: Pixel Guild and Family, each with people who have faces.
// Alex joins Pixel Guild through the app's control channel; Family only once family-go exists, after
// its invite has been shown on screen.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep, waitFor } from "../../packages/core/test/helpers";
import { ASSETS, DATA } from "./paths";

const HERE = DATA;
const PHONE_PORT = Number(process.env.PHONE_PORT ?? 9575);
const png = (name: string) => new Blob([readFileSync(join(ASSETS, `${name}.png`))], { type: "image/png" });
const blobArg = (name: string) => ({ $blob: { bytes: readFileSync(join(ASSETS, `${name}.png`)).toString("base64"), type: "image/png" } });

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
      if (message.kind === "reply") this.waiting.get(message.id)?.(message);
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

type Person = [username: string, displayName: string, bio: string];

async function server(tag: string, name: string, icon: string, people: Person[], channels: { type: "text" | "voice"; name: string; topic?: string }[]) {
  const setup = readFileSync(join(HERE, `setup-${tag}.txt`), "utf8").trim();
  const [ownerName, ownerDisplay, ownerBio] = people[0];
  const owner = await new TestApp(ownerName, join(HERE, `world-${tag}`, ownerName)).open();
  const preview = await owner.client.previewInvite(setup);
  owner.serverId = (await owner.client.register(preview, ownerName, "showcase-only-password", { displayName: ownerDisplay, bio: ownerBio })).serverId;
  await owner.online();
  owner.client.setActive(true);
  await owner.session.updateProfile({ displayName: ownerDisplay, bio: ownerBio }, png(`avatar-${ownerName}`));
  await owner.session.updateServerSettings({ name });
  await owner.session.updateServerIcon(png(icon));
  for (const channel of channels) await owner.session.createChannel(channel);
  const invite = await owner.session.createInvite(0, 0);
  writeFileSync(join(HERE, `invite-${tag}.txt`), invite);
  const apps: Record<string, TestApp> = { [ownerName]: owner };
  for (const [username, displayName, bio] of people.slice(1)) {
    const app = await new TestApp(username, join(HERE, `world-${tag}`, username)).open();
    const joined = await app.client.previewInvite(invite);
    app.serverId = (await app.client.register(joined, username, "showcase-only-password", { displayName, bio })).serverId;
    await app.online();
    app.client.setActive(true);
    await app.session.updateProfile({ displayName, bio }, png(`avatar-${username}`));
    apps[username] = app;
  }
  console.log(`${name} is set up`);
  return { owner, apps, invite };
}

async function alexOn(phone: Phone, invite: string) {
  const preview = await phone.call(null, "previewInvite", invite);
  const serverId = (await phone.call(null, "register", preview, "alex", "showcase-only-password", { displayName: "Alex Morgan", bio: "Usually behind the camera." })).serverId as string;
  await phone.call(serverId, "updateProfile", { displayName: "Alex Morgan", bio: "Usually behind the camera." }, blobArg("avatar-alex"));
  return serverId;
}

async function main() {
  await loadCrypto();
  const pixel = await server("pixel", "Pixel Guild", "icon-pixel", [
    ["rin", "Rin Takeda", "Tank main. Snacks officer."],
    ["marco", "Marco Bianchi", "Raid lead on Fridays."],
    ["zoe", "Zoe Adler", "Speedruns and spreadsheets."],
  ], [
    { type: "text", name: "general", topic: "Say hi" },
    { type: "text", name: "lfg", topic: "Looking for group" },
    { type: "text", name: "clips", topic: "Your best plays" },
    { type: "voice", name: "Raid night" },
  ]);
  const family = await server("family", "Family", "icon-family", [
    ["ella", "Ella Morgan", "Big sister. Keeper of the photos."],
    ["david", "David Morgan", "Dad. Fixes everything but the printer."],
    ["rose", "Rose Morgan", "Grandma. Best pie in town."],
  ], []);

  const phone = new Phone();
  await phone.connect();
  const pixelServer = await alexOn(phone, pixel.invite);
  console.log("Alex joined Pixel Guild");
  const alexIn = (owner: TestApp) => owner.session.getUsers().find((user) => user.username === "alex");
  await waitFor(() => !!alexIn(pixel.owner), "Alex in Pixel Guild", 30_000);
  const { rin, marco, zoe } = pixel.apps;
  const alexPixel = alexIn(pixel.owner)!.id;
  const squad = await zoe.session.createGroup("Friday squad", [alexPixel, rin.userId, marco.userId], false, png("icon-pixel"));
  zoe.session.sendMessage(`group:${squad}`, { text: "GG everyone, that last boss was wild 🔥" });
  await sleep(500);
  rin.session.sendMessage(`group:${squad}`, { text: "Same time next week?" });
  await sleep(500);
  marco.session.sendMessage(`user:${alexPixel}`, { text: "Raid starts in 10, you in? 🎮" });

  // Family, once its invite has been shown.
  console.log("Waiting for family-go");
  await waitFor(() => existsSync(join(HERE, "family-go")), "the family invite to be shown", 30 * 60_000);
  const familyServer = await alexOn(phone, family.invite);
  console.log("Alex joined Family");
  await waitFor(() => !!alexIn(family.owner), "Alex in Family", 30_000);
  const { ella, david, rose } = family.apps;
  const alexFamily = alexIn(family.owner)!.id;
  const home = await ella.session.createGroup("Morgans 🏡", [alexFamily, david.userId, rose.userId], false, png("icon-family"));
  david.session.sendMessage(`user:${alexFamily}`, { text: "Can you look at the printer this weekend? 😅" });
  await sleep(500);
  ella.session.sendMessage(`group:${home}`, { text: "Who's bringing dessert on Sunday?" });
  await sleep(500);
  rose.session.sendMessage(`group:${home}`, { text: "Lunch at mine, 1pm. I'm making apple pie 🥧" });
  writeFileSync(join(HERE, "servers.json"), JSON.stringify({ pixel: pixelServer, family: familyServer }));
  console.log("Both servers are ready. Everyone stays online until this stops.");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
