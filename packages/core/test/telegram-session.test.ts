// A linked Telegram account's session (telegram/session.ts) and its engine's pairing of answers
// (telegram/engine.ts), driven through the fake engine for what telegram.test.ts leaves out: the
// rest of linking, every update a chat or a message takes, history, media, search and groups, and
// what Telegram refuses, in the app's words. No server, and no ZunaClient: the session alone.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZunaClient } from "../src/client";
import { Engine, TelegramError, type TelegramAdapter } from "../src/telegram/engine";
import { TelegramSession } from "../src/telegram/session";
import type { FileAdapter } from "../src/files";
import { TELEGRAM_ID, type CoreEvent, type TelegramLink } from "../src/types";
import { BOT, CHANNEL, FakeTdlib, GRACE, GROUP, SELF, serverId, textMessage } from "./fake-tdlib";
import { loadCrypto, MemoryDbProvider } from "./helpers";

beforeAll(loadCrypto);

type Td = { "@type": string; [field: string]: any };

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

/** The fake engine, which can also be made to refuse a kind of request, or answer it otherwise. */
class Telegram extends FakeTdlib {
  private refusals = new Map<string, { code: number; message: string }>();
  private answers = new Map<string, Td>();
  private throwing = new Map<string, unknown>();

  refuse(kind: string, message: string, code = 400): void {
    this.answers.delete(kind);
    this.refusals.set(kind, { code, message });
  }

  answer(kind: string, value: Td): void {
    this.refusals.delete(kind);
    this.answers.set(kind, value);
  }

  /** The broker's end throws as the request is handed to it. */
  throwOn(kind: string, error: unknown): void {
    this.throwing.set(kind, error);
  }

  override send(json: string): void {
    const request = JSON.parse(json) as Td;
    const kind = request["@type"];
    if (this.throwing.has(kind)) throw this.throwing.get(kind);
    const refusal = this.refusals.get(kind);
    const answer = this.answers.get(kind);
    if (!refusal && !answer) return super.send(json);
    this.asked.push(request);
    const value = refusal ? { "@type": "error", ...refusal } : answer!;
    setTimeout(() => this.emit({ ...value, "@extra": request["@extra"] }), 0);
  }
}

function linked(options: { authorized?: boolean; files?: FileAdapter } = {}) {
  const engine = new Telegram();
  engine.authorized = options.authorized ?? true;
  const events: CoreEvent[] = [];
  const counts = { linked: 0, gone: 0 };
  const session = new TelegramSession(engine, {
    onEvent: (event) => events.push(event),
    linking: !engine.authorized,
    onLinked: () => counts.linked++,
    onGone: () => counts.gone++,
    files: options.files,
  });
  session.start();
  const link = () => [...events].reverse().find((event): event is Extract<CoreEvent, { type: "telegram" }> => event.type === "telegram")?.link;
  return { engine, events, session, counts, link };
}

async function ready(options: { files?: FileAdapter } = {}) {
  const account = linked(options);
  await until(() => account.session.getConversations().length === 3, "the list");
  return account;
}

const of = <T extends CoreEvent["type"]>(events: CoreEvent[], type: T) => events.filter((event): event is Extract<CoreEvent, { type: T }> => event.type === type);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the engine's answers", () => {
  function engine() {
    const sent: Td[] = [];
    let hear: (json: string) => void = () => undefined;
    const updates: Td[] = [];
    const adapter: TelegramAdapter = {
      start: (onMessage) => {
        hear = onMessage;
        return null;
      },
      send: (json) => void sent.push(JSON.parse(json)),
      stop: () => undefined,
      file: () => new Blob(),
    };
    const paired = new Engine(adapter, (update) => updates.push(update as Td));
    paired.start();
    return { paired, sent, updates, hear: (value: unknown) => hear(typeof value === "string" ? value : JSON.stringify(value)) };
  }

  it("pairs each answer with its request, and hands the rest on as updates", async () => {
    const { paired, sent, updates, hear } = engine();
    const asked = paired.request({ "@type": "getMe" });
    hear({ "@type": "updateUser", user: { id: 1 } });
    hear({ "@type": "user", id: 1, "@extra": sent[0]!["@extra"] });
    await expect(asked).resolves.toMatchObject({ "@type": "user", id: 1 });
    expect(updates).toEqual([{ "@type": "updateUser", user: { id: 1 } }]);
    // What isn't JSON, isn't an object of a kind, or answers nothing asked is dropped.
    hear("not json");
    hear("[1, 2]");
    hear({ "@type": 5 });
    hear({ "@type": "ok", "@extra": "c999" });
    expect(updates).toHaveLength(1);
  });

  it("fails a request with what TDLib said, or with words of its own when it said nothing", async () => {
    const { paired, sent, hear } = engine();
    const refused = paired.request({ "@type": "getChat" });
    hear({ "@type": "error", "@extra": sent[0]!["@extra"] });
    const error = await refused.catch((caught) => caught);
    expect(error).toBeInstanceOf(TelegramError);
    expect([error.message, error.code]).toEqual(["Telegram refused that.", 400]);
  });

  it("gives up on an answer after two minutes", async () => {
    vi.useFakeTimers();
    const { paired } = engine();
    const waiting = paired.request({ "@type": "getMe" }).catch((caught) => caught);
    await vi.advanceTimersByTimeAsync(120_001);
    const error = await waiting;
    expect([error.message, error.code]).toEqual(["Telegram didn't answer in time.", 504]);
  });
});

