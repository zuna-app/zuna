// Brings the Polish world's people back online, says yes to their new devices, and finishes Rodzina:
// Kuba joins it from the Polish simulator and the family writes.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep, waitFor } from "../../packages/core/test/helpers";
import { ASSETS, DATA } from "./paths";

const SHOW = DATA;
const HERE = join(SHOW, "pl");
const PHONE_PORT = Number(process.env.PHONE_PORT ?? 9576);
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
  const szlak = await reopen("szlak");
  await reopen("gildia");
  const rodzina = await reopen("rodzina");
  console.log("Wszyscy wrócili");
  setInterval(() => {
    for (const app of Object.values(szlak)) {
      for (const device of app.session.getNewDevices()) void app.session.answerNewDevice(device.id, true).catch(() => undefined);
    }
  }, 1500);

  const phone = new Phone();
  await phone.connect();
  const invite = readFileSync(join(HERE, "invite-rodzina.txt"), "utf8").trim();
  const preview = await phone.call(null, "previewInvite", invite);
  const profile = { displayName: "Kuba Lewandowski", bio: "Zwykle stoję za aparatem." };
  const serverId = (await phone.call(null, "register", preview, "kuba", "showcase-only-password", profile)).serverId as string;
  await phone.call(serverId, "updateProfile", profile, blobArg("avatar-alex"));
  const { ola, piotr, halina } = rodzina;
  const kuba = () => ola.session.getUsers().find((user) => user.username === "kuba");
  await waitFor(() => !!kuba(), "Kuba w Rodzinie", 30_000);
  const kubaId = kuba()!.id;
  const home = await ola.session.createGroup("Lewandowscy 🏡", [kubaId, piotr.userId, halina.userId], false, png("icon-family"));
  piotr.session.sendMessage(`user:${kubaId}`, { text: "Zerkniesz w weekend na drukarkę? 😅" });
  await sleep(500);
  ola.session.sendMessage(`group:${home}`, { text: "Kto przynosi deser w niedzielę?" });
  await sleep(500);
  halina.session.sendMessage(`group:${home}`, { text: "Obiad u mnie o 13. Piekę szarlotkę 🥧" });
  writeFileSync(join(HERE, "rodzina-server.txt"), serverId);
  console.log("Wszystko gotowe. Wszyscy zostają online, dopóki to działa.");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
