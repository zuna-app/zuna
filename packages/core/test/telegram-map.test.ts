// What TDLib says, read through the mapping's checks (telegram/map.ts) and its text through the
// markup's (telegram/markup.ts): every kind of media, sender, status, list position, reaction,
// button, reply and forward, and what's left out when a field isn't what it should be. Plain
// functions, with no engine and no server.

import { describe, expect, it } from "vitest";
import {
  attachmentsOf,
  avatarOf,
  chatKey,
  chatKind,
  chatSenderView,
  conversationView,
  displayName,
  formatted,
  messageView,
  muteFor,
  positionIn,
  presenceOf,
  senderOf,
  userView,
  usernameOf,
  waveformFromTelegram,
  waveformToTelegram,
  type ChatContext,
  type MessageContext,
} from "../src/telegram/map";
import { fromMarkup, toMarkup } from "../src/telegram/markup";
import type { TdObject } from "../src/telegram/engine";

const SELF = 1000;
const GRACE = 2000;
const GROUP = -300;
const NOW = 1_800_000_000_000;
const file = (id: unknown, size = 100, change: Record<string, unknown> = {}) => ({ "@type": "file", id, size, ...change });

const messages: MessageContext = { selfId: SELF, now: NOW, find: () => undefined, nameOf: (id) => (id ? `Person ${id}` : "Someone") };

function message(content: unknown, change: Record<string, unknown> = {}): TdObject {
  return { "@type": "message", id: 1048576, chat_id: GRACE, sender_id: { "@type": "messageSenderUser", user_id: GRACE }, date: 1_700_000_000, content, ...change };
}

const view = (content: unknown, change: Record<string, unknown> = {}, context = messages) => messageView(message(content, change), context)!;
const text = (words: string) => ({ "@type": "messageText", text: { text: words, entities: [] } });

