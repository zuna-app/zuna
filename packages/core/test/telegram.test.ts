// A Telegram account linked on a device (docs/TELEGRAM_PLAN.md), against a fake engine that
// speaks TDLib's JSON: linking, the list, history, sending, reading, notifications and unlinking,
// what's kept apart from Zuna's chats, and the mapping's checks. No server takes part.

import { beforeAll, describe, expect, it } from "vitest";
import { ZunaClient } from "../src/client";
import { serveCore, type RpcPort } from "../src/rpc";
import { fromMarkup, toMarkup } from "../src/telegram/markup";
import { conversationView, messageView, userView } from "../src/telegram/map";
import { TELEGRAM_ID, type CoreEvent, type TelegramLink } from "../src/types";
import { BOT, CHANNEL, FakeTdlib, GRACE, GROUP, SECRET, SELF, serverId, textMessage } from "./fake-tdlib";
import { loadCrypto, MemoryDbProvider } from "./helpers";

beforeAll(loadCrypto);

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

async function linkedClient(options: { authorized?: boolean; password?: string } = {}) {
  const engine = new FakeTdlib();
  engine.authorized = options.authorized ?? false;
  engine.password = options.password ?? null;
  const events: CoreEvent[] = [];
  const db = new MemoryDbProvider();
  const client = new ZunaClient({ db, deviceKey: new Uint8Array(32).fill(3), deviceName: "Test", onEvent: (event) => events.push(event), telegram: engine });
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
    await expect(client.telegramSession.linkWithPhone("+1 555 0100")).rejects.toThrow("isn't a phone number Telegram knows");
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

  it("makes no account: a number Telegram doesn't know is sent to Telegram's app", async () => {
    const { engine, client, link } = await linkedClient();
    client.linkTelegram();
    await until(() => link()?.step === "phone", "the phone step");
    engine.auth("authorizationStateWaitRegistration", { terms_of_service: null });
    await until(() => link()?.step === "signup", "the sign-up step");
    expect(engine.requests("registerUser")).toEqual([]);
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
    await expect(session.loadMessages(String(CHANNEL))).rejects.toThrow("isn't on Telegram here");
  });

  it("sends with Zuna's markup as Telegram's entities, and the sent message takes Telegram's number", async () => {
    const { engine, events, session } = await ready();
    const pending = await session.sendMessage(`user:${GRACE}`, { text: "**On** my way", replyTo: String(serverId(3)) });
    expect(pending.status).toBe("sending");
    const [request] = engine.requests("sendMessage");
    expect(request.input_message_content.text).toEqual({ "@type": "formattedText", text: "On my way", entities: [{ offset: 0, length: 2, type: { "@type": "textEntityTypeBold" } }] });
    expect(request.reply_to).toMatchObject({ message_id: serverId(3) });
    const moved = await until(() => events.find((event) => event.type === "message" && event.message.id === String(serverId(101))), "the sent message");
    expect(events.some((event) => event.type === "message_removed" && event.id === pending.id)).toBe(true);
    expect(moved).toMatchObject({ message: { status: "sent", text: "**On** my way" } });
    await expect(session.sendMessage(`user:${GRACE}`, { text: "a file", attachments: [{} as never] })).rejects.toThrow("Files can't be sent");
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
    for (const [id, method] of [[2, "getDevices"], [3, "createInvite"], [4, "voiceAccess"], [5, "forwardMessage"]] as const) {
      expect(await call(id, method)).toMatchObject({ ok: false, error: { message: "The core has no such thing to do." } });
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
    expect(photo.text).toBe("Sunset\n_Photo, which Zuna can't show yet. It's in Telegram's app._");
    const once = messageView({ ...textMessage(GRACE, serverId(2), GRACE, ""), content: { "@type": "messagePhoto", caption: { text: "", entities: [] }, self_destruct_type: { "@type": "messageSelfDestructTypeImmediately" } } }, context)!;
    expect(once.text).toContain("Photo, to be seen once");
    const joined = messageView({ ...textMessage(GROUP, serverId(3), GRACE, ""), content: { "@type": "messageChatAddMembers", member_user_ids: [BOT, "x"] } }, context)!;
    expect(joined.system).toEqual({ type: "member_added", actorId: String(GRACE), targetIds: [String(BOT)] });
    const call = messageView({ ...textMessage(GRACE, serverId(4), GRACE, ""), content: { "@type": "messageCall", is_video: false, discard_reason: { "@type": "callDiscardReasonMissed" }, duration: 0 } }, context)!;
    expect(call.text).toBe("_Missed call, in Telegram's app_");
  });
});