describe("linking, the rest of the way", () => {
  it("says why the engine can't start, and starts nothing", () => {
    const events: CoreEvent[] = [];
    const adapter: TelegramAdapter = { start: () => "Telegram isn't installed with this app.", send: () => undefined, stop: () => undefined, file: () => new Blob() };
    const session = new TelegramSession(adapter, { onEvent: (event) => events.push(event), linking: true, onLinked: () => undefined, onGone: () => undefined });
    session.start();
    expect(session.getLink()).toEqual({ step: "failed", reason: "Telegram isn't installed with this app." });
    expect(of(events, "telegram")).toHaveLength(1);
  });

  it("asks for an email's code when Telegram sends one there, and checks it as one", async () => {
    const { engine, session, link } = linked({ authorized: false });
    await until(() => link()?.step === "phone", "the phone step");
    engine.auth("authorizationStateWaitEmailCode", { code_info: { email_address_pattern: "a***@example.com", length: 6 } });
    await until(() => link()?.step === "email", "the email step");
    expect(session.getLink()).toEqual({ step: "email", pattern: "a***@example.com", length: 6 });
    await session.enterCode("123 456");
    expect(engine.requests("checkAuthenticationEmailCode")).toEqual([expect.objectContaining({ code: { "@type": "emailAddressAuthenticationCode", code: "123456" } })]);
  });

  it("says how each code comes, and whether another can be asked for", async () => {
    const { engine, session, link } = linked({ authorized: false });
    await until(() => link()?.step === "phone", "the phone step");
    for (const [type, via] of [
      ["authenticationCodeTypeSms", "sms"],
      ["authenticationCodeTypeCall", "call"],
      ["authenticationCodeTypeFragment", "fragment"],
      ["authenticationCodeTypeFirebaseIos", "other"],
    ] as const) {
      engine.auth("authorizationStateWaitCode", { code_info: { phone_number: "+99966", type: { "@type": type, length: 6 } } });
      await until(() => link()?.step === "code" && (link() as Extract<TelegramLink, { step: "code" }>).via === via, via);
      expect(link()).toMatchObject({ length: 6, canResend: false });
    }
    await session.resendCode();
    expect(engine.requests("resendAuthenticationCode")).toHaveLength(1);
    engine.refuse("resendAuthenticationCode", "Too Many Requests: retry after 61", 429);
    await expect(session.resendCode()).rejects.toThrow("Telegram asks to wait 2 minutes before trying again.");
  });

  it("shows no QR code that isn't Telegram's, and says what it can't do here", async () => {
    const { engine, session, link } = linked({ authorized: false });
    await until(() => link()?.step === "phone", "the phone step");
    engine.auth("authorizationStateWaitOtherDeviceConfirmation", { link: "https://evil.example/login" });
    await settle();
    expect(link()).toEqual({ step: "phone" });
    engine.auth("authorizationStateWaitEmailAddress");
    await until(() => link()?.step === "failed", "the email address step");
    expect(link()).toMatchObject({ reason: expect.stringContaining("login email") });
    engine.auth("authorizationStateWaitPremiumPurchase");
    await until(() => link()?.step === "failed" && (link() as Extract<TelegramLink, { step: "failed" }>).reason.includes("Premium"), "the Premium step");
    engine.refuse("requestQrCodeAuthentication", "PHONE_NUMBER_BANNED");
    await expect(session.linkWithQr()).rejects.toThrow("Telegram has banned that number.");
    engine.refuse("setAuthenticationPhoneNumber", "CHAT_ADMIN_REQUIRED", 403);
    await expect(session.linkWithPhone("+99966 12345")).rejects.toThrow("Only the group's admins can do that.");
    engine.refuse("checkAuthenticationPassword", "Something nobody's heard of");
    await expect(session.enterPassword("x")).rejects.toThrow("Telegram said: Something nobody's heard of");
    engine.refuse("checkAuthenticationCode", "FORBIDDEN", 403);
    await expect(session.enterCode("1")).rejects.toThrow("Zuna doesn't do that on Telegram.");
  });

  it("says Telegram stopped working when the broker does, and fails what was waiting", async () => {
    const { engine, events, session } = await ready();
    engine.emit({ "@type": "zunaRestarted" });
    engine.emit({ "@type": "zunaFailed", reason: "the engine crashed" });
    expect(session.getLink()).toEqual({ step: "failed", reason: "Telegram stopped working here: the engine crashed" });
    expect(session.getConnectionState()).toBe("offline");
    expect(of(events, "connection").at(-1)).toMatchObject({ serverId: TELEGRAM_ID, state: "offline" });
    // A stop it didn't ask for, from an engine before this one, changes nothing.
    engine.emit({ "@type": "zunaStopped", erased: true, signedOut: false });
    expect(session.getConversations()).toHaveLength(3);
  });

  it("keeps the account when it stops without erasing, and erases it on an end it asked for", async () => {
    const { engine, session, counts, link } = await ready();
    session.stop();
    await settle();
    expect(engine.stops).toEqual([false]);
    expect(counts.gone).toBe(0);
    // Closed after being asked to stop: not an end from another device.
    engine.auth("authorizationStateClosed");
    await settle();
    expect(engine.stops).toEqual([false]);
    session.start();
    await until(() => link()?.step === "ready", "ready again");
    const unlinked = session.unlink();
    engine.auth("authorizationStateClosed");
    expect(await unlinked).toBe(true);
    expect(counts.gone).toBe(1);
    expect(engine.stops).toEqual([false, true]);
  });

  it("goes on without the list when Telegram can't say who the account is", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = new Telegram();
    engine.authorized = true;
    engine.refuse("getMe", "UNAUTHORIZED", 401);
    engine.refuse("loadChats", "INTERNAL", 500);
    const session = new TelegramSession(engine, { onEvent: () => undefined, linking: false, onLinked: () => undefined, onGone: () => undefined });
    session.start();
    await until(() => warn.mock.calls.some((call) => String(call[0]).includes("account couldn't be read")), "the warning");
    expect(session.getSelf()).toEqual({ userId: "", username: "", role: "member", deviceId: "" });
    expect(engine.requests("loadChats")).toEqual([]);
  });

  it("warns, and goes on to the archive, when a list can't be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = new Telegram();
    engine.authorized = true;
    engine.refuse("loadChats", "INTERNAL", 500);
    const session = new TelegramSession(engine, { onEvent: () => undefined, linking: false, onLinked: () => undefined, onGone: () => undefined });
    session.start();
    // Each warning comes once Telegram has answered.
    const warned = () => warn.mock.calls.filter((call) => String(call[0]).includes("chats couldn't be loaded"));
    await until(() => warned().length === 2, "a warning for each list");
    expect(engine.requests("loadChats").map((request) => request.chat_list["@type"])).toEqual(["chatListMain", "chatListArchive"]);
  });
});

describe("what the session says of itself", () => {
  it("shows the account online only while it's in front, once linked", async () => {
    const { engine, session, link } = linked({ authorized: false });
    await until(() => link()?.step === "phone", "the phone step");
    session.setActive(true);
    expect(engine.requests("setOption")).toEqual([]);
    await session.linkWithQr();
    await until(() => link()?.step === "qr", "the QR step");
    engine.confirm();
    // Once it's ready, what was asked before is said.
    await until(() => engine.requests("setOption").length === 1, "online");
    session.setActive(true);
    session.setActive(false);
    expect(engine.requests("setOption").map((request) => request.value.value)).toEqual([true, false]);
    expect(session.isActiveElsewhere()).toBe(false);
  });

  it("answers as a server's session would, with what Telegram has here", async () => {
    const { session } = await ready();
    expect(session.getInfo()).toMatchObject({ name: "Telegram", registration: "invite", max_upload_mb: 0 });
    expect(session.serverUrl()).toBe("");
    expect(session.getEmotes()).toEqual({ set_id: "", set_name: "", emotes: [] });
    expect(session.emotesIn()).toEqual({});
    expect(session.getSelf()).toEqual({ userId: String(SELF), username: "ada", role: "member", deviceId: "" });
    expect(session.getConnectionState()).toBe("online");
    session.suspend();
    session.resume();
    session.nudge();
    await session.flushOutbox();
  });

  it("follows the connection's state as TDLib says it", async () => {
    const { engine, events, session } = await ready();
    for (const [state, shown] of [
      ["connectionStateUpdating", "syncing"],
      ["connectionStateConnectingToProxy", "connecting"],
      ["connectionStateWaitingForNetwork", "offline"],
      ["connectionStateSomethingNew", "connecting"],
      ["connectionStateReady", "online"],
    ] as const) {
      engine.emit({ "@type": "updateConnectionState", state: { "@type": state } });
      expect(session.getConnectionState()).toBe(shown);
    }
    expect(of(events, "connection").slice(-5).map((event) => event.state)).toEqual(["syncing", "connecting", "offline", "connecting", "online"]);
  });

  it("lists a supergroup's chats that speak as themselves among the people", async () => {
    const { engine, session } = await ready();
    engine.emit({ "@type": "updateNewChat", chat: { "@type": "chat", id: -1009, type: { "@type": "chatTypeSupergroup", supergroup_id: 9, is_channel: false }, title: "Club", positions: [] } });
    expect(session.getUsers().find((user) => user.id === "chat:-1009")).toMatchObject({ displayName: "Club" });
    // What isn't a user or a chat isn't kept.
    engine.emit({ "@type": "updateUser", user: { id: "nope" } });
    engine.emit({ "@type": "updateNewChat", chat: { "@type": "chat" } });
    expect(session.getUsers().some((user) => user.id === "nope")).toBe(false);
  });
});

