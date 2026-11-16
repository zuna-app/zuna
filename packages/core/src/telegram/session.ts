import { t } from "../i18n";
// A Telegram account linked on this device, as the interface sees it: a session under the server
// ID `telegram` that answers the calls a ServerSession does, for the part of them Telegram has,
// with the same shapes and the same CoreEvents (docs/TELEGRAM_PLAN.md, The adapter). It maps and
// nothing else: it opens no connection, imports nothing of the core's cryptography, and keeps no
// Telegram message anywhere but in memory, as a cache of the engine's, which holds the only copy
// on this device. Telegram's servers hold the real one.

import type {
  CallView,
  ConnectionState,
  ConversationView,
  CoreEvent,
  GroupMemberView,
  EmoteSet,
  MessageBody,
  MessageView,
  Preferences,
  SearchResult,
  ServerInfo,
  TelegramCallView,
  TelegramLink,
  UserView,
} from "../types";
import { TELEGRAM_ID } from "../types";
import { blobFiles, type FileAdapter } from "../files";
import { withoutMetadata, type ByteSource } from "../metadata";
import { previewText } from "../notify";
import { Engine, TelegramError, type TdObject, type TelegramAdapter } from "./engine";
import {
  TELEGRAM_FILE,
  attachmentsOf,
  chatKey,
  chatKind,
  chatSenderView,
  conversationView,
  displayName,
  fileNumber,
  filesIn,
  formatted,
  idOf,
  int,
  isObject,
  kindOf,
  lastingFileId,
  list,
  messageView,
  muteFor,
  positionIn,
  presenceOf,
  senderOf,
  str,
  userView,
  waveformToTelegram,
} from "./map";
import { fromMarkup, toMarkup } from "./markup";
import { TelegramCalls } from "./calls/call";

/** A file the person sends: what `sendWithAttachments` takes, as a server's session does. */
export interface OutgoingFile {
  blob: Blob;
  name: string;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
  voice?: boolean;
  waveform?: string;
  round?: boolean;
}

/** What a chat's details list on their own, as TDLib's search filters find them. */
const MEDIA_FILTERS: Record<string, string> = {
  photo: "searchMessagesFilterPhoto",
  video: "searchMessagesFilterVideo",
  file: "searchMessagesFilterDocument",
  audio: "searchMessagesFilterAudio",
  voice: "searchMessagesFilterVoiceNote",
  link: "searchMessagesFilterUrl",
};

/** How much of a file to send the engine at once, as it's written there a part at a time. */
const UPLOAD_PART = 512 * 1024;
/** Telegram's own limit for a file from an account without Premium. */
const MOST_UPLOAD = 2000 * 1024 * 1024;

export { TELEGRAM_ID };

const PAGE_SIZE = 50;

/** The most of one kind of a chat's media given at once, as an app asks for again all it has shown. */
const MEDIA_PAGE_MOST = 500;
/** How many times TDLib is asked for one page of media, which it may give a little at a time. */
const MEDIA_ASKS = 10;
/** How many messages of each chat are kept in memory, newest first, beyond those a chat shows. */
const KEPT_PER_CHAT = 400;
/** How many files' sources are kept, the latest shown, for finding each again after the engine starts again. */
const MOST_SOURCES = 20_000;
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
  "updateFileGenerationStart",
  "updateFileGenerationStop",
  "updateCall",
  "updateNewCallSignalingData",
]);

