// A Telegram account linked on a device (docs/TELEGRAM_PLAN.md), against a fake engine that
// speaks TDLib's JSON: linking, the list, history, sending, reading, notifications and unlinking,
// what's kept apart from Zuna's chats, the mapping's checks, and media, stickers, drafts, the
// archive and groups. No server takes part.

import polish from "@zuna/i18n/locales/pl.json";
import { beforeAll, describe, expect, it } from "vitest";
import { ZunaClient } from "../src/client";
import { serveCore, type RpcPort } from "../src/rpc";
import { fromMarkup, toMarkup } from "../src/telegram/markup";
import { attachmentsOf, conversationView, messageView, userView, waveformFromTelegram, waveformToTelegram } from "../src/telegram/map";
import { previewText } from "../src/notify";
import { telegramNotifyTiming, telegramSendTiming } from "../src/telegram/session";
import { TELEGRAM_ID, type CoreEvent, type TelegramLink } from "../src/types";
import { BOT, CHANNEL, FakeTdlib, GRACE, GROUP, SECRET, SELF, serverId, sticker, textMessage } from "./fake-tdlib";
import { loadCrypto, MemoryDbProvider } from "./helpers";

beforeAll(loadCrypto);
// The fake's messages are dated long ago, so each notifies as one heard of late: a moment after the engine is online.
beforeAll(() => {
  telegramNotifyTiming.settle = 20;
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Waited for ${what}`);
    await settle(5);
  }
}

async function linkedClient(options: { authorized?: boolean; password?: string; restricted?: boolean; calls?: boolean; pushed?: boolean; engine?: FakeTdlib } = {}) {
  const engine = options.engine ?? new FakeTdlib();
  engine.authorized = options.authorized ?? false;
  engine.password = options.password ?? null;
  const events: CoreEvent[] = [];
  const db = new MemoryDbProvider();
  const client = new ZunaClient({
    db,
    deviceKey: new Uint8Array(32).fill(3),
    deviceName: "Test",
    onEvent: (event) => events.push(event),
    telegram: engine,
    telegramRestricted: options.restricted,
    telegramCalls: options.calls,
    telegramPushed: options.pushed,
  });
  await client.open();
  const link = () => [...events].reverse().find((event): event is Extract<CoreEvent, { type: "telegram" }> => event.type === "telegram")?.link;
  return { engine, events, client, db, link };
}

describe("linking a Telegram account", () => {
  it("links by a QR code, and puts the account's icon in the rail", async () => {
    const { engine, client, link } = await linkedClient();
    expect(client.telegramAvailable()).toBe(true);
    expect(client.listServers()).toEqual([]);
    client.linkTelegram();
    await until(() => link()?.step === "phone", "the phone step");
    await client.telegramSession.linkWithQr();
    const qr = await until(() => (link()?.step === "qr" ? (link() as Extract<TelegramLink, { step: "qr" }>) : null), "the QR step");
    expect(qr.link).toBe("tg://login?token=AQEGV_ZqeAeV");
    engine.confirm();
    await until(() => link()?.step === "ready", "being linked");
    await until(() => client.telegramSession.getConversations().length > 0, "the list");
    const [entry] = client.listServers();
    expect(entry).toMatchObject({ kind: "telegram", id: TELEGRAM_ID, name: "Telegram", userId: String(SELF), username: "ada" });
  });

  it("links by a phone number, its code and the account's password, and says what's wrong", async () => {
    const { client, link } = await linkedClient({ password: "secret" });
    client.linkTelegram();
    await until(() => link()?.step === "phone", "the phone step");
    await expect(client.telegramSession.linkWithPhone("12")).rejects.toThrow("country code");
    await expect(client.telegramSession.linkWithPhone("+1 555 0100")).rejects.toThrow("doesn't recognize this phone number");
    await client.telegramSession.linkWithPhone("+999 66 2 1234");
    const code = await until(() => (link()?.step === "code" ? (link() as Extract<TelegramLink, { step: "code" }>) : null), "the code step");
    expect(code).toMatchObject({ length: 5, via: "telegram", canResend: true });
    await expect(client.telegramSession.enterCode("11111")).rejects.toThrow("That code isn't right.");
    await client.telegramSession.enterCode("22-222");
    const password = await until(() => (link()?.step === "password" ? (link() as Extract<TelegramLink, { step: "password" }>) : null), "the password step");
    expect(password.hint).toBe("a dog's name");
    await expect(client.telegramSession.enterPassword("wrong")).rejects.toThrow("That password isn't right.");
    await client.telegramSession.enterPassword("secret");
    await until(() => link()?.step === "ready", "being linked");
  });

  it("lists nothing until Telegram lets the account in, and forgets one let go while the app was closed", async () => {
    const { engine, client, db, link } = await linkedClient();
    client.linkTelegram();
    await until(() => link()?.step === "phone", "the phone step");
    // Half linked: no icon, and nothing that starts by itself with the app.
    expect(client.listServers()).toEqual([]);
    client.stop();
    const again = new ZunaClient({ db, deviceKey: new Uint8Array(32).fill(3), deviceName: "Test", onEvent: () => undefined, telegram: engine });
    await again.open();
    expect(engine.started).toBe(1);
    // Linked, then its database lost while the app was closed: it asks to sign in again, and goes.
    again.linkTelegram();
    await again.telegramSession.linkWithQr();
    engine.confirm();
    await until(() => again.listServers().length === 1, "being linked");
    again.stop();
    engine.authorized = false;
    const third = new ZunaClient({ db, deviceKey: new Uint8Array(32).fill(3), deviceName: "Test", onEvent: () => undefined, telegram: engine });
    await third.open();
    await until(() => engine.stops.at(-1) === true, "being erased");
    await until(() => third.listServers().length === 0, "being forgotten");
  });

  it("makes no account: a number Telegram doesn't know is sent to Telegram's app", async () => {
    const { engine, client, link } = await linkedClient();
    client.linkTelegram();
    await until(() => link()?.step === "phone", "the phone step");
    engine.auth("authorizationStateWaitRegistration", { terms_of_service: null });
    await until(() => link()?.step === "signup", "the sign-up step");
    expect(engine.requests("registerUser")).toEqual([]);
  });

  it("starts an engine the broker gave up on again when the app comes back, and only then", async () => {
    const { engine, events, client, link } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => link()?.step === "ready", "being linked");
    const connection = () => [...events].reverse().find((event): event is Extract<CoreEvent, { type: "connection" }> => event.type === "connection" && event.serverId === TELEGRAM_ID)?.state;
    // Back on screen with the engine running: nothing starts again.
    client.nudge();
    expect(engine.started).toBe(1);
    // The helper kept failing to start, as while iOS held the app in the background.
    engine.emit({ "@type": "zunaFailed", reason: "Telegram's engine couldn't start." });
    await until(() => link()?.step === "failed", "the failure");
    expect(connection()).toBe("offline");
    client.nudge();
    expect(engine.started).toBe(2);
    expect(connection()).toBe("connecting");
    await until(() => link()?.step === "ready", "being back");
    await until(() => connection() === "online", "being online");
    client.nudge();
    expect(engine.started).toBe(2);
    expect(engine.stops).toEqual([]);
  });

  it("is connecting while its broker starts the engine again, and while it goes on trying", async () => {
    const { engine, events, client, link } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => link()?.step === "ready", "being linked");
    const connection = () => [...events].reverse().find((event): event is Extract<CoreEvent, { type: "connection" }> => event.type === "connection" && event.serverId === TELEGRAM_ID)?.state;
    await until(() => connection() === "online", "being online");
    await until(() => client.telegramSession.getConversations().length > 0, "the list");
    // The engine went and its broker started another, which hasn't said anything yet: what the
    // one before it said of its connection isn't shown as this one's.
    const asked = client.telegramSession.setPinned(String(GRACE), String(serverId(1)), true).then(
      () => "answered",
      (error: Error) => error.message,
    );
    engine.emit({ "@type": "zunaRestarted" });
    expect(connection()).toBe("connecting");
    expect(client.telegramSession.getConnectionState()).toBe("connecting");
    // What was asked of the engine that went is answered by nobody.
    expect(await asked).toContain("Telegram restarted.");
    engine.emit({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
    expect(connection()).toBe("online");
    // It kept failing, and the broker says so while it goes on trying by itself, as the iPhone's
    // does: still connecting, never "waiting for network", and back on screen starts it now.
    engine.emit({ "@type": "zunaFailed", reason: "Telegram's engine stopped.", retrying: true });
    await until(() => link()?.step === "failed", "the failure");
    expect(connection()).toBe("connecting");
    // The broker's own next try came first: nothing is left for coming back on screen to start.
    engine.emit({ "@type": "zunaRestarted" });
    client.nudge();
    expect(engine.started).toBe(1);
    engine.emit({ "@type": "zunaFailed", reason: "Telegram's engine stopped.", retrying: true });
    client.nudge();
    expect(engine.started).toBe(2);
    // Linked by then, which the host is told: it starts nothing where the account's database isn't.
    expect(engine.startedLinked).toEqual([false, true]);
    await until(() => link()?.step === "ready", "being back");
    await until(() => connection() === "online", "being online again");
    expect(engine.stops).toEqual([]);
  });

  it("starts again with the app, without linking again", async () => {
    const { engine, client, db } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => client.telegramSession.getConversations().length > 0, "the list");
    client.stop();
    expect(engine.stops).toEqual([false]);
    const again = new ZunaClient({ db, deviceKey: new Uint8Array(32).fill(3), deviceName: "Test", onEvent: () => undefined, telegram: engine });
    await again.open();
    expect(engine.started).toBe(2);
    // The host is told which start is of an account signed in before: its database has to be
    // there, where one being linked starts from nothing.
    expect(engine.startedLinked).toEqual([false, true]);
    await until(() => again.telegramSession.getConversations().length > 0, "the list after starting again");
    // A host without the engine has no Telegram, though this device linked one.
    const web = new ZunaClient({ db, deviceKey: new Uint8Array(32).fill(3), deviceName: "Test", onEvent: () => undefined });
    await web.open();
    expect(web.telegramAvailable()).toBe(false);
    expect(() => web.linkTelegram()).toThrow("can't use Telegram");
  });
});

describe("a linked account's chats", () => {
  async function ready() {
    const linked = await linkedClient({ authorized: true });
    linked.client.linkTelegram();
    await until(() => linked.client.telegramSession.getConversations().length === 3, "the list");
    return { ...linked, session: linked.client.telegramSession };
  }

  it("lists people and groups, never channels or secret chats, with Telegram's marks", async () => {
    const { session } = await ready();
    const list = session.getConversations();
    expect(list.map((chat) => chat.key).sort()).toEqual([`group:${GROUP}`, `user:${BOT}`, `user:${GRACE}`].sort());
    expect(list.some((chat) => chat.groupId === String(CHANNEL) || chat.groupId === String(SECRET))).toBe(false);
    const grace = list.find((chat) => chat.key === `user:${GRACE}`)!;
    expect(grace).toMatchObject({ kind: "dm", peerId: String(GRACE), title: "Grace Hopper", unread: 1, muted: false, readBy: { [GRACE]: serverId(2) }, ownRead: serverId(1) });
    expect(grace.lastMessage?.text).toBe("See you at 8? **bold**");
    const group = list.find((chat) => chat.key === `group:${GROUP}`)!;
    expect(group).toMatchObject({ kind: "group", pinned: true, muted: true, mutedUntil: null });
    const bot = list.find((chat) => chat.key === `user:${BOT}`)!;
    expect(bot).toMatchObject({ bot: true, markedUnread: true });
    expect(session.getPreferences()).toMatchObject({ pinned: [`group:${GROUP}`], muted: [`group:${GROUP}`], markedUnread: [`user:${BOT}`] });
    const users = session.getUsers();
    expect(users.find((user) => user.id === String(SELF))).toMatchObject({ isSelf: true, displayName: "Ada Lovelace" });
    expect(users.find((user) => user.id === String(BOT))?.bot).not.toBeNull();
    // What Telegram here hasn't got is asked for alike, and empty.
    expect([session.getChannels(), session.getCalls(), session.getVoiceMembers(), session.getSounds(), session.getNewDevices()]).toEqual([[], [], [], [], []]);
  });

  it("reads history newest last, and opens the chat for TDLib", async () => {
    const { engine, session } = await ready();
    const page = await session.loadMessages(String(GRACE));
    expect(page.messages.map((message) => message.text)).toEqual(["Hello Ada", "Hi! How are you?", "See you at 8? **bold**"]);
    expect(page.messages[1]).toMatchObject({ senderId: String(SELF), seq: serverId(2), status: "sent" });
    expect(engine.requests("openChat")).toEqual([expect.objectContaining({ chat_id: GRACE })]);
    const older = await session.loadMessages(String(GRACE), serverId(2));
    expect(older.messages.map((message) => message.id)).toEqual([String(serverId(1))]);
    await expect(session.loadMessages(String(CHANNEL))).rejects.toThrow("Telegram chat isn't available here");
  });

  it("sends with Zuna's markup as Telegram's entities, and the sent message takes Telegram's number", async () => {
    const { engine, events, session } = await ready();
    const pending = await session.sendMessage(`user:${GRACE}`, { text: "**On** my way", replyTo: String(serverId(3)) });
    expect(pending.status).toBe("sending");
    const [request] = engine.requests("sendMessage");
    expect(request.input_message_content.text).toEqual({ "@type": "formattedText", text: "On my way", entities: [{ offset: 0, length: 2, type: { "@type": "textEntityTypeBold" } }] });
    expect(request.reply_to).toMatchObject({ message_id: serverId(3) });
    const moved = await until(() => events.find((event) => event.type === "message" && event.message.id === String(serverId(101))), "the sent message");
    // In one event, which says whose place it takes, so the chat swaps the row where it is.
    expect(events.some((event) => event.type === "message_removed" && event.id === pending.id)).toBe(false);
    expect(moved).toMatchObject({ message: { status: "sent", text: "**On** my way" }, isNew: false, replaces: pending.id });
    await expect(session.sendMessage(`user:${GRACE}`, { text: "a file", attachments: [{} as never] })).rejects.toThrow("Files uploaded to a Zuna server can't be sent to Telegram");
  });

  it("mentions someone by name as Telegram's apps do, with or without a username", async () => {
    const { engine, session } = await ready();
    await session.sendMessage(`group:${GROUP}`, { text: `**Hi** [Grace](tg://user?id=${GRACE}), [Ada](tg://user?id=${SELF})!` });
    const [request] = engine.requests("sendMessage");
    expect(request.input_message_content.text).toEqual({
      "@type": "formattedText",
      text: "Hi Grace, Ada!",
      entities: [
        { offset: 0, length: 2, type: { "@type": "textEntityTypeBold" } },
        { offset: 3, length: 5, type: { "@type": "textEntityTypeMentionName", user_id: GRACE } },
        { offset: 10, length: 3, type: { "@type": "textEntityTypeMentionName", user_id: SELF } },
      ],
    });
    // What a mention says is someone's first name, which every person Telegram tells of has.
    expect(session.getUsers().find((user) => user.id === String(GRACE))?.firstName).toBeTruthy();
  });

  it("reads up to a message on every device, and hears when another device read", async () => {
    const { engine, events, session } = await ready();
    await session.markRead(String(GRACE), serverId(3));
    expect(engine.requests("viewMessages")).toEqual([expect.objectContaining({ chat_id: GRACE, message_ids: [serverId(3)], force_read: true })]);
    await until(() => events.find((event) => event.type === "read" && event.userId === String(SELF) && event.seq === serverId(3)), "the read event");
    // Nothing goes for what's already read.
    await session.markRead(String(GRACE), serverId(1));
    expect(engine.requests("viewMessages")).toHaveLength(1);
    engine.emit({ "@type": "updateChatReadOutbox", chat_id: GRACE, last_read_outbox_message_id: serverId(3) });
    await until(() => events.find((event) => event.type === "read" && event.userId === String(GRACE)), "Grace reading");
  });

  it("notifies as Telegram would, and shows typing", async () => {
    const { engine, events, session } = await ready();
    const notified = () => events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify");
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(10), GRACE, "Are you there?") });
    await until(() => notified().length === 1, "a notification");
    expect(notified()[0]).toMatchObject({ serverId: TELEGRAM_ID, title: "Grace Hopper", body: "Are you there?", conversationKey: `user:${GRACE}`, messageId: String(serverId(10)) });
    // Not for this account's own, nor a silent one, nor in a muted chat, unless it mentions this account.
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(11), SELF, "Yes") });
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(12), GRACE, "shh", { disable_notification: true }) });
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GROUP, serverId(13), GRACE, "Muted") });
    await settle();
    expect(notified()).toHaveLength(1);
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GROUP, serverId(14), GRACE, "@ada look", { contains_unread_mention: true }) });
    await until(() => notified().length === 2, "a mention in a muted group");
    expect(notified()[1]).toMatchObject({ title: "Weekend trip", body: "Grace Hopper: @ada look" });
    // A channel's posts never.
    engine.emit({ "@type": "updateNewMessage", message: textMessage(CHANNEL, serverId(15), GRACE, "News") });
    await settle();
    expect(notified()).toHaveLength(2);
    expect(events.some((event) => event.type === "message" && event.message.groupId === String(CHANNEL))).toBe(false);

    engine.emit({ "@type": "updateChatAction", chat_id: GRACE, message_thread_id: 0, sender_id: { "@type": "messageSenderUser", user_id: GRACE }, action: { "@type": "chatActionTyping" } });
    await until(() => events.find((event) => event.type === "typing" && event.userId === String(GRACE)), "typing");
    session.sendTyping(String(GRACE));
    session.sendTyping(String(GRACE));
    expect(engine.requests("sendChatAction")).toHaveLength(1);
  });

  it("notifies of what it hears late only once it has caught up, and only if it's still unread", async () => {
    const { engine, events } = await ready();
    telegramNotifyTiming.settle = 150;
    try {
      const notified = () => events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify").map((event) => event.body);
      const now = () => Math.floor(Date.now() / 1000);
      const connection = (state: string) => engine.emit({ "@type": "updateConnectionState", state: { "@type": state } });
      const from = (id: number, text: string, date = now()) => engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(id), GRACE, text, { date }) });
      // One that comes as it's sent notifies at once.
      from(20, "Now");
      await until(() => notified().length === 1, "the message sent now", 100);
      // Read already, on another device, it never does.
      from(1, "Read long ago");
      // While the engine catches up, as after its computer slept, nothing notifies yet, however new.
      connection("connectionStateUpdating");
      from(21, "While away, read elsewhere");
      from(22, "While away, deleted");
      from(23, "While away, still unread");
      // That the chat was read on another device comes after its messages.
      engine.emit({ "@type": "updateChatReadInbox", chat_id: GRACE, last_read_inbox_message_id: serverId(21), unread_count: 2 });
      engine.emit({ "@type": "updateDeleteMessages", chat_id: GRACE, message_ids: [serverId(22)], is_permanent: true, from_cache: false });
      await settle(250);
      expect(notified()).toEqual(["Now"]);
      connection("connectionStateReady");
      await settle(60);
      expect(notified()).toEqual(["Now"]);
      await until(() => notified().length === 2, "what's still unread");
      expect(notified()).toEqual(["Now", "While away, still unread"]);
      // A group's messages can come after the engine says it's caught up: one sent a while ago waits too.
      from(24, "From a minute ago", now() - 60);
      from(25, "From a minute ago, read elsewhere", now() - 60);
      engine.emit({ "@type": "updateChatReadInbox", chat_id: GRACE, last_read_inbox_message_id: serverId(24), unread_count: 1 });
      await settle(60);
      expect(notified()).toHaveLength(2);
      await until(() => notified().length === 3, "the one from a minute ago");
      expect(notified()[2]).toBe("From a minute ago, read elsewhere");
    } finally {
      telegramNotifyTiming.settle = 20;
    }
  });

  it("notifies of nothing it hears late where Telegram pushes the device, as a phone", async () => {
    const { engine, events, client } = await linkedClient({ authorized: true, pushed: true });
    client.linkTelegram();
    await until(() => client.telegramSession.getConversations().length === 3, "the list");
    const notified = () => events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify").map((event) => event.body);
    const now = () => Math.floor(Date.now() / 1000);
    const from = (id: number, text: string, date = now()) => engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(id), GRACE, text, { date }) });
    // What came while the app was away, Telegram pushed, or left untold as read on another device.
    engine.emit({ "@type": "updateConnectionState", state: { "@type": "connectionStateUpdating" } });
    from(20, "While the app was away");
    engine.emit({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
    from(21, "From hours ago", now() - 3 * 3600);
    await settle(80);
    expect(notified()).toEqual([]);
    // What comes while the app runs still notifies, as nothing pushes that.
    from(22, "Now");
    await until(() => notified().length === 1, "the message sent now", 100);
    // The messages themselves show in their chat all the same.
    expect(events.filter((event) => event.type === "message" && event.isNew).length).toBe(3);
  });

  it("tells how old a message is by Telegram's clock, not the device's", async () => {
    // The device's clock is an hour ahead of Telegram's: by it, every message was sent an hour ago.
    const engine = new FakeTdlib();
    engine.clock = () => Date.now() - 3_600_000;
    const { events, client } = await linkedClient({ authorized: true, pushed: true, engine });
    client.linkTelegram();
    await until(() => client.telegramSession.getConversations().length === 3, "the list");
    await until(() => engine.requests("getOption").some((request) => request.name === "unix_time"), "asking for Telegram's clock");
    await settle();
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(20), GRACE, "Now", { date: Math.floor(engine.clock() / 1000) }) });
    await until(() => events.some((event) => event.type === "notify"), "the message sent now", 100);
  });

  it("drops what it doesn't know, and keeps what was edited, reacted to and deleted in step", async () => {
    const { engine, events, session } = await ready();
    await session.loadMessages(String(GRACE));
    engine.emit({ "@type": "updateSomethingNew", chat_id: GRACE, secret: "x" });
    engine.emit({ "@type": "updateMessageEdited", chat_id: GRACE, message_id: serverId(1), edit_date: 1_700_000_500, reply_markup: null });
    const edited = await until(() => events.find((event) => event.type === "message" && event.message.id === String(serverId(1))), "the edit");
    expect(edited).toMatchObject({ message: { editedAt: 1_700_000_500_000 } });
    engine.emit({
      "@type": "updateMessageInteractionInfo",
      chat_id: GRACE,
      message_id: serverId(2),
      interaction_info: { reactions: { reactions: [{ type: { "@type": "reactionTypeEmoji", emoji: "👍" }, total_count: 3, is_chosen: true, recent_sender_ids: [{ "@type": "messageSenderUser", user_id: GRACE }] }] } },
    });
    const reacted = await until(() => events.find((event) => event.type === "message" && event.message.id === String(serverId(2)) && event.message.reactions.length > 0), "the reaction");
    expect(reacted).toMatchObject({ message: { reactions: [{ key: "👍", userIds: [String(SELF), String(GRACE), "?0"] }] } });
    await session.toggleReaction(String(GRACE), String(serverId(2)), "👍");
    expect(engine.requests("removeMessageReaction")).toHaveLength(1);
    // Only what's gone from Telegram goes from the chat, not what left TDLib's cache.
    engine.emit({ "@type": "updateDeleteMessages", chat_id: GRACE, message_ids: [serverId(1)], is_permanent: false, from_cache: true });
    engine.emit({ "@type": "updateDeleteMessages", chat_id: GRACE, message_ids: [serverId(2)], is_permanent: true, from_cache: false });
    await until(() => events.find((event) => event.type === "message_removed" && event.id === String(serverId(2))), "the deletion");
    expect(events.some((event) => event.type === "message_removed" && event.id === String(serverId(1)))).toBe(false);
  });

  it("mutes and marks chats on Telegram itself", async () => {
    const { engine, session } = await ready();
    await session.mute(`user:${GRACE}`);
    expect(engine.requests("setChatNotificationSettings")[0]).toMatchObject({ chat_id: GRACE, notification_settings: { use_default_mute_for: false, mute_for: 0x7fffffff, use_default_sound: true } });
    await session.unmute(`user:${GRACE}`);
    expect(engine.requests("setChatNotificationSettings")[1].notification_settings.mute_for).toBe(0);
    await session.setMarkedUnread(`user:${GRACE}`, true);
    expect(engine.requests("toggleChatIsMarkedAsUnread")).toEqual([expect.objectContaining({ chat_id: GRACE, is_marked_as_unread: true })]);
    await session.setPinnedChats([`user:${GRACE}`]);
    expect(engine.requests("toggleChatIsPinned").map((request) => [request.chat_id, request.is_pinned])).toEqual(
      expect.arrayContaining([
        [GRACE, true],
        [GROUP, false],
      ]),
    );
  });

  it("calls the chat with oneself by the language shown, and has the list read again when it changes", async () => {
    const { engine, events, client, session } = await ready();
    const listed = [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order: "8000", is_pinned: false }];
    engine.emit({ "@type": "updateNewChat", chat: { "@type": "chat", id: SELF, type: { "@type": "chatTypePrivate", user_id: SELF }, title: "Ada Lovelace", positions: listed } });
    const saved = () => session.getConversations().find((chat) => chat.key === `user:${SELF}`)?.title;
    expect(await until(saved, "Saved messages")).toBe("Saved messages");
    const seen = events.length;
    try {
      client.setLanguage("pl", polish);
      expect(saved()).toBe("Zapisane wiadomości");
      // The interface holds the list it read, so it's told to read it again.
      expect(events.slice(seen)).toEqual(expect.arrayContaining([{ type: "conversations", serverId: TELEGRAM_ID }, { type: "users", serverId: TELEGRAM_ID }]));
    } finally {
      client.setLanguage("en", null);
    }
    expect(saved()).toBe("Saved messages");
  });
});