describe("what changes in a chat", () => {
  it("takes each of a chat's fields as its update says, and lists it again", async () => {
    const { engine, session } = await ready();
    const grace = () => session.getConversations().find((chat) => chat.key === `user:${GRACE}`)!;
    engine.emit({ "@type": "updateChatTitle", chat_id: GRACE, title: "Grace H." });
    engine.emit({ "@type": "updateChatPhoto", chat_id: GRACE, photo: { small: { id: 61 } } });
    engine.emit({ "@type": "updateChatUnreadMentionCount", chat_id: GRACE, unread_mention_count: 2 });
    engine.emit({ "@type": "updateChatNotificationSettings", chat_id: GRACE, notification_settings: { mute_for: 3600 } });
    engine.emit({ "@type": "updateChatIsMarkedAsUnread", chat_id: GRACE, is_marked_as_unread: true });
    engine.emit({ "@type": "updateChatBlockList", chat_id: GRACE, block_list: { "@type": "blockListMain" } });
    engine.emit({ "@type": "updateChatMessageAutoDeleteTime", chat_id: GRACE, message_auto_delete_time: 604800 });
    expect(grace()).toMatchObject({ title: "Grace H.", avatar: { fileId: "tg:61" }, mentioned: true, muted: true, markedUnread: true, blocked: true, disappearAfter: 604800 });
    expect(grace().mutedUntil).toBeGreaterThan(Date.now());
    const preferences = session.getPreferences();
    expect(preferences.mutedUntil?.[`user:${GRACE}`]).toBeGreaterThan(Date.now());
    expect(preferences.blocked).toEqual([String(GRACE)]);
    expect(preferences.markedUnread).toContain(`user:${GRACE}`);
    engine.emit({ "@type": "updateMessageMentionRead", chat_id: GRACE, message_id: 1, unread_mention_count: 0 });
    expect(grace().mentioned).toBe(false);
    // A chat it never heard of is no chat to change.
    engine.emit({ "@type": "updateChatTitle", chat_id: 424242, title: "Nobody" });
    expect(session.getConversations()).toHaveLength(3);
  });

  it("moves a chat by its last message, and keeps that message to show", async () => {
    const { engine, events, session } = await ready();
    const latest = textMessage(GRACE, serverId(20), GRACE, "Newest");
    engine.emit({ "@type": "updateChatLastMessage", chat_id: GRACE, last_message: latest, positions: [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order: "9999", is_pinned: true }] });
    const grace = session.getConversations().find((chat) => chat.key === `user:${GRACE}`)!;
    expect(grace).toMatchObject({ pinned: true, lastMessage: { text: "Newest" } });
    expect(await session.messageById(String(GRACE), String(serverId(20)))).toMatchObject({ text: "Newest" });
    await until(() => of(events, "conversations").length > 0, "the list again");
  });

  it("mutes chats by Telegram's defaults for each kind, as its scopes say", async () => {
    const { engine, session } = await ready();
    engine.emit({ "@type": "updateScopeNotificationSettings", scope: { "@type": "notificationSettingsScopePrivateChats" }, notification_settings: { mute_for: 0x7fffffff } });
    engine.emit({ "@type": "updateScopeNotificationSettings", scope: { "@type": "notificationSettingsScopeGroupChats" }, notification_settings: { mute_for: 60 } });
    engine.emit({ "@type": "updateScopeNotificationSettings", scope: { "@type": "notificationSettingsScopeChannelChats" }, notification_settings: { mute_for: 5 } });
    // The bot's chat takes the default for people's chats.
    expect(session.getConversations().find((chat) => chat.key === `user:${BOT}`)).toMatchObject({ muted: true, mutedUntil: null });
    expect(session.getPreferences().muted).toContain(`user:${BOT}`);
  });

  it("says when someone comes online, for people it knows", async () => {
    const { engine, events } = await ready();
    engine.emit({ "@type": "updateUserStatus", user_id: GRACE, status: { "@type": "userStatusOnline", expires: Math.floor(Date.now() / 1000) + 300 } });
    engine.emit({ "@type": "updateUserStatus", user_id: 999999, status: { "@type": "userStatusOnline", expires: 1 } });
    engine.emit({ "@type": "updateUserStatus", status: { "@type": "userStatusOnline", expires: 1 } });
    expect(of(events, "presence")).toEqual([{ type: "presence", serverId: TELEGRAM_ID, userId: String(GRACE), online: true, lastSeenAt: expect.any(Number) }]);
  });

  it("stops showing typing when it's cancelled, and never for a chat it doesn't list", async () => {
    const { engine, events } = await ready();
    const action = (chat: number, kind: string) => engine.emit({ "@type": "updateChatAction", chat_id: chat, sender_id: { "@type": "messageSenderUser", user_id: GRACE }, action: { "@type": kind } });
    action(GRACE, "chatActionTyping");
    action(GRACE, "chatActionCancel");
    action(CHANNEL, "chatActionTyping");
    engine.emit({ "@type": "updateChatAction", chat_id: GRACE, sender_id: null, action: { "@type": "chatActionTyping" } });
    expect(of(events, "typing")).toHaveLength(1);
  });

  it("pins, mutes, marks, archives and reads chats, and says what Telegram refuses", async () => {
    const { engine, session } = await ready();
    await session.mute(`group:${GROUP}`, Date.now() + 10_000);
    expect(engine.requests("setChatNotificationSettings").at(-1)!.notification_settings.mute_for).toBe(60);
    // A chat this side never had settings for gets them made.
    engine.emit({ "@type": "updateChatNotificationSettings", chat_id: GRACE, notification_settings: null });
    await session.mute(`user:${GRACE}`);
    expect(engine.requests("setChatNotificationSettings").at(-1)!.notification_settings).toEqual({ "@type": "chatNotificationSettings", use_default_mute_for: false, mute_for: 0x7fffffff });

    engine.refuse("setChatNotificationSettings", "CHAT_WRITE_FORBIDDEN");
    await expect(session.unmute(`user:${GRACE}`)).rejects.toThrow("You can't write in this chat.");
    engine.refuse("toggleChatIsMarkedAsUnread", "USER_IS_BLOCKED");
    await expect(session.setMarkedUnread(`user:${GRACE}`, true)).rejects.toThrow("You can't write to this person.");
    engine.refuse("toggleChatIsPinned", "Too Many Requests: retry after 600", 429);
    await expect(session.updatePreferences({ pinned: [] })).rejects.toThrow("Telegram asks to wait 10 minutes");
    engine.refuse("addChatToList", "CHANNELS_TOO_MUCH");
    await expect(session.updatePreferences({ hidden: [`user:${GRACE}`] })).rejects.toThrow("You're in as many groups as Telegram allows.");
    engine.refuse("createPrivateChat", "USER_PRIVACY_RESTRICTED");
    await expect(session.saveDraft("user:4040", "hi")).rejects.toThrow("Their privacy settings on Telegram don't let you add them.");
  });

  it("reads a chat all the way, its mentions and its mark, but asks nothing for what's read", async () => {
    const { engine, session } = await ready();
    engine.emit({ "@type": "updateChatUnreadMentionCount", chat_id: BOT, unread_mention_count: 1 });
    engine.emit({ "@type": "updateChatLastMessage", chat_id: BOT, last_message: textMessage(BOT, serverId(4), BOT, "Sunny"), positions: [] });
    await session.markChatRead(`user:${BOT}`);
    expect(engine.requests("viewMessages").at(-1)).toMatchObject({ chat_id: BOT, message_ids: [serverId(4)] });
    expect(engine.requests("toggleChatIsMarkedAsUnread").at(-1)).toMatchObject({ chat_id: BOT, is_marked_as_unread: false });
    expect(engine.requests("readAllChatMentions")).toEqual([expect.objectContaining({ chat_id: BOT })]);
    // A chat with nothing in it has nothing to read.
    const asked = engine.asked.length;
    await session.markChatRead(`group:${GROUP}`);
    expect(engine.asked.slice(asked).map((request) => request["@type"])).toEqual([]);
  });

  it("finds a group's unread mentions, oldest first, and reads one jumped to", async () => {
    const { engine, session } = await ready();
    engine.answer("searchChatMessages", { "@type": "foundChatMessages", messages: [{ id: 30 }, { id: 10 }, { id: 20 }, { id: "x" }] });
    expect(await session.unreadMentions(String(GROUP), 10)).toEqual([
      { id: "20", seq: 20 },
      { id: "30", seq: 30 },
    ]);
    expect(engine.requests("searchChatMessages").at(-1)).toMatchObject({ chat_id: GROUP, filter: { "@type": "searchMessagesFilterUnreadMention" } });
    session.markMentionSeen(String(GROUP), "20");
    await until(() => engine.requests("viewMessages").length === 1, "the mention read");
    expect(engine.requests("viewMessages")[0]).toMatchObject({ chat_id: GROUP, message_ids: [20], force_read: true });
    engine.refuse("searchChatMessages", "INTERNAL", 500);
    expect(await session.unreadMentions(String(GROUP))).toEqual([]);
  });
});

