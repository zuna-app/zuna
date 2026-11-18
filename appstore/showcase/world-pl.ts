// The Polish screenshots' world: Szlakiem, Gildia Pikseli and Rodzina, with Kuba
// Lewandowski on the Polish simulator, whose side is sent through the app's control channel. Rodzina
// waits for pl/rodzina-go, after its invite has been shown. Stays running so everyone shows online.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestApp, loadCrypto, sleep, waitFor } from "../../packages/core/test/helpers";
import { ASSETS, DATA } from "./paths";

const SHOW = DATA;
const HERE = join(SHOW, "pl");
const PHONE_PORT = Number(process.env.PHONE_PORT ?? 9576);
const GAP = Number(process.env.GAP_MS ?? 45_000);
const PASSWORD = "showcase-only-password";

const png = (name: string) => new Blob([readFileSync(join(ASSETS, `${name}.png`))], { type: "image/png" });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const blobArg = (name: string) => ({ $blob: { bytes: b64(readFileSync(join(ASSETS, `${name}.png`))), type: "image/png" } });

function photo(name: string, file: string) {
  const dir = mkdtempSync(join(tmpdir(), "thumb-"));
  execFileSync("sips", ["-Z", "32", join(ASSETS, `${name}.png`), "--out", join(dir, "t.png")], { stdio: "ignore" });
  return { blob: png(name), name: file, mime: "image/png", width: 1600, height: 1200, thumb: `data:image/png;base64,${b64(readFileSync(join(dir, "t.png")))}` };
}

function voice(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  execFileSync("say", ["-v", "Zosia", "-o", join(dir, "v.aiff"), text]);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", join(dir, "v.aiff"), join(dir, "v.m4a")]);
  const info = execFileSync("afinfo", [join(dir, "v.m4a")], { encoding: "utf8" });
  const duration = Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 8);
  const bars = Array.from({ length: 48 }, (_, i) => Math.round(60 + 150 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)) + (i % 5) * 9));
  return { blob: new Blob([readFileSync(join(dir, "v.m4a"))], { type: "audio/mp4" }), name: "voice.m4a", mime: "audio/mp4", duration, voice: true, waveform: b64(new Uint8Array(bars)) };
}

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

type Person = [username: string, displayName: string, avatar: string, bio: string];
type Channel = { type: "text" | "voice"; name: string; topic?: string; key: string };

async function server(tag: string, name: string, icon: string, people: Person[], channels: Channel[]) {
  const setup = readFileSync(join(HERE, `setup-${tag}.txt`), "utf8").trim();
  const [ownerName, ownerDisplay, ownerAvatar, ownerBio] = people[0];
  const owner = await new TestApp(ownerName, join(HERE, `world-${tag}`, ownerName)).open();
  const preview = await owner.client.previewInvite(setup);
  owner.serverId = (await owner.client.register(preview, ownerName, PASSWORD, { displayName: ownerDisplay, bio: ownerBio })).serverId;
  await owner.online();
  owner.client.setActive(true);
  await owner.session.updateProfile({ displayName: ownerDisplay, bio: ownerBio }, png(ownerAvatar));
  await owner.session.updateServerSettings({ name });
  await owner.session.updateServerIcon(png(icon));
  const ids: Record<string, string> = {};
  for (const { key, ...channel } of channels) ids[key] = await owner.session.createChannel(channel);
  const invite = await owner.session.createInvite(0, 0);
  writeFileSync(join(HERE, `invite-${tag}.txt`), invite);
  const apps: Record<string, TestApp> = { [ownerName]: owner };
  for (const [username, displayName, avatar, bio] of people.slice(1)) {
    const app = await new TestApp(username, join(HERE, `world-${tag}`, username)).open();
    const joined = await app.client.previewInvite(invite);
    app.serverId = (await app.client.register(joined, username, PASSWORD, { displayName, bio })).serverId;
    await app.online();
    app.client.setActive(true);
    await app.session.updateProfile({ displayName, bio }, png(avatar));
    apps[username] = app;
  }
  console.log(`${name} jest gotowy`);
  return { owner, apps, invite, ids };
}

const KUBA = { displayName: "Kuba Lewandowski", bio: "Zwykle stoję za aparatem." };

async function kubaOn(phone: Phone, invite: string) {
  const preview = await phone.call(null, "previewInvite", invite);
  const serverId = (await phone.call(null, "register", preview, "kuba", PASSWORD, KUBA)).serverId as string;
  await phone.call(serverId, "updateProfile", KUBA, blobArg("avatar-alex"));
  return serverId;
}