describe("unlinking", () => {
  it("signs out at Telegram and erases what's here", async () => {
    const { engine, client, link } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => link()?.step === "ready", "being linked");
    expect(await client.unlinkTelegram()).toEqual({ signedOut: true });
    expect(engine.stops).toEqual([true]);
    expect(link()).toEqual({ step: "unlinked", signedOut: true });
    expect(client.listServers()).toEqual([]);
    expect(() => client.telegramSession).toThrow("No Telegram account is linked here.");
  });

  it("erases what's here when its session is ended from another device", async () => {
    const { engine, client, link } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => link()?.step === "ready", "being linked");
    engine.authorized = false;
    engine.auth("authorizationStateLoggingOut");
    engine.auth("authorizationStateClosed");
    await until(() => link()?.step === "unlinked", "being unlinked");
    expect(engine.stops).toEqual([true]);
    expect(client.listServers()).toEqual([]);
  });
});

describe("kept apart from Zuna's chats", () => {
  it("answers only its own list over RPC, and forwards nothing either way", async () => {
    const { engine, client } = await linkedClient({ authorized: true });
    client.linkTelegram();
    await until(() => client.telegramSession.getConversations().length > 0, "the list");
    const replies: any[] = [];
    const port: RpcPort = { postMessage: (message) => replies.push(message), onmessage: null };
    serveCore(port, () => client);
    const call = async (id: number, method: string, args: unknown[] = []) => {
      port.onmessage!({ data: { kind: "call", id, serverId: TELEGRAM_ID, method, args } } as MessageEvent);
      return until(() => replies.find((reply) => reply.id === id), method);
    };
    expect((await call(1, "getConversations")).ok).toBe(true);
    // A server's own methods aren't the Telegram account's.
    for (const [id, method] of [[2, "getDevices"], [3, "createChannel"], [4, "voiceAccess"], [5, "forwardMessage"]] as const) {
      expect(await call(id, method)).toMatchObject({ ok: false, error: { message: "This operation isn't supported." } });
    }
    await expect(client.forwardMessages(TELEGRAM_ID, String(GRACE), [String(serverId(1))], "some-server", "user:x")).rejects.toThrow("Nothing is forwarded between Zuna and Telegram.");
    await expect(client.forwardMessages("some-server", "g", ["m"], TELEGRAM_ID, `user:${GRACE}`)).rejects.toThrow("Nothing is forwarded between Zuna and Telegram.");
    expect(engine.requests("forwardMessages")).toEqual([]);
  });
});