describe("what changes in a message", () => {
  it("replaces a message whose sending failed, and keeps one that failed where it was", async () => {
    const { engine, events, session } = await ready();
    const failed = { ...textMessage(GRACE, serverId(30), SELF, "lost"), sending_state: { "@type": "messageSendingStateFailed" } };
    engine.emit({ "@type": "updateMessageSendFailed", message: failed, old_message_id: 77, error: { code: 400, message: "x" } });
    expect(of(events, "message_removed")).toEqual([{ type: "message_removed", serverId: TELEGRAM_ID, groupId: String(GRACE), id: "77" }]);
    expect(of(events, "message").at(-1)).toMatchObject({ message: { id: String(serverId(30)), status: "failed" }, isNew: false });
    // Failed under its own number: nothing to take away.
    engine.emit({ "@type": "updateMessageSendFailed", message: failed, old_message_id: serverId(30) });
    engine.emit({ "@type": "updateMessageSendFailed", message: null, old_message_id: 1 });
    engine.emit({ "@type": "updateMessageSendSucceeded", message: { ...failed, chat_id: 0 }, old_message_id: 1 });
    engine.emit({ "@type": "updateMessageSendSucceeded", message: failed });
    expect(of(events, "message_removed")).toHaveLength(1);
    expect(await session.messageById(String(GRACE), String(serverId(30)))).toMatchObject({ status: "failed" });
  });

  it("follows a message's new content and its pin, and drops a deletion it can't read", async () => {
    const { engine, events, session } = await ready();
    await session.loadMessages(String(GRACE));
    engine.emit({ "@type": "updateMessageContent", chat_id: GRACE, message_id: serverId(1), new_content: { "@type": "messageText", text: { text: "Hello again", entities: [] } } });
    engine.emit({ "@type": "updateMessageIsPinned", chat_id: GRACE, message_id: serverId(1), is_pinned: true });
    expect(of(events, "message").at(-1)).toMatchObject({ message: { text: "Hello again", pinnedAt: expect.any(Number) } });
    // For a message it doesn't hold, nothing.
    const before = events.length;
    engine.emit({ "@type": "updateMessageIsPinned", chat_id: GRACE, message_id: 5, is_pinned: true });
    engine.emit({ "@type": "updateDeleteMessages", chat_id: 0, message_ids: [1], is_permanent: true });
    engine.emit({ "@type": "updateDeleteMessages", chat_id: GRACE, message_ids: ["x", 0], is_permanent: true });
    expect(events.length).toBe(before);
  });

  it("names the one a service line is about, as a chat that speaks as itself or someone it doesn't know", async () => {
    const { engine, events } = await ready();
    const line = (sender: unknown) => engine.emit({ "@type": "updateNewMessage", message: { ...textMessage(GROUP, serverId(40), GRACE, ""), sender_id: sender, content: { "@type": "messageChatChangeTitle", title: "Trip" } } });
    line({ "@type": "messageSenderUser", user_id: GRACE });
    line({ "@type": "messageSenderUser", user_id: 4444 });
    line({ "@type": "messageSenderChat", chat_id: GROUP });
    line({ "@type": "messageSenderChat", chat_id: 5555 });
    expect(of(events, "message").slice(-4).map((event) => event.message.text)).toEqual(["_Grace Hopper named the group “Trip”_", "_Someone named the group “Trip”_", "_Weekend trip named the group “Trip”_", "_Someone named the group “Trip”_"]);
  });

  it("keeps a chat's newest four hundred messages in memory, and forgets the oldest", async () => {
    const { engine, session } = await ready();
    for (let n = 1; n <= 451; n++) engine.emit({ "@type": "updateNewMessage", message: textMessage(GROUP, serverId(1000 + n), GRACE, `m${n}`, { is_outgoing: true }) });
    engine.refuse("getMessage", "Not Found", 404);
    expect(await session.messageById(String(GROUP), String(serverId(1052)))).toMatchObject({ text: "m52" });
    expect(await session.messageById(String(GROUP), String(serverId(1051)))).toBeNull();
  });

  it("names a notification's group Group when it has no title, and the sender by their name", async () => {
    const { engine, events } = await ready();
    engine.emit({ "@type": "updateChatTitle", chat_id: GROUP, title: "" });
    engine.emit({ "@type": "updateChatNotificationSettings", chat_id: GROUP, notification_settings: { mute_for: 0 } });
    engine.emit({ "@type": "updateNewMessage", message: { ...textMessage(GROUP, serverId(50), GRACE, ""), content: { "@type": "messagePoll" } } });
    expect(of(events, "notify").at(-1)).toMatchObject({ title: "Group", body: expect.stringMatching(/^Grace Hopper: /), inUse: false });
    // A chat without a place in a list notifies nothing.
    engine.emit({ "@type": "updateChatPosition", chat_id: GRACE, position: { "@type": "chatPosition", list: { "@type": "chatListMain" }, order: "0" } });
    const count = of(events, "notify").length;
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(51), GRACE, "hi") });
    engine.emit({ "@type": "updateNewMessage", message: "not a message" });
    expect(of(events, "notify")).toHaveLength(count);
    engine.emit({ "@type": "updateChatPosition", chat_id: GRACE, position: "nonsense" });
  });
});