describe("Telegram's media as the app's attachments", () => {
  it("shows videos, GIFs, audio and round videos with what Telegram says of them", () => {
    expect(
      attachmentsOf({ "@type": "messageVideo", video: { file_name: "clip.mov", mime_type: "video/quicktime", width: 1920, height: 1080, duration: 12, minithumbnail: { data: "AAEC" }, video: file(5, 0, { expected_size: 5000 }) } }),
    ).toEqual([{ fileId: "tg:5", key: "", prefix: "", chunks: 0, size: 5000, name: "clip.mov", mime: "video/quicktime", width: 1920, height: 1080, duration: 12, thumb: "data:image/jpeg;base64,AAEC" }]);
    // What isn't said takes the kind's defaults, and a thumbnail that isn't base64 is none.
    expect(attachmentsOf({ "@type": "messageAnimation", animation: { width: -1, minithumbnail: { data: "<svg>" }, animation: file(6) } })).toEqual([
      { fileId: "tg:6", key: "", prefix: "", chunks: 0, size: 100, name: "animation.mp4", mime: "video/mp4", width: undefined, height: undefined, duration: undefined, thumb: undefined },
    ]);
    expect(attachmentsOf({ "@type": "messageVideo", video: { video: file(0) } })).toBeNull();

    expect(attachmentsOf({ "@type": "messageAudio", audio: { title: "Song", file_name: "", mime_type: "audio/flac", duration: 200, audio: file(7) } })).toEqual([
      { fileId: "tg:7", key: "", prefix: "", chunks: 0, size: 100, name: "Song.mp3", mime: "audio/flac", duration: 200 },
    ]);
    expect(attachmentsOf({ "@type": "messageAudio", audio: { file_name: "...", audio: file(8) } })![0]).toMatchObject({ name: "audio.mp3", mime: "audio/mpeg", duration: undefined });

    expect(attachmentsOf({ "@type": "messageVideoNote", video_note: { length: 384, duration: 9, video: file(9) } })![0]).toMatchObject({ width: 384, height: 384, duration: 9, round: true, mime: "video/mp4" });
    expect(attachmentsOf({ "@type": "messageVideoNote", video_note: { video: file(10) } })![0]).toMatchObject({ width: 240, height: 240, duration: undefined });

    expect(attachmentsOf({ "@type": "messageVoiceNote", voice_note: { voice: file(11) } })![0]).toMatchObject({ name: "voice.ogg", mime: "audio/ogg", duration: undefined, waveform: undefined, voice: true });
    expect(attachmentsOf({ "@type": "messagePoll" })).toBeNull();
    expect(attachmentsOf(null)).toBeNull();
  });

  it("picks a photo's largest size up to 1280 pixels, or the smallest larger one when none fits", () => {
    const big = attachmentsOf({
      "@type": "messagePhoto",
      photo: {
        sizes: [
          { photo: file(1), width: 4000, height: 3000 },
          { photo: file(2), width: 2000, height: 1500 },
          // Without a file, or a size, it isn't one.
          { photo: file(3), width: 0, height: 10 },
          { photo: {}, width: 100, height: 100 },
        ],
      },
    });
    expect(big![0]).toMatchObject({ fileId: "tg:1", width: 4000, height: 3000, thumb: undefined });
    expect(attachmentsOf({ "@type": "messagePhoto", photo: { sizes: [{ photo: {}, width: 10, height: 10 }] } })).toBeNull();
    expect(attachmentsOf({ "@type": "messagePhoto" })).toBeNull();
  });

  it("shows an animated sticker by its still thumbnail, of whichever format it is", () => {
    const animated = (format: string, width?: number) => ({
      "@type": "messageSticker",
      sticker: { format: { "@type": "stickerFormatWebm" }, thumbnail: { format: { "@type": format }, width, height: width, file: file(40) }, sticker: file(41) },
    });
    expect(attachmentsOf(animated("thumbnailFormatWebp", 128))![0]).toMatchObject({ fileId: "tg:40", mime: "image/webp", sticker: true, width: 128, height: 128 });
    expect(attachmentsOf(animated("thumbnailFormatPng"))![0]).toMatchObject({ mime: "image/png", width: 512, height: 512 });
    expect(attachmentsOf(animated("thumbnailFormatJpeg", 5000))![0]).toMatchObject({ mime: "image/jpeg", width: 512 });
    expect(attachmentsOf(animated("thumbnailFormatGif"))).toBeNull();
    expect(attachmentsOf({ "@type": "messageSticker", sticker: { format: { "@type": "stickerFormatWebp" }, width: 100, height: 200, sticker: file(42) } })![0]).toMatchObject({ fileId: "tg:42", width: 100, height: 200 });
  });

  it("names files with nothing a path could make of them", () => {
    const named = (name: unknown) => attachmentsOf({ "@type": "messageDocument", document: { file_name: name, document: file(50) } })![0]!.name;
    expect(named('a<b>:c"d|e?f*g\\h/i')).toBe("a_b__c_d_e_f_g_h_i");
    expect(named("\u0000\u001fbell")).toBe("bell");
    expect(named("..hidden")).toBe("hidden");
    expect(named(42)).toBe("file");
  });

  it("packs nothing into no waveform, and keeps the last bar's bits from past the end", () => {
    expect(waveformFromTelegram("")).toBeUndefined();
    // Five bytes are eight bars of five bits each.
    const bars = Uint8Array.from(atob(waveformFromTelegram(btoa("\xff\xff\xff\xff\xff"))!), (char) => char.charCodeAt(0));
    expect([...bars]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(waveformToTelegram("")).toBe("");
    expect(waveformToTelegram("%%%")).toBe("");
  });
});

describe("Telegram's people as the app's users", () => {
  it("tells people from chats that speak as themselves, and from no one", () => {
    expect(senderOf({ "@type": "messageSenderUser", user_id: GRACE })).toBe(String(GRACE));
    expect(senderOf({ "@type": "messageSenderChat", chat_id: GROUP })).toBe(`chat:${GROUP}`);
    expect(senderOf({ "@type": "messageSenderChat", user_id: GRACE })).toBe("");
    expect(senderOf({ "@type": "messageSenderUser", user_id: 0 })).toBe("");
    expect(senderOf(undefined)).toBe("");
    expect(chatSenderView(GROUP, "")).toMatchObject({ id: `chat:${GROUP}`, displayName: "Unknown", bot: null });
    expect(chatSenderView(GROUP, "News").displayName).toBe("News");
  });

  it("names people as Telegram does, and takes only a username that's one", () => {
    expect(displayName({ "@type": "user", first_name: "Ada", last_name: "Lovelace", type: { "@type": "userTypeDeleted" } })).toBe("Deleted Account");
    expect(displayName({ "@type": "user", first_name: "", last_name: " " })).toBe("Unknown");
    expect(displayName({ "@type": "user", first_name: "Ada" })).toBe("Ada");
    expect(usernameOf({ "@type": "user", usernames: { editable_username: "", active_usernames: ["ada_l"] } })).toBe("ada_l");
    expect(usernameOf({ "@type": "user", usernames: { editable_username: "not one!" } })).toBe("");
    expect(usernameOf({ "@type": "user" })).toBe("");
  });

  it("is online until the status says it expires, and hides when exactly unless Telegram says", () => {
    expect(presenceOf({ "@type": "userStatusOnline", expires: NOW / 1000 + 60 }, NOW)).toEqual({ online: true, lastSeenAt: NOW, hidesLastSeen: false });
    expect(presenceOf({ "@type": "userStatusOnline", expires: NOW / 1000 - 60 }, NOW).online).toBe(false);
    expect(presenceOf({ "@type": "userStatusOffline", was_online: 1_700_000_000 }, NOW)).toEqual({ online: false, lastSeenAt: 1_700_000_000_000, hidesLastSeen: false });
    expect(presenceOf({ "@type": "userStatusOffline" }, NOW).lastSeenAt).toBeNull();
    expect(presenceOf({ "@type": "userStatusRecently" }, NOW)).toEqual({ online: false, lastSeenAt: null, hidesLastSeen: true });
  });

  it("shows a bot as never online, a deleted account as deleted, and this account as itself", () => {
    const bot = userView({ "@type": "user", id: 3000, first_name: "Helper", type: { "@type": "userTypeBot" }, status: { "@type": "userStatusOnline", expires: 2 ** 31 - 1 } }, SELF, NOW)!;
    expect(bot).toMatchObject({ online: false, hidesLastSeen: true, bot: { ownerId: "", listed: true, add: "owner" }, isSelf: false, deleted: false });
    const gone = userView({ "@type": "user", id: 4000, type: { "@type": "userTypeDeleted" } }, SELF, NOW)!;
    expect(gone).toMatchObject({ displayName: "Deleted Account", deleted: true, bot: null });
    const self = userView({ "@type": "user", id: SELF, first_name: "Ada", profile_photo: { small: file(60) } }, SELF, NOW)!;
    expect(self).toMatchObject({ isSelf: true, avatar: { fileId: "tg:60", mime: "image/jpeg" } });
    expect(avatarOf({ small: file(-1) })).toBeNull();
    expect(avatarOf(null)).toBeNull();
  });
});

describe("Telegram's chats as the app's conversations", () => {
  const listed = (order = "5", pinned = false, list = "chatListMain") => [{ list: { "@type": list }, order, is_pinned: pinned }];
  const chats = (change: Partial<ChatContext> = {}): ChatContext => ({ selfId: SELF, now: NOW, defaults: { private: 0, group: 3600 }, users: new Map(), lastMessage: null, ...change });

  it("keys people by who they are and groups by their chat, and lists no channel or secret chat", () => {
    const supergroup = { "@type": "chat", id: -1001, type: { "@type": "chatTypeSupergroup", is_channel: false } };
    expect([chatKind(supergroup), chatKey(supergroup)]).toEqual(["group", "group:-1001"]);
    expect(chatKind({ "@type": "chat", type: { "@type": "chatTypeBasicGroup" } })).toBe("group");
    expect(chatKind({ "@type": "chat", type: { "@type": "chatTypeSecret", user_id: GRACE } })).toBeNull();
    expect(chatKey({ "@type": "chat", id: 7, type: { "@type": "chatTypeSecret", user_id: GRACE } })).toBeNull();
    expect(chatKey({ "@type": "chat", id: GRACE, type: { "@type": "chatTypePrivate" } })).toBeNull();
    expect(chatKey({ "@type": "chat", id: "x", type: { "@type": "chatTypePrivate", user_id: GRACE } })).toBeNull();
  });

  it("takes a chat's place in a list only from an order that's a number", () => {
    const chat = (positions: unknown) => ({ "@type": "chat", positions });
    expect(positionIn(chat(listed("12345678901234567890", true)), "chatListMain")).toEqual({ order: 12345678901234567890n, pinned: true });
    expect(positionIn(chat(listed("0")), "chatListMain")).toBeNull();
    expect(positionIn(chat(listed("-5")), "chatListMain")).toBeNull();
    expect(positionIn(chat(listed("5", false, "chatListArchive")), "chatListMain")).toBeNull();
    expect(positionIn(chat("nonsense"), "chatListMain")).toBeNull();
  });

  it("mutes for the kind's default where the chat takes it, and for its own time otherwise", () => {
    const defaults = { private: 60, group: 3600 };
    const dm = (settings: unknown) => ({ "@type": "chat", type: { "@type": "chatTypePrivate", user_id: GRACE }, notification_settings: settings });
    const group = (settings: unknown) => ({ "@type": "chat", type: { "@type": "chatTypeBasicGroup" }, notification_settings: settings });
    expect(muteFor(dm({ use_default_mute_for: true, mute_for: 99 }), defaults)).toBe(60);
    expect(muteFor(group({ use_default_mute_for: true }), defaults)).toBe(3600);
    expect(muteFor(group({ mute_for: 99 }), defaults)).toBe(99);
    expect(muteFor(group({ mute_for: -1 }), defaults)).toBe(0);
    expect(muteFor(group(undefined), defaults)).toBe(0);
  });

  it("shows a group's marks, its readers, a mute's end, and when a draft moves it up the list", () => {
    const last = view(text("hello"));
    const group = conversationView(
      {
        "@type": "chat",
        id: GROUP,
        type: { "@type": "chatTypeBasicGroup" },
        title: "",
        positions: [...listed("9", true, "chatListArchive"), ...listed("8", true)],
        notification_settings: { use_default_mute_for: true },
        last_read_inbox_message_id: 5,
        last_read_outbox_message_id: 4,
        unread_count: 3,
        unread_mention_count: 2,
        is_marked_as_unread: true,
        draft_message: { date: 1_900_000_000 },
        message_auto_delete_time: 86400,
      },
      chats({ lastMessage: last }),
    )!;
    expect(group).toMatchObject({
      key: `group:${GROUP}`,
      kind: "group",
      peerId: null,
      title: "Unknown",
      lastMessage: last,
      lastActivityAt: 1_900_000_000_000,
      unread: 3,
      mentioned: true,
      unreadMentions: 2,
      pinned: true,
      muted: true,
      mutedUntil: NOW + 3600 * 1000,
      // In the main list as well, so not hidden.
      hidden: false,
      markedUnread: true,
      readBy: { "*": 4 },
      ownRead: 5,
      disappearAfter: 86400,
      blocked: false,
      bot: false,
    });
  });

  it("names a person's chat after them when it has no title, and shows a bot's, an archived one's and a blocked one's marks", () => {
    const users = new Map<number, TdObject>([[GRACE, { "@type": "user", id: GRACE, first_name: "Grace", type: { "@type": "userTypeBot" } }]]);
    const dm = conversationView(
      {
        "@type": "chat",
        id: GRACE,
        type: { "@type": "chatTypePrivate", user_id: GRACE },
        positions: listed("3", false, "chatListArchive"),
        notification_settings: { mute_for: 2 ** 31 - 1 },
        last_read_outbox_message_id: 7,
        unread_mention_count: 4,
        block_list: { "@type": "blockListMain" },
      },
      chats({ users }),
    )!;
    expect(dm).toMatchObject({ title: "Grace", hidden: true, pinned: false, muted: true, mutedUntil: null, readBy: { [GRACE]: 7 }, unreadMentions: 0, mentioned: true, bot: true, blocked: true, lastActivityAt: 0 });
    const stranger = conversationView({ "@type": "chat", id: 4000, type: { "@type": "chatTypePrivate", user_id: 4000 }, positions: listed() }, chats())!;
    expect(stranger).toMatchObject({ title: "Unknown", muted: false, mutedUntil: null, readBy: {}, hidden: false, bot: false });
  });
});

describe("Telegram's messages as the app's", () => {
  it("says what a message holds that Zuna can't show, and Telegram's words for what it can", () => {
    expect(view({ "@type": "messageSticker", sticker: { format: { "@type": "stickerFormatTgs" } } }).text).toBe("Sticker");
    expect(view({ "@type": "messageContact", contact: { first_name: "Alan", last_name: "Turing" } }).text).toBe("Contact: Alan Turing");
    expect(view({ "@type": "messageContact", contact: {} }).text).toBe("Contact: someone");
    expect(view({ "@type": "messagePoll", caption: { text: "Vote", entities: [] } }).text).toBe("Vote\n_Poll, which Zuna can't show yet. It's in Telegram's app._");
    expect(view({ "@type": "messageVideo", is_secret: true, video: { video: file(1) } }).text).toBe("_Video, to be seen once, which Zuna can't show yet. It's in Telegram's app._");
    expect(view({ "@type": "messageSomethingNew" }).text).toBe("_A message Zuna can't show, which Zuna can't show yet. It's in Telegram's app._");
    expect(view({ "@type": "messageLocation", location: { latitude: 52.2, longitude: 21 } })).toMatchObject({ text: "", location: { lat: 52.2, lon: 21 } });
    expect(view({ "@type": "messageLocation", location: { latitude: 0, longitude: 181 } }).location).toBeNull();
    expect(view({ "@type": "messageLocation", location: { latitude: "0", longitude: 0 } }).location).toBeNull();
  });

  it("puts what happened in a group as the app's system lines, or in words where it has none", () => {
    const line = (content: Record<string, unknown>, sender: unknown = { "@type": "messageSenderUser", user_id: GRACE }) => view(content, { chat_id: GROUP, sender_id: sender });
    expect(line({ "@type": "messageChatJoinByLink" }).system).toEqual({ type: "member_added", actorId: String(GRACE), targetIds: [String(GRACE)] });
    expect(line({ "@type": "messageChatJoinByRequest" }, null).system).toEqual({ type: "member_added", actorId: undefined, targetIds: [] });
    expect(line({ "@type": "messageChatDeleteMember", user_id: GRACE }).system).toEqual({ type: "member_left", actorId: String(GRACE), targetIds: [String(GRACE)] });
    expect(line({ "@type": "messageChatDeleteMember", user_id: 5000 }).system).toEqual({ type: "member_removed", actorId: String(GRACE), targetIds: ["5000"] });
    expect(line({ "@type": "messageChatDeleteMember" }).system).toEqual({ type: "member_removed", actorId: String(GRACE), targetIds: [] });
    expect(line({ "@type": "messageBasicGroupChatCreate" }).system).toEqual({ type: "group_created", actorId: String(GRACE) });
    expect(line({ "@type": "messageSupergroupChatCreate" }).system).toEqual({ type: "group_created", actorId: String(GRACE) });
    expect(line({ "@type": "messageChatSetMessageAutoDeleteTime", message_auto_delete_time: 3600 }).system).toEqual({ type: "timer_changed", actorId: String(GRACE), seconds: 3600 });
    const words = (content: Record<string, unknown>) => {
      const shown = line(content);
      expect(shown.system).toBeNull();
      return shown.text;
    };
    expect(words({ "@type": "messageChatChangeTitle", title: "Club" })).toBe(`_Person ${GRACE} named the group “Club”_`);
    expect(words({ "@type": "messageChatChangePhoto" })).toBe(`_Person ${GRACE} changed the group's picture_`);
    expect(words({ "@type": "messageChatDeletePhoto" })).toBe(`_Person ${GRACE} removed the group's picture_`);
    expect(words({ "@type": "messagePinMessage" })).toBe(`_Person ${GRACE} pinned a message_`);
    expect(words({ "@type": "messageScreenshotTaken" })).toBe(`_Person ${GRACE} took a screenshot_`);
    expect(words({ "@type": "messageContactRegistered" })).toBe(`_Person ${GRACE} joined Telegram_`);
    expect(words({ "@type": "messageChatUpgradeTo" })).toBe("_The group was upgraded_");
    expect(words({ "@type": "messageChatUpgradeFrom" })).toBe("_The group was upgraded_");
    expect(words({ "@type": "messageCall", is_video: true, discard_reason: { "@type": "callDiscardReasonMissed" } })).toBe("_Missed video call, in Telegram's app_");
    expect(words({ "@type": "messageCall", is_video: true })).toBe("_Video call, in Telegram's app_");
    expect(words({ "@type": "messageCall" })).toBe("_Voice call, in Telegram's app_");
    for (const kind of ["messageChatSetTheme", "messageSupergroupSomething", "messageBasicGroupSomething", "messageCustomServiceAction"]) {
      expect(words({ "@type": kind })).toBe("_Something changed in the group_");
    }
  });

  it("counts reactions by their emoji alone, with this account among them when it chose one", () => {
    const reacted = view(text("hi"), {
      interaction_info: {
        reactions: {
          reactions: [
            { type: { "@type": "reactionTypeEmoji", emoji: "👍" }, total_count: 3, is_chosen: true, recent_sender_ids: [{ "@type": "messageSenderUser", user_id: GRACE }] },
            { type: { "@type": "reactionTypeEmoji", emoji: "❤️" }, total_count: 1, is_chosen: true, recent_sender_ids: [{ "@type": "messageSenderUser", user_id: SELF }] },
            { type: { "@type": "reactionTypeCustomEmoji", custom_emoji_id: "1" }, total_count: 5 },
            { type: { "@type": "reactionTypeEmoji", emoji: "" }, total_count: 5 },
            { type: { "@type": "reactionTypeEmoji", emoji: "🔥" }, total_count: 0, recent_sender_ids: [] },
          ],
        },
      },
    });
    expect(reacted.reactions).toEqual([
      { key: "👍", userIds: [String(SELF), String(GRACE), "?0"] },
      { key: "❤️", userIds: [String(SELF)] },
    ]);
    // Without an account to be, nobody is this one.
    const anonymous = view(text("hi"), { interaction_info: { reactions: { reactions: [{ type: { "@type": "reactionTypeEmoji", emoji: "👍" }, total_count: 1, is_chosen: true }] } } }, { ...messages, selfId: null });
    expect(anonymous.reactions).toEqual([{ key: "👍", userIds: ["?0"] }]);
  });

  it("keeps only buttons with words, and a callback's data only when it's base64", () => {
    const pressed = view(text("pick"), {
      reply_markup: {
        "@type": "replyMarkupInlineKeyboard",
        rows: [
          [
            { text: "", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "AQ==" } },
            { text: "Bad", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "not base64" } },
            { text: "Login", type: { "@type": "inlineKeyboardButtonTypeLoginUrl", url: "https://t.me" } },
          ],
          [{ text: "Yes", type: { "@type": "inlineKeyboardButtonTypeCallback", data: "" } }],
        ],
      },
    });
    expect(pressed.buttons).toEqual([[{ text: "Yes", data: "" }]]);
    expect(view(text("x"), { reply_markup: { "@type": "replyMarkupShowKeyboard", rows: [[{ text: "Hi" }]] } }).buttons).toEqual([]);
  });

  it("previews what a reply answers, in another chat or this one, and says nothing of one it hasn't seen", () => {
    const original = message({ "@type": "messagePhoto", caption: { text: "", entities: [] }, photo: { sizes: [{ photo: file(1), width: 10, height: 10 }] } }, { id: 77, chat_id: GROUP });
    const find = (chatId: number, id: number) => (chatId === GROUP && id === 77 ? original : chatId === GRACE && id === 78 ? message({ "@type": "messagePoll" }) : undefined);
    const context = { ...messages, find };
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToMessage", chat_id: GROUP, message_id: 77 } }, context).reply).toEqual({ id: "77", senderId: String(GRACE), text: "", hasAttachment: true, deleted: false });
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToMessage", message_id: 78 } }, context).reply).toEqual({ id: "78", senderId: String(GRACE), text: "Poll", hasAttachment: true, deleted: false });
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToMessage", message_id: 79 } }, context).reply).toEqual({ id: "79", senderId: "", text: "", hasAttachment: false, deleted: false });
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToMessage" } }, context).reply).toBeNull();
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToStory", story_id: 1 } }, context).reply).toBeNull();
    // A reply to words shows them.
    const words = message(text("the question"), { id: 80 });
    expect(view(text("re"), { reply_to: { "@type": "messageReplyToMessage", message_id: 80 } }, { ...messages, find: () => words }).reply?.text).toBe("the question");
  });

  it("says who a forward came from, how it's being sent, when it was pinned and edited, and when it goes", () => {
    const forwarded = (origin: unknown) => view(text("fw"), { forward_info: { origin } }).forwarded;
    expect(forwarded({ "@type": "messageOriginUser", sender_user_id: GRACE })).toEqual({ userId: String(GRACE) });
    expect(forwarded({ "@type": "messageOriginChat", sender_chat_id: GROUP })).toEqual({ userId: `chat:${GROUP}` });
    expect(forwarded({ "@type": "messageOriginChannel", chat_id: -1005 })).toEqual({ userId: "chat:-1005" });
    expect(forwarded({ "@type": "messageOriginHiddenUser", sender_name: "Someone" })).toEqual({});
    expect(forwarded({ "@type": "messageOriginUser" })).toEqual({});
    expect(view(text("x")).forwarded).toBeNull();

    expect(view(text("x"), { sending_state: { "@type": "messageSendingStatePending" } }).status).toBe("sending");
    expect(view(text("x"), { sending_state: { "@type": "messageSendingStateFailed" } }).status).toBe("failed");
    expect(view(text("x")).status).toBe("sent");
    const pinned = view(text("x"), { is_pinned: true, edit_date: 1_700_000_100, auto_delete_in: 1.5 });
    expect(pinned).toMatchObject({ pinnedAt: 1_700_000_000_000, editedAt: 1_700_000_100_000, expiresAt: NOW + 1500 });
    expect(view(text("x"), { auto_delete_in: 0 })).toMatchObject({ pinnedAt: null, editedAt: null, expiresAt: null });
    expect(view(text("x"), { auto_delete_in: "60" }).expiresAt).toBeNull();
  });

  it("shows a link's preview only for a web address, with what it says of itself", () => {
    const preview = (link_preview: unknown) => view(text("https://example.com"), { link_preview }).preview;
    expect(preview({ url: "https://example.com", title: "Example", description: { text: "A site" }, site_name: "Example Inc" })).toEqual({ url: "https://example.com", title: "Example", description: "A site", siteName: "Example Inc" });
    expect(preview({ url: "https://example.com" })).toEqual({ url: "https://example.com", title: undefined, description: undefined, siteName: undefined });
    expect(preview({ url: "file:///etc/passwd", title: "No" })).toBeNull();
    expect(preview(null)).toBeNull();
  });

  it("reads only the entities that lie inside their text, of a kind it knows the shape of", () => {
    const read = formatted({
      text: "hello world",
      entities: [
        { offset: 0, length: 5, type: { "@type": "textEntityTypeBold" } },
        { offset: 6, length: 5, type: { "@type": "textEntityTypeMentionName", user_id: GRACE } },
        { offset: 6, length: 9, type: { "@type": "textEntityTypeBold" } },
        { offset: 0, length: 0, type: { "@type": "textEntityTypeBold" } },
        { offset: 0, length: 2, type: "textEntityTypeBold" },
        { offset: 0, length: 2, type: { "@type": "textEntityTypePreCode", language: 7, url: null } },
      ],
    });
    expect(read).toEqual({
      text: "hello world",
      entities: [
        { offset: 0, length: 5, type: { "@type": "textEntityTypeBold", language: "", url: "", user_id: undefined } },
        { offset: 6, length: 5, type: { "@type": "textEntityTypeMentionName", language: "", url: "", user_id: GRACE } },
        { offset: 0, length: 2, type: { "@type": "textEntityTypePreCode", language: "", url: "", user_id: undefined } },
      ],
    });
    expect(formatted(null)).toEqual({ text: "", entities: [] });
  });
});