describe("Telegram's text and Zuna's markup", () => {
  it("turns entities into markup and back", () => {
    const text = "Bold italic strike spoiler code";
    const entities = [
      { offset: 0, length: 4, type: { "@type": "textEntityTypeBold" } },
      { offset: 5, length: 6, type: { "@type": "textEntityTypeItalic" } },
      { offset: 12, length: 6, type: { "@type": "textEntityTypeStrikethrough" } },
      { offset: 19, length: 7, type: { "@type": "textEntityTypeSpoiler" } },
      { offset: 27, length: 4, type: { "@type": "textEntityTypeCode" } },
    ];
    const markup = toMarkup({ text, entities });
    expect(markup).toBe("**Bold** *italic* ~~strike~~ ||spoiler|| `code`");
    expect(fromMarkup(markup)).toEqual({ text, entities });
  });

  it("nests marks, and puts a link's address beside its words", () => {
    expect(toMarkup({ text: "very bold", entities: [{ offset: 0, length: 9, type: { "@type": "textEntityTypeBold" } }, { offset: 5, length: 4, type: { "@type": "textEntityTypeItalic" } }] })).toBe("**very *bold***");
    expect(toMarkup({ text: "see here", entities: [{ offset: 4, length: 4, type: { "@type": "textEntityTypeTextUrl", url: "https://example.com" } }] })).toBe("see here (https://example.com)");
    // A script's address stays out.
    expect(toMarkup({ text: "see here", entities: [{ offset: 4, length: 4, type: { "@type": "textEntityTypeTextUrl", url: "javascript:alert(1)" } }] })).toBe("see here");
    // What Zuna has no mark for stays plain.
    expect(toMarkup({ text: "under", entities: [{ offset: 0, length: 5, type: { "@type": "textEntityTypeUnderline" } }] })).toBe("under");
  });

  it("keeps code blocks and quotes on lines of their own", () => {
    const markup = toMarkup({ text: "look:\nlet x = 1;\nquoted line\nsecond", entities: [{ offset: 6, length: 10, type: { "@type": "textEntityTypePreCode", language: "js" } }, { offset: 17, length: 18, type: { "@type": "textEntityTypeBlockQuote" } }] });
    expect(markup).toBe("look:\n```js\nlet x = 1;\n```\n> quoted line\n> second");
    expect(fromMarkup("look:\n```js\nlet x = 1;\n```\n> quoted line\n> second")).toEqual({
      text: "look:\nlet x = 1;\nquoted line\nsecond",
      entities: [
        { offset: 6, length: 10, type: { "@type": "textEntityTypePreCode", language: "js" } },
        { offset: 17, length: 18, type: { "@type": "textEntityTypeBlockQuote" } },
      ],
    });
  });

  it("counts in UTF-16 as Telegram does", () => {
    const text = "👋 hi there";
    const markup = toMarkup({ text, entities: [{ offset: 3, length: 2, type: { "@type": "textEntityTypeBold" } }] });
    expect(markup).toBe("👋 **hi** there");
    expect(fromMarkup(markup)).toEqual({ text, entities: [{ offset: 3, length: 2, type: { "@type": "textEntityTypeBold" } }] });
  });
});