describe("history, media and search", () => {
  it("reads around a message, and what came after one", async () => {
    const { engine, session } = await ready();
    const around = await session.loadAround(String(GRACE), serverId(2));
    expect(around.map((message) => message.text)).toEqual(["Hello Ada", "Hi! How are you?", "See you at 8? **bold**"]);
    expect(engine.requests("getChatHistory").at(-1)).toMatchObject({ from_message_id: serverId(2), offset: -25 });
    const newer = await session.loadNewer(String(GRACE), serverId(1));
    expect(newer).toMatchObject({ hasMore: false });
    expect(newer.messages.map((message) => message.id)).toEqual([String(serverId(2)), String(serverId(3))]);
  });

  it("asks again until TDLib has as many as asked for, and goes on without a page it can't give", async () => {
    const { engine, session } = await ready();
    engine.history.set(GRACE, Array.from({ length: 120 }, (_, index) => textMessage(GRACE, serverId(index + 1), GRACE, `n${index + 1}`)));
    const page = await session.loadMessages(String(GRACE));
    expect(page.messages).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    engine.refuse("getChatHistory", "INTERNAL", 500);
    expect(await session.loadMessages(String(GRACE), serverId(10))).toEqual({ messages: [], hasMore: false });
  });

  it("closes the chat open before, and gets a message it hasn't seen from Telegram", async () => {
    const { engine, session } = await ready();
    await session.loadMessages(String(GRACE));
    await session.loadMessages(String(BOT));
    await session.loadMessages(String(BOT));
    await until(() => engine.requests("closeChat").length === 1, "the chat closed");
    expect(engine.requests("closeChat")[0]).toMatchObject({ chat_id: GRACE });
    expect(engine.requests("openChat")).toHaveLength(2);
    engine.history.set(BOT, [textMessage(BOT, serverId(9), BOT, "Rain")]);
    expect(await session.messageById(String(BOT), String(serverId(9)))).toMatchObject({ text: "Rain" });
    expect(await session.messageById(String(BOT), String(serverId(10)))).toBeNull();
  });

  it("counts a chat's media by kind, and lists one kind a page at a time", async () => {
    const { engine, session } = await ready();
    engine.answer("getChatMessageCount", { "@type": "count", count: 7 });
    expect(await session.mediaCounts(String(GRACE))).toEqual({ photo: 7, video: 7, file: 7, audio: 7, voice: 7, link: 7 });
    expect(engine.requests("getChatMessageCount").map((request) => request.filter["@type"])).toEqual([
      "searchMessagesFilterPhoto",
      "searchMessagesFilterVideo",
      "searchMessagesFilterDocument",
      "searchMessagesFilterAudio",
      "searchMessagesFilterVoiceNote",
      "searchMessagesFilterUrl",
    ]);
    engine.refuse("getChatMessageCount", "INTERNAL", 500);
    expect((await session.mediaCounts(String(GRACE))).photo).toBe(0);

    const photo = (n: number) => ({ ...textMessage(GRACE, serverId(n), GRACE, ""), content: { "@type": "messagePhoto", caption: { text: "", entities: [] }, photo: { sizes: [{ photo: { id: n }, width: 10, height: 10 }] } } });
    engine.answer("searchChatMessages", { "@type": "foundChatMessages", messages: [photo(5), photo(4), photo(3)] });
    const first = await session.loadMedia(String(GRACE), "photo", undefined, 2);
    expect(first.messages.map((message) => message.attachments[0]!.fileId)).toEqual(["tg:5", "tg:4", "tg:3"]);
    expect(first.hasMore).toBe(true);
    expect(engine.requests("searchChatMessages").at(-1)).toMatchObject({ limit: 2, from_message_id: 0, filter: { "@type": "searchMessagesFilterPhoto" } });
    const older = await session.loadMedia(String(GRACE), "photo", serverId(4), 500);
    expect(older.messages.map((message) => message.id)).toEqual([String(serverId(3))]);
    expect(engine.requests("searchChatMessages").at(-1)).toMatchObject({ limit: 100, from_message_id: serverId(4) });
    expect(await session.loadMedia(String(GRACE), "stickers")).toEqual({ messages: [], hasMore: false });
    engine.refuse("searchChatMessages", "INTERNAL", 500);
    expect(await session.loadMedia(String(GRACE), "photo")).toEqual({ messages: [], hasMore: false });
  });

  it("lists a chat's pins, and nothing when Telegram can't", async () => {
    const { engine, session } = await ready();
    engine.history.get(GRACE)![0]!.is_pinned = true;
    expect((await session.loadPins(String(GRACE))).map((message) => message.text)).toEqual(["Hello Ada"]);
    engine.refuse("searchChatMessages", "INTERNAL", 500);
    expect(await session.loadPins(String(GRACE))).toEqual([]);
  });

  it("searches one chat or all of them, keeping what's found in chats the list has", async () => {
    const { engine, session } = await ready();
    engine.history.set(CHANNEL, [textMessage(CHANNEL, serverId(1), GRACE, "hello from the news")]);
    expect(await session.search("   ")).toEqual([]);
    const everywhere = await session.search("hello");
    expect(everywhere.map((result) => [result.conversationKey, result.message.text])).toEqual([[`user:${GRACE}`, "Hello Ada"]]);
    expect(engine.requests("searchMessages").at(-1)).toMatchObject({ query: "hello", chat_list: { "@type": "chatListMain" } });
    const inOne = await session.search("you", String(GRACE), 500);
    expect(inOne.map((result) => result.message.id)).toEqual([String(serverId(2)), String(serverId(3))]);
    expect(engine.requests("searchChatMessages").at(-1)).toMatchObject({ chat_id: GRACE, limit: 100 });
    engine.answer("searchMessages", { "@type": "foundMessages", messages: ["junk", { "@type": "message" }] });
    expect(await session.search("x")).toEqual([]);
  });
});