async function main() {
  await loadCrypto();
  const szlak = await server("szlak", "Szlakiem", "icon-basecamp", [
    ["marta", "Marta Zielińska", "avatar-maya", "Biegam po górach. Zawsze planuję następny wyjazd."],
    ["tomek", "Tomek Kaczmarek", "avatar-theo", "Planszówki, suchary i dobra kawa."],
    ["zuzia", "Zuzia Wójcik", "avatar-nadia", "Gotuję dla każdego, kto wpadnie."],
    ["kacper", "Kacper Mazur", "avatar-kai", "Zdjęcia z każdego miejsca."],
    ["ewa", "Ewa Dąbrowska", "avatar-elena", "Fanka prognoz pogody ☀️"],
    ["janek", "Janek Kowalczyk", "avatar-jonas", "Opiekuję się serwerem. Zazwyczaj."],
    ["ania", "Ania Szymańska", "avatar-aiko", "W weekendy na ściance."],
    ["lukasz", "Łukasz Piotrowski", "avatar-leo", "Mistrz gry w czwartki 🎲"],
    ["zosia", "Zosia Grabowska", "avatar-sofia", "Rowery i mapy."],
    ["bartek", "Bartek Pawlak", "avatar-ben", "Jestem tu dla zdjęć."],
  ], [
    { key: "ogolny", type: "text", name: "ogólny", topic: "Plany, zdjęcia i cała reszta" },
    { key: "wyjazdy", type: "text", name: "wyjazdy", topic: "Gdzie następnym razem?" },
    { key: "planszowki", type: "text", name: "planszówki", topic: "Czwartki o 20" },
    { key: "zdjecia", type: "text", name: "zdjęcia", topic: "Wasze najlepsze ujęcia" },
    { key: "ognisko", type: "voice", name: "Ognisko" },
    { key: "glos", type: "voice", name: "Planszówki" },
  ]);
  writeFileSync(join(HERE, "szlak-channels.json"), JSON.stringify(szlak.ids));
  const gildia = await server("gildia", "Gildia Pikseli", "icon-pixel", [
    ["wiktoria", "Wiktoria Nowicka", "avatar-rin", "Tank. Oficer od przekąsek."],
    ["igor", "Igor Krawczyk", "avatar-marco", "Prowadzę rajdy w piątki."],
    ["oliwia", "Oliwia Adamczyk", "avatar-zoe", "Speedruny i arkusze kalkulacyjne."],
  ], [
    { key: "ogolny", type: "text", name: "ogólny", topic: "Przywitaj się" },
    { key: "ekipa", type: "text", name: "szukam-ekipy", topic: "Szukasz drużyny?" },
    { key: "klipy", type: "text", name: "klipy", topic: "Wasze najlepsze akcje" },
    { key: "rajd", type: "voice", name: "Rajd" },
  ]);
  const rodzina = await server("rodzina", "Rodzina", "icon-family", [
    ["ola", "Ola Lewandowska", "avatar-ella", "Starsza siostra. Strażniczka zdjęć."],
    ["piotr", "Piotr Lewandowski", "avatar-david", "Tata. Naprawię wszystko oprócz drukarki."],
    ["halina", "Halina Lewandowska", "avatar-rose", "Babcia. Najlepsza szarlotka w mieście."],
  ], []);

  // Their simulators sign in as them to come into voice: each says it was them.
  setInterval(() => {
    for (const app of Object.values(szlak.apps)) {
      for (const device of app.session.getNewDevices()) void app.session.answerNewDevice(device.id, true).catch(() => undefined);
    }
  }, 1500);

  const phone = new Phone();
  await phone.connect();
  const szlakServer = await kubaOn(phone, szlak.invite);
  const userOn = (owner: TestApp) => owner.session.getUsers().find((user) => user.username === "kuba");
  await waitFor(() => !!userOn(szlak.owner), "Kuba na Szlakiem", 30_000);
  const kubaId = userOn(szlak.owner)!.id;
  console.log("Kuba dołączył do Szlakiem");

  const phoneHas = async (serverId: string, key: string) => {
    for (let i = 0; i < 100; i++) {
      const list = (await phone.call(serverId, "getConversations")) as { key: string }[];
      if (list.some((item) => item.key === key)) return;
      await sleep(300);
    }
    throw new Error(`telefon nie dostał ${key}`);
  };
  const kubaSays = async (key: string, text: string) => {
    await phoneHas(szlakServer, key);
    await phone.call(szlakServer, "sendMessage", key, { text });
    await sleep(400);
  };
  const say = async (app: TestApp, key: string, text: string, extra: Record<string, unknown> = {}) => {
    const sent = app.session.sendMessage(key, { text, ...extra });
    await sleep(350);
    return sent.id;
  };
  const p = szlak.apps;
  const dm = `user:${kubaId}`;

  // The channels first.
  for (const app of Object.values(p)) {
    for (const id of Object.values(szlak.ids)) {
      const channel = app.session.getChannels().find((item) => item.id === id);
      if (channel && channel.type === "text") await waitFor(() => !!app.session.getChannels().find((item) => item.id === id)?.conversation?.ready, `${app.name} w ${id}`, 30_000);
    }
  }
  const g = `group:${szlak.ids.ogolny}`;
  const hello = await say(p.janek, g, "Serwer zaktualizowany. Głos powinien działać płynniej 🎧");
  await say(p.zosia, g, "Potwierdzam, wczoraj w Ognisku było świetnie słychać.");
  await p.zosia.session.sendWithAttachments(g, [photo("photo-ridge", "IMG_przelecz.png")], { text: "Wczorajsza trasa, szczyt przełęczy" });
  await sleep(400);
  const view = await say(p.ania, g, "Ale widok 😍");
  await say(p.lukasz, g, "Czwartek o 20, kanał **Planszówki** 🎲");
  for (const [app, emoji] of [[p.tomek, "🎉"], [p.kacper, "🎉"], [p.zuzia, "🙌"], [p.ewa, "🎉"]] as const) await app.session.toggleReaction(szlak.ids.ogolny, hello, emoji);
  await p.zosia.session.toggleReaction(szlak.ids.ogolny, view, "❤️");
  await say(p.marta, `group:${szlak.ids.wyjazdy}`, "Dolomity w czerwcu? 🏔️");
  await say(p.ania, `group:${szlak.ids.wyjazdy}`, "Jestem za. Jeden dzień na via ferratę!");
  await say(p.zosia, `group:${szlak.ids.wyjazdy}`, "Rozpiszę trasy rowerowe wokół Cortiny 🚴");
  await p.kacper.session.sendWithAttachments(`group:${szlak.ids.zdjecia}`, [photo("photo-sunrise", "IMG_jezioro.png")], { text: "Złota godzina nad jeziorem" });
  await sleep(400);
  await say(p.bartek, `group:${szlak.ids.zdjecia}`, "To też wieszam na ścianie 😍");
  await say(p.lukasz, `group:${szlak.ids.planszowki}`, "W czwartek przynoszę nowy dodatek");
  await say(p.tomek, `group:${szlak.ids.planszowki}`, "Przekąski na mnie 🍕");

  // Oldest first, so the newest chat is on top.
  await say(p.bartek, dm, "Dzięki za zdjęcia z soboty!");
  await say(p.bartek, dm, "To z jeziorem wieszam na ścianie");
  await kubaSays(`user:${p.bartek.userId}`, "Haha cieszę się, wyślę ci pełną rozdzielczość");
  await sleep(GAP);

  const games = await p.tomek.session.createGroup("Planszówkowy czwartek 🎲", [kubaId, p.kacper.userId, p.lukasz.userId, p.bartek.userId], false);
  const gk = `group:${games}`;
  await say(p.lukasz, gk, "Kampania czy planszówki?");
  await say(p.kacper, gk, "Planszówki, wciąż dochodzę do siebie po smoku z zeszłego tygodnia");
  await kubaSays(gk, "Planszówki! Biorę Cascadię");
  await say(p.tomek, gk, "Kto w tym tygodniu u siebie?");
  await sleep(GAP);

  await say(p.ewa, dm, "Widziałeś prognozę na sobotę? ☀️");
  await kubaSays(`user:${p.ewa.userId}`, "Bezchmurnie cały dzień!");
  await say(p.ewa, dm, "Wschód słońca o 6:12. Warto wstać wcześniej.");
  await sleep(GAP);

  await say(p.zuzia, dm, "Obiecany przepis 🍝");
  await say(p.zuzia, dm, "Podwójny czosnek. Zaufaj mi.");
  await kubaSays(`user:${p.zuzia.userId}`, "Robię dziś wieczorem, dzięki!!");
  await sleep(GAP);

  await p.tomek.session.sendWithAttachments(dm, [voice("Hej Kuba! Mam prośbę, możesz przed sobotą wziąć ode mnie drugi namiot? Jest w szafie w przedpokoju. Dzięki!")], {});
  await sleep(GAP);

  const trip = await p.marta.session.createGroup("Weekend w Tatrach 🏔️", [kubaId, p.tomek.userId, p.zuzia.userId, p.kacper.userId], false, png("photo-sunrise"));
  const tk = `group:${trip}`;
  const plan = await say(p.marta, tk, "Dobra ekipa, plan: w piątek wieczorem wyjazd, w sobotę schronisko, w niedzielę szczyt 🏔️");
  await say(p.tomek, tk, "Mogę prowadzić. Wyjeżdżamy o 6?");
  await kubaSays(tk, "6 pasuje. Biorę aparat i kuchenkę");
  await say(p.zuzia, tk, "Jedzenie ogarniam. Ktoś jest wegetarianinem?");
  await kubaSays(tk, "Ja! Dzięki Zuzia 🙏");
  await p.kacper.session.sendWithAttachments(tk, [photo("photo-sunrise", "IMG_wschod.png"), photo("photo-tent", "IMG_namiot.png")], { text: "Z zeszłego roku. To samo miejsce?" });
  await sleep(500);
  const booked = await say(p.marta, tk, "To samo. Schronisko na sobotę zarezerwowane 🎉", { replyTo: plan });
  for (const [app, emoji] of [[p.tomek, "🔥"], [p.zuzia, "🔥"], [p.kacper, "🎉"]] as const) await app.session.toggleReaction(trip, plan, emoji);
  await p.tomek.session.toggleReaction(trip, booked, "🙌");
  await p.marta.session.setPinned(trip, plan, true);
  await sleep(GAP);

  await say(p.marta, dm, "Wysyłam ci trasę 🗺️");
  await say(p.marta, dm, "Około 14 km, głównie granią. Weź coś ciepłego!");
  console.log("Szlakiem gotowy");

  // Gildia Pikseli.
  const gildiaServer = await kubaOn(phone, gildia.invite);
  await waitFor(() => !!userOn(gildia.owner), "Kuba w Gildii", 30_000);
  const kubaG = userOn(gildia.owner)!.id;
  const { wiktoria, igor, oliwia } = gildia.apps;
  const squad = await oliwia.session.createGroup("Piątkowa ekipa", [kubaG, wiktoria.userId, igor.userId], false, png("icon-pixel"));
  oliwia.session.sendMessage(`group:${squad}`, { text: "GG wszystkim, ten ostatni boss to było coś 🔥" });
  await sleep(500);
  wiktoria.session.sendMessage(`group:${squad}`, { text: "Ta sama pora za tydzień?" });
  await sleep(500);
  igor.session.sendMessage(`user:${kubaG}`, { text: "Rajd za 10 minut, wchodzisz? 🎮" });
  console.log("Gildia Pikseli gotowa");

  // Rodzina, once its invite has been shown.
  console.log("Czekam na rodzina-go");
  await waitFor(() => existsSync(join(HERE, "rodzina-go")), "pokazanie zaproszenia", 60 * 60_000);
  const rodzinaServer = await kubaOn(phone, rodzina.invite);
  await waitFor(() => !!userOn(rodzina.owner), "Kuba w Rodzinie", 30_000);
  const kubaR = userOn(rodzina.owner)!.id;
  const { ola, piotr, halina } = rodzina.apps;
  const home = await ola.session.createGroup("Lewandowscy 🏡", [kubaR, piotr.userId, halina.userId], false, png("icon-family"));
  piotr.session.sendMessage(`user:${kubaR}`, { text: "Zerkniesz w weekend na drukarkę? 😅" });
  await sleep(500);
  ola.session.sendMessage(`group:${home}`, { text: "Kto przynosi deser w niedzielę?" });
  await sleep(500);
  halina.session.sendMessage(`group:${home}`, { text: "Obiad u mnie o 13. Piekę szarlotkę 🥧" });
  writeFileSync(join(HERE, "servers.json"), JSON.stringify({ szlak: szlakServer, gildia: gildiaServer, rodzina: rodzinaServer }));
  console.log("Wszystko gotowe. Wszyscy zostają online, dopóki to działa.");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
