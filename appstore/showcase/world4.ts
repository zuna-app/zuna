// Brings Pixel Guild's and Family's people back online and makes Friday squad livelier for the iPad's
// shot of the servers.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep } from "../../packages/core/test/helpers";
import { DATA } from "./paths";

const HERE = DATA;

async function reopen(tag: string) {
  const dir = join(HERE, `world-${tag}`);
  const apps: Record<string, TestApp> = {};
  for (const name of readdirSync(dir)) {
    const app = await new TestApp(name, join(dir, name)).open();
    await app.online();
    app.client.setActive(true);
    apps[name] = app;
  }
  return apps;
}

async function main() {
  await loadCrypto();
  const pixel = await reopen("pixel");
  await reopen("family");
  console.log("Everyone is back");
  const { rin, marco, zoe } = pixel;
  const squad = zoe.session.getConversations().find((item) => item.key.startsWith("group:") && item.title.startsWith("Friday squad"));
  if (!squad) throw new Error("no Friday squad");
  const key = squad.key;
  const say = async (app: TestApp, text: string) => {
    app.session.sendMessage(key, { text });
    await sleep(700);
  };
  await say(marco, "I'm in. Bringing the new healer build 🧪");
  await say(zoe, "Just watched the clip back. Rin's dodge at the end 😂");
  await say(rin, "Pure luck, don't tell anyone");
  await say(marco, "Too late, it's already in #clips");
  await say(zoe, "Friday, 8pm, Raid night voice. I'll bring the strategy doc 📋");
  await say(rin, "Snacks officer reporting for duty 🍿");
  console.log("Friday squad is busy. Everyone stays online until this stops.");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