describe("sending, and what Telegram refuses", () => {
  it("sends a place, and nothing that's empty or forwarded from a server", async () => {
    const { engine, session } = await ready();
    await session.sendMessage(`user:${GRACE}`, { text: "", location: { lat: 52.23, lon: 21.01, accuracy: 12 } });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content).toEqual({
      "@type": "inputMessageLocation",
      location: { "@type": "location", latitude: 52.23, longitude: 21.01, horizontal_accuracy: 12 },
      live_period: 0,
      heading: 0,
      proximity_alert_radius: 0,
    });
    await session.sendMessage(`user:${GRACE}`, { text: "", location: { lat: 1, lon: 2 } });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content.location.horizontal_accuracy).toBe(0);
    await expect(session.sendMessage(`user:${GRACE}`, { text: "  " })).rejects.toThrow("There's nothing to send.");
    await expect(session.sendMessage(`user:${GRACE}`, { text: "x", forwarded: { userId: "u" } } as never)).rejects.toThrow("Nothing is forwarded between Zuna and Telegram.");
    engine.refuse("sendMessage", "MESSAGE_TOO_LONG");
    await expect(session.sendMessage(`user:${GRACE}`, { text: "long" })).rejects.toThrow("That message is too long for Telegram.");
    engine.answer("sendMessage", { "@type": "message", id: 0, chat_id: GRACE });
    await expect(session.sendMessage(`user:${GRACE}`, { text: "lost" })).rejects.toThrow("Telegram didn't take that message.");
  });

  it("finds a chat by its key, as a person's, a group's or its bare number, and refuses what isn't one", async () => {
    const { engine, session } = await ready();
    await session.sendMessage(`group:${GROUP}`, { text: "to the group" });
    await session.sendMessage(String(GROUP), { text: "again" });
    expect(engine.requests("sendMessage").map((request) => request.chat_id)).toEqual([GROUP, GROUP]);
    // A person with no chat yet gets one, which the list then has.
    await session.sendMessage("user:5000", { text: "hi" });
    expect(engine.requests("createPrivateChat").at(-1)).toMatchObject({ user_id: 5000 });
    expect(await session.messageById("5000", "1")).toBeNull();
    engine.answer("createPrivateChat", { "@type": "chat", id: 0 });
    await expect(session.sendMessage("user:6000", { text: "hi" })).rejects.toThrow("That chat isn't on Telegram here.");
    await expect(session.sendMessage("channel:1", { text: "hi" })).rejects.toThrow("That chat isn't on Telegram here.");
    await expect(session.sendMessage(String(CHANNEL), { text: "hi" })).rejects.toThrow("That chat isn't on Telegram here.");
  });

  it("edits, deletes, reacts and pins as Telegram does, and says what it refuses", async () => {
    const { engine, session } = await ready();
    await session.editMessage(String(GRACE), String(serverId(2)), "**fixed**");
    expect(engine.requests("editMessageText")[0]).toMatchObject({ chat_id: GRACE, message_id: serverId(2), input_message_content: { text: { text: "fixed" } } });
    engine.refuse("editMessageText", "MESSAGE_NOT_MODIFIED");
    await expect(session.editMessage(String(GRACE), String(serverId(2)), "fixed")).rejects.toThrow("Nothing changed.");

    await session.deleteMessage(String(GRACE), String(serverId(2)));
    expect(engine.requests("deleteMessages")[0]).toMatchObject({ message_ids: [serverId(2)], revoke: true });
    await session.deleteMessages(String(GRACE), ["x", String(serverId(1))]);
    expect(engine.requests("deleteMessages")[1]!.message_ids).toEqual([serverId(1)]);
    engine.refuse("deleteMessages", "CHAT_ADMIN_REQUIRED");
    await expect(session.deleteMessage(String(GRACE), "1")).rejects.toThrow("Only the group's admins can do that.");

    // A reaction to a message it hasn't seen is added.
    await session.toggleReaction(String(GRACE), "12345", "🔥");
    expect(engine.requests("addMessageReaction")[0]).toMatchObject({ chat_id: GRACE, message_id: 12345, reaction_type: { emoji: "🔥" } });
    engine.refuse("addMessageReaction", "REACTION_INVALID");
    await expect(session.toggleReaction(String(GRACE), "12345", "🔥")).rejects.toThrow("Telegram said: REACTION_INVALID");

    await session.setPinned(String(GRACE), String(serverId(1)), true);
    await session.setPinned(String(GRACE), String(serverId(1)), false);
    expect(engine.requests("pinChatMessage")[0]).toMatchObject({ chat_id: GRACE, message_id: serverId(1), disable_notification: true });
    expect(engine.requests("unpinChatMessage")[0]).toMatchObject({ chat_id: GRACE, message_id: serverId(1) });
    engine.refuse("unpinChatMessage", "CHAT_ADMIN_REQUIRED");
    await expect(session.setPinned(String(GRACE), "1", false)).rejects.toThrow("Only the group's admins can do that.");

    await session.markListened(String(GRACE), String(serverId(3)));
    expect(engine.requests("openMessageContent")[0]).toMatchObject({ chat_id: GRACE, message_id: serverId(3) });
  });

  it("says what Telegram refuses of a button, a forward, a sticker or a download", async () => {
    const { engine, session } = await ready();
    engine.history.set(BOT, [{ ...textMessage(BOT, serverId(5), BOT, "?"), reply_markup: { "@type": "replyMarkupInlineKeyboard", rows: [[{ text: "Go", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "AQ==" } }]] } }]);
    await session.loadMessages(String(BOT));
    engine.refuse("getCallbackQueryAnswer", "BOT_RESPONSE_TIMEOUT");
    await expect(session.pressButton(String(BOT), String(serverId(5)), 0, 0)).rejects.toThrow("Telegram said: BOT_RESPONSE_TIMEOUT");
    await expect(session.pressButton(String(BOT), "1", 0, 0)).rejects.toThrow("That button isn't there any more.");
    engine.refuse("forwardMessages", "CHAT_WRITE_FORBIDDEN");
    await expect(session.forwardMessages(String(GRACE), [String(serverId(1)), "-1"], `group:${GROUP}`)).rejects.toThrow("You can't write in this chat.");
    expect(engine.requests("forwardMessages")[0]!.message_ids).toEqual([serverId(1)]);
    engine.refuse("sendMessage", "CHAT_WRITE_FORBIDDEN");
    await expect(session.sendSticker(`user:${GRACE}`, 801, "🐱", 512, 512)).rejects.toThrow("You can't write in this chat.");
    engine.answer("downloadFile", { "@type": "file", id: 7, local: { path: "C:/x", is_downloading_completed: false } });
    await expect(session.downloadFile({ fileId: "tg:7" })).rejects.toThrow("Telegram didn't send that file.");
    engine.answer("downloadFile", { "@type": "file", id: 7, local: { path: "C:/x", is_downloading_completed: true } });
    expect((await session.downloadFile({ fileId: "tg:7" })).type).toBe("application/octet-stream");
    engine.answer("getMessageProperties", { "@type": "error" });
    engine.refuse("getMessageProperties", "Not Found", 404);
    expect(await session.deleteChoices(String(GRACE), "1")).toEqual({ forEveryone: false, forSelf: false });
  });

  it("refuses a file past Telegram's limit, and sends each kind as Telegram's message for it", async () => {
    const sizes = new Map<Blob, number>();
    const files: FileAdapter = {
      size: (blob) => sizes.get(blob) ?? blob.size,
      type: (blob) => blob.type,
      read: async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
      assemble: async (parts, mime) => new Blob(parts as BlobPart[], { type: mime }),
    };
    const { engine, session } = await ready({ files });
    const huge = new Blob(["x"]);
    sizes.set(huge, 2001 * 1024 * 1024);
    await expect(session.sendWithAttachments(`user:${GRACE}`, [{ blob: huge, name: "film.mkv", mime: "video/x-matroska" }], { text: "" })).rejects.toThrow("film.mkv is larger than Telegram's 2 GB limit.");

    // With no files, it's a message.
    await session.sendWithAttachments(`user:${GRACE}`, [], { text: "just words" });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content["@type"]).toBe("inputMessageText");

    const file = (name: string, mime: string, extra: Record<string, unknown> = {}) => ({ blob: new Blob(["data"], { type: mime }), name, mime, ...extra });
    const sent = [
      file("round.mp4", "video/mp4", { round: true, width: 1000, duration: 4.6 }),
      file("cat.gif", "image/gif", { width: 10.4, height: 20.6 }),
      file("clip.mp4", "video/mp4", { width: 640, height: 360, duration: 3 }),
      file("song.mp3", "audio/mpeg", { duration: 200 }),
      file("photo.webp", "image/webp"),
    ];
    // More than one, not all pictures: each its own message, the reply on the first.
    await session.sendWithAttachments(`user:${GRACE}`, sent, { text: "**all**", replyTo: String(serverId(3)) }, { keepMetadata: true });
    const contents = engine.requests("sendMessage").slice(-5);
    expect(contents.map((request) => request.input_message_content["@type"])).toEqual(["inputMessageVideoNote", "inputMessageAnimation", "inputMessageVideo", "inputMessageAudio", "inputMessagePhoto"]);
    expect(contents.map((request) => request.reply_to?.message_id ?? null)).toEqual([serverId(3), null, null, null, null]);
    expect(contents[0]!.input_message_content.video_note).toMatchObject({ length: 640, duration: 5 });
    expect(contents[1]!.input_message_content).toMatchObject({ animation: { width: 10, height: 21 }, caption: { text: "" } });
    expect(contents[2]!.input_message_content.video).toMatchObject({ width: 640, height: 360, duration: 3, supports_streaming: true });
    expect(contents[3]!.input_message_content.audio).toMatchObject({ duration: 200 });
    expect(contents[4]!.input_message_content.photo).toMatchObject({ width: 0, height: 0 });
    // A video note's name, as any, is made safe: no folder of the device in it.
    await session.sendWithAttachments(`user:${GRACE}`, [file("..\\..\\x.mp4", "video/mp4", { round: true })], { text: "" });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content.video_note.video_note.original_path).toMatch(/^zuna-[a-z0-9-]+\/_.._x\.mp4$/);
    await session.sendWithAttachments(`user:${GRACE}`, [file("...", "application/pdf")], { text: "" });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content.document.document.original_path).toMatch(/\/file$/);

    engine.refuse("sendMessageAlbum", "CHAT_WRITE_FORBIDDEN");
    await expect(session.sendWithAttachments(`user:${GRACE}`, [file("a.png", "image/png"), file("b.png", "image/png")], { text: "" }, { keepMetadata: true })).rejects.toThrow("You can't write in this chat.");
    engine.refuse("sendMessage", "USER_IS_BLOCKED");
    await expect(session.sendWithAttachments(`user:${GRACE}`, [file("a.txt", "text/plain")], { text: "" }, { keepMetadata: true })).rejects.toThrow("You can't write to this person.");
  });

  it("strips a picture's metadata unless asked not to, and tells TDLib when a file can't be read", async () => {
    const files: FileAdapter = {
      size: (blob) => blob.size,
      type: (blob) => blob.type,
      read: async (blob, start, end) => {
        if (blob.type === "application/x-broken") throw new Error("the disk went away");
        return new Uint8Array(await blob.slice(start, end).arrayBuffer());
      },
      assemble: async (parts, mime) => new Blob(parts as BlobPart[], { type: mime }),
    };
    const { engine, session } = await ready({ files });
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob(["broken"], { type: "application/x-broken" }), name: "broken.bin", mime: "application/x-broken" }], { text: "" }, { keepMetadata: true });
    const broken = await until(() => [...engine.generated.entries()].find(([path, written]) => path.endsWith("/broken.bin") && written.finished), "the failure");
    expect(broken[1].error).toMatch(/the disk went away/);
    // A plain text file goes through the metadata check, which leaves it as it is.
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob(["notes"], { type: "text/plain" }), name: "notes.txt", mime: "text/plain" }], { text: "" });
    const notes = await until(() => [...engine.generated.entries()].find(([path, written]) => path.endsWith("/notes.txt") && written.finished), "the notes");
    expect(atob(notes[1].data)).toBe("notes");
    // TDLib asks with a generation that isn't a number: nothing is said.
    const asked = engine.requests("finishFileGeneration").length;
    engine.emit({ "@type": "updateFileGenerationStart", generation_id: "x", original_path: "a", conversion: "zuna" });
    engine.emit({ "@type": "updateFileGenerationStop", generation_id: "x" });
    await settle();
    expect(engine.requests("finishFileGeneration")).toHaveLength(asked);
  });
});

