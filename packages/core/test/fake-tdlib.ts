// A stand-in for a linked Telegram account's engine: it speaks TDLib's JSON, as the broker hands
// it on (docs/TELEGRAM_PLAN.md), over a small world of its own, for the core's tests and the
// interfaces'. It answers what the adapter asks with what TDLib's pinned version would, and sends
// the updates TDLib would, as recorded from Telegram's test servers.

import type { TelegramAdapter } from "../src/telegram/engine";

type Td = { "@type": string; [field: string]: any };

export const SELF = 1000;
export const GRACE = 2000;
export const BOT = 3000;
export const GROUP = -300;
export const CHANNEL = -1001500;
export const SECRET = 7777;

/** A message ID as Telegram gives one: a server's number, shifted. */
export const serverId = (n: number) => n * 1048576;

const user = (id: number, first: string, last: string, username: string, type = "userTypeRegular"): Td => ({
  "@type": "user",
  id,
  first_name: first,
  last_name: last,
  usernames: username ? { "@type": "usernames", active_usernames: [username], disabled_usernames: [], editable_username: username } : null,
  phone_number: "999661234",
  status: { "@type": "userStatusOffline", was_online: 1_700_000_000 },
  type: { "@type": type },
});

const position = (order: string, pinned = false): Td => ({ "@type": "chatPosition", list: { "@type": "chatListMain" }, order, is_pinned: pinned, source: null });

const settings = (muteFor = 0, useDefault = false): Td => ({ "@type": "chatNotificationSettings", use_default_mute_for: useDefault, mute_for: muteFor, use_default_sound: true, sound_id: "0", use_default_show_preview: true, show_preview: true });

export function textMessage(chat: number, id: number, from: number, text: string, extra: Partial<Td> = {}): Td {
  return {
    "@type": "message",
    id,
    sender_id: { "@type": "messageSenderUser", user_id: from },
    chat_id: chat,
    is_outgoing: from === SELF,
    is_pinned: false,
    date: 1_700_000_000 + id / 1048576,
    edit_date: 0,
    content: { "@type": "messageText", text: { "@type": "formattedText", text, entities: [] } },
    ...extra,
  };
}

export class FakeTdlib implements TelegramAdapter {
  /** Every request the adapter made, in order. */
  readonly asked: Td[] = [];
  started = 0;
  stops: boolean[] = [];
  authorized = false;
  /** The account has two-step verification, with this password. */
  password: string | null = null;
  users = new Map<number, Td>();
  chats = new Map<number, Td>();
  history = new Map<number, Td[]>();
  private listener: ((json: string) => void) | null = null;
  private nextTemporary = 1;
  private loaded = false;

