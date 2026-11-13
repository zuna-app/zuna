// The native app through a SOCKS5 proxy (docs/SOCKS5_PLAN.md), on macOS: two copies of it,
// each set to go through the test proxy with a password (packages/core/test/socks-proxy.ts),
// to a test server reached by name and behind a door that writes down where each connection
// came from. Both sign up, start again with the proxy from their settings, write to each
// other and send a file, and every connection the server saw left the proxy, which was given
// the server's name, never an address. With the proxy gone they connect to nothing and say
// why, and come back with it. Turned off, the app connects directly again.
//
//   node apps/desktop/test/proxy-check.mjs [screenshot-dir]
//
// Calls through the proxy come next, and the check with them.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { build, root, session, sleep, until } from "./mac-session.mjs";
import { Recorder, SocksProxy } from "../../../packages/core/test/socks-proxy.ts";

const PASSWORD = "the proxy check's password";
const { server: serverBinary } = build();
const { work, check, startServer, startApp, finish } = session({ shots: process.argv[2] });

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

/** Quits a copy and starts it again in its folder, as the person would. */
async function restart(app, name) {
  await app.quit();
  await sleep(2500);
  apps.splice(apps.indexOf(app), 1);
  const again = await startApp(name);
  apps.push(again);
  return again;
}

try {
  const proxy = await new SocksProxy({ username: "zuna", password: PASSWORD }).start();
  const doorPort = 30000 + Math.floor(Math.random() * 20000);
  // Reached as localhost, so the proxy is given a name to resolve.
  const { port, setupLink } = await startServer(serverBinary, ["--public-url", `http://localhost:${doorPort}`]);
  const door = await new Recorder().start({ host: "127.0.0.1", port }, doorPort);
  check("the server's links name it by name", setupLink.startsWith(`http://localhost:${doorPort}/`), setupLink);
  const through = { host: "127.0.0.1", port: proxy.port, username: "zuna", password: PASSWORD };

  // --- Both sign up and talk, through the proxy alone ---
  let first = await startApp("first");
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
  let second = await startApp("second");
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
  finish();
}