describe("groups, the rest of the way", () => {
  it("says what Telegram refuses of making, changing and leaving a group", async () => {
    const { engine, session } = await ready();
    engine.refuse("createNewBasicGroupChat", "USERS_TOO_MUCH");
    await expect(session.createGroup("Big", [String(GRACE)])).rejects.toThrow("That group is full.");
    engine.answer("createNewBasicGroupChat", { "@type": "createdBasicGroupChat", chat_id: 0 });
    await expect(session.createGroup("Nothing", [])).rejects.toThrow("Telegram didn't make that group.");
    engine.refuse("addChatMembers", "USER_NOT_MUTUAL_CONTACT");
    await expect(session.addMembers(String(GROUP), [String(BOT), "-5"])).rejects.toThrow("Only their contacts can add them.");
    expect(engine.requests("addChatMembers")[0]!.user_ids).toEqual([BOT]);
    engine.refuse("setChatMemberStatus", "USER_CHANNELS_TOO_MUCH");
    await expect(session.removeMember(String(GROUP), String(GRACE))).rejects.toThrow("They're in as many groups as Telegram allows.");
    engine.refuse("leaveChat", "INTERNAL", 500);
    await expect(session.leaveGroup(String(GROUP))).rejects.toThrow("Telegram said: INTERNAL");
    engine.refuse("setChatTitle", "CHAT_ADMIN_REQUIRED");
    await expect(session.updateGroupMeta(String(GROUP), { name: "New" })).rejects.toThrow("Only the group's admins can do that.");
    engine.refuse("createChatInviteLink", "CHAT_ADMIN_REQUIRED");
    await expect(session.createInvite(String(GROUP))).rejects.toThrow("Only the group's admins can do that.");
    engine.answer("createChatInviteLink", { "@type": "chatInviteLink", invite_link: "https://evil.example/+x" });
    await expect(session.createInvite(String(GROUP))).rejects.toThrow("Telegram didn't make a link.");
  });

  it("sends a group's new picture a part at a time, as any file goes", async () => {
    const { engine, session } = await ready();
    await session.updateGroupMeta(String(GROUP), {}, new Blob(["not really a jpeg"], { type: "image/jpeg" }));
    const [request] = engine.requests("setChatPhoto");
    expect(request).toMatchObject({ chat_id: GROUP, photo: { "@type": "inputChatPhotoStatic", photo: { "@type": "inputFileGenerated", conversion: "zuna" } } });
    expect(request!.photo.photo.original_path).toMatch(/^zuna-[a-z0-9-]+\/picture\.jpg$/);
    expect(engine.requests("setChatTitle")).toEqual([]);
    engine.refuse("setChatPhoto", "CHAT_ADMIN_REQUIRED");
    await expect(session.updateGroupMeta(String(GROUP), {}, new Blob(["x"], { type: "image/png" }))).rejects.toThrow("Only the group's admins can do that.");
  });

  it("joins by a link only where Telegram lets this account in here", async () => {
    const { engine, session } = await ready();
    engine.refuse("checkChatInviteLink", "INVITE_HASH_EXPIRED");
    await expect(session.joinByLink("https://t.me/+old")).rejects.toThrow("That link doesn't lead anywhere any more.");
    engine.answer("checkChatInviteLink", { "@type": "chatInviteLinkInfo", chat_id: 0, type: { "@type": "inviteLinkChatTypeSupergroup" }, subscription_info: { "@type": "chatInviteLinkSubscriptionInfo" } });
    await expect(session.joinByLink("https://t.me/+paid")).rejects.toThrow("asks for a payment");
    engine.answer("checkChatInviteLink", { "@type": "chatInviteLinkInfo", chat_id: 0, type: { "@type": "inviteLinkChatTypeSupergroup" }, subscription_info: null });
    engine.answer("joinChatByInviteLink", { "@type": "chatJoinResultGuardBotApprovalRequired" });
    await expect(session.joinByLink("https://telegram.me/joinchat/guarded")).rejects.toThrow("That group's bot has to let you in first");
    engine.answer("joinChatByInviteLink", { "@type": "chatJoinResultSomethingNew" });
    await expect(session.joinByLink("https://t.me/+new")).rejects.toThrow("Telegram didn't let you in.");
    engine.refuse("joinChatByInviteLink", "USERS_TOO_MUCH");
    await expect(session.joinByLink("https://t.me/+full")).rejects.toThrow("That group is full.");
  });

  it("lists a supergroup's recent people, without those who left or were banned", async () => {
    const { engine, session } = await ready();
    engine.emit({ "@type": "updateNewChat", chat: { "@type": "chat", id: -1007, type: { "@type": "chatTypeSupergroup", supergroup_id: 7, is_channel: false }, title: "Big group", positions: [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order: "100" }] } });
    engine.answer("getSupergroupMembers", {
      "@type": "chatMembers",
      members: [
        { "@type": "chatMember", member_id: { "@type": "messageSenderUser", user_id: SELF }, status: { "@type": "chatMemberStatusAdministrator" }, joined_chat_date: 1_700_000_000 },
        { "@type": "chatMember", member_id: { "@type": "messageSenderUser", user_id: GRACE }, status: { "@type": "chatMemberStatusBanned" } },
        { "@type": "chatMember", member_id: { "@type": "messageSenderChat", chat_id: -1007 }, status: { "@type": "chatMemberStatusMember" } },
        { "@type": "chatMember", member_id: null, status: { "@type": "chatMemberStatusMember" } },
      ],
    });
    await session.loadMessages("-1007");
    const group = await until(() => session.getConversations().find((chat) => chat.groupId === "-1007" && chat.members.length > 0), "the members");
    expect(group.members).toEqual([
      { userId: String(SELF), role: "admin", joinedAt: 1_700_000_000_000 },
      { userId: "chat:-1007", role: "member", joinedAt: 0 },
    ]);
    expect(engine.requests("getSupergroupMembers")[0]).toMatchObject({ supergroup_id: 7, filter: { "@type": "supergroupMembersFilterRecent" } });
    // A supergroup whose people Telegram won't list has none shown.
    engine.emit({ "@type": "updateNewChat", chat: { "@type": "chat", id: -1008, type: { "@type": "chatTypeSupergroup", supergroup_id: 8, is_channel: false }, title: "Closed", positions: [{ "@type": "chatPosition", list: { "@type": "chatListMain" }, order: "99" }] } });
    engine.refuse("getSupergroupMembers", "CHAT_ADMIN_REQUIRED");
    await session.loadMessages("-1008");
    await until(() => engine.requests("getSupergroupMembers").length === 2, "the people asked for");
    await settle(80);
    expect(session.getConversations().find((chat) => chat.groupId === "-1008")!.members).toEqual([]);
    // A person's chat has no members to ask for.
    await session.loadMessages(String(GRACE));
    expect(engine.requests("getBasicGroupFullInfo")).toEqual([]);
  });

  it("lists a sticker set without a cover, and none that's not one", async () => {
    const { engine, session } = await ready();
    engine.answer("getInstalledStickerSets", { "@type": "stickerSets", sets: [{ "@type": "stickerSetInfo", id: "8", title: "", covers: [] }, { "@type": "stickerSetInfo", id: "x" }, "junk"] });
    expect(await session.getStickerSets()).toEqual([{ id: "8", title: "Stickers", cover: null }]);
    engine.refuse("getInstalledStickerSets", "INTERNAL", 500);
    expect(await session.getStickerSets()).toEqual([]);
    engine.refuse("getStickerSet", "INTERNAL", 500);
    expect(await session.getStickers("77")).toEqual([]);
  });
});

