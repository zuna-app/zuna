// The native app through a SOCKS5 proxy (docs/SOCKS5.md), on macOS: two copies of it,
// each set to go through the test proxy with a password (packages/core/test/socks-proxy.ts),
// to a test server reached by name and behind a door that writes down where each connection
// came from. Both sign up, start again with the proxy from their settings, write to each
// other and send a file, and every connection the server saw left the proxy, which was given
// the server's name, never an address. With the proxy gone they connect to nothing and say
// why, and come back with it. Turned off, the app connects directly again.
//
// Then a call: both come into a voice channel on a LiveKit of the check's own, each with a
// tone in place of a microphone, and each hears the other, through relays on loopback and
// the proxy alone, over UDP, and again over TCP with the proxy refusing UDP, as Tor does. In
// it they watch a video together, in the fake of YouTube's player (packages/watch/fake) at a
// name only the proxy knows, which WebKit reaches through it or not at all.
//
//   node apps/desktop/test/proxy-check.mjs [screenshot-dir]

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { build, root, session, sleep, until } from "./mac-session.mjs";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";
import { Recorder, SocksProxy } from "../../../packages/core/test/socks-proxy.ts";

const PASSWORD = "the proxy check's password";
const { server: serverBinary } = build();
const { work, check, start, startServer, startApp, finish } = session({ shots: process.argv[2] });

/**
 * The fake of YouTube's player, at a name only the check's proxy resolves. One without a dot,
 * as App Transport Security keeps an app from plain HTTP to any other name before the proxy
 * is even asked, and the system takes no proxy to this machine's own addresses.
 */
const PLAYER_NAME = "zuna-watch";
const playerPage = readFileSync(join(root, "packages", "watch", "fake", "player.html"), "utf8");
const player = createServer((_, response) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(playerPage));
await new Promise((resolve) => player.listen(0, "127.0.0.1", resolve));
const playerPort = player.address().port;

/** Each copy with a tone for a microphone, the fake player, and what it hears in its log. */
const APP_ENV = { ZUNA_FAKE_MIC: "1", ZUNA_WATCH_PLAYER: `http://${PLAYER_NAME}:${playerPort}`, RUST_LOG: "info,zuna=debug" };

/** Where an app's player last said it was, from its log. */
const playerAt = (app) => [...app.log().matchAll(/watch: player (\S+) at (\d+) ms, (\d+)/g)].at(-1)?.[1] ?? null;

/** The loudest a voice decoded at in a copy's log since `from`, once it's heard. */
const loudest = (app, from = 0) => Math.max(0, ...[...app.log().slice(from).matchAll(/voice: \S+ peaks at ([0-9.]+)/g)].map((match) => Number(match[1])));

/** A conversation's texts, as the core has them. */
async function texts(app, serverId) {
  const conversations = (await app.core("getConversations", [], serverId)).ok ?? [];
  const out = [];
  for (const conversation of conversations.filter((item) => item.groupId)) {
    const page = (await app.core("loadMessages", [conversation.groupId], serverId)).ok;
    for (const message of page?.messages ?? []) out.push(message.text ?? "");
  }
  return out;
}

async function signUp(app, link, username, displayName) {
  const preview = await app.core("previewInvite", [link]);
  if (!preview.ok) return preview;
  return app.core("register", [preview.ok, username, `${username} through the proxy check`, { displayName }]);
}

/** Each copy of the app, so that whatever happens, its password goes from the keychain after. */
const apps = [];
/** The check's LiveKit, whose log is kept with the apps'. */
let media;

/** Quits a copy and starts it again in its folder, as the person would. */
async function restart(app, name) {
  await app.quit();
  await sleep(2500);
  apps.splice(apps.indexOf(app), 1);
  const again = await startApp(name, APP_ENV);
  apps.push(again);
  return again;
}

