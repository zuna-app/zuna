// A Telegram account linked on this device, as the interface sees it: a session under the server
// ID `telegram` that answers the calls a ServerSession does, for the part of them Telegram has,
// with the same shapes and the same CoreEvents (docs/TELEGRAM_PLAN.md, The adapter). It maps and
// nothing else: it opens no connection, imports nothing of the core's cryptography, and keeps no
// Telegram message anywhere but in memory, as a cache of the engine's, which holds the only copy
// on this device. Telegram's servers hold the real one.

import type {
  ConnectionState,
  ConversationView,
  CoreEvent,
  EmoteSet,
  MessageBody,
  MessageView,
  Preferences,
  SearchResult,
  ServerInfo,
  TelegramLink,
  UserView,
} from "../types";
import { TELEGRAM_ID } from "../types";
import { Engine, TelegramError, type TdObject, type TelegramAdapter } from "./engine";
import { chatKey, chatKind, chatSenderView, conversationView, displayName, idOf, int, isObject, kindOf, list, messageView, muteFor, positionIn, presenceOf, senderOf, str, userView } from "./map";
import { fromMarkup } from "./markup";

export { TELEGRAM_ID };

const PAGE_SIZE = 50;
/** How many messages of each chat are kept in memory, newest first, beyond those a chat shows. */
const KEPT_PER_CHAT = 400;
/** How long typing shows for, as Telegram's apps show it, unless it's cancelled. */
const TYPING_MS = 6000;
/** How often this device says it's typing, at most. */
const TYPING_EVERY_MS = 4000;

/**
 * Updates the adapter acts on. Any other kind is dropped, and noted once, never handed on: what
 * TDLib adds in a new version is shown nowhere until it's mapped here.
 */
const HANDLED = new Set([
  "updateAuthorizationState",
  "updateConnectionState",
  "updateUser",
  "updateUserStatus",
  "updateNewChat",
  "updateChatTitle",
  "updateChatPhoto",
  "updateChatLastMessage",
  "updateChatPosition",
  "updateChatReadInbox",
  "updateChatReadOutbox",
  "updateChatUnreadMentionCount",
  "updateMessageMentionRead",
  "updateChatNotificationSettings",
  "updateScopeNotificationSettings",
  "updateChatIsMarkedAsUnread",
  "updateChatDraftMessage",
  "updateChatBlockList",
  "updateChatMessageAutoDeleteTime",
  "updateNewMessage",
  "updateMessageSendSucceeded",
  "updateMessageSendFailed",
  "updateMessageContent",
  "updateMessageEdited",
  "updateMessageIsPinned",
  "updateMessageInteractionInfo",
  "updateDeleteMessages",
  "updateChatAction",
]);

/** What Telegram's errors mean, in the app's words. */
function explain(error: unknown): Error {
  if (!(error instanceof TelegramError)) return error instanceof Error ? error : new Error(String(error));
  const message = error.message;
  const wait = message.match(/retry after (\d+)/i);
  if (wait) return new Error(`Telegram asks to wait ${Math.ceil(Number(wait[1]) / 60)} minutes before trying again.`);
  const known: Record<string, string> = {
    PHONE_NUMBER_INVALID: "That isn't a phone number Telegram knows.",
    PHONE_NUMBER_BANNED: "Telegram has banned that number.",
    PHONE_CODE_INVALID: "That code isn't right.",
    PHONE_CODE_EXPIRED: "That code has run out. Ask for a new one.",
    EMAIL_CODE_INVALID: "That code isn't right.",
    PASSWORD_HASH_INVALID: "That password isn't right.",
    AUTH_TOKEN_EXPIRED: "That code has run out. A new one is on its way.",
    MESSAGE_TOO_LONG: "That message is too long for Telegram.",
    CHAT_WRITE_FORBIDDEN: "You can't write in this chat.",
    USER_IS_BLOCKED: "You can't write to this person.",
    MESSAGE_NOT_MODIFIED: "Nothing changed.",
  };
  for (const [code, text] of Object.entries(known)) if (message.includes(code)) return new Error(text);
  return new Error(error.code === 403 ? "Zuna doesn't do that on Telegram." : `Telegram said: ${message}`);
}

export interface TelegramSessionOptions {
  onEvent: (event: CoreEvent) => void;
  /**
   * Being linked now, rather than started as an account linked before: only then does a step
   * before signing in belong here. One that comes to an account linked before means it was let
   * go, as its database couldn't be opened, and it's erased.
   */
  linking: boolean;
  /** Telegram let the account in: from now on it's linked on this device. */
  onLinked: () => void;
  /** The account is gone from this device: unlinked here, or its session ended from another device. */
  onGone: () => void;
}

export class TelegramSession {
  readonly serverId = TELEGRAM_ID;
  private readonly engine: Engine;
  private link: TelegramLink = { step: "starting" };
  private connection: ConnectionState = "connecting";
  private readonly chats = new Map<number, TdObject>();
  private readonly users = new Map<number, TdObject>();
  /** chat ID -> message ID -> message, the newest a chat has shown or been sent. */
  private readonly messages = new Map<number, Map<number, TdObject>>();
  private selfId: number | null = null;
  private defaults = { private: 0, group: 0 };
  private active = false;
  private opened: number | null = null;
  private typingSent = new Map<number, number>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private conversationsQueued = false;
  private usersQueued = false;
  private noted = new Set<string>();
  private unlinking: ((signedOut: boolean) => void) | null = null;
  private signingOut = false;
  private ended = false;
  private linking: boolean;