describe("Telegram's errors in the app's words", () => {
  it("passes on what isn't Telegram's own error as it is", async () => {
    const { engine, session } = await ready();
    engine.throwOn("leaveChat", new Error("the broker is gone"));
    await expect(session.leaveGroup(String(GROUP))).rejects.toThrow("the broker is gone");
    engine.throwOn("leaveChat", "a plain string");
    await expect(session.leaveGroup(String(GROUP))).rejects.toThrow("a plain string");
  });
});

describe("the Telegram account in the app", () => {
  async function client(engine = new Telegram()) {
    const events: CoreEvent[] = [];
    const app = new ZunaClient({ db: new MemoryDbProvider(), deviceKey: new Uint8Array(32).fill(4), deviceName: "Test", onEvent: (event) => events.push(event), telegram: engine });
    await app.open();
    return { app, engine, events };
  }

  it("links one account at a time, shows it online only in front, and keeps its place in the rail", async () => {
    const engine = new Telegram();
    engine.authorized = false;
    const { app } = await client(engine);
    app.setActive(true, TELEGRAM_ID);
    app.linkTelegram();
    app.linkTelegram();
    expect(engine.started).toBe(1);
    await until(() => app.telegramSession.getLink().step === "phone", "the phone step");
    await app.telegramSession.linkWithQr();
    engine.confirm();
    await until(() => app.listServers().length === 1, "being linked");
    await until(() => engine.requests("setOption").length === 1, "online");
    expect(engine.requests("setOption")[0]!.value.value).toBe(true);
    // Another server in front: Telegram's account isn't.
    app.setActive(true, "some-server");
    expect(engine.requests("setOption").at(-1)!.value.value).toBe(false);
    app.reorderServers([TELEGRAM_ID]);
    expect(app.listServers()).toEqual([expect.objectContaining({ kind: "telegram", id: TELEGRAM_ID })]);
    app.nudge();
    app.stop();
  });

  it("forgets an account that was half linked when asked to unlink, with nothing to sign out", async () => {
    const { app } = await client();
    expect(await app.unlinkTelegram()).toEqual({ signedOut: false });
    expect(app.findLink("see https://example.com/a and more")).toBe("https://example.com/a");
    app.stop();
  });
});

describe("what the session leaves out", () => {
  it("takes an account Telegram names without a number for nobody in particular", async () => {
    const engine = new Telegram();
    engine.authorized = true;
    engine.answer("getMe", { "@type": "user", id: "1000" });
    const session = new TelegramSession(engine, { onEvent: () => undefined, linking: false, onLinked: () => undefined, onGone: () => undefined });
    session.start();
    await until(() => engine.requests("loadChats").length > 0, "the list asked for");
    expect(session.getSelf().userId).toBe("");
  });

  it("notes an update it doesn't show once, and changes nothing for one that names no chat or message", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { engine, events, session } = await ready();
    engine.emit({ "@type": "updateStoryNew", story: {} });
    engine.emit({ "@type": "updateStoryNew", story: {} });
    expect(debug.mock.calls.filter((call) => String(call[0]).includes("updateStoryNew"))).toHaveLength(1);
    const before = events.filter((event) => event.type !== "conversations" && event.type !== "preferences").length;
    engine.emit({ "@type": "updateChatTitle", title: "Nobody" });
    engine.emit({ "@type": "updateChatLastMessage", chat_id: GRACE, last_message: null, positions: [] });
    engine.emit({ "@type": "updateChatReadInbox", chat_id: GRACE, last_read_inbox_message_id: 0, unread_count: 0 });
    engine.emit({ "@type": "updateChatReadOutbox", chat_id: GRACE, last_read_outbox_message_id: 0 });
    engine.emit({ "@type": "updateMessageIsPinned", chat_id: GRACE, is_pinned: true });
    // A message without a number: nothing to show, and nothing to notify.
    engine.emit({ "@type": "updateNewMessage", message: { ...textMessage(GRACE, 0, GRACE, "no number") } });
    engine.emit({ "@type": "updateNewMessage", message: { ...textMessage(0, serverId(60), GRACE, "no chat") } });
    expect(events.filter((event) => event.type !== "conversations" && event.type !== "preferences")).toHaveLength(before);
    expect(session.getConversations().find((chat) => chat.key === `user:${GRACE}`)!.lastMessage).toBeNull();
  });

  it("says a group was read by everyone, and words a message with nothing in it as a message", async () => {
    const { engine, events } = await ready();
    engine.emit({ "@type": "updateChatReadOutbox", chat_id: GROUP, last_read_outbox_message_id: serverId(3) });
    expect(of(events, "read").at(-1)).toMatchObject({ groupId: String(GROUP), userId: "*", seq: serverId(3) });
    engine.emit({ "@type": "updateNewMessage", message: textMessage(GRACE, serverId(61), GRACE, "") });
    expect(of(events, "notify").at(-1)).toMatchObject({ body: "Message" });
  });

  it("lists pinned chats by Telegram's order, newest first", async () => {
    const { engine, session } = await ready();
    const pin = (chat: number, order: string) => engine.emit({ "@type": "updateChatPosition", chat_id: chat, position: { "@type": "chatPosition", list: { "@type": "chatListMain" }, order, is_pinned: true } });
    pin(GRACE, "500");
    pin(BOT, "500");
    pin(GROUP, "900");
    expect(session.getPreferences().pinned[0]).toBe(`group:${GROUP}`);
    pin(GRACE, "950");
    expect(session.getPreferences().pinned).toEqual([`user:${GRACE}`, `group:${GROUP}`, `user:${BOT}`]);
    await session.updatePreferences({ pinned: [`user:${GRACE}`] });
    expect(engine.requests("toggleChatIsPinned").map((request) => [request.chat_id, request.is_pinned])).toEqual(expect.arrayContaining([[GROUP, false], [BOT, false]]));
  });

  it("sends with no text at all, and shows nothing for what Telegram answers without a number", async () => {
    const { engine, events, session } = await ready();
    await session.sendMessage(`user:${GRACE}`, { location: { lat: 1, lon: 2 } });
    await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob(["x"]), name: "x.bin", mime: "application/octet-stream" }], {}, { keepMetadata: true });
    expect(engine.requests("sendMessage").at(-1)!.input_message_content.caption.text).toBe("");
    // Once Telegram has said both were sent.
    await settle();
    const shown = of(events, "message").length;
    engine.answer("sendMessage", { "@type": "message", id: 0, chat_id: GRACE });
    await session.sendSticker(`user:${GRACE}`, 801, "🐱", 512, 512);
    expect(await session.sendWithAttachments(`user:${GRACE}`, [{ blob: new Blob(["x"]), name: "x.bin", mime: "application/octet-stream" }], { text: "" }, { keepMetadata: true })).toBe("");
    engine.answer("sendMessageAlbum", { "@type": "messages", messages: [] });
    const pictures = [0, 1].map((n) => ({ blob: new Blob([String(n)]), name: `${n}.png`, mime: "image/png" }));
    expect(await session.sendWithAttachments(`user:${GRACE}`, pictures, { text: "" }, { keepMetadata: true })).toBe("");
    expect(of(events, "message")).toHaveLength(shown);
  });

  it("shows no cover for a sticker set whose first sticker has no picture, and lists media without a number", async () => {
    const { engine, session } = await ready();
    engine.answer("getInstalledStickerSets", { "@type": "stickerSets", sets: [{ "@type": "stickerSetInfo", id: "9", title: "Moving", covers: [{ "@type": "sticker", format: { "@type": "stickerFormatTgs" }, thumbnail: null, sticker: { id: 5 } }] }] });
    expect(await session.getStickerSets()).toEqual([{ id: "9", title: "Moving", cover: null }]);
    engine.answer("searchChatMessages", { "@type": "foundChatMessages", messages: [{ "@type": "message", chat_id: GRACE }] });
    expect((await session.loadMedia(String(GRACE), "file", serverId(5))).messages).toEqual([]);
  });
});