describe("what the engine says is checked", () => {
  const context = { selfId: SELF, now: 1_800_000_000_000, find: () => undefined, nameOf: () => "Someone" };

  it("leaves out what isn't a message, a user or a chat it lists", () => {
    expect(messageView({ "@type": "message", id: "1", chat_id: GRACE }, context)).toBeNull();
    expect(messageView({ "@type": "message", id: 2 ** 60, chat_id: GRACE }, context)).toBeNull();
    expect(userView({ "@type": "user", id: -0.5 }, SELF)).toBeNull();
    const channel = { "@type": "chat", id: CHANNEL, type: { "@type": "chatTypeSupergroup", is_channel: true }, positions: [{ list: { "@type": "chatListMain" }, order: "1" }] };
    expect(conversationView(channel, { selfId: SELF, now: 0, defaults: { private: 0, group: 0 }, users: new Map(), lastMessage: null })).toBeNull();
    const unlisted = { "@type": "chat", id: GRACE, type: { "@type": "chatTypePrivate", user_id: GRACE }, positions: [] };
    expect(conversationView(unlisted, { selfId: SELF, now: 0, defaults: { private: 0, group: 0 }, users: new Map(), lastMessage: null })).toBeNull();
  });

  it("calls the chat with oneself Saved messages, whatever name TDLib gives it", () => {
    const listed = [{ list: { "@type": "chatListMain" }, order: "1" }];
    const chats = { selfId: SELF, now: 0, defaults: { private: 0, group: 0 }, users: new Map(), lastMessage: null };
    const saved = conversationView({ "@type": "chat", id: SELF, type: { "@type": "chatTypePrivate", user_id: SELF }, title: "Ada Lovelace", positions: listed }, chats)!;
    expect(saved.title).toBe("Saved messages");
    expect(saved.peerId).toBe(String(SELF));
    const other = conversationView({ "@type": "chat", id: GRACE, type: { "@type": "chatTypePrivate", user_id: GRACE }, title: "Grace Hopper", positions: listed }, chats)!;
    expect(other.title).toBe("Grace Hopper");
  });

  it("holds strings, entities, buttons and places to their limits", () => {
    const long = "x".repeat(100_000);
    const message = messageView(
      {
        ...textMessage(GRACE, serverId(1), GRACE, ""),
        content: { "@type": "messageText", text: { text: long, entities: [{ offset: 99_990, length: 5, type: { "@type": "textEntityTypeBold" } }, { offset: -1, length: 3, type: { "@type": "textEntityTypeBold" } }] } },
        reply_markup: { "@type": "replyMarkupInlineKeyboard", rows: [[{ text: "Open", type: { "@type": "inlineKeyboardButtonTypeUrl", url: "javascript:alert(1)" } }, { text: "Go", type: { "@type": "inlineKeyboardButtonTypeUrl", url: "https://t.me/x" } }, { text: "Press", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "AQID" } }]] },
      },
      context,
    )!;
    expect(message.text).toHaveLength(16384);
    expect(message.buttons).toEqual([[{ text: "Go", url: "https://t.me/x" }, { text: "Press", data: "AQID" }]]);
    const place = messageView({ ...textMessage(GRACE, serverId(2), GRACE, ""), content: { "@type": "messageLocation", location: { latitude: 200, longitude: 0 } } }, context)!;
    expect(place.location).toBeNull();
  });

  it("says what Zuna can't show yet, and keeps its words", () => {
    const photo = messageView({ ...textMessage(GRACE, serverId(1), GRACE, ""), content: { "@type": "messagePhoto", caption: { text: "Sunset", entities: [] } } }, context)!;
    expect(photo.text).toBe("Sunset\n*Zuna can't display this yet: Photo. You can see it in the Telegram app.*");
    const once = messageView({ ...textMessage(GRACE, serverId(2), GRACE, ""), content: { "@type": "messagePhoto", caption: { text: "", entities: [] }, self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" } } }, context)!;
    expect(once.text).toContain("Photo (view once)");
    const joined = messageView({ ...textMessage(GROUP, serverId(3), GRACE, ""), content: { "@type": "messageChatAddMembers", member_user_ids: [BOT, "x"] } }, context)!;
    expect(joined.system).toEqual({ type: "member_added", actorId: String(GRACE), targetIds: [String(BOT)] });
    const call = messageView({ ...textMessage(GRACE, serverId(4), GRACE, ""), content: { "@type": "messageCall", is_video: false, discard_reason: { "@type": "callDiscardReasonMissed" }, duration: 0 } }, context)!;
    expect(call.text).toBe("*Missed call*");
  });
});

describe("media, stickers and groups", () => {
  const context = { selfId: SELF, now: 1_800_000_000_000, find: () => undefined, nameOf: () => "Someone" };
  const sent = (content: Record<string, unknown>) => messageView({ ...textMessage(GRACE, serverId(9), GRACE, ""), content }, context)!;

  async function ready() {
    const linked = await linkedClient({ authorized: true });
    linked.client.linkTelegram();
    await until(() => linked.client.telegramSession.getConversations().length === 3, "the list");
    return { ...linked, session: linked.client.telegramSession };
  }

  it("shows Telegram's photos, voice messages, files and stickers as the app's attachments", () => {
    const photo = sent({
      "@type": "messagePhoto",
      caption: { text: "Sunset", entities: [] },
      photo: {
        minithumbnail: { data: "AAEC" },
        sizes: [
          { type: "m", photo: { id: 11, size: 900 }, width: 320, height: 240 },
          { type: "y", photo: { id: 12, size: 90_000 }, width: 1280, height: 960 },
          { type: "w", photo: { id: 13, size: 900_000 }, width: 2560, height: 1920 },
        ],
      },
    });
    // The largest that fits in 1280 pixels, as Telegram's apps pick it.
    expect(photo.text).toBe("Sunset");
    expect(photo.attachments).toEqual([{ fileId: "tg:12", key: "", prefix: "", chunks: 0, size: 90_000, name: "photo.jpg", mime: "image/jpeg", width: 1280, height: 960, thumb: "data:image/jpeg;base64,AAEC" }]);
    const voice = sent({ "@type": "messageVoiceNote", caption: { text: "", entities: [] }, voice_note: { duration: 3, waveform: waveformToTelegram(btoa("\xff\x00".repeat(50))), mime_type: "audio/ogg", voice: { id: 21, size: 4000 } } });
    expect(voice.attachments[0]).toMatchObject({ fileId: "tg:21", voice: true, duration: 3, mime: "audio/ogg" });
    // A name is only a name: nothing in it can point anywhere on the device.
    const file = sent({ "@type": "messageDocument", caption: { text: "", entities: [] }, document: { file_name: "../../evil.exe", mime_type: "not a type", document: { id: 31, size: 10 } } });
    expect(file.attachments[0]).toMatchObject({ name: "_.._evil.exe", mime: "application/octet-stream" });
    const still = sent({ "@type": "messageSticker", sticker: sticker(801, "🐱") });
    expect(still.text).toBe("");
    expect(still.attachments[0]).toMatchObject({ fileId: "tg:801", sticker: true, mime: "image/webp", width: 512, height: 512 });
    expect(previewText(still)).toBe("🖼️ Sticker");
    // An animated one with nothing still to show is its emoji.
    const animated = sent({ "@type": "messageSticker", sticker: sticker(803, "🙀", false) });
    expect(animated).toMatchObject({ text: "🙀", attachments: [] });
    // Seen once, it's never downloaded here.
    const once = sent({ "@type": "messagePhoto", caption: { text: "", entities: [] }, photo: { sizes: [{ photo: { id: 41 }, width: 10, height: 10 }] }, self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" } });
    expect(once.attachments).toEqual([]);
    expect(attachmentsOf({ "@type": "messagePhoto", photo: { sizes: [{ photo: { id: "41" }, width: 10, height: 10 }] } })).toBeNull();
  });

  it("packs a voice message's loudness as Telegram does, and back", () => {
    const bars = Uint8Array.from({ length: 100 }, (_, index) => (index * 37) % 256);
    const packed = waveformToTelegram(btoa(String.fromCharCode(...bars)));
    expect(atob(packed)).toHaveLength(63);
    const back = Uint8Array.from(atob(waveformFromTelegram(packed)!), (char) => char.charCodeAt(0));
    expect(back).toHaveLength(100);
    for (const [index, value] of back.entries()) expect(Math.abs(value - bars[index]!)).toBeLessThanOrEqual(5);
    expect(waveformToTelegram(undefined)).toBe("");
    expect(waveformFromTelegram("not base64!")).toBeUndefined();
  });

  it("hands over a file Telegram downloaded, and nothing that isn't one of its files", async () => {
    const { session } = await ready();
    const file = await session.downloadFile({ fileId: "tg:12", mime: "image/jpeg" });
    expect(file.type).toBe("image/jpeg");
    expect(await file.text()).toBe("C:/zuna/telegram/photos/12.jpg");
    await expect(session.downloadFile({ fileId: "abc" })).rejects.toThrow("This file isn't from Telegram.");
    await expect(session.downloadFile({ fileId: "tg:404" })).rejects.toThrow();
  });

  it("sends files a part at a time as TDLib asks, pictures together as one album", async () => {
    const { engine, session, events } = await ready();
    const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * seed) % 251);
    const big = bytes(600_000, 7);
    const pictures = [
      { blob: new Blob([bytes(1000, 3)], { type: "image/png" }), name: "a.png", mime: "image/png", width: 40, height: 30 },
      { blob: new Blob([bytes(2000, 5)], { type: "image/jpeg" }), name: "b.jpg", mime: "image/jpeg", width: 30, height: 40 },
    ];
    await session.sendWithAttachments(`user:${GRACE}`, pictures, { text: "**Look**" }, { keepMetadata: true });
    const [album] = engine.requests("sendMessageAlbum");
    expect(album!.input_message_contents.map((content: any) => content["@type"])).toEqual(["inputMessagePhoto", "inputMessagePhoto"]);
    expect(album!.input_message_contents[0].caption).toMatchObject({ text: "Look", entities: [{ offset: 0, length: 4, type: { "@type": "textEntityTypeBold" } }] });
    expect(album!.input_message_contents[1].caption.text).toBe("");
    await until(() => [...engine.generated.values()].filter((file) => file.finished).length === 2, "both pictures written");
    const written = [...engine.generated.values()].map((file) => atob(file.data).length).sort((a, b) => a - b);
    expect(written).toEqual([1000, 2000]);
    expect(events.some((event) => event.type === "message" && event.message.attachments[0]?.mime === "image/jpeg")).toBe(true);

    // A large file goes in parts, and a voice message as one, its loudness packed.
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob([big]), name: "notes.bin", mime: "application/octet-stream" }], { text: "" });
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob([bytes(500, 11)], { type: "audio/ogg" }), name: "voice.ogg", mime: "audio/ogg", voice: true, duration: 2.4, waveform: btoa("\x80".repeat(40)) }], { text: "" });
    await until(() => [...engine.generated.values()].filter((file) => file.finished).length === 4, "every file written");
    const document = [...engine.generated.values()].find((file) => atob(file.data).length === big.length);
    expect(document).toMatchObject({ error: null });
    expect(Uint8Array.from(atob(document!.data), (char) => char.charCodeAt(0))).toEqual(big);
    expect(engine.requests("writeGeneratedFilePart").length).toBe(2 + 2 + 1);
    // TDLib names a file by the last part of what it's asked for, so that's the file's own name.
    expect(engine.requests("sendMessage").at(-2)!.input_message_content.document.document.original_path).toMatch(/^zuna-[a-z0-9-]+\/notes\.bin$/);
    const voice = engine.requests("sendMessage").at(-1)!.input_message_content;
    expect(voice).toMatchObject({ "@type": "inputMessageVoiceNote", voice_note: { duration: 2 } });
    expect(waveformFromTelegram(voice.voice_note.waveform)).toBeDefined();

    // TDLib asks for a file nobody here sent: it's told so, and given nothing.
    engine.askForFile("C:/Users/someone/secret.txt");
    await until(() => engine.generated.get("C:/Users/someone/secret.txt")?.finished, "the refusal");
    expect(engine.generated.get("C:/Users/someone/secret.txt")).toMatchObject({ data: "", error: "That file isn't being sent" });

    // The message goes while its file does: once TDLib stops asking, nothing more is written.
    engine.stopAfterBytes = 1;
    const finished = engine.requests("finishFileGeneration").length;
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob([bytes(600_000, 13)]), name: "gone.bin", mime: "application/octet-stream" }], { text: "" });
    const gone = await until(() => [...engine.generated.entries()].find(([path, file]) => path.endsWith("/gone.bin") && file.data), "the first part");
    await settle(50);
    expect(atob(gone[1].data).length).toBe(512 * 1024);
    expect(engine.requests("finishFileGeneration")).toHaveLength(finished);
  });

  it("lists the account's stickers, and sends one", async () => {
    const { engine, session } = await ready();
    expect(await session.getStickerSets()).toEqual([{ id: "77", title: "Cats", cover: "tg:801" }]);
    // An animated sticker shows its still thumbnail, and one with none isn't offered.
    expect(await session.getStickers("77")).toEqual([
      { file: 801, picture: "tg:801", emoji: "🐱", width: 512, height: 512 },
      { file: 802, picture: "tg:802", emoji: "😺", width: 512, height: 512 },
    ]);
    expect(await session.getStickers("../1")).toEqual([]);
    await session.sendSticker(`user:${GRACE}`, 801, "🐱", 512, 512);
    expect(engine.requests("sendMessage").at(-1)!.input_message_content).toMatchObject({ "@type": "inputMessageSticker", sticker: { sticker: { "@type": "inputFileId", id: 801 } }, emoji: "🐱" });
    await expect(session.sendSticker(`user:${GRACE}`, 0, "", 1, 1)).rejects.toThrow("That isn't one of your stickers.");
  });

  it("archives what's hidden here, and brings it back", async () => {
    const { engine, session } = await ready();
    await session.updatePreferences({ hidden: [`user:${BOT}`] });
    expect(engine.requests("addChatToList").at(-1)).toMatchObject({ chat_id: BOT, chat_list: { "@type": "chatListArchive" } });
    await until(() => session.getPreferences().hidden.includes(`user:${BOT}`), "the chat archived");
    expect(session.getConversations().find((chat) => chat.key === `user:${BOT}`)).toMatchObject({ hidden: true });
    await session.updatePreferences({ hidden: [] });
    expect(engine.requests("addChatToList").at(-1)).toMatchObject({ chat_id: BOT, chat_list: { "@type": "chatListMain" } });
    await until(() => !session.getPreferences().hidden.includes(`user:${BOT}`), "the chat back");
    expect(engine.requests("addChatToList")).toHaveLength(2);
    await expect(session.updatePreferences({ blocked: [] })).rejects.toThrow("That's only available in Telegram's own apps.");
  });

  it("keeps drafts on Telegram, where the account's other devices find them", async () => {
    const { engine, session } = await ready();
    await session.saveDraft(`user:${GRACE}`, "  **soon**  ");
    expect(engine.requests("setChatDraftMessage")[0]).toMatchObject({ chat_id: GRACE, draft_message: { content: { "@type": "draftMessageContentText", text: { text: "soon", entities: [{ type: { "@type": "textEntityTypeBold" } }] } } } });
    await until(() => session.getDraft(`user:${GRACE}`) === "**soon**", "the draft");
    await session.saveDraft(`user:${GRACE}`, " ");
    expect(engine.requests("setChatDraftMessage")[1]).toMatchObject({ draft_message: null });
    await until(() => session.getDraft(`user:${GRACE}`) === "", "no draft");
  });

  it("makes groups, changes who's in them, and joins one by its link", async () => {
    const { engine, session } = await ready();
    await expect(session.createGroup("  ", [String(GRACE)])).rejects.toThrow("Enter a group name.");
    const id = await session.createGroup("Book club", [String(GRACE), "x"]);
    expect(id).toBe("-400");
    expect(engine.requests("createNewBasicGroupChat")[0]).toMatchObject({ title: "Book club", user_ids: [GRACE] });
    await until(() => session.getConversations().some((chat) => chat.key === "group:-400"), "the new group");
    await session.addMembers(id, [String(BOT)]);
    await session.removeMember(id, String(BOT));
    expect(engine.requests("setChatMemberStatus")[0]).toMatchObject({ chat_id: -400, member_id: { user_id: BOT }, status: { "@type": "chatMemberStatusLeft" } });
    await session.updateGroupMeta(id, { name: "Books" });
    expect(engine.requests("setChatTitle")[0]).toMatchObject({ title: "Books" });
    await expect(session.updateGroupMeta(id, { name: "" })).rejects.toThrow("Enter a group name.");
    expect(await session.createInvite(id)).toBe("https://t.me/+AbCdEf123");
    await session.leaveGroup(id);
    expect(engine.requests("leaveChat")[0]).toMatchObject({ chat_id: -400 });
    // And out of the list, for this account alone, as Telegram's apps leave one.
    expect(engine.requests("deleteChatHistory")[0]).toMatchObject({ chat_id: -400, remove_from_chat_list: true, revoke: false });
    await until(() => !session.getConversations().some((chat) => chat.key === "group:-400"), "the group gone from the list");
    // Who's in a group comes as it's opened, without those who left.
    await session.loadMessages(String(GROUP));
    const group = await until(() => session.getConversations().find((chat) => chat.key === `group:${GROUP}` && chat.members.length > 0), "the members");
    expect(group.members.map((member) => [member.userId, member.role])).toEqual([[String(SELF), "admin"], [String(GRACE), "member"]]);
    // A group this account is already in opens; another is joined.
    expect(await session.joinByLink("https://t.me/+AbCdEf123")).toBe(String(GROUP));
    expect(engine.requests("joinChatByInviteLink")).toEqual([]);
    expect(await session.joinByLink("tg://join?invite=XyZ")).toBe(String(GROUP));
    await expect(session.joinByLink("https://t.me/+club-ask")).rejects.toThrow("Request sent.");
    await expect(session.joinByLink("https://example.com/+AbCdEf123")).rejects.toThrow("Enter a link to a Telegram group.");
    await expect(session.joinByLink("t.me/+news")).rejects.toThrow("To open this Telegram channel, use the Telegram app");
  });

  it("presses a bot's button, forwards inside Telegram, and deletes as Telegram allows", async () => {
    const { engine, client, session } = await ready();
    engine.history.set(BOT, [
      { ...textMessage(BOT, serverId(5), BOT, "Weather?"), reply_markup: { "@type": "replyMarkupInlineKeyboard", rows: [[{ text: "Today", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "AQID" } }]] } },
    ]);
    await session.loadMessages(String(BOT));
    expect(await session.pressButton(String(BOT), String(serverId(5)), 0, 0)).toBe("It's sunny");
    expect(engine.requests("getCallbackQueryAnswer")[0]).toMatchObject({ chat_id: BOT, message_id: serverId(5), payload: { data: "AQID" } });
    await expect(session.pressButton(String(BOT), String(serverId(5)), 0, 1)).rejects.toThrow("This button is no longer available.");

    await client.forwardMessages(TELEGRAM_ID, String(GRACE), [String(serverId(1))], TELEGRAM_ID, `group:${GROUP}`);
    expect(engine.requests("forwardMessages")[0]).toMatchObject({ chat_id: GROUP, from_chat_id: GRACE, message_ids: [serverId(1)], send_copy: false });

    expect(await session.deleteChoices(String(GRACE), String(serverId(2)))).toEqual({ forEveryone: true, forSelf: true });
    expect(await session.deleteChoices(String(GRACE), String(serverId(1)))).toEqual({ forEveryone: false, forSelf: true });
    await session.deleteMessages(String(GRACE), [String(serverId(1))], false);
    expect(engine.requests("deleteMessages")[0]).toMatchObject({ chat_id: GRACE, message_ids: [serverId(1)], revoke: false });
  });
});