  constructor(
    adapter: TelegramAdapter,
    private readonly options: TelegramSessionOptions,
  ) {
    this.engine = new Engine(adapter, (update) => this.onUpdate(update));
    this.linking = options.linking;
  }

  // --- Lifecycle ---

  start(): void {
    this.ended = false;
    const why = this.engine.start();
    if (why) this.setLink({ step: "failed", reason: why });
  }

  stop(): void {
    this.ended = true;
    this.engine.stop(false);
  }

  /** Signs out at Telegram, if it can, and erases everything of the account's here. Says whether it signed out. */
  unlink(): Promise<boolean> {
    return new Promise((resolve) => {
      this.unlinking = resolve;
      this.signingOut = true;
      this.engine.stop(true);
    });
  }

  suspend(): void {}
  resume(): void {}
  nudge(): void {}
  async flushOutbox(): Promise<void> {}

  getConnectionState(): ConnectionState {
    return this.connection;
  }

  /**
   * Whether the person is using this device with the Telegram account in front, which is when
   * Telegram shows them online, as its own apps do.
   */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.link.step !== "ready") return;
    void this.engine.request({ "@type": "setOption", name: "online", value: { "@type": "optionValueBoolean", value: active } }).catch(() => undefined);
  }

  isActiveElsewhere(): boolean {
    return false;
  }

  // --- Linking ---

  getLink(): TelegramLink {
    return this.link;
  }

  /** Links by a QR code, which Telegram on another device scans: the link to show comes as the `qr` step. */
  async linkWithQr(): Promise<void> {
    await this.engine.request({ "@type": "requestQrCodeAuthentication", other_user_ids: [] }).catch((error) => {
      throw explain(error);
    });
  }

  /** Links by a phone number, whose code comes in Telegram on another device, or by email. */
  async linkWithPhone(phone: string): Promise<void> {
    const number = phone.replace(/[^\d+]/g, "").slice(0, 20);
    if (!/^\+?\d{5,}$/.test(number)) throw new Error("Enter the phone number with its country code.");
    await this.engine
      .request({
        "@type": "setAuthenticationPhoneNumber",
        phone_number: number,
        settings: { "@type": "phoneNumberAuthenticationSettings", allow_flash_call: false, allow_missed_call: false, is_current_phone_number: false, has_unknown_phone_number: false, allow_sms_retriever_api: false, authentication_tokens: [] },
      })
      .catch((error) => {
        throw explain(error);
      });
  }

  async enterCode(code: string): Promise<void> {
    const digits = code.replace(/\D/g, "").slice(0, 16);
    const kind = this.link.step === "email" ? "checkAuthenticationEmailCode" : "checkAuthenticationCode";
    const query: TdObject =
      kind === "checkAuthenticationEmailCode"
        ? { "@type": kind, code: { "@type": "emailAddressAuthenticationCode", code: digits } }
        : { "@type": kind, code: digits };
    await this.engine.request(query).catch((error) => {
      throw explain(error);
    });
  }

  async resendCode(): Promise<void> {
    await this.engine.request({ "@type": "resendAuthenticationCode", reason: null }).catch((error) => {
      throw explain(error);
    });
  }

  /** The account's two-step verification password, which TDLib proves it knows without sending it. */
  async enterPassword(password: string): Promise<void> {
    await this.engine.request({ "@type": "checkAuthenticationPassword", password }).catch((error) => {
      throw explain(error);
    });
  }

  private setLink(link: TelegramLink): void {
    this.link = link;
    this.options.onEvent({ type: "telegram", serverId: TELEGRAM_ID, link });
  }

  private onAuth(state: unknown): void {
    const kind = kindOf(state);
    // An account linked before that asks to sign in again isn't linked any more.
    if (!this.linking && kind.startsWith("authorizationStateWait") && kind !== "authorizationStateWaitTdlibParameters" && !this.signingOut) {
      this.signingOut = true;
      this.engine.stop(true);
      return;
    }
    switch (kind) {
      case "authorizationStateWaitTdlibParameters":
        return this.setLink({ step: "starting" });
      case "authorizationStateWaitPhoneNumber":
        return this.setLink({ step: "phone" });
      case "authorizationStateWaitOtherDeviceConfirmation": {
        const link = str((state as TdObject).link, 512);
        return this.setLink(link.startsWith("tg://login?token=") ? { step: "qr", link } : { step: "phone" });
      }
      case "authorizationStateWaitCode": {
        const info = (state as TdObject).code_info as TdObject | undefined;
        const type = info?.type as TdObject | undefined;
        const via: Record<string, string> = {
          authenticationCodeTypeTelegramMessage: "telegram",
          authenticationCodeTypeSms: "sms",
          authenticationCodeTypeSmsWord: "sms",
          authenticationCodeTypeSmsPhrase: "sms",
          authenticationCodeTypeCall: "call",
          authenticationCodeTypeFragment: "fragment",
        };
        return this.setLink({
          step: "code",
          phone: str(info?.phone_number, 24),
          length: int(type?.length, 0, 16, 0),
          via: via[kindOf(type)] ?? "other",
          canResend: isObject(info?.next_type),
        });
      }
      case "authorizationStateWaitEmailCode": {
        const info = (state as TdObject).code_info as TdObject | undefined;
        return this.setLink({ step: "email", pattern: str(info?.email_address_pattern, 128), length: int(info?.length, 0, 16, 0) });
      }
      case "authorizationStateWaitPassword": {
        const raw = state as TdObject;
        return this.setLink({ step: "password", hint: str(raw.password_hint, 128) });
      }
      case "authorizationStateWaitRegistration":
        // No account is made here: someone new signs up in Telegram's own app first.
        return this.setLink({ step: "signup" });
      case "authorizationStateWaitEmailAddress":
        return this.setLink({ step: "failed", reason: "Telegram asks this account for a login email first. Add one in Telegram's app, then link again." });
      case "authorizationStateWaitPremiumPurchase":
        return this.setLink({ step: "failed", reason: "Telegram asks this account to buy Premium before it can sign in here." });
      case "authorizationStateReady":
        if (this.linking) {
          this.linking = false;
          this.options.onLinked();
        }
        this.setLink({ step: "ready" });
        void this.loadAccount();
        return;
      case "authorizationStateLoggingOut":
        return;
      case "authorizationStateClosed":
        // Not asked for here: its session was ended from another device, and TDLib erased what
        // it held. The rest of it goes too, as someone who ends a session means for it to go.
        if (!this.ended && !this.signingOut) {
          this.signingOut = true;
          this.engine.stop(true);
        }
        return;
    }
  }

  /** Who this account is, and the list of its chats, once it's signed in. */
  private async loadAccount(): Promise<void> {
    try {
      const me = await this.engine.request({ "@type": "getMe" });
      this.selfId = idOf(me.id);
      this.users.set(this.selfId ?? 0, me);
      this.queueUsers();
      if (this.active) this.setActive(true);
      // The list comes as updates, a page at a time, until Telegram says there's no more.
      for (let page = 0; page < 50; page++) {
        await this.engine.request({ "@type": "loadChats", chat_list: { "@type": "chatListMain" }, limit: 100 });
      }
    } catch (error) {
      if (!(error instanceof TelegramError && error.code === 404)) console.warn("[zuna] Telegram's chats couldn't be loaded", error);
    }
    this.queueConversations();
  }

  // --- Updates ---

  private onUpdate(update: TdObject): void {
    const kind = update["@type"];
    if (kind.startsWith("zuna")) return this.onBroker(update);
    if (!HANDLED.has(kind)) {
      if (!this.noted.has(kind)) {
        this.noted.add(kind);
        console.debug(`[zuna] Telegram's ${kind} isn't shown`);
      }
      return;
    }
    switch (kind) {
      case "updateAuthorizationState":
        return this.onAuth(update.authorization_state);
      case "updateConnectionState": {
        const states: Record<string, ConnectionState> = {
          connectionStateReady: "online",
          connectionStateUpdating: "syncing",
          connectionStateConnecting: "connecting",
          connectionStateConnectingToProxy: "connecting",
          connectionStateWaitingForNetwork: "offline",
        };
        this.connection = states[kindOf(update.state)] ?? "connecting";
        this.options.onEvent({ type: "connection", serverId: TELEGRAM_ID, state: this.connection });
        return;
      }
      case "updateUser": {
        const user = update.user;
        const id = idOf((user as TdObject | undefined)?.id);
        if (id && isObject(user)) {
          this.users.set(id, user);
          this.queueUsers();
        }
        return;
      }
      case "updateUserStatus": {
        const id = idOf(update.user_id);
        const user = id ? this.users.get(id) : undefined;
        if (!id || !user) return;
        user.status = update.status;
        const presence = presenceOf(update.status);
        this.options.onEvent({ type: "presence", serverId: TELEGRAM_ID, userId: String(id), online: presence.online, lastSeenAt: presence.lastSeenAt });
        return;
      }
      case "updateNewChat": {
        const chat = update.chat;
        const id = idOf((chat as TdObject | undefined)?.id);
        if (id && isObject(chat)) {
          this.chats.set(id, chat);
          if (isObject(chat.last_message)) this.remember(chat.last_message);
          this.queueConversations();
        }
        return;
      }
      case "updateScopeNotificationSettings": {
        const mute = int((update.notification_settings as TdObject | undefined)?.mute_for, 0, 2 ** 31, 0);
        if (kindOf(update.scope) === "notificationSettingsScopePrivateChats") this.defaults.private = mute;
        if (kindOf(update.scope) === "notificationSettingsScopeGroupChats") this.defaults.group = mute;
        this.queueConversations();
        return;
      }
      case "updateNewMessage":
        return this.onNewMessage(update.message);
      case "updateMessageSendSucceeded": {
        const message = update.message;
        const old = idOf(update.old_message_id);
        if (!isObject(message) || !old) return;
        const chatId = idOf(message.chat_id);
        if (!chatId) return;
        this.messages.get(chatId)?.delete(old);
        this.options.onEvent({ type: "message_removed", serverId: TELEGRAM_ID, groupId: String(chatId), id: String(old) });
        this.remember(message);
        this.emitMessage(message, false);
        return;
      }
      case "updateMessageSendFailed": {
        const message = update.message;
        const old = idOf(update.old_message_id);
        if (!isObject(message)) return;
        const chatId = idOf(message.chat_id);
        if (chatId && old && old !== idOf(message.id)) {
          this.messages.get(chatId)?.delete(old);
          this.options.onEvent({ type: "message_removed", serverId: TELEGRAM_ID, groupId: String(chatId), id: String(old) });
        }
        this.remember(message);
        this.emitMessage(message, false);
        return;
      }
      case "updateMessageContent":
        return this.patchMessage(update, (message) => (message.content = update.new_content));
      case "updateMessageEdited":
        return this.patchMessage(update, (message) => {
          message.edit_date = update.edit_date;
          message.reply_markup = update.reply_markup;
        });
      case "updateMessageIsPinned":
        return this.patchMessage(update, (message) => (message.is_pinned = update.is_pinned));
      case "updateMessageInteractionInfo":
        return this.patchMessage(update, (message) => (message.interaction_info = update.interaction_info));
      case "updateDeleteMessages": {
        // Messages that only left the engine's cache are still Telegram's.
        if (update.is_permanent !== true) return;
        const chatId = idOf(update.chat_id);
        if (!chatId) return;
        for (const raw of list(update.message_ids, 10_000)) {
          const id = idOf(raw);
          if (!id) continue;
          this.messages.get(chatId)?.delete(id);
          this.options.onEvent({ type: "message_removed", serverId: TELEGRAM_ID, groupId: String(chatId), id: String(id) });
        }
        return;
      }
      case "updateChatAction":
        return this.onChatAction(update);
      default:
        return this.patchChat(update);
    }
  }

  /** What the broker says about the engine itself. */
  private onBroker(update: TdObject): void {
    switch (update["@type"]) {
      case "zunaStopped": {
        // Only an end this session asked for is its own: one before it may still be telling of its stop.
        if (!this.ended && !this.signingOut) return;
        this.engine.failAll(new TelegramError("Telegram stopped.", 503));
        if (update.erased === true) {
          const signedOut = update.signedOut === true;
          this.chats.clear();
          this.users.clear();
          this.messages.clear();
          this.setLink({ step: "unlinked", signedOut });
          this.unlinking?.(signedOut);
          this.unlinking = null;
          this.options.onGone();
        }
        return;
      }
      case "zunaFailed":
        this.engine.failAll(new TelegramError("Telegram stopped.", 503));
        this.connection = "offline";
        this.options.onEvent({ type: "connection", serverId: TELEGRAM_ID, state: "offline" });
        return this.setLink({ step: "failed", reason: `Telegram stopped working here: ${str(update.reason, 200)}` });
      case "zunaRestarted":
        this.engine.failAll(new TelegramError("Telegram started again.", 503));
        return;
    }
  }

  /** A change to one of a chat's fields, as the update names it. */
  private patchChat(update: TdObject): void {
    const chat = this.chats.get(idOf(update.chat_id) ?? 0);
    if (!chat) return;
    switch (update["@type"]) {
      case "updateChatTitle":
        chat.title = update.title;
        break;
      case "updateChatPhoto":
        chat.photo = update.photo;
        break;
      case "updateChatLastMessage":
        chat.last_message = update.last_message;
        if (isObject(update.last_message)) this.remember(update.last_message);
        for (const position of list(update.positions, 16)) this.setPosition(chat, position);
        break;
      case "updateChatPosition":
        this.setPosition(chat, update.position);
        break;
      case "updateChatReadInbox": {
        chat.last_read_inbox_message_id = update.last_read_inbox_message_id;
        chat.unread_count = update.unread_count;
        // Read here or on another device: its notifications go.
        const seq = idOf(update.last_read_inbox_message_id);
        if (seq && this.selfId) this.options.onEvent({ type: "read", serverId: TELEGRAM_ID, groupId: String(chat.id), userId: String(this.selfId), seq });
        break;
      }
      case "updateChatReadOutbox": {
        chat.last_read_outbox_message_id = update.last_read_outbox_message_id;
        const seq = idOf(update.last_read_outbox_message_id);
        const peer = chatKind(chat) === "dm" ? idOf((chat.type as TdObject).user_id) : null;
        if (seq) this.options.onEvent({ type: "read", serverId: TELEGRAM_ID, groupId: String(chat.id), userId: peer ? String(peer) : "*", seq });
        break;
      }
      case "updateChatUnreadMentionCount":
      case "updateMessageMentionRead":
        chat.unread_mention_count = update.unread_mention_count;
        break;
      case "updateChatNotificationSettings":
        chat.notification_settings = update.notification_settings;
        break;
      case "updateChatIsMarkedAsUnread":
        chat.is_marked_as_unread = update.is_marked_as_unread;
        break;
      case "updateChatDraftMessage":
        chat.draft_message = update.draft_message;
        for (const position of list(update.positions, 16)) this.setPosition(chat, position);
        break;
      case "updateChatBlockList":
        chat.block_list = update.block_list;
        break;
      case "updateChatMessageAutoDeleteTime":
        chat.message_auto_delete_time = update.message_auto_delete_time;
        break;
    }
    this.queueConversations();
  }

  private setPosition(chat: TdObject, position: unknown): void {
    if (!isObject(position)) return;
    const listKind = kindOf(position.list);
    const positions = list(chat.positions, 16).filter((existing) => kindOf((existing as TdObject).list) !== listKind);
    if (str(position.order, 24) !== "0") positions.push(position);
    chat.positions = positions;
  }

  private onNewMessage(raw: unknown): void {
    if (!isObject(raw)) return;
    this.remember(raw);
    this.emitMessage(raw, true);
    this.maybeNotify(raw);
  }

  private patchMessage(update: TdObject, patch: (message: TdObject) => void): void {
    const chatId = idOf(update.chat_id);
    const id = idOf(update.message_id);
    const message = chatId && id ? this.messages.get(chatId)?.get(id) : undefined;
    if (!message) return;
    patch(message);
    this.emitMessage(message, false);
  }

  private remember(message: TdObject): void {
    const chatId = idOf(message.chat_id);
    const id = idOf(message.id);
    if (!chatId || !id) return;
    let kept = this.messages.get(chatId);
    if (!kept) this.messages.set(chatId, (kept = new Map()));
    kept.set(id, message);
    if (kept.size > KEPT_PER_CHAT + PAGE_SIZE) {
      const oldest = [...kept.keys()].sort((a, b) => a - b).slice(0, kept.size - KEPT_PER_CHAT);
      for (const key of oldest) kept.delete(key);
    }
  }

  private find(chatId: number, messageId: number): TdObject | undefined {
    return this.messages.get(chatId)?.get(messageId);
  }

  private view(message: TdObject): MessageView | null {
    return messageView(message, {
      selfId: this.selfId,
      now: Date.now(),
      find: (chatId, messageId) => this.find(chatId, messageId),
      nameOf: (senderId) => this.nameOf(senderId),
    });
  }

  private nameOf(senderId: string): string {
    if (senderId.startsWith("chat:")) return str(this.chats.get(Number(senderId.slice(5)))?.title, 256) || "Someone";
    const user = this.users.get(Number(senderId));
    return user ? displayName(user) : "Someone";
  }

  /** Whether a chat is one the list shows: a person or a group, never a channel or a secret chat. */
  private listed(chatId: number): TdObject | undefined {
    const chat = this.chats.get(chatId);
    return chat && chatKind(chat) ? chat : undefined;
  }

  private emitMessage(raw: TdObject, isNew: boolean): void {
    const chatId = idOf(raw.chat_id);
    if (!chatId || !this.listed(chatId)) return;
    const message = this.view(raw);
    if (message) this.options.onEvent({ type: "message", serverId: TELEGRAM_ID, message, isNew });
    this.queueConversations();
  }

  /**
   * Tells the interface about a new message as Telegram's own apps would: not one of this
   * account's own, not a silent one, and not in a muted chat, unless it mentions or replies to
   * this account, as Telegram notifies those by default.
   */
  private maybeNotify(raw: TdObject): void {
    if (raw.is_outgoing === true || raw.disable_notification === true) return;
    const chatId = idOf(raw.chat_id);
    const chat = chatId ? this.listed(chatId) : undefined;
    if (!chat || !positionIn(chat, "chatListMain")) return;
    if (muteFor(chat, this.defaults) > 0 && raw.contains_unread_mention !== true) return;
    const message = this.view(raw);
    const key = chatKey(chat);
    if (!message || !key) return;
    const sender = this.nameOf(message.senderId);
    const what = message.text.replace(/[*_~|`]/g, "").trim() || "Message";
    const group = chatKind(chat) === "group";
    this.options.onEvent({
      type: "notify",
      serverId: TELEGRAM_ID,
      title: group ? str(chat.title, 256) || "Group" : sender,
      body: group ? `${sender}: ${what}` : what,
      conversationKey: key,
      groupId: String(chatId),
      messageId: message.id,
      inUse: this.active,
    });
  }

  private onChatAction(update: TdObject): void {
    const chatId = idOf(update.chat_id);
    const userId = senderOf(update.sender_id);
    if (!chatId || !userId || !this.listed(chatId)) return;
    const timerKey = `${chatId}/${userId}`;
    clearTimeout(this.typingTimers.get(timerKey));
    this.typingTimers.delete(timerKey);
    if (kindOf(update.action) === "chatActionCancel") return;
    this.options.onEvent({ type: "typing", serverId: TELEGRAM_ID, groupId: String(chatId), userId });
    this.typingTimers.set(timerKey, setTimeout(() => this.typingTimers.delete(timerKey), TYPING_MS));
  }

  private queueConversations(): void {
    if (this.conversationsQueued) return;
    this.conversationsQueued = true;
    setTimeout(() => {
      this.conversationsQueued = false;
      this.options.onEvent({ type: "conversations", serverId: TELEGRAM_ID });
      this.options.onEvent({ type: "preferences", serverId: TELEGRAM_ID });
    }, 50);
  }

  private queueUsers(): void {
    if (this.usersQueued) return;
    this.usersQueued = true;
    setTimeout(() => {
      this.usersQueued = false;
      this.options.onEvent({ type: "users", serverId: TELEGRAM_ID });
    }, 50);
  }

  // --- What the interface reads ---

  getInfo(): ServerInfo {
    return {
      name: "Telegram",
      version: "",
      has_icon: false,
      claimed: true,
      registration: "invite",
      max_upload_mb: 0,
      allow_member_invites: false,
      allow_member_bots: false,
      max_bots: 0,
      retention_days: 0,
      emote_set_id: "",
      emote_set_name: "",
      user_count: 0,
    };
  }

  getSelf(): { userId: string; username: string; role: "member"; deviceId: string } {
    const me = this.selfId ? this.users.get(this.selfId) : undefined;
    return { userId: this.selfId ? String(this.selfId) : "", username: me ? str((me.usernames as TdObject | undefined)?.editable_username, 64) : "", role: "member", deviceId: "" };
  }

  serverUrl(): string {
    return "";
  }

  getUsers(): UserView[] {
    const now = Date.now();
    const views = [...this.users.values()].map((user) => userView(user, this.selfId, now)).filter((view): view is UserView => !!view);
    // Chats that speak as themselves in groups.
    for (const chat of this.chats.values()) {
      const id = idOf(chat.id);
      if (id && kindOf(chat.type) === "chatTypeSupergroup") views.push(chatSenderView(id, str(chat.title, 256)));
    }
    return views;
  }

  getConversations(): ConversationView[] {
    const now = Date.now();
    const views: ConversationView[] = [];
    for (const chat of this.chats.values()) {
      const last = isObject(chat.last_message) ? this.view(chat.last_message) : null;
      const view = conversationView(chat, { selfId: this.selfId, now, defaults: this.defaults, users: this.users, lastMessage: last });
      if (view) views.push(view);
    }
    return views;
  }

  getPreferences(): Preferences {
    const pinned: { key: string; order: bigint }[] = [];
    const muted: string[] = [];
    const mutedUntil: Record<string, number> = {};
    const markedUnread: string[] = [];
    const blocked: string[] = [];
    const now = Date.now();
    for (const chat of this.chats.values()) {
      const key = chatKey(chat);
      const position = positionIn(chat, "chatListMain");
      if (!key || !position) continue;
      if (position.pinned) pinned.push({ key, order: position.order });
      const mute = muteFor(chat, this.defaults);
      if (mute >= 366 * 86400) muted.push(key);
      else if (mute > 0) mutedUntil[key] = now + mute * 1000;
      if (chat.is_marked_as_unread === true) markedUnread.push(key);
      if (chat.block_list != null && key.startsWith("user:")) blocked.push(key.slice(5));
    }
    pinned.sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
    return { pinned: pinned.map((entry) => entry.key), hidden: [], muted, mutedUntil, markedUnread, mentionsOnly: [], blocked, reported: [], sendReadReceipts: true };
  }

  // What a server has and Telegram here doesn't: asked for alike, and empty.
  getChannels(): [] {
    return [];
  }
  getVoiceMembers(): [] {
    return [];
  }
  getCalls(): [] {
    return [];
  }
  getSounds(): [] {
    return [];
  }
  getEmotes(): EmoteSet {
    return { set_id: "", set_name: "", emotes: [] };
  }
  emotesIn(): Record<string, never> {
    return {};
  }
  getNewDevices(): [] {
    return [];
  }

  // --- Messages ---

  private chatOf(groupId: string): number {
    const id = Number(groupId);
    if (!Number.isSafeInteger(id) || !this.listed(id)) throw new Error("That chat isn't on Telegram here.");
    return id;
  }

  /** One page of history, newest last, as a server's session gives it. */
  async loadMessages(groupId: string, before?: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const chatId = this.chatOf(groupId);
    if (before === undefined) await this.open(chatId);
    const found = await this.history(chatId, before ?? 0, 0, PAGE_SIZE);
    const older = found.filter((message) => before === undefined || (idOf(message.id) ?? 0) < before);
    return { messages: this.views(older), hasMore: older.length >= PAGE_SIZE / 2 };
  }

  async loadAround(groupId: string, seq: number): Promise<MessageView[]> {
    const chatId = this.chatOf(groupId);
    return this.views(await this.history(chatId, seq, -Math.floor(PAGE_SIZE / 2), PAGE_SIZE));
  }

  async loadNewer(groupId: string, after: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const chatId = this.chatOf(groupId);
    const found = (await this.history(chatId, after, -PAGE_SIZE, PAGE_SIZE + 1)).filter((message) => (idOf(message.id) ?? 0) > after);
    return { messages: this.views(found), hasMore: found.length >= PAGE_SIZE };
  }

  async messageById(groupId: string, id: string): Promise<MessageView | null> {
    const chatId = this.chatOf(groupId);
    const messageId = Number(id);
    const known = this.find(chatId, messageId);
    if (known) return this.view(known);
    try {
      const message = await this.engine.request({ "@type": "getMessage", chat_id: chatId, message_id: messageId });
      this.remember(message);
      return this.view(message);
    } catch {
      return null;
    }
  }

  async loadPins(groupId: string): Promise<MessageView[]> {
    const chatId = this.chatOf(groupId);
    const found = await this.engine
      .request({ "@type": "searchChatMessages", chat_id: chatId, topic_id: null, query: "", sender_id: null, from_message_id: 0, offset: 0, limit: 100, filter: { "@type": "searchMessagesFilterPinned" } })
      .catch(() => null);
    const messages = list(found?.messages, 100).filter(isObject);
    for (const message of messages) this.remember(message);
    return messages.map((message) => this.view(message)).filter((view): view is MessageView => !!view);
  }

  async search(query: string, groupId?: string, limit = 50): Promise<SearchResult[]> {
    const text = query.trim().slice(0, 256);
    if (!text) return [];
    const found = groupId
      ? await this.engine.request({ "@type": "searchChatMessages", chat_id: this.chatOf(groupId), topic_id: null, query: text, sender_id: null, from_message_id: 0, offset: 0, limit: Math.min(limit, 100), filter: null })
      : await this.engine.request({ "@type": "searchMessages", chat_list: { "@type": "chatListMain" }, query: text, offset: "", limit: Math.min(limit, 100), filter: null, chat_type_filter: null, min_date: 0, max_date: 0 });
    const results: SearchResult[] = [];
    for (const raw of list(found.messages, 100)) {
      if (!isObject(raw)) continue;
      const chat = this.listed(idOf(raw.chat_id) ?? 0);
      const key = chat ? chatKey(chat) : null;
      this.remember(raw);
      const message = this.view(raw);
      if (message && key) results.push({ message, conversationKey: key });
    }
    return results;
  }

  /** TDLib gives fewer messages than asked for until it has them, so it's asked until it does. */
  private async history(chatId: number, from: number, offset: number, limit: number): Promise<TdObject[]> {
    const found = new Map<number, TdObject>();
    let cursor = from;
    for (let attempt = 0; attempt < 5 && found.size < limit; attempt++) {
      const page = await this.engine
        .request({ "@type": "getChatHistory", chat_id: chatId, from_message_id: cursor, offset: attempt === 0 ? offset : 0, limit: Math.min(100, limit - found.size + (attempt === 0 ? 0 : 1)), only_local: false })
        .catch(() => null);
      const messages = list(page?.messages, 100).filter(isObject);
      let added = 0;
      for (const message of messages) {
        const id = idOf(message.id);
        if (id && !found.has(id)) {
          found.set(id, message);
          added++;
        }
      }
      if (added === 0 || offset < 0) break;
      cursor = Math.min(...[...found.keys()]);
    }
    for (const message of found.values()) this.remember(message);
    return [...found.values()].sort((a, b) => (idOf(a.id) ?? 0) - (idOf(b.id) ?? 0));
  }

  private views(messages: TdObject[]): MessageView[] {
    return messages.map((message) => this.view(message)).filter((view): view is MessageView => !!view);
  }

  /** Tells TDLib which chat is open, so that it keeps it up to date, and closes the one before. */
  private async open(chatId: number): Promise<void> {
    if (this.opened === chatId) return;
    if (this.opened !== null) void this.engine.request({ "@type": "closeChat", chat_id: this.opened }).catch(() => undefined);
    this.opened = chatId;
    await this.engine.request({ "@type": "openChat", chat_id: chatId }).catch(() => undefined);
  }

  /** Where a conversation's key points, making the chat with someone if there's none yet. */
  private async chatForKey(key: string): Promise<number> {
    const user = key.match(/^user:(\d+)$/);
    if (user) {
      const chat = await this.engine.request({ "@type": "createPrivateChat", user_id: Number(user[1]), force: false }).catch((error) => {
        throw explain(error);
      });
      const id = idOf(chat.id);
      if (!id) throw new Error("That chat isn't on Telegram here.");
      if (!this.chats.has(id)) this.chats.set(id, chat);
      return id;
    }
    const group = key.match(/^group:(-?\d+)$/);
    if (group) return this.chatOf(group[1]!);
    return this.chatOf(key);
  }

  async sendMessage(groupKey: string, body: MessageBody): Promise<MessageView> {
    if (body.attachments?.length) throw new Error("Files can't be sent to Telegram from Zuna yet.");
    if (body.forwarded) throw new Error("Nothing is forwarded between Zuna and Telegram.");
    const text = (body.text ?? "").trim();
    if (!text && !body.location) throw new Error("There's nothing to send.");
    const chatId = await this.chatForKey(groupKey);
    const replyTo = body.replyTo && /^\d+$/.test(body.replyTo) ? { "@type": "inputMessageReplyToMessage", message_id: Number(body.replyTo), quote: null } : null;
    const content = body.location
      ? { "@type": "inputMessageLocation", location: { "@type": "location", latitude: body.location.lat, longitude: body.location.lon, horizontal_accuracy: body.location.accuracy ?? 0 }, live_period: 0, heading: 0, proximity_alert_radius: 0 }
      : { "@type": "inputMessageText", text: { "@type": "formattedText", ...fromMarkup(text) }, link_preview_options: null, clear_draft: true };
    const sent = await this.engine
      .request({ "@type": "sendMessage", chat_id: chatId, topic_id: null, reply_to: replyTo, options: null, reply_markup: null, input_message_content: content })
      .catch((error) => {
        throw explain(error);
      });
    this.remember(sent);
    const view = this.view(sent);
    if (!view) throw new Error("Telegram didn't take that message.");
    this.options.onEvent({ type: "message", serverId: TELEGRAM_ID, message: view, isNew: true });
    return view;
  }

  async editMessage(groupId: string, id: string, text: string): Promise<void> {
    const chatId = this.chatOf(groupId);
    await this.engine
      .request({ "@type": "editMessageText", chat_id: chatId, message_id: Number(id), reply_markup: null, input_message_content: { "@type": "inputMessageText", text: { "@type": "formattedText", ...fromMarkup(text) }, link_preview_options: null, clear_draft: false } })
      .catch((error) => {
        throw explain(error);
      });
  }

  /** Deletes for everyone where Telegram allows it, and otherwise for this account alone. */
  async deleteMessage(groupId: string, id: string): Promise<void> {
    await this.deleteMessages(groupId, [id]);
  }

  async deleteMessages(groupId: string, ids: string[]): Promise<void> {
    const chatId = this.chatOf(groupId);
    const messageIds = ids.map(Number).filter((id) => Number.isSafeInteger(id));
    await this.engine.request({ "@type": "deleteMessages", chat_id: chatId, message_ids: messageIds, revoke: true }).catch((error) => {
      throw explain(error);
    });
  }

  async toggleReaction(groupId: string, messageId: string, key: string): Promise<void> {
    const chatId = this.chatOf(groupId);
    const message = this.find(chatId, Number(messageId));
    const view = message ? this.view(message) : null;
    const chosen = !!this.selfId && !!view?.reactions.some((reaction) => reaction.key === key && reaction.userIds.includes(String(this.selfId)));
    const reaction = { "@type": "reactionTypeEmoji", emoji: key };
    const query: TdObject = chosen
      ? { "@type": "removeMessageReaction", chat_id: chatId, message_id: Number(messageId), reaction_type: reaction }
      : { "@type": "addMessageReaction", chat_id: chatId, message_id: Number(messageId), reaction_type: reaction, is_big: false, update_recent_reactions: true };
    await this.engine.request(query).catch((error) => {
      throw explain(error);
    });
  }

  async setPinned(groupId: string, id: string, pinned: boolean): Promise<void> {
    const chatId = this.chatOf(groupId);
    const query: TdObject = pinned
      ? { "@type": "pinChatMessage", chat_id: chatId, message_id: Number(id), disable_notification: true, only_for_self: false }
      : { "@type": "unpinChatMessage", chat_id: chatId, message_id: Number(id) };
    await this.engine.request(query).catch((error) => {
      throw explain(error);
    });
  }

  /** Telegram's apps say someone is typing every few seconds while they are. */
  sendTyping(groupId: string): void {
    const chatId = this.chatOf(groupId);
    const now = Date.now();
    if (now - (this.typingSent.get(chatId) ?? 0) < TYPING_EVERY_MS) return;
    this.typingSent.set(chatId, now);
    void this.engine.request({ "@type": "sendChatAction", chat_id: chatId, topic_id: null, business_connection_id: "", action: { "@type": "chatActionTyping" } }).catch(() => undefined);
  }

  /** Marks a chat read up to a message, here and on every device of the account, as Telegram does. */
  async markRead(groupId: string, seq: number): Promise<void> {
    const chatId = this.chatOf(groupId);
    const chat = this.chats.get(chatId)!;
    if (seq <= (idOf(chat.last_read_inbox_message_id) ?? 0)) return;
    await this.engine.request({ "@type": "viewMessages", chat_id: chatId, message_ids: [seq], source: { "@type": "messageSourceChatHistory" }, force_read: true }).catch(() => undefined);
  }

  async markChatRead(key: string): Promise<void> {
    const chatId = await this.chatForKey(key);
    const chat = this.chats.get(chatId);
    const last = idOf((chat?.last_message as TdObject | undefined)?.id);
    if (last) await this.markRead(String(chatId), last);
    if (chat?.is_marked_as_unread === true) await this.setMarkedUnread(key, false);
    if (int(chat?.unread_mention_count, 0, 1_000_000, 0) > 0) await this.engine.request({ "@type": "readAllChatMentions", chat_id: chatId }).catch(() => undefined);
  }

  unreadMentions(): { id: string; seq: number }[] {
    return [];
  }

  markMentionSeen(): void {}

  async setMarkedUnread(key: string, marked: boolean): Promise<void> {
    const chatId = await this.chatForKey(key);
    await this.engine.request({ "@type": "toggleChatIsMarkedAsUnread", chat_id: chatId, is_marked_as_unread: marked }).catch((error) => {
      throw explain(error);
    });
  }

  /** Mutes a chat on Telegram, on every device of the account, as Telegram's own apps do. */
  async mute(key: string, until?: number): Promise<void> {
    const seconds = until ? Math.max(60, Math.round((until - Date.now()) / 1000)) : 0x7fffffff;
    await this.setMute(key, seconds);
  }

  async unmute(key: string): Promise<void> {
    await this.setMute(key, 0);
  }

  private async setMute(key: string, seconds: number): Promise<void> {
    const chatId = await this.chatForKey(key);
    const current = this.chats.get(chatId)?.notification_settings;
    const settings = isObject(current) ? { ...current } : { "@type": "chatNotificationSettings" };
    settings.use_default_mute_for = false;
    settings.mute_for = Math.min(seconds, 0x7fffffff);
    await this.engine.request({ "@type": "setChatNotificationSettings", chat_id: chatId, notification_settings: settings }).catch((error) => {
      throw explain(error);
    });
  }

  /** Pins or unpins chats in Telegram's list, as the person's pinned conversations say. */
  async setPinnedChats(keys: string[]): Promise<void> {
    const wanted = new Set(keys);
    for (const chat of this.chats.values()) {
      const key = chatKey(chat);
      const position = positionIn(chat, "chatListMain");
      if (!key || !position || position.pinned === wanted.has(key)) continue;
      await this.engine.request({ "@type": "toggleChatIsPinned", chat_list: { "@type": "chatListMain" }, chat_id: chat.id, is_pinned: wanted.has(key) }).catch((error) => {
        throw explain(error);
      });
    }
  }

  /**
   * What the interface changes of a chat list's preferences, as a server's session takes them:
   * pinned chats are Telegram's own pins. What Telegram has no such thing for is refused.
   */
  async updatePreferences(patch: Partial<Preferences>): Promise<void> {
    const { pinned, ...rest } = patch;
    if (Object.keys(rest).length > 0) throw new Error("Telegram keeps that in its own apps.");
    if (pinned) await this.setPinnedChats(pinned);
  }

  /** A bot's button with data: Telegram asks the bot, and its answer, if any, is words to show. */
  async pressButton(groupId: string, messageId: string, data: string): Promise<string> {
    const chatId = this.chatOf(groupId);
    const answer = await this.engine
      .request({ "@type": "getCallbackQueryAnswer", chat_id: chatId, message_id: Number(messageId), payload: { "@type": "callbackQueryPayloadData", data } })
      .catch((error) => {
        throw explain(error);
      });
    return str(answer.text, 200);
  }
}