try {
  const proxy = await new SocksProxy({ username: "zuna", password: PASSWORD }).start();
  proxy.names.set(PLAYER_NAME, "127.0.0.1");
  // A LiveKit of its own, its signalling reached by name too, and its media on this Mac's
  // address on its network, as LiveKit is never on loopback, where it takes nothing from loopback
  // in turn: that's the proxy's address it sees, as a server sees a real proxy's.
  const liveKitPort = 30000 + Math.floor(Math.random() * 20000);
  const lan = Object.values(networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
  if (!lan) throw new Error("This Mac has no address on a network, which the call's media goes to.");
  const config = `${LIVEKIT_CONFIG}  tcp_port: ${liveKitPort + 1}\n  udp_port: ${liveKitPort + 2}\nport: ${liveKitPort}\n`;
  media = start(ensureLiveKit(), ["--dev", "--bind", lan, "--bind", "127.0.0.1", "--node-ip", lan, "--config-body", config], process.env, "livekit");
  const doorPort = 30000 + Math.floor(Math.random() * 20000);
  // Reached as localhost, so the proxy is given a name to resolve.
  const { port, setupLink } = await startServer(serverBinary, ["--public-url", `http://localhost:${doorPort}`, "--livekit-url", `ws://localhost:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"]);
  const door = await new Recorder().start({ host: "127.0.0.1", port }, doorPort);
  check("the server's links name it by name", setupLink.startsWith(`http://localhost:${doorPort}/`), setupLink);
  const through = { host: "127.0.0.1", port: proxy.port, username: "zuna", password: PASSWORD };

  // --- Both sign up and talk, through the proxy alone ---
  let first = await startApp("first", APP_ENV);
  apps.push(first);
  await first.send({ proxy: through });
  check("the proxy is set before anything connects", door.ports.length === 0 && (await first.send({ connection: true })).ok?.proxy === `127.0.0.1:${proxy.port}`);
  await first.send({ proxy: "show" });
  await first.shot("proxy-dialog");
  await first.key("escape");
  const owner = await signUp(first, setupLink, "owner", "Proxy Owner");
  check("the owner signs up through the proxy", !!owner.ok, JSON.stringify(owner).slice(0, 300));
  const serverId = owner.ok?.serverId;
  const invite = (await first.core("createInvite", [10, 3600], serverId)).ok;
  const lounge = (await first.core("createChannel", [{ type: "voice", name: "Lounge" }], serverId)).ok;
  check("the owner makes a voice channel", typeof lounge === "string", String(lounge));
  let second = await startApp("second", APP_ENV);
  apps.push(second);
  await second.send({ proxy: through });
  const guest = await signUp(second, invite, "guest", "Proxy Guest");
  check("the guest signs up through the proxy", !!guest.ok, JSON.stringify(guest).slice(0, 300));
  const guestServerId = guest.ok?.serverId;

  // --- Started again, each goes through the proxy from its settings before anything connects ---
  first = await restart(first, "first");
  second = await restart(second, "second");
  const restarted = (await first.send({ connection: true })).ok;
  check("started again, the proxy is the one its settings keep", restarted?.proxy === `127.0.0.1:${proxy.port}`, JSON.stringify(restarted));
  await until(async () => ((await first.core("listServers")).ok ?? []).length === 1, "the owner's server", 30_000);
  const ownerId = ((await first.core("getSelf", [], serverId)).ok ?? {}).userId;
  await second.core("sendMessage", [`user:${ownerId}`, { text: "hello through a proxy" }], guestServerId);
  const heard = await until(async () => (await texts(first, serverId)).includes("hello through a proxy"), "the owner to read it", 30_000).catch(() => false);
  check("a message reaches the owner", heard);
  const guestId = ((await second.core("getSelf", [], guestServerId)).ok ?? {}).userId;
  await first.core("sendMessage", [`user:${guestId}`, { text: "and back" }], serverId);
  check("an answer reaches the guest", await until(async () => (await texts(second, guestServerId)).includes("and back"), "the guest to read it", 30_000).catch(() => false));
  const fixtures = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures");
  copyFileSync(join(fixtures, "chromium-opus.m4a"), join(work, "voice.m4a"));
  const sent = await second.core("sendWithAttachments", [`user:${ownerId}`, [{ blob: { $file: { path: join(work, "voice.m4a"), type: "audio/mp4" } }, name: "Voice message.m4a", mime: "audio/mp4", duration: 3, voice: true }], {}], guestServerId);
  check("a file goes through it", !!sent.ok, JSON.stringify(sent).slice(0, 200));
  await sleep(2000);
  await first.shot("chat");
  const strangers = door.strangers(proxy);
  check("every connection the server saw left the proxy", door.ports.length > 0 && strangers.length === 0, `${door.ports.length} seen, from elsewhere: ${strangers.join(", ")}`);
  const names = proxy.requests.filter((request) => request.kind !== "name" || request.host !== "localhost");
  check("the proxy was given the server's name, never an address", proxy.requests.length > 0 && names.length === 0, JSON.stringify(names.slice(0, 3)));
  check("every connection signed in", proxy.requests.every((request) => request.user === "zuna"));

  // --- A call, through relays on loopback and the proxy alone ---
  check("LiveKit runs", media.exitCode === null, media.output.slice(-300));
  const callThrough = async (way) => {
    const heardFrom = { first: first.log().length, second: second.log().length };
    await first.send({ voice: { server: serverId, channel: lounge } });
    await second.send({ voice: { server: guestServerId, channel: lounge } });
    const heard = await until(() => loudest(first, heardFrom.first) > 0.1 && loudest(second, heardFrom.second) > 0.1, "each to hear the other", 60_000).catch(() => false);
    check(`in a call ${way}, each hears the other's tone`, heard, `owner ${loudest(first, heardFrom.first)}, guest ${loudest(second, heardFrom.second)}`);
    const said = (await first.send({ way: true })).ok;
    check(`the stream stats say it goes through the proxy ${way}`, said === `Through the proxy, ${way}`, String(said));
    await first.shot(`call-${way.replace(/ /g, "-")}`);
    await first.send({ voice: null });
    await second.send({ voice: null });
    await sleep(2000);
  };
  const before = { requests: proxy.requests.length, datagrams: proxy.datagrams.length };
  await callThrough("over UDP");
  const toLiveKit = proxy.requests.slice(before.requests).filter((request) => request.port === liveKitPort);
  check("the call's signalling went through the proxy, to LiveKit by name", toLiveKit.length > 0 && toLiveKit.every((request) => request.host === "localhost" && request.kind === "name"), JSON.stringify(toLiveKit.slice(0, 2)));
  const datagrams = proxy.datagrams.slice(before.datagrams);
  check("its media went through the proxy to LiveKit's UDP port, and nowhere else", datagrams.length > 0 && datagrams.every((datagram) => datagram.port === liveKitPort + 2 && datagram.host === lan), JSON.stringify([...new Set(datagrams.map((datagram) => `${datagram.host}:${datagram.port}`))]));
  check("no STUN server was asked", !proxy.requests.slice(before.requests).some((request) => request.port === 3478 || request.port === 19302));

  // --- Watching together, the player's page through the proxy too ---
  const rejoinedFrom = { first: first.log().length, second: second.log().length };
  await first.send({ voice: { server: serverId, channel: lounge } });
  await second.send({ voice: { server: guestServerId, channel: lounge } });
  const rejoined = await until(() => loudest(first, rejoinedFrom.first) > 0.1 && loudest(second, rejoinedFrom.second) > 0.1, "both to be in the call again", 60_000).catch(() => false);
  check("both come into the call again", rejoined);
  const watching = await first.core("watchStart", [lounge, "https://youtu.be/aqz-KE-bpKQ?t=30"], serverId);
  check("the owner puts a video on", !watching.error, JSON.stringify(watching).slice(0, 200));
  await until(async () => !!(await second.core("getWatch", [lounge], guestServerId)).ok, "the guest to see the video", 15_000).catch(() => false);
  await first.send({ watchHere: true });
  await second.send({ watchHere: true });
  const inStep = await until(() => playerAt(first) === "in-step" && playerAt(second) === "in-step", "both players to come into step", 45_000).catch(() => false);
  check("both play it, from a page only the proxy could find", inStep, `${playerAt(first)}, ${playerAt(second)}`);
  check("the player came through the proxy, by name", proxy.requests.some((request) => request.host === PLAYER_NAME && request.kind === "name" && request.user === "zuna"));
  await first.shot("watching");
  await first.core("watchStop", [lounge], serverId);
  await first.send({ voice: null });
  await second.send({ voice: null });
  await sleep(2000);

  proxy.refuseUdp = true;
  const tcpFrom = proxy.requests.length;
  await callThrough("over TCP");
  check("with UDP refused, the media went over the proxy to LiveKit's TCP port", proxy.requests.slice(tcpFrom).some((request) => request.command === "connect" && request.port === liveKitPort + 1));
  proxy.refuseUdp = false;

  // --- With the proxy gone, nothing connects, and the app says why ---
  const seen = door.ports.length;
  await proxy.stop();
  const said = await until(async () => (await first.send({ connection: true })).ok?.trouble, "the app to say the proxy can't be reached", 30_000).catch(() => null);
  check("the app says it can't reach the proxy", !!said && said.startsWith("Can't reach the proxy"), String(said));
  await sleep(5000);
  await first.shot("proxy-gone");
  check("nothing goes around it meanwhile", door.ports.length === seen, `${door.ports.length - seen} connections`);
  await proxy.start(through.port);
  await first.core("sendMessage", [`user:${guestId}`, { text: "after the proxy came back" }], serverId);
  check("it comes back with the proxy", await until(async () => (await texts(second, guestServerId)).includes("after the proxy came back"), "the guest to read it", 60_000).catch(() => false));
  check("and still went through it alone", door.strangers(proxy).length === 0);

  // --- The wrong password connects to nothing either ---
  proxy.refusePassword = true;
  proxy.goAway();
  const refused = await until(async () => (await second.send({ connection: true })).ok?.trouble, "the app to say the password was refused", 30_000).catch(() => null);
  check("the app says the proxy refused the password", refused === "The proxy refused the username or password.", String(refused));
  await second.shot("password-refused");
  proxy.refusePassword = false;

  // --- Turned off, it connects directly ---
  await second.send({ proxy: null });
  await first.send({ proxy: null });
  await first.core("sendMessage", [`user:${guestId}`, { text: "with the proxy off" }], serverId);
  check("with the proxy off, it connects directly", await until(async () => (await texts(second, guestServerId)).includes("with the proxy off"), "the guest to read it", 60_000).catch(() => false));
  check("which the server saw", door.strangers(proxy).length > 0);
  await door.stop();
  await proxy.stop();
} finally {
  // Turned off, the app forgets the proxy's password, which leaves nothing in the keychain.
  for (const app of apps) await app.send({ proxy: null }).catch(() => undefined);
  if (media) writeFileSync(join(work, "livekit.log"), media.output);
  player.close();
  finish();
}