describe("sending from the share sheet (sendNow)", () => {
  // The iPhone's share extension sends and stops straight after, so it waits until Telegram has
  // what was sent (docs/IOS_TELEGRAM_SHARE_PLAN.md).
  async function ready() {
    const linked = await linkedClient({ authorized: true });
    linked.client.linkTelegram();
    await until(() => linked.client.telegramSession.getConversations().length === 3, "the list");
    return { ...linked, session: linked.client.telegramSession };
  }

  const picture = () => ({ blob: new Blob([new Uint8Array(1500).fill(9)], { type: "image/png" }), name: "a.png", mime: "image/png", width: 40, height: 30 });

  it("is back once Telegram has the text, or every message with a file", async () => {
    const { engine, session } = await ready();
    engine.holdSends = true;
    let done = false;
    const sending = session.sendNow(`user:${GRACE}`, [], { text: "hello" }).then(() => (done = true));
    await until(() => engine.requests("sendMessage").length === 1, "the message going");
    await settle();
    expect(done).toBe(false);
    engine.letSendsThrough();
    await sending;

    await session.sendNow(`group:${GROUP}`, [picture(), picture()], { text: "two" }, { keepMetadata: true, previewUrl: "https://example.com" });
    expect(engine.requests("sendMessageAlbum")).toHaveLength(1);
    expect([...engine.generated.values()].filter((file) => file.finished && !file.error)).toHaveLength(2);
  });

  it("throws what Telegram refused, and gives up once it's said nothing for too long", async () => {
    const { engine, session } = await ready();
    engine.refuseSends = "CHAT_WRITE_FORBIDDEN";
    await expect(session.sendNow(`group:${GROUP}`, [], { text: "hi" })).rejects.toThrow("You can't send messages in this chat.");
    engine.refuseSends = null;

    const wait = telegramSendTiming.sent;
    telegramSendTiming.sent = 50;
    try {
      engine.holdSends = true;
      await expect(session.sendNow(`user:${GRACE}`, [], { text: "hi" })).rejects.toThrow("Telegram hasn't confirmed the message yet.");
    } finally {
      telegramSendTiming.sent = wait;
    }
  });

  it("waits for the account to be signed in, and asks for a group the list hasn't told of", async () => {
    const engine = new FakeTdlib();
    engine.holdList = true;
    const { client } = await linkedClient({ authorized: true, engine });
    client.linkTelegram();
    const session = client.telegramSession;
    await session.sendNow(`group:${GROUP}`, [], { text: "from the share sheet" });
    expect(engine.requests("getChat").some((request) => request.chat_id === GROUP)).toBe(true);
    expect(engine.requests("sendMessage").at(-1)).toMatchObject({ chat_id: GROUP });
    engine.tellList();
    await until(() => session.getConversations().length === 3, "the list");
  });

  it("finishes a send that went on across the engine starting again", async () => {
    const { engine, session } = await ready();
    engine.holdSends = true;
    const sending = session.sendNow(`user:${GRACE}`, [picture()], { text: "" }, { keepMetadata: true });
    await until(() => engine.requests("sendMessage").length === 1, "the message going");
    // The app went to sleep and woke: its broker closed TDLib and started it again.
    engine.emit({ "@type": "zunaRestarted" });
    engine.emit({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
    engine.letSendsThrough();
    await sending;
  });

  it("says why it can't, rather than wait, once the engine stopped", async () => {
    const { engine, session } = await ready();
    engine.holdSends = true;
    const sending = session.sendNow(`user:${GRACE}`, [], { text: "hi" });
    await until(() => engine.requests("sendMessage").length === 1, "the message going");
    session.stop();
    await expect(sending).rejects.toThrow("Telegram stopped.");
  });
});

describe("what an app held to an app store's rules withholds", () => {
  // An 18+ bot, a group Telegram restricts on iOS, one it hasn't told of, and a group of its own
  // with a message it marks, a reply to it, and messages from or by way of what's restricted.
  const ADULT_BOT = 4000;
  const RESTRICTED = -1004200;
  const CLEAN = -1004300;
  const UNTOLD = -1004400;
  const sensitive = { "@type": "restrictionInfo", restriction_reason: "", has_sensitive_content: true };
  const reason = { "@type": "restrictionInfo", restriction_reason: "This group can't be displayed because it violated local laws.", has_sensitive_content: false };
  const file = (id: number, unique: string) => ({ "@type": "file", id, size: 1000, remote: { "@type": "remoteFile", unique_id: unique } });
  const photo = (chat: number, id: number, from: number, caption: string, picture: ReturnType<typeof file>, extra: Record<string, unknown> = {}) => ({
    ...textMessage(chat, id, from, ""),
    content: { "@type": "messagePhoto", caption: { "@type": "formattedText", text: caption, entities: [] }, photo: { "@type": "photo", sizes: [{ "@type": "photoSize", type: "y", photo: picture, width: 800, height: 600 }] } },
    ...extra,
  });
  const chat = (id: number, type: Record<string, unknown>, title: string, order: string, extra: Record<string, unknown> = {}, pinned = false) => ({
    "@type": "chat",
    id,
    type,
    title,
    positions: [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order, is_pinned: pinned }],
    unread_count: 0,
    notification_settings: { "@type": "chatNotificationSettings", use_default_mute_for: false, mute_for: 0 },
    ...extra,
  });

  function world(): FakeTdlib {
    const engine = new FakeTdlib();
    engine.users.set(ADULT_BOT, { ...engine.users.get(BOT)!, id: ADULT_BOT, first_name: "After dark", restriction_info: sensitive });
    engine.supergroups.set(4200, { "@type": "supergroup", id: 4200, is_channel: false, restriction_info: reason });
    engine.supergroups.set(4300, { "@type": "supergroup", id: 4300, is_channel: false, restriction_info: null });
    engine.chats.set(ADULT_BOT, chat(ADULT_BOT, { "@type": "chatTypePrivate", user_id: ADULT_BOT }, "After dark", "6000"));
    const inside = photo(RESTRICTED, serverId(1), GRACE, "Inside", file(63, "group63"));
    engine.chats.set(
      RESTRICTED,
      chat(RESTRICTED, { "@type": "chatTypeSupergroup", supergroup_id: 4200, is_channel: false }, "After hours", "6100", { photo: { "@type": "chatPhotoInfo", small: file(64, "grouppic64") }, last_message: inside }, true),
    );
    engine.history.set(RESTRICTED, [inside]);
    engine.chats.set(UNTOLD, chat(UNTOLD, { "@type": "chatTypeSupergroup", supergroup_id: 4400, is_channel: false }, "Untold", "6200"));
    engine.chats.set(CLEAN, chat(CLEAN, { "@type": "chatTypeSupergroup", supergroup_id: 4300, is_channel: false }, "Book club", "6300"));
    engine.history.set(CLEAN, [
      photo(CLEAN, serverId(1), GRACE, "Look", file(61, "clean61")),
      photo(CLEAN, serverId(2), GRACE, "Hidden caption", file(62, "hidden62"), { restriction_info: sensitive, link_preview: { "@type": "linkPreview", url: "https://example.com/x", title: "Hidden title" } }),
      textMessage(CLEAN, serverId(3), GRACE, "Reply", { reply_to: { "@type": "messageReplyToMessage", chat_id: CLEAN, message_id: serverId(2) } }),
      textMessage(CLEAN, serverId(4), GRACE, "Via bot", { via_bot_user_id: ADULT_BOT }),
      textMessage(CLEAN, serverId(5), GRACE, "Forwarded", { forward_info: { "@type": "messageForwardInfo", origin: { "@type": "messageOriginChannel", chat_id: RESTRICTED, message_id: serverId(1), author_signature: "" }, date: 1_700_000_000 } }),
      textMessage(CLEAN, serverId(6), ADULT_BOT, "From the bot"),
    ]);
    return engine;
  }

  async function linked(restricted: boolean) {
    const result = await linkedClient({ authorized: true, restricted, calls: true, engine: world() });
    result.client.linkTelegram();
    const session = result.client.telegramSession;
    await until(() => session.getConversations().some((each) => each.key === `group:${CLEAN}`), "the list");
    await settle();
    return { ...result, session };
  }

  const keys = (session: { getConversations(): { key: string }[] }) => session.getConversations().map((each) => each.key);
  const WITHHELD = "*This message can't be shown on this device*";

  it("lists no chat Telegram restricts, opens none, and names nobody it restricts", async () => {
    const { engine, session } = await linked(true);
    expect(keys(session)).toEqual(expect.arrayContaining([`user:${GRACE}`, `group:${GROUP}`, `user:${BOT}`, `group:${CLEAN}`]));
    // The 18+ bot, the restricted group, and a group whose supergroup TDLib hasn't told of.
    for (const key of [`user:${ADULT_BOT}`, `group:${RESTRICTED}`, `group:${UNTOLD}`]) expect(keys(session)).not.toContain(key);
    expect(session.getPreferences().pinned).not.toContain(`group:${RESTRICTED}`);
    await expect(session.loadMessages(String(RESTRICTED))).rejects.toThrow("Telegram chat isn't available here");
    await expect(session.loadMessages(String(ADULT_BOT))).rejects.toThrow("Telegram chat isn't available here");
    await expect(session.sendMessage(`user:${ADULT_BOT}`, { text: "hi" })).rejects.toThrow("Telegram chat isn't available here");
    const users = session.getUsers().map((user) => user.id);
    expect(users).toContain(String(GRACE));
    expect(users).not.toContain(String(ADULT_BOT));
    expect(users).not.toContain(`chat:${RESTRICTED}`);
    // The app's list of pins doesn't have it, and it stays pinned on Telegram.
    expect(session.getPreferences().pinned).toEqual([`group:${GROUP}`]);
    await session.setPinnedChats([`group:${GROUP}`]);
    await session.updatePreferences({ hidden: [] });
    expect(engine.requests("toggleChatIsPinned")).toEqual([]);
    expect(engine.requests("addChatToList")).toEqual([]);
  });

  it("shows a line in place of what Telegram restricts, and never downloads its files", async () => {
    const { engine, events, session } = await linked(true);
    const { messages } = await session.loadMessages(String(CLEAN));
    const byId = new Map(messages.map((message) => [Number(message.id), message]));
    expect(byId.get(serverId(1))).toMatchObject({ text: "Look", attachments: [{ fileId: "tg:61:clean61" }] });
    // Marked by Telegram itself: no caption, picture or preview.
    expect(byId.get(serverId(2))).toMatchObject({ text: WITHHELD, attachments: [], preview: null });
    // A reply quotes nothing of it.
    expect(byId.get(serverId(3))).toMatchObject({ text: "Reply", reply: { text: "This message can't be shown on this device", hasAttachment: false } });
    // By way of the bot, forwarded from the restricted group, from the bot itself.
    for (const id of [4, 5, 6]) expect(byId.get(serverId(id))).toMatchObject({ text: WITHHELD, forwarded: null });
    expect(JSON.stringify(messages)).not.toMatch(/Hidden|Via bot|Forwarded|From the bot/);

    expect(await (await session.downloadFile({ fileId: "tg:61:clean61", mime: "image/jpeg" })).text()).toBe("C:/zuna/telegram/photos/61.jpg");
    for (const fileId of ["tg:62:hidden62", "tg:63:group63", "tg:64:grouppic64"]) await expect(session.downloadFile({ fileId, mime: "image/jpeg" })).rejects.toThrow("This file is no longer available.");
    expect(engine.requests("downloadFile").map((request) => request.file_id)).toEqual([61]);

    // Nothing is found by what it holds, and nothing withheld is passed on.
    expect((await session.search("Via")).length).toBe(0);
    expect((await session.search("Reply")).map((found) => found.message.id)).toEqual([String(serverId(3))]);
    await expect(session.forwardMessages(String(CLEAN), [String(serverId(2))], `user:${GRACE}`)).rejects.toThrow("This message can't be shown on this device");
    expect(engine.requests("forwardMessages")).toEqual([]);

    // What comes: nothing of the restricted group, a line and no notification for a marked message.
    const notified = () => events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify");
    const shown = () => events.filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message").map((event) => event.message);
    engine.emit({ "@type": "updateNewMessage", message: textMessage(RESTRICTED, serverId(20), GRACE, "In the restricted group") });
    engine.emit({ "@type": "updateNewMessage", message: textMessage(CLEAN, serverId(21), GRACE, "Marked", { restriction_info: sensitive }) });
    engine.emit({ "@type": "updateNewMessage", message: textMessage(CLEAN, serverId(22), GRACE, "Fine") });
    await until(() => notified().length === 1, "the one notification");
    expect(notified()[0]).toMatchObject({ groupId: String(CLEAN), body: "Grace Hopper: Fine" });
    expect(shown().map((message) => [message.id, message.text])).toEqual([
      [String(serverId(21)), WITHHELD],
      [String(serverId(22)), "Fine"],
    ]);
  });

  it("withholds a group Telegram restricts later, and the files seen in it", async () => {
    const { engine, session } = await linked(true);
    await session.loadMessages(String(CLEAN));
    engine.emit({ "@type": "updateSupergroup", supergroup: { "@type": "supergroup", id: 4300, is_channel: false, restriction_info: reason } });
    await until(() => !keys(session).includes(`group:${CLEAN}`), "the group gone from the list");
    await expect(session.downloadFile({ fileId: "tg:61:clean61", mime: "image/jpeg" })).rejects.toThrow("This file is no longer available.");
    expect(engine.requests("downloadFile")).toEqual([]);
  });

  it("shows 18+ media where the account lets it through, and never what's restricted for a reason", async () => {
    const { engine, events, session } = await linked(true);
    const option = (name: string, value: boolean) => engine.emit({ "@type": "updateOption", name, value: { "@type": "optionValueBoolean", value } });
    const message = async (id: number) => (await session.loadMessages(String(CLEAN))).messages.find((each) => each.id === String(serverId(id)));
    // Telegram allows it, but the person hasn't chosen it: still withheld.
    option("can_ignore_sensitive_content_restrictions", true);
    await settle();
    expect(keys(session)).not.toContain(`user:${ADULT_BOT}`);
    expect((await message(2))?.text).toBe(WITHHELD);
    // Chosen on another device too: the 18+ bot, its messages and the marked picture show.
    option("ignore_sensitive_content_restrictions", true);
    await until(() => keys(session).includes(`user:${ADULT_BOT}`), "the bot listed");
    expect(await message(2)).toMatchObject({ text: "Hidden caption", attachments: [{ fileId: "tg:62:hidden62" }] });
    expect((await message(4))?.text).toBe("Via bot");
    expect((await message(6))?.text).toBe("From the bot");
    expect(await (await session.downloadFile({ fileId: "tg:62:hidden62", mime: "image/jpeg" })).text()).toBe("C:/zuna/telegram/photos/62.jpg");
    // What's restricted for a reason stays withheld: the group, what's forwarded from it, its files.
    expect(keys(session)).not.toContain(`group:${RESTRICTED}`);
    expect((await message(5))?.text).toBe(WITHHELD);
    await expect(session.downloadFile({ fileId: "tg:63:group63", mime: "image/jpeg" })).rejects.toThrow("This file is no longer available.");
    // Turned off again: withheld again, and the chat shown is told so.
    events.length = 0;
    option("ignore_sensitive_content_restrictions", false);
    await until(() => !keys(session).includes(`user:${ADULT_BOT}`), "the bot gone");
    const told = events.filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message" && event.message.id === String(serverId(2)));
    expect(told.at(-1)?.message.text).toBe(WITHHELD);
    await expect(session.downloadFile({ fileId: "tg:62:hidden62", mime: "image/jpeg" })).rejects.toThrow("This file is no longer available.");
  });

  it("rings for no call from someone Telegram restricts", async () => {
    const { engine, session } = await linked(true);
    engine.ringFrom(ADULT_BOT);
    await settle();
    expect(session.getTelegramCall()).toBeNull();
    engine.ringFrom(GRACE);
    await until(() => session.getTelegramCall(), "Grace's call");
  });

  it("shows all of it where the app isn't held to those rules, as the desktop's isn't", async () => {
    const { session } = await linked(false);
    expect(keys(session)).toEqual(expect.arrayContaining([`user:${ADULT_BOT}`, `group:${RESTRICTED}`, `group:${UNTOLD}`, `group:${CLEAN}`]));
    const { messages } = await session.loadMessages(String(CLEAN));
    expect(messages.find((message) => message.id === String(serverId(2)))).toMatchObject({ text: "Hidden caption", attachments: [{ fileId: "tg:62:hidden62" }], preview: { title: "Hidden title" } });
    expect(messages.find((message) => message.id === String(serverId(4)))?.text).toBe("Via bot");
    expect(await (await session.downloadFile({ fileId: "tg:62:hidden62", mime: "image/jpeg" })).text()).toBe("C:/zuna/telegram/photos/62.jpg");
    expect((await session.loadMessages(String(RESTRICTED))).messages[0]?.text).toBe("Inside");
  });
});