describe("Telegram's entities and Zuna's markup, at their edges", () => {
  const bold = (offset: number, length: number) => ({ offset, length, type: { "@type": "textEntityTypeBold" } });

  it("leaves out a mark around nothing but space, across a line, or around code's own backticks", () => {
    expect(toMarkup({ text: "a   b", entities: [bold(1, 3)] })).toBe("a   b");
    expect(toMarkup({ text: " word ", entities: [bold(0, 6)] })).toBe(" **word** ");
    expect(toMarkup({ text: "one\ntwo", entities: [bold(0, 7)] })).toBe("one\ntwo");
    expect(toMarkup({ text: "a `b` c", entities: [{ offset: 0, length: 7, type: { "@type": "textEntityTypeCode" } }] })).toBe("a `b` c");
    // An entity past the text's end is cut to it.
    expect(toMarkup({ text: "short", entities: [bold(-3, 100)] })).toBe("**short**");
  });

  it("puts a code block and a quote on lines of their own wherever they start", () => {
    expect(toMarkup({ text: "see code here", entities: [{ offset: 4, length: 4, type: { "@type": "textEntityTypePre" } }] })).toBe("see \n```\ncode\n```\n here");
    expect(toMarkup({ text: "x", entities: [{ offset: 0, length: 1, type: { "@type": "textEntityTypePreCode", language: "c++ <script>" } }] })).toBe("```c++script\nx\n```");
    expect(toMarkup({ text: "he said: hi", entities: [{ offset: 9, length: 2, type: { "@type": "textEntityTypeExpandableBlockQuote" } }] })).toBe("he said: \n> hi");
    // A link whose words are its address needs no address beside it.
    expect(toMarkup({ text: "https://a.example", entities: [{ offset: 0, length: 17, type: { "@type": "textEntityTypeTextUrl", url: "https://a.example" } }] })).toBe("https://a.example");
    expect(toMarkup({ text: "here", entities: [{ offset: 0, length: 4, type: { "@type": "textEntityTypeTextUrl" } }] })).toBe("here");
  });

  it("reads fences, quotes and nested marks back, as markup.tsx draws them", () => {
    // A fence first in the text, an empty one, one that never closes, and one with no language.
    expect(fromMarkup("```\ncode\n```")).toEqual({ text: "code", entities: [{ offset: 0, length: 4, type: { "@type": "textEntityTypePre" } }] });
    expect(fromMarkup("before\n```\n```\nafter")).toEqual({ text: "before\n\nafter", entities: [] });
    expect(fromMarkup("```js\nnever closed")).toEqual({ text: "```js\nnever closed", entities: [] });
    expect(fromMarkup("> \nplain")).toEqual({ text: "\nplain", entities: [] });
    expect(fromMarkup("> one\n>two")).toEqual({ text: "one\ntwo", entities: [{ offset: 0, length: 7, type: { "@type": "textEntityTypeBlockQuote" } }] });
    expect(fromMarkup("_lean_ and ||**hidden bold**||")).toEqual({
      text: "lean and hidden bold",
      entities: [
        { offset: 0, length: 4, type: { "@type": "textEntityTypeItalic" } },
        { offset: 9, length: 11, type: { "@type": "textEntityTypeBold" } },
        { offset: 9, length: 11, type: { "@type": "textEntityTypeSpoiler" } },
      ],
    });
  });

  it("nests each mark inside the others, but never inside itself", () => {
    expect(fromMarkup("~~a **b _c ||d *e* d|| c_ b** a~~")).toEqual({
      text: "a b c d e d c b a",
      entities: [
        { offset: 0, length: 17, type: { "@type": "textEntityTypeStrikethrough" } },
        { offset: 2, length: 13, type: { "@type": "textEntityTypeBold" } },
        { offset: 4, length: 9, type: { "@type": "textEntityTypeItalic" } },
        { offset: 6, length: 5, type: { "@type": "textEntityTypeSpoiler" } },
        { offset: 8, length: 1, type: { "@type": "textEntityTypeItalic" } },
      ],
    });
    // The nearest closing ends a mark, so one inside another of its kind only splits it.
    expect(fromMarkup("**a **b** c**")).toEqual({
      text: "a b c",
      entities: [
        { offset: 0, length: 2, type: { "@type": "textEntityTypeBold" } },
        { offset: 3, length: 2, type: { "@type": "textEntityTypeBold" } },
      ],
    });
  });
});