/** What Telegram's errors mean, in the app's words. */
function explain(error: unknown): Error {
  if (!(error instanceof TelegramError)) return error instanceof Error ? error : new Error(String(error));
  const message = error.message;
  const wait = message.match(/retry after (\d+)/i);
  if (wait) return new Error(t("telegram.waitMinutes", { count: Math.ceil(Number(wait[1]) / 60) }));
  const known: Record<string, string> = {
    PHONE_NUMBER_INVALID: t("telegram.thatIsntAPhoneNumber"),
    PHONE_NUMBER_BANNED: t("telegram.telegramHasBannedThatNumber"),
    PHONE_CODE_INVALID: t("telegram.wrongCode"),
    PHONE_CODE_EXPIRED: t("telegram.codeExpired"),
    EMAIL_CODE_INVALID: t("telegram.wrongCode"),
    PASSWORD_HASH_INVALID: t("telegram.wrongPassword"),
    AUTH_TOKEN_EXPIRED: t("telegram.codeExpiredNewSent"),
    MESSAGE_TOO_LONG: t("telegram.thatMessageIsTooLong"),
    CHAT_WRITE_FORBIDDEN: t("telegram.youCantWriteInThis"),
    USER_IS_BLOCKED: t("telegram.youCantWriteToThis"),
    MESSAGE_NOT_MODIFIED: t("telegram.nothingChanged"),
    INVITE_HASH_INVALID: t("telegram.thatLinkDoesntWorkAnymore"),
    INVITE_HASH_EXPIRED: t("telegram.thatLinkDoesntWorkAnymore"),
    "Wrong invite link": t("telegram.thatLinkDoesntWorkAnymore"),
    USERS_TOO_MUCH: t("telegram.thatGroupIsFull"),
    CHANNELS_TOO_MUCH: t("telegram.youreInAsManyGroups"),
    CHAT_ADMIN_REQUIRED: t("telegram.onlyTheGroupsAdminsCan"),
    USER_PRIVACY_RESTRICTED: t("telegram.theirPrivacySettingsOnTelegram"),
    USER_NOT_MUTUAL_CONTACT: t("telegram.onlyTheirContactsCanAdd"),
    USER_CHANNELS_TOO_MUCH: t("telegram.theyreInAsManyGroups"),
  };
  // A code is matched whole, as one can end another: USER_CHANNELS_TOO_MUCH isn't CHANNELS_TOO_MUCH.
  for (const [code, text] of Object.entries(known)) if (new RegExp(`(^|[^A-Z_])${code}($|[^A-Z_])`).test(message)) return new Error(text);
  return new Error(error.code === 403 ? t("telegram.zunaDoesntSupportThatOn") : t("telegram.telegramSaid", { message }));
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
  /** How the files the person sends are read, as the host gives them. */
  files?: FileAdapter;
  /** The app has calls (calls/call.ts). Without it, a call is nobody's here, and Telegram's own apps take it. */
  calls?: boolean;
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
  /**
   * The broker said the engine keeps failing (`zunaFailed`): `nudge` starts it again at once,
   * whether the broker gave up on it or is waiting to try again itself.
   */
  private stalled = false;
  private linking: boolean;
  /**
   * Files being sent, by the name each was given to TDLib: it never reads them itself, but asks
   * for each when it needs it (`updateFileGenerationStart`), and is written it a part at a time.
   */
  private outgoing = new Map<string, ByteSource>();
  /**
   * Generations TDLib stopped asking for, as when the message was deleted while it went: their
   * writing stops. The file stays in `outgoing`, as TDLib may ask for it again.
   */
  private stopped = new Set<string>();
  /** A group's people, as last asked of TDLib, for its details. */
  private members = new Map<number, GroupMemberView[]>();
  /**
   * What brings each file shown back from the engine, by Telegram's lasting ID for it: TDLib
   * numbers its files afresh each time it starts, and what the interfaces show still names the
   * numbers from before (`renumbered`).
   */
  private sources = new Map<string, TdObject>();
  /** The account's one call at a time (calls/call.ts). */
  private readonly calls: TelegramCalls;

  constructor(
    private readonly adapter: TelegramAdapter,
    private readonly options: TelegramSessionOptions,
  ) {
    this.engine = new Engine(adapter, (update) => this.onUpdate(update));
    this.linking = options.linking;
    this.calls = new TelegramCalls({
      request: (query) => this.engine.request(query),
      emit: (event) => this.options.onEvent(event),
      selfId: () => this.selfId,
      nameOf: (userId) => this.nameOf(String(userId)),
    });
  }

  // --- Lifecycle ---

  start(): void {
    this.ended = false;
    this.stalled = false;
    const why = this.engine.start(!this.linking);
    if (why) {
      this.stalled = true;
      this.setLink({ step: "failed", reason: why });
    }
  }

  stop(): void {
    this.ended = true;
    this.calls.reset();
    this.engine.stop(false);
  }

  /** Signs out at Telegram, if it can, and erases everything of the account's here. Says whether it signed out. */
  unlink(): Promise<boolean> {
    this.calls.reset();
    return new Promise((resolve) => {
      this.unlinking = resolve;
      this.signingOut = true;
      this.engine.stop(true);
    });
  }

  suspend(): void {}
  resume(): void {}

  /**
   * The app is back on screen, or its network is: an engine that keeps failing is started again
   * now, rather than when its broker next tries, or never where the broker gave up on it.
   */
  nudge(): void {
    if (!this.stalled || this.ended || this.signingOut) return;
    this.setConnection("connecting");
    this.start();
  }
  async flushOutbox(): Promise<void> {}

  getConnectionState(): ConnectionState {
    return this.connection;
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    this.options.onEvent({ type: "connection", serverId: TELEGRAM_ID, state });
  }

  /**
   * Whether the person is using this device with the Telegram account in front, which is when
   * Telegram shows them online, as its own apps do.
   */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.sayOnline();
  }

  /** Tells Telegram whether the account is in front here, once it's signed in. */
  private sayOnline(): void {
    if (this.link.step !== "ready") return;
    void this.engine.request({ "@type": "setOption", name: "online", value: { "@type": "optionValueBoolean", value: this.active } }).catch(() => undefined);
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
    if (!/^\+?\d{5,}$/.test(number)) throw new Error(t("telegram.enterThePhoneNumberWith"));
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
        return this.setLink({ step: "failed", reason: t("telegram.needsLoginEmail") });
      case "authorizationStateWaitPremiumPurchase":
        return this.setLink({ step: "failed", reason: t("telegram.needsPremium") });
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
      if (this.selfId) this.note(me.profile_photo, { "@type": "getUser", user_id: this.selfId });
      this.queueUsers();
      if (this.active) this.sayOnline();
      // The list comes as updates, a page at a time, until Telegram says there's no more, and the
      // archive after it, which the app shows as its hidden chats.
      for (const listKind of ["chatListMain", "chatListArchive"]) {
        try {
          for (let page = 0; page < 50; page++) await this.engine.request({ "@type": "loadChats", chat_list: { "@type": listKind }, limit: 100 });
        } catch (error) {
          if (!(error instanceof TelegramError && error.code === 404)) console.warn("[zuna] Telegram's chats couldn't be loaded", error);
        }
      }
    } catch (error) {
      console.warn("[zuna] Telegram's account couldn't be read", error);
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
        this.setConnection(states[kindOf(update.state)] ?? "connecting");
        return;
      }
      case "updateUser": {
        const user = update.user;
        const id = idOf((user as TdObject | undefined)?.id);
        if (id && isObject(user)) {
          this.users.set(id, user);
          this.note(user.profile_photo, { "@type": "getUser", user_id: id });
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
          this.note(chat.photo, { "@type": "getChat", chat_id: id });
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
        this.remember(message);
        this.emitMessage(message, false, old);
        return;
      }
      case "updateMessageSendFailed": {
        const message = update.message;
        const old = idOf(update.old_message_id);
        if (!isObject(message)) return;
        const chatId = idOf(message.chat_id);
        const replaced = chatId && old && old !== idOf(message.id) ? old : undefined;
        if (chatId && replaced) this.messages.get(chatId)?.delete(replaced);
        this.remember(message);
        this.emitMessage(message, false, replaced);
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
      case "updateFileGenerationStart":
        return void this.generate(update);
      case "updateFileGenerationStop": {
        const generation = str(update.generation_id, 24);
        if (/^\d+$/.test(generation)) this.stopped.add(generation);
        return;
      }
      case "updateCall":
        if (this.options.calls) this.calls.onUpdate(update.call);
        return;
      case "updateNewCallSignalingData":
        if (this.options.calls) this.calls.onSignalingData(update.call_id, update.data);
        return;
      default:
        return this.patchChat(update);
    }
  }

  /** TDLib asks for a file being sent: it's written there a part at a time, from the app's copy. */
  private async generate(update: TdObject): Promise<void> {
    const generation = str(update.generation_id, 24);
    const source = this.outgoing.get(str(update.original_path, 300));
    if (!/^\d+$/.test(generation)) return;
    if (!source || str(update.conversion, 16) !== "zuna") {
      await this.engine.request({ "@type": "finishFileGeneration", generation_id: generation, error: { "@type": "error", code: 400, message: "That file isn't being sent" } }).catch(() => undefined);
      return;
    }
    try {
      for (let offset = 0; offset < source.size; offset += UPLOAD_PART) {
        if (this.stopped.delete(generation)) return;
        const part = await source.read(offset, Math.min(source.size, offset + UPLOAD_PART));
        let binary = "";
        for (const byte of part) binary += String.fromCharCode(byte);
        await this.engine.request({ "@type": "writeGeneratedFilePart", generation_id: generation, offset, data: btoa(binary) });
      }
      await this.engine.request({ "@type": "finishFileGeneration", generation_id: generation, error: null });
      this.outgoing.delete(str(update.original_path, 300));
    } catch (error) {
      await this.engine.request({ "@type": "finishFileGeneration", generation_id: generation, error: { "@type": "error", code: 400, message: String(error) } }).catch(() => undefined);
    } finally {
      this.stopped.delete(generation);
    }
  }

  /** What the broker says about the engine itself. */
  private onBroker(update: TdObject): void {
    switch (update["@type"]) {
      case "zunaStopped": {
        // Only an end this session asked for is its own: one before it may still be telling of its stop.
        if (!this.ended && !this.signingOut) return;
        this.engine.failAll(new TelegramError(t("telegram.telegramStopped"), 503));
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
        this.calls.reset();
        this.engine.failAll(new TelegramError(t("telegram.telegramStopped"), 503));
        this.stalled = true;
        // A broker that goes on trying by itself, as the iPhone's does, is still connecting: only
        // one that gave up, which nothing but `nudge` starts again, waits.
        this.setConnection(update.retrying === true ? "connecting" : "offline");
        return this.setLink({ step: "failed", reason: t("telegram.telegramStoppedWorkingHere", { reason: str(update.reason, 200) }) });
      case "zunaRestarted":
        // A new engine, which says where it stands as it starts: until then it's connecting, and
        // what the one before it said of its connection is nobody's.
        this.calls.reset();
        this.engine.failAll(new TelegramError(t("telegram.telegramRestarted"), 503));
        this.stalled = false;
        this.setConnection("connecting");
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
        this.note(update.photo, { "@type": "getChat", chat_id: idOf(update.chat_id) });
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
    this.note(message, { "@type": "getMessage", chat_id: chatId, message_id: id });
    this.emitMessage(message, false);
  }

  private remember(message: TdObject): void {
    const chatId = idOf(message.chat_id);
    const id = idOf(message.id);
    if (!chatId || !id) return;
    this.note(message, { "@type": "getMessage", chat_id: chatId, message_id: id });
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

  /**
   * A message for the interface. One that took the place of another, as one sent takes the number
   * Telegram gives it, says which in the same event, so the chat swaps it where it is: taken away
   * and added again, its list was laid out anew and jumped.
   */
  private emitMessage(raw: TdObject, isNew: boolean, replaces?: number): void {
    const chatId = idOf(raw.chat_id);
    if (!chatId || !this.listed(chatId)) return;
    const message = this.view(raw);
    if (message) this.options.onEvent({ type: "message", serverId: TELEGRAM_ID, message, isNew, ...(replaces ? { replaces: String(replaces) } : {}) });
    else if (replaces) this.options.onEvent({ type: "message_removed", serverId: TELEGRAM_ID, groupId: String(chatId), id: String(replaces) });
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
    if (!chat || !(positionIn(chat, "chatListMain") || positionIn(chat, "chatListArchive"))) return;
    if (muteFor(chat, this.defaults) > 0 && raw.contains_unread_mention !== true) return;
    const message = this.view(raw);
    const key = chatKey(chat);
    if (!message || !key) return;
    const sender = this.nameOf(message.senderId);
    const what = previewText(message) || "Message";
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

  /**
   * The chats in Telegram's own order, as its apps list them: pinned first, then the one with the
   * newest message or draft, which TDLib keeps as each chat's place in its list. The archive's
   * chats, which the app hides, come after.
   */
  getConversations(): ConversationView[] {
    const now = Date.now();
    const placed: { view: ConversationView; archived: boolean; order: bigint }[] = [];
    for (const [id, chat] of this.chats) {
      const last = isObject(chat.last_message) ? this.view(chat.last_message) : null;
      const view = conversationView(chat, { selfId: this.selfId, now, defaults: this.defaults, users: this.users, lastMessage: last, members: this.members.get(id) ?? [] });
      if (!view) continue;
      const main = positionIn(chat, "chatListMain");
      placed.push({ view, archived: !main, order: (main ?? positionIn(chat, "chatListArchive"))?.order ?? 0n });
    }
    placed.sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        Number(b.view.pinned) - Number(a.view.pinned) ||
        (a.order < b.order ? 1 : a.order > b.order ? -1 : 0) ||
        b.view.lastActivityAt - a.view.lastActivityAt,
    );
    return placed.map((entry) => entry.view);
  }

  getPreferences(): Preferences {
    const pinned: { key: string; order: bigint }[] = [];
    const muted: string[] = [];
    const mutedUntil: Record<string, number> = {};
    const markedUnread: string[] = [];
    const blocked: string[] = [];
    const hidden: string[] = [];
    const now = Date.now();
    for (const chat of this.chats.values()) {
      const key = chatKey(chat);
      const position = positionIn(chat, "chatListMain");
      const archived = positionIn(chat, "chatListArchive");
      if (!key || !(position || archived)) continue;
      if (position?.pinned) pinned.push({ key, order: position.order });
      if (!position && archived) hidden.push(key);
      const mute = muteFor(chat, this.defaults);
      if (mute >= 366 * 86400) muted.push(key);
      else if (mute > 0) mutedUntil[key] = now + mute * 1000;
      if (chat.is_marked_as_unread === true) markedUnread.push(key);
      if (chat.block_list != null && key.startsWith("user:")) blocked.push(key.slice(5));
    }
    pinned.sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
    return { pinned: pinned.map((entry) => entry.key), hidden, muted, mutedUntil, markedUnread, mentionsOnly: [], blocked, reported: [], sendReadReceipts: true };
  }

  // What a server has and Telegram here doesn't: asked for alike, and empty.
  getChannels(): [] {
    return [];
  }
  getVoiceMembers(): [] {
    return [];
  }
  /** The account's call while it's going, as a conversation's call, as a server's are. */
  getCalls(): CallView[] {
    return this.calls.callViews();
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

  // --- Calls ---
  // One at a time, with one person, by voice or with the camera (docs/TELEGRAM_CALLS_PLAN.md).
  // Its media is the interface's, which the core tells what to do (`telegram_call_media`).

  /** The call going on, or the one that just ended, as its screen shows it. */
  getTelegramCall(): TelegramCallView | null {
    return this.calls.current();
  }

  /** Calls the person a private chat is with. Says the call's number. */
  async startCall(groupId: string, options: { video?: boolean } = {}): Promise<number> {
    const chat = this.listed(this.chatOf(groupId));
    const peer = chat && chatKind(chat) === "dm" ? idOf((chat.type as TdObject).user_id) : null;
    const user = peer ? this.users.get(peer) : undefined;
    if (!this.options.calls || !peer || peer === this.selfId || kindOf(user?.type) === "userTypeBot") throw new Error(t("telegram.call.cantCallHere"));
    return this.calls.start(peer, options?.video === true).catch((error) => {
      throw explain(error);
    });
  }

  async answerCall(id: number): Promise<void> {
    await this.calls.answer(id).catch((error) => {
      throw explain(error);
    });
  }

  /** Declines the call ringing in a chat, as a server's call is declined, by its group. */
  async declineCall(groupId: string): Promise<void> {
    const call = this.calls.current();
    if (call && call.groupId === groupId) await this.calls.decline(call.id);
  }

  async endCall(id: number): Promise<void> {
    await this.calls.hangUp(id);
  }

  /** The peer connection's offer, which gives back what it's to set. */
  callOffer(id: number, sdp: string): string {
    return this.calls.offer(id, sdp);
  }

  callCandidate(id: number, candidate: string): void {
    this.calls.candidate(id, candidate);
  }

  callHeard(id: number, text: string): void {
    this.calls.heard(id, text);
  }

  callSaid(id: number, state: { muted: boolean; camera: boolean }): void {
    this.calls.said(id, state);
  }

  callConnection(id: number, state: string): void {
    this.calls.connection(id, state);
  }

  /** How a call was, one to five, and which of Telegram's problems it had (`PROBLEMS` in calls/call.ts). */
  async rateCall(id: number, stars: number, problems: string[]): Promise<void> {
    await this.calls.rate(id, stars, problems).catch((error) => {
      throw explain(error);
    });
  }

  /** Whether Telegram rings this device for calls: its own "Accept calls" for this session. */
  async takesCalls(): Promise<boolean> {
    const sessions = await this.engine.request({ "@type": "getActiveSessions" }).catch((error) => {
      throw explain(error);
    });
    const current = list(sessions.sessions, 1000).find((session) => isObject(session) && session.is_current === true) as TdObject | undefined;
    return current?.can_accept_calls !== false;
  }

  /** Turns that on or off. Off, no call rings here, and calls can still be made from here. */
  async setTakesCalls(on: boolean): Promise<void> {
    await this.engine.request({ "@type": "toggleSessionCanAcceptCalls", session_id: 0, can_accept_calls: on === true }).catch((error) => {
      throw explain(error);
    });
  }

  // --- Files ---

  /**
   * A file a message or a picture shows, by its `tg:` number: TDLib downloads it into its own
   * folder, and the host hands that file to the interface, which reads it there.
   */
  async downloadFile(ref: { fileId: string; mime?: string }): Promise<Blob> {
    const found = ref.fileId.match(TELEGRAM_FILE);
    if (!found) throw new Error(t("telegram.thatIsntOneOfTelegrams"));
    const [, number, lasting] = found;
    let fileId = Number(number);
    // A number from before the engine last started may be another file's now, which is never
    // given in its place: the file is found again by what brought it, under its new number.
    if (lasting) {
      const known = await this.engine.request({ "@type": "getFile", file_id: fileId }).catch(() => null);
      if (!known || lastingFileId(known) !== lasting) fileId = await this.renumbered(lasting);
    }
    const file = await this.engine.request({ "@type": "downloadFile", file_id: fileId, priority: 16, offset: 0, limit: 0, synchronous: true }).catch((error) => {
      throw explain(error);
    });
    const local = file.local as TdObject | undefined;
    const path = str(local?.path, 4096);
    if (local?.is_downloading_completed !== true || !path) throw new Error(t("telegram.telegramDidntSendThatFile"));
    return await this.adapter.file(path, typeof ref.mime === "string" ? ref.mime.slice(0, 128) : "application/octet-stream");
  }

  /** Notes what brings back each file in something the engine sent, the latest kept (`sources`). */
  private note(value: unknown, source: TdObject): void {
    for (const file of filesIn(value)) {
      const lasting = lastingFileId(file);
      if (!lasting) continue;
      this.sources.delete(lasting);
      this.sources.set(lasting, source);
    }
    for (const oldest of this.sources.keys()) {
      if (this.sources.size <= MOST_SOURCES) break;
      this.sources.delete(oldest);
    }
  }

  /**
   * A file's number in the engine running now, which numbered its files afresh as it started,
   * from asking again for what brought it: a message, a person, a chat or a sticker set. TDLib
   * then also has where the file came from, which it needs to fetch one whose reference expired.
   */
  private async renumbered(lasting: string): Promise<number> {
    const source = this.sources.get(lasting);
    const fresh = source ? await this.engine.request(source).catch(() => null) : null;
    const number = fileNumber(filesIn(fresh).find((file) => lastingFileId(file) === lasting));
    if (!number) throw new TelegramError(t("telegram.thatFileIsntHereAny"), 404);
    // The message kept here takes the new numbers, which what it shows from now on names.
    if (fresh && source!["@type"] === "getMessage") this.remember(fresh);
    return number;
  }

  /** Sends files, each as the kind of message Telegram has for it, with the text on the first. */
  async sendWithAttachments(groupKey: string, files: OutgoingFile[], body: MessageBody, options: { keepMetadata?: boolean } = {}): Promise<string> {
    const reader = this.options.files ?? blobFiles;
    if (files.length === 0) return (await this.sendMessage(groupKey, body)).id;
    const tooBig = files.find((file) => reader.size(file.blob) > MOST_UPLOAD);
    if (tooBig) throw new Error(t("telegram.fileTooLarge", { name: tooBig.name }));
    const chatId = await this.chatForKey(groupKey);
    const caption = (body.text ?? "").trim();
    const contents: TdObject[] = [];
    for (const [index, file] of files.entries()) {
      const whole: ByteSource = { size: reader.size(file.blob), read: (start, end) => reader.read(file.blob, start, end) };
      // What the Privacy switch says goes for Telegram too: a voice or video message is recorded here, and holds nothing of it.
      const source = options.keepMetadata || file.voice || file.round ? whole : await withoutMetadata(whole, file.mime, file.name);
      contents.push(this.inputContent(file, source, index === 0 ? caption : ""));
    }
    const replyTo = body.replyTo && /^\d+$/.test(body.replyTo) ? { "@type": "inputMessageReplyToMessage", message_id: Number(body.replyTo), quote: null } : null;
    // Pictures and videos together go as one album, of up to ten, as Telegram's apps send them.
    const album = contents.length > 1 && contents.length <= 10 && contents.every((content) => content["@type"] === "inputMessagePhoto" || content["@type"] === "inputMessageVideo");
    const sent: TdObject[] = [];
    if (album) {
      const answer = await this.engine.request({ "@type": "sendMessageAlbum", chat_id: chatId, topic_id: null, reply_to: replyTo, options: null, input_message_contents: contents }).catch((error) => {
        throw explain(error);
      });
      sent.push(...list(answer.messages, 10).filter(isObject));
    } else {
      for (const [index, content] of contents.entries()) {
        const message = await this.engine
          .request({ "@type": "sendMessage", chat_id: chatId, topic_id: null, reply_to: index === 0 ? replyTo : null, options: null, reply_markup: null, input_message_content: content })
          .catch((error) => {
            throw explain(error);
          });
        sent.push(message);
      }
    }
    for (const message of sent) {
      this.remember(message);
      const view = this.view(message);
      if (view) this.options.onEvent({ type: "message", serverId: TELEGRAM_ID, message: view, isNew: true });
    }
    return String(idOf(sent[0]?.id) ?? "");
  }

  /** How one file goes to Telegram: as the engine will ask for it by a name made for this send. */
  private inputContent(file: OutgoingFile, source: ByteSource, caption: string): TdObject {
    const name = uploadName(file.name);
    this.outgoing.set(name, source);
    const input = { "@type": "inputFileGenerated", original_path: name, conversion: "zuna", expected_size: source.size };
    const text = { "@type": "formattedText", ...fromMarkup(caption) };
    const width = Math.max(0, Math.round(file.width ?? 0));
    const height = Math.max(0, Math.round(file.height ?? 0));
    const duration = Math.max(0, Math.round(file.duration ?? 0));
    if (file.voice) return { "@type": "inputMessageVoiceNote", voice_note: { "@type": "inputVoiceNote", voice_note: input, duration, waveform: waveformToTelegram(file.waveform) }, caption: text, self_destruct_type: null };
    if (file.round) return { "@type": "inputMessageVideoNote", video_note: { "@type": "inputVideoNote", video_note: input, thumbnail: null, duration, length: Math.min(width || 384, 640) }, self_destruct_type: null };
    if (file.mime === "image/gif") return { "@type": "inputMessageAnimation", animation: { "@type": "inputAnimation", animation: input, thumbnail: null, added_sticker_file_ids: [], duration, width, height }, caption: text, show_caption_above_media: false, has_spoiler: false };
    if (/^image\/(jpeg|png|webp)$/.test(file.mime)) return { "@type": "inputMessagePhoto", photo: { "@type": "inputPhoto", photo: input, thumbnail: null, video: null, added_sticker_file_ids: [], width, height }, caption: text, show_caption_above_media: false, self_destruct_type: null, has_spoiler: false };
    if (file.mime.startsWith("video/")) return { "@type": "inputMessageVideo", video: { "@type": "inputVideo", video: input, thumbnail: null, cover: null, start_timestamp: 0, added_sticker_file_ids: [], duration, width, height, supports_streaming: true }, caption: text, show_caption_above_media: false, self_destruct_type: null, has_spoiler: false };
    if (file.mime.startsWith("audio/")) return { "@type": "inputMessageAudio", audio: { "@type": "inputAudio", audio: input, album_cover_thumbnail: null, duration, title: "", performer: "" }, caption: text };
    return { "@type": "inputMessageDocument", document: { "@type": "inputDocument", document: input, thumbnail: null, disable_content_type_detection: false }, caption: text };
  }

  /** How many of each kind a chat holds, as Telegram counts them, for a chat's details. */
  async mediaCounts(groupId: string): Promise<Record<string, number>> {
    const chatId = this.chatOf(groupId);
    const counts: Record<string, number> = {};
    for (const [kind, filter] of Object.entries(MEDIA_FILTERS)) {
      const found = await this.engine.request({ "@type": "getChatMessageCount", chat_id: chatId, topic_id: null, filter: { "@type": filter }, return_local: false }).catch(() => null);
      counts[kind] = int(found?.count, 0, 2 ** 31, 0);
    }
    return counts;
  }

  /**
   * One kind of what a chat holds, newest first, a page at a time: those older than `before`, or
   * the newest when it's left out, as the apps ask for the first page with null. TDLib may give
   * fewer than asked for, so it's asked again until there are enough, or none left.
   */
  async loadMedia(groupId: string, kind: string, before?: number | null, limit = PAGE_SIZE): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const chatId = this.chatOf(groupId);
    const filter = MEDIA_FILTERS[kind];
    if (!filter) return { messages: [], hasMore: false };
    const wanted = Math.min(int(limit, 1, Number.MAX_SAFE_INTEGER, PAGE_SIZE), MEDIA_PAGE_MOST);
    const found: TdObject[] = [];
    // Each message is older than the last, which leaves out `before` itself and any repeated.
    let oldest = typeof before === "number" && before > 0 ? before : Infinity;
    let from = Number.isFinite(oldest) ? oldest : 0;
    let more = true;
    for (let asked = 0; more && found.length < wanted && asked < MEDIA_ASKS; asked++) {
      // One more from where it goes on, in case that one comes again.
      const limit = Math.min(wanted - found.length + (from > 0 ? 1 : 0), 100);
      const page = await this.engine
        .request({ "@type": "searchChatMessages", chat_id: chatId, topic_id: null, query: "", sender_id: null, from_message_id: from, offset: 0, limit, filter: { "@type": filter } })
        .catch(() => null);
      if (!page) {
        more = false;
        break;
      }
      for (const message of list(page.messages, 100).filter(isObject)) {
        const id = idOf(message.id) ?? 0;
        if (id <= 0 || id >= oldest) continue;
        found.push(message);
        oldest = id;
      }
      // None left once Telegram says so, or when it gives the same place to go on from.
      const next = idOf(page.next_from_message_id) ?? 0;
      more = next > 0 && (from === 0 || next < from);
      from = next;
    }
    if (found.length > wanted) {
      found.length = wanted;
      more = true;
    }
    for (const message of found) this.remember(message);
    return { messages: this.views(found), hasMore: more };
  }

  // --- Messages ---

  private chatOf(groupId: string): number {
    const id = Number(groupId);
    if (!Number.isSafeInteger(id) || !this.listed(id)) throw new Error(t("telegram.thatChatIsntOnTelegram"));
    return id;
  }

  /** One page of history, newest last, as a server's session gives it. */
  async loadMessages(groupId: string, before?: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const chatId = this.chatOf(groupId);
    if (before === undefined) await this.open(chatId);
    const found = await this.history(chatId, before ?? 0, 0, PAGE_SIZE);
    const older = found.filter((message) => before === undefined || idOf(message.id)! < before);
    return { messages: this.views(older), hasMore: older.length >= PAGE_SIZE / 2 };
  }

  async loadAround(groupId: string, seq: number): Promise<MessageView[]> {
    const chatId = this.chatOf(groupId);
    return this.views(await this.history(chatId, seq, -Math.floor(PAGE_SIZE / 2), PAGE_SIZE));
  }

  async loadNewer(groupId: string, after: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const chatId = this.chatOf(groupId);
    const found = (await this.history(chatId, after, -PAGE_SIZE, PAGE_SIZE + 1)).filter((message) => idOf(message.id)! > after);
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
    return [...found.entries()].sort(([a], [b]) => a - b).map(([, message]) => message);
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
    void this.loadMembers(chatId);
  }

  /** Where a conversation's key points, making the chat with someone if there's none yet. */
  private async chatForKey(key: string): Promise<number> {
    const user = key.match(/^user:(\d+)$/);
    if (user) {
      const chat = await this.engine.request({ "@type": "createPrivateChat", user_id: Number(user[1]), force: false }).catch((error) => {
        throw explain(error);
      });
      const id = idOf(chat.id);
      if (!id) throw new Error(t("telegram.thatChatIsntOnTelegram"));
      if (!this.chats.has(id)) this.chats.set(id, chat);
      return id;
    }
    const group = key.match(/^group:(-?\d+)$/);
    if (group) return this.chatOf(group[1]!);
    return this.chatOf(key);
  }

  async sendMessage(groupKey: string, body: MessageBody): Promise<MessageView> {
    if (body.attachments?.length) throw new Error(t("telegram.thoseFilesWereUploadedTo"));
    if (body.forwarded) throw new Error(t("telegram.nothingIsForwardedBetweenZuna"));
    const text = (body.text ?? "").trim();
    if (!text && !body.location) throw new Error(t("telegram.theresNothingToSend"));
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
    if (!view) throw new Error(t("telegram.telegramDidntAcceptThatMessage"));
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

  /** Deletes for everyone, unless `forEveryone` is false, when it's for this account alone. */
  async deleteMessages(groupId: string, ids: string[], forEveryone = true): Promise<void> {
    const chatId = this.chatOf(groupId);
    const messageIds = ids.map(Number).filter((id) => Number.isSafeInteger(id));
    await this.engine.request({ "@type": "deleteMessages", chat_id: chatId, message_ids: messageIds, revoke: forEveryone }).catch((error) => {
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

  /** The unread messages that mention this account in a group, oldest first, for jumping to each. */
  async unreadMentions(groupId: string, after = 0): Promise<{ id: string; seq: number }[]> {
    const chatId = this.chatOf(groupId);
    const found = await this.engine
      .request({ "@type": "searchChatMessages", chat_id: chatId, topic_id: null, query: "", sender_id: null, from_message_id: 0, offset: 0, limit: 100, filter: { "@type": "searchMessagesFilterUnreadMention" } })
      .catch(() => null);
    return list(found?.messages, 100)
      .map((message) => idOf((message as TdObject).id))
      .filter((id): id is number => !!id && id > after)
      .sort((a, b) => a - b)
      .map((id) => ({ id: String(id), seq: id }));
  }

  /** A mention jumped to is read, as Telegram counts it. */
  markMentionSeen(groupId: string, id: string): void {
    const chatId = this.chatOf(groupId);
    void this.engine.request({ "@type": "viewMessages", chat_id: chatId, message_ids: [Number(id)], source: { "@type": "messageSourceChatHistory" }, force_read: true }).catch(() => undefined);
  }

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
    const { pinned, hidden, ...rest } = patch;
    if (Object.keys(rest).length > 0) throw new Error(t("telegram.thatsOnlyAvailableInTelegrams"));
    if (pinned) await this.setPinnedChats(pinned);
    if (hidden) await this.setArchived(hidden);
  }

  /** Telegram's archive is the app's hidden chats: what's hidden here is archived there, and back. */
  private async setArchived(keys: string[]): Promise<void> {
    const wanted = new Set(keys);
    for (const chat of this.chats.values()) {
      const key = chatKey(chat);
      if (!key) continue;
      const archived = !!positionIn(chat, "chatListArchive");
      if (archived === wanted.has(key) || (!archived && !positionIn(chat, "chatListMain"))) continue;
      const target = wanted.has(key) ? "chatListArchive" : "chatListMain";
      await this.engine.request({ "@type": "addChatToList", chat_id: chat.id, chat_list: { "@type": target } }).catch((error) => {
        throw explain(error);
      });
    }
  }

  /**
   * A bot's button with data, by where it is under the message, as a server's session takes it:
   * Telegram asks the bot, and its answer, if any, is words to show.
   */
  async pressButton(groupId: string, messageId: string, row: number, column: number): Promise<string> {
    const chatId = this.chatOf(groupId);
    const message = this.find(chatId, Number(messageId));
    const view = message ? this.view(message) : null;
    const data = view?.buttons[row]?.[column]?.data;
    if (data === undefined) throw new Error(t("telegram.thatButtonIsntThereAny"));
    const answer = await this.engine
      .request({ "@type": "getCallbackQueryAnswer", chat_id: chatId, message_id: Number(messageId), payload: { "@type": "callbackQueryPayloadData", data } })
      .catch((error) => {
        throw explain(error);
      });
    return str(answer.text, 200);
  }

  // --- Forwarding, drafts and what a message allows ---

  /** Forwards messages to another of Telegram's chats, saying whose they were, as Telegram does. */
  async forwardMessages(groupId: string, ids: string[], toKey: string): Promise<void> {
    const fromChat = this.chatOf(groupId);
    const toChat = await this.chatForKey(toKey);
    const messageIds = ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    await this.engine
      .request({ "@type": "forwardMessages", chat_id: toChat, topic_id: null, from_chat_id: fromChat, message_ids: messageIds, options: null, send_copy: false, remove_caption: false })
      .catch((error) => {
        throw explain(error);
      });
  }

  /** What Telegram has for a chat as written but not sent, on any device of the account. */
  getDraft(key: string): string {
    const chat = [...this.chats.values()].find((candidate) => chatKey(candidate) === key);
    const content = (chat?.draft_message as TdObject | undefined)?.content as TdObject | undefined;
    if (kindOf(content) !== "draftMessageContentText") return "";
    return toMarkup(formatted(content?.text));
  }

  /** Keeps what's written in a chat as Telegram's draft, which the account's other devices show. */
  async saveDraft(key: string, text: string): Promise<void> {
    const chatId = await this.chatForKey(key);
    const trimmed = text.trim();
    const draft = trimmed
      ? { "@type": "draftMessage", reply_to: null, date: 0, content: { "@type": "draftMessageContentText", text: { "@type": "formattedText", ...fromMarkup(trimmed) }, link_preview_options: null }, effect_id: "0", suggested_post_info: null }
      : null;
    await this.engine.request({ "@type": "setChatDraftMessage", chat_id: chatId, topic_id: null, draft_message: draft }).catch(() => undefined);
  }

  /** Whether a message can go for everyone, or only for this account, as Telegram allows. */
  async deleteChoices(groupId: string, id: string): Promise<{ forEveryone: boolean; forSelf: boolean }> {
    const chatId = this.chatOf(groupId);
    const properties = await this.engine.request({ "@type": "getMessageProperties", chat_id: chatId, message_id: Number(id) }).catch(() => null);
    return { forEveryone: properties?.can_be_deleted_for_all_users === true, forSelf: properties?.can_be_deleted_only_for_self === true };
  }

  /** Marks a voice or video message as listened to, which its sender's apps show. */
  async markListened(groupId: string, id: string): Promise<void> {
    const chatId = this.chatOf(groupId);
    await this.engine.request({ "@type": "openMessageContent", chat_id: chatId, message_id: Number(id) }).catch(() => undefined);
  }

  // --- Stickers ---

  /** The account's own sticker sets, each with a picture of its first sticker. */
  async getStickerSets(): Promise<{ id: string; title: string; cover: string | null }[]> {
    const asked: TdObject = { "@type": "getInstalledStickerSets", sticker_type: { "@type": "stickerTypeRegular" } };
    const found = await this.engine.request(asked).catch(() => null);
    this.note(found, asked);
    return list(found?.sets, 200)
      .filter(isObject)
      .flatMap((set) => {
        const id = str(set.id, 24);
        if (!/^\d+$/.test(id)) return [];
        const first = list(set.covers, 1)[0] as TdObject | undefined;
        return [{ id, title: str(set.title, 64) || "Stickers", cover: first ? stickerPicture(first)?.fileId ?? null : null }];
      });
  }

  /** A set's stickers, each with the picture the app shows of it and what sending it takes. */
  async getStickers(setId: string): Promise<{ file: number; picture: string; emoji: string; width: number; height: number }[]> {
    if (!/^\d+$/.test(setId)) return [];
    const asked: TdObject = { "@type": "getStickerSet", set_id: setId };
    const set = await this.engine.request(asked).catch(() => null);
    this.note(set, asked);
    return list(set?.stickers, 200)
      .filter(isObject)
      .flatMap((sticker) => {
        const file = int((sticker.sticker as TdObject | undefined)?.id, 1, 2 ** 31 - 1, 0);
        const picture = stickerPicture(sticker);
        if (!file || !picture) return [];
        return [{ file, picture: picture.fileId, emoji: str(sticker.emoji, 16), width: int(sticker.width, 1, 2048, 512), height: int(sticker.height, 1, 2048, 512) }];
      });
  }

  /** Sends one of the account's stickers, as Telegram's apps do. */
  async sendSticker(groupKey: string, file: number, emoji: string, width: number, height: number): Promise<void> {
    if (!Number.isSafeInteger(file) || file <= 0) throw new Error(t("telegram.thatIsntOneOfYour"));
    const chatId = await this.chatForKey(groupKey);
    const content = { "@type": "inputMessageSticker", sticker: { "@type": "inputSticker", sticker: { "@type": "inputFileId", id: file }, thumbnail: null, width: Math.round(width), height: Math.round(height) }, emoji: emoji.slice(0, 16) };
    const sent = await this.engine
      .request({ "@type": "sendMessage", chat_id: chatId, topic_id: null, reply_to: null, options: null, reply_markup: null, input_message_content: content })
      .catch((error) => {
        throw explain(error);
      });
    this.remember(sent);
    const view = this.view(sent);
    if (view) this.options.onEvent({ type: "message", serverId: TELEGRAM_ID, message: view, isNew: true });
  }

  // --- Groups ---

  /** Makes a group with these people, as Telegram's apps make a small one, and says its ID. */
  async createGroup(name: string, memberIds: string[]): Promise<string> {
    const title = name.trim().slice(0, 128);
    if (!title) throw new Error(t("telegram.aGroupNeedsAName"));
    const users = memberIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    const created = await this.engine.request({ "@type": "createNewBasicGroupChat", user_ids: users, title, message_auto_delete_time: 0 }).catch((error) => {
      throw explain(error);
    });
    const chatId = idOf(created.chat_id);
    if (!chatId) throw new Error(t("telegram.telegramCouldntCreateThatGroup"));
    return String(chatId);
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    const chatId = this.chatOf(groupId);
    const users = userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    await this.engine.request({ "@type": "addChatMembers", chat_id: chatId, user_ids: users }).catch((error) => {
      throw explain(error);
    });
    void this.loadMembers(chatId);
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    const chatId = this.chatOf(groupId);
    await this.engine
      .request({ "@type": "setChatMemberStatus", chat_id: chatId, member_id: { "@type": "messageSenderUser", user_id: Number(userId) }, status: { "@type": "chatMemberStatusLeft" } })
      .catch((error) => {
        throw explain(error);
      });
    void this.loadMembers(chatId);
  }

  async leaveGroup(groupId: string): Promise<void> {
    const chatId = this.chatOf(groupId);
    await this.engine.request({ "@type": "leaveChat", chat_id: chatId }).catch((error) => {
      throw explain(error);
    });
    // Out of the list too, as Telegram's apps leave a group: a basic group left stays in it
    // otherwise, with nothing to do there. Its history goes for this account alone.
    await this.engine.request({ "@type": "deleteChatHistory", chat_id: chatId, remove_from_chat_list: true, revoke: false }).catch(() => undefined);
  }

  /** A group's name, and its picture, sent a part at a time as any file is. */
  async updateGroupMeta(groupId: string, changes: { name?: string }, avatarBlob?: Blob | null): Promise<void> {
    const chatId = this.chatOf(groupId);
    if (changes.name !== undefined) {
      const title = changes.name.trim().slice(0, 128);
      if (!title) throw new Error(t("telegram.aGroupNeedsAName"));
      await this.engine.request({ "@type": "setChatTitle", chat_id: chatId, title }).catch((error) => {
        throw explain(error);
      });
    }
    if (avatarBlob) {
      const reader = this.options.files ?? blobFiles;
      const whole: ByteSource = { size: reader.size(avatarBlob), read: (start, end) => reader.read(avatarBlob, start, end) };
      const source = await withoutMetadata(whole, reader.type(avatarBlob), "picture.jpg");
      const name = uploadName("picture.jpg");
      this.outgoing.set(name, source);
      await this.engine
        .request({ "@type": "setChatPhoto", chat_id: chatId, photo: { "@type": "inputChatPhotoStatic", photo: { "@type": "inputFileGenerated", original_path: name, conversion: "zuna", expected_size: source.size } } })
        .catch((error) => {
          throw explain(error);
        });
    }
  }

  /** A link that brings people into a group, made by Telegram. */
  async createInvite(groupId: string): Promise<string> {
    const chatId = this.chatOf(groupId);
    const link = await this.engine.request({ "@type": "createChatInviteLink", chat_id: chatId, name: "", expiration_date: 0, member_limit: 0, creates_join_request: false }).catch((error) => {
      throw explain(error);
    });
    const url = str(link.invite_link, 256);
    if (!/^https:\/\/t\.me\//.test(url)) throw new Error(t("telegram.couldntCreateLink"));
    return url;
  }

  /** Joins a group by a link to it, and says its chat's ID. */
  async joinByLink(link: string): Promise<string> {
    const url = link.trim();
    if (!/^(https?:\/\/)?(t\.me|telegram\.me)\/(\+|joinchat\/)[\w-]+$/i.test(url) && !/^tg:\/\/join\?invite=[\w-]+$/i.test(url)) throw new Error(t("telegram.thatIsntALinkTo"));
    // What it leads to, first: a channel or a paid group stays in Telegram's own app.
    const info = await this.engine.request({ "@type": "checkChatInviteLink", invite_link: url }).catch((error) => {
      throw explain(error);
    });
    if (kindOf(info.type) === "inviteLinkChatTypeChannel") throw new Error(t("telegram.thatsAChannel"));
    if (isObject(info.subscription_info)) throw new Error(t("telegram.thatGroupRequiresAPayment"));
    const known = idOf(info.chat_id);
    if (known && this.listed(known)) return String(known);
    const joined = await this.engine.request({ "@type": "joinChatByInviteLink", invite_link: url }).catch((error) => {
      throw explain(error);
    });
    const result = kindOf(joined);
    if (result === "chatJoinResultRequestSent") throw new Error(t("telegram.requestSent"));
    if (result === "chatJoinResultGuardBotApprovalRequired") throw new Error(t("telegram.thatGroupsBotNeedsTo"));
    const chatId = result === "chatJoinResultSuccess" ? idOf(joined.chat_id) : null;
    if (!chatId) throw new Error(t("telegram.telegramDidntLetYouIn"));
    return String(chatId);
  }

  /** A group's people, as TDLib knows them, for its details. */
  private async loadMembers(chatId: number): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat || chatKind(chat) !== "group") return;
    let members: unknown[] = [];
    if (kindOf(chat.type) === "chatTypeBasicGroup") {
      const info = await this.engine.request({ "@type": "getBasicGroupFullInfo", basic_group_id: (chat.type as TdObject).basic_group_id }).catch(() => null);
      members = list(info?.members, 1000);
    } else {
      const found = await this.engine
        .request({ "@type": "getSupergroupMembers", supergroup_id: (chat.type as TdObject).supergroup_id, filter: { "@type": "supergroupMembersFilterRecent" }, offset: 0, limit: 200 })
        .catch(() => null);
      members = list(found?.members, 200);
    }
    this.members.set(
      chatId,
      members.filter(isObject).flatMap((member) => {
        const userId = senderOf(member.member_id);
        const status = kindOf(member.status);
        if (!userId || status === "chatMemberStatusLeft" || status === "chatMemberStatusBanned") return [];
        return [{ userId, role: status === "chatMemberStatusCreator" || status === "chatMemberStatusAdministrator" ? ("admin" as const) : ("member" as const), joinedAt: int(member.joined_chat_date, 0, 2 ** 31, 0) * 1000 }];
      }),
    );
    this.queueConversations();
  }
}

/**
 * What TDLib is told a file being sent is called: a name made for this send, which TDLib asks for
 * it by, and the file's own name after it, which TDLib takes for the name Telegram shows.
 */
function uploadName(name: string): string {
  const own = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(-200) || "file";
  return `zuna-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}/${own}`;
}

/** The picture the app shows of a sticker: itself if it's still, its still thumbnail if not. */
function stickerPicture(sticker: TdObject): { fileId: string } | null {
  const found = attachmentsOf({ "@type": "messageSticker", sticker });
  return found?.[0] ? { fileId: found[0].fileId } : null;
}

