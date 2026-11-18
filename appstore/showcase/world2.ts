// Brings Basecamp's people back online, says yes to their own new devices (the simulators that join
// voice as them), and fills the other channels a little.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep, waitFor } from "../../packages/core/test/helpers";
import { ASSETS, DATA } from "./paths";

const HERE = DATA;
const NAMES = ["maya", "theo", "nadia", "kai", "elena", "jonas", "aiko", "leo", "sofia", "ben"];
const CHANNELS = { trips: "3abf62a10b9f1bea4a6ffb01c0fdbfa1", gameNight: "4834cc7a59576aca8a221c0ad3b65aff", photos: "da2d31ce01fc18ba907534401cb2dccd" };

function photo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thumb-"));
  execFileSync("sips", ["-Z", "32", join(ASSETS, `${name}.png`), "--out", join(dir, "t.png")], { stdio: "ignore" });
  return {
    blob: new Blob([readFileSync(join(ASSETS, `${name}.png`))], { type: "image/png" }),
    name: `${name.replace("photo-", "IMG_")}.png`, mime: "image/png", width: 1600, height: 1200,
    thumb: `data:image/png;base64,${readFileSync(join(dir, "t.png")).toString("base64")}`,
  };
}

async function main() {
  await loadCrypto();
  const people: Record<string, TestApp> = {};
  for (const name of NAMES) {
    const app = await new TestApp(name, join(HERE, "world", name)).open();
    await app.online();
    app.client.setActive(true);
    people[name] = app;
  }
  console.log("Everyone is back");

  // Their simulators sign in as them: each says it was them, as a person would on their phone.
  setInterval(() => {
    for (const app of Object.values(people)) {
      for (const device of app.session.getNewDevices()) {
        void app.session.answerNewDevice(device.id, true).then(() => console.log(`${app.name} approved ${device.id}`)).catch(() => undefined);
      }
    }
  }, 1500);

  const { maya, aiko, sofia, kai, ben, leo, theo } = people as Record<string, TestApp>;
  for (const app of [maya, aiko, sofia, kai, ben, leo, theo]) {
    for (const id of Object.values(CHANNELS)) {
      await waitFor(() => !!app.session.getChannels().find((item) => item.id === id)?.conversation?.ready, `${app.name} in ${id}`, 30_000);
    }
  }
  const say = async (app: TestApp, id: string, text: string) => {
    app.session.sendMessage(`group:${id}`, { text });
    await sleep(400);
  };
  await say(maya, CHANNELS.trips, "Next up: the Dolomites in June? 🏔️");
  await say(aiko, CHANNELS.trips, "I'm in. One via ferrata day, please");
  await say(sofia, CHANNELS.trips, "I'll map out the rides around Cortina 🚴");
  await kai.session.sendWithAttachments(`group:${CHANNELS.photos}`, [photo("photo-sunrise")], { text: "Golden hour at the lake" });
  await sleep(500);
  await say(ben, CHANNELS.photos, "Okay this one is going on my wall too 😍");
  await say(leo, CHANNELS.gameNight, "Bringing the new expansion Thursday");
  await say(theo, CHANNELS.gameNight, "Snacks are on me 🍕");
  console.log("The channels are busy. Everyone stays online until this stops.");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