  constructor() {
    for (const each of [user(SELF, "Ada", "Lovelace", "ada"), user(GRACE, "Grace", "Hopper", "grace"), user(BOT, "Weather", "", "weather_bot", "userTypeBot")]) this.users.set(each.id, each);
    this.chats.set(GRACE, { "@type": "chat", id: GRACE, type: { "@type": "chatTypePrivate", user_id: GRACE }, title: "Grace Hopper", positions: [position("9000")], unread_count: 1, unread_mention_count: 0, last_read_inbox_message_id: serverId(1), last_read_outbox_message_id: serverId(2), notification_settings: settings(), is_marked_as_unread: false, message_auto_delete_time: 0 });
    this.chats.set(GROUP, { "@type": "chat", id: GROUP, type: { "@type": "chatTypeBasicGroup", basic_group_id: 300 }, title: "Weekend trip", positions: [position("8000", true)], unread_count: 0, unread_mention_count: 0, last_read_inbox_message_id: 0, last_read_outbox_message_id: 0, notification_settings: settings(0x7fffffff), is_marked_as_unread: false, message_auto_delete_time: 0 });
    this.chats.set(BOT, { "@type": "chat", id: BOT, type: { "@type": "chatTypePrivate", user_id: BOT }, title: "Weather", positions: [position("7000")], unread_count: 0, unread_mention_count: 0, last_read_inbox_message_id: 0, last_read_outbox_message_id: 0, notification_settings: settings(0, true), is_marked_as_unread: true, message_auto_delete_time: 0 });
    this.chats.set(CHANNEL, { "@type": "chat", id: CHANNEL, type: { "@type": "chatTypeSupergroup", supergroup_id: 1500, is_channel: true }, title: "News", positions: [position("9500")], unread_count: 40, notification_settings: settings() });
    this.chats.set(SECRET, { "@type": "chat", id: SECRET, type: { "@type": "chatTypeSecret", secret_chat_id: 5, user_id: GRACE }, title: "Grace Hopper", positions: [position("9600")], unread_count: 0, notification_settings: settings() });
    this.history.set(GRACE, [
      textMessage(GRACE, serverId(1), GRACE, "Hello Ada"),
      textMessage(GRACE, serverId(2), SELF, "Hi! How are you?"),
      {
        ...textMessage(GRACE, serverId(3), GRACE, "See you at 8? bold"),
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "See you at 8? bold", entities: [{ "@type": "textEntity", offset: 14, length: 4, type: { "@type": "textEntityTypeBold" } }] } },
      },
    ]);
    for (const [chatId, messages] of this.history) this.chats.get(chatId)!.last_message = messages.at(-1);
  }

  start(onMessage: (json: string) => void): string | null {
    this.listener = onMessage;
    this.started++;
    // TDLib tells each run of the chats in its database again, as it's asked for the list.
    this.loaded = false;
    setTimeout(() => {
      this.emit({ "@type": "updateAuthorizationState", authorization_state: { "@type": "authorizationStateWaitTdlibParameters" } });
      this.emit({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
      if (this.authorized) this.signedIn();
      else this.auth("authorizationStateWaitPhoneNumber");
    }, 0);
    return null;
  }

  stop(signOut: boolean): void {
    this.stops.push(signOut);
    const signedOut = signOut && this.authorized;
    if (signOut) this.authorized = false;
    setTimeout(() => this.emit({ "@type": "zunaStopped", erased: signOut, signedOut }), 0);
  }

  send(json: string): void {
    const request = JSON.parse(json) as Td;
    this.asked.push(request);
    const extra = request["@extra"];
    const answer = (value: Td): void => {
      setTimeout(() => this.emit({ ...value, "@extra": extra }), 0);
    };
    const fail = (code: number, message: string) => answer({ "@type": "error", code, message });
    const ok = () => answer({ "@type": "ok" });
    switch (request["@type"]) {
      case "requestQrCodeAuthentication":
        ok();
        return this.auth("authorizationStateWaitOtherDeviceConfirmation", { link: "tg://login?token=AQEGV_ZqeAeV" });
      case "setAuthenticationPhoneNumber":
        if (!/^\+?99966\d{5}$/.test(request.phone_number)) return fail(400, "PHONE_NUMBER_INVALID");
        ok();
        return this.auth("authorizationStateWaitCode", { code_info: { "@type": "authenticationCodeInfo", phone_number: request.phone_number, type: { "@type": "authenticationCodeTypeTelegramMessage", length: 5 }, next_type: { "@type": "authenticationCodeTypeSms", length: 5 }, timeout: 60 } });
      case "checkAuthenticationCode":
        if (request.code !== "22222") return fail(400, "PHONE_CODE_INVALID");
        ok();
        return this.password ? this.auth("authorizationStateWaitPassword", { password_hint: "a dog's name", has_recovery_email_address: false }) : this.confirm();
      case "checkAuthenticationPassword":
        if (request.password !== this.password) return fail(400, "PASSWORD_HASH_INVALID");
        ok();
        return this.confirm();
      case "getMe":
        return answer(this.users.get(SELF)!);
      case "loadChats":
        if (this.loaded) return fail(404, "Not Found");
        this.loaded = true;
        for (const chat of this.chats.values()) this.emit({ "@type": "updateNewChat", chat: { ...chat, positions: [] } });
        for (const chat of this.chats.values()) for (const each of chat.positions ?? []) this.emit({ "@type": "updateChatPosition", chat_id: chat.id, position: each });
        return ok();
      case "getChatHistory": {
        const messages = [...(this.history.get(request.chat_id) ?? [])].sort((a, b) => b.id - a.id);
        const from = request.from_message_id || Infinity;
        const start = messages.findIndex((message) => message.id <= from);
        const at = Math.max(0, (start === -1 ? messages.length : start) + request.offset);
        return answer({ "@type": "messages", total_count: messages.length, messages: messages.slice(at, at + request.limit) });
      }
      case "getMessage": {
        const found = this.history.get(request.chat_id)?.find((message) => message.id === request.message_id);
        return found ? answer(found) : fail(404, "Not Found");
      }
      case "sendMessage": {
        const temporary = this.nextTemporary++;
        const content = request.input_message_content;
        const message: Td = {
          ...textMessage(request.chat_id, temporary, SELF, ""),
          content: { "@type": "messageText", text: content.text },
          sending_state: { "@type": "messageSendingStatePending" },
          reply_to: request.reply_to ? { "@type": "messageReplyToMessage", chat_id: request.chat_id, message_id: request.reply_to.message_id } : null,
        };
        answer(message);
        setTimeout(() => {
          const sent = { ...message, id: serverId(100 + temporary), sending_state: null };
          this.history.get(request.chat_id)?.push(sent);
          this.emit({ "@type": "updateMessageSendSucceeded", message: sent, old_message_id: temporary });
        }, 5);
        return;
      }
      case "viewMessages": {
        ok();
        const chat = this.chats.get(request.chat_id);
        if (chat) this.emit({ "@type": "updateChatReadInbox", chat_id: request.chat_id, last_read_inbox_message_id: Math.max(...request.message_ids), unread_count: 0 });
        return;
      }
      case "createPrivateChat":
        return answer(this.chats.get(request.user_id) ?? { "@type": "chat", id: request.user_id, type: { "@type": "chatTypePrivate", user_id: request.user_id }, title: "", positions: [] });
      case "searchChatMessages":
      case "searchMessages": {
        const all = request.chat_id ? (this.history.get(request.chat_id) ?? []) : [...this.history.values()].flat();
        const query = String(request.query ?? "").toLowerCase();
        const pinned = request.filter?.["@type"] === "searchMessagesFilterPinned";
        const found = all.filter((message) => (pinned ? message.is_pinned : message.content.text?.text.toLowerCase().includes(query)));
        return answer({ "@type": request["@type"] === "searchMessages" ? "foundMessages" : "foundChatMessages", total_count: found.length, messages: found });
      }
      default:
        return ok();
    }
  }

  /** Telegram on another device lets this one in, after a QR code was scanned. */
  confirm(): void {
    this.authorized = true;
    this.signedIn();
  }

  private signedIn(): void {
    this.emit({ "@type": "updateUser", user: this.users.get(SELF) });
    for (const each of this.users.values()) this.emit({ "@type": "updateUser", user: each });
    this.auth("authorizationStateReady");
  }

  auth(kind: string, fields: Record<string, unknown> = {}): void {
    setTimeout(() => this.emit({ "@type": "updateAuthorizationState", authorization_state: { "@type": kind, ...fields } }), 0);
  }

  /** Something arrives from Telegram. */
  emit(update: Td): void {
    this.listener?.(JSON.stringify(update));
  }

  /** The requests of one kind the adapter made. */
  requests(kind: string): Td[] {
    return this.asked.filter((request) => request["@type"] === kind);
  }
}
