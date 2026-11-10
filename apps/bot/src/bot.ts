// A bot's account, run for the bot's code: the client core underneath, as in every app,
// and on top of it Telegram's Bot API, method by method. Whoever writes a bot never
// touches MLS: what its code gets has been decrypted here, on the machine the bot runs
// on, and what it sends is encrypted here.
//
// It leaves out calls, voice and link previews. A bot fetching every link it's sent
// would tell those sites where it runs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, ZunaClient, type Attachment, type ConversationView, type CoreEvent, type MessageBody, type MessageButton, type MessageView, type ServerSession, type UserView } from "@zuna/core";
import { randomBytes } from "@zuna/crypto";
import { markupOf, ParseError, toTelegram } from "./format";
import { DiskDbProvider, dataFolder, deviceKey, loadCrypto, pinServer, sealedFetch, writePrivate } from "./host";
import { ApiFailure, type Params, flag, integer, required, structured, text } from "./params";
import { BotStore, type StoredFile } from "./store";
import { Updates } from "./updates";

const DAY_MS = 24 * 3600 * 1000;
/** How long a method waits for the server to take what it sent. */
const SEND_WAIT_MS = 60_000;

/** What Telegram has and Zuna doesn't, by the methods that are for it. Each is refused by name. */
const NO_PLACE: [what: string, methods: RegExp][] = [
  ["payments", /invoice|shippingquery|precheckoutquery|starpayment|startransactions|paidmedia|gift|userstarsubscription/i],
  ["inline mode", /inlinequery|webappquery|preparedinlinemessage|^answerwebapp/i],
  ["stickers", /sticker/i],
  ["games", /game/i],
  ["topics", /forumtopic/i],
];

type Json = Record<string, unknown>;

interface Chat {
  groupId: string;
  kind: "dm" | "group" | "channel";
  title: string;
  description: string;
  peerId: string | null;
  members: ConversationView["members"];
}

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export class Bot {
  readonly store: BotStore;
  readonly updates: Updates;
  readonly token: string;
  private client!: ZunaClient;
  private serverId = "";
  private readonly db: DiskDbProvider;
  private handling: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: CoreEvent) => void>();
  private users = new Map<string, UserView>();
  private chats = new Map<string, Chat>();

  private constructor(dataDir: string) {
    this.db = new DiskDbProvider(dataDir);
    this.store = new BotStore(join(dataDir, "bot.db"));
    this.token = readFileSync(join(dataDir, "token"), "utf8").trim();
    this.updates = new Updates(this.store, (method, params) => this.call(method, params));
  }

  // --- Setting up and starting ---

  /** Whether a folder holds a bot that's been set up. */
  static isSetUp(dataDir: string): boolean {
    return existsSync(join(dataDir, "token"));
  }

  /**
   * Signs the bot up through its setup link, which works once: its keys are made here,
   * on the machine that will run it, so not even its owner holds them. Its recovery key
   * goes in a file beside its data, the only way back if the rest of the folder is lost.
   */
  static async setUp(dataDir: string, link: string): Promise<{ username: string; server: string }> {
    loadCrypto();
    dataFolder(dataDir);
    if (Bot.isSetUp(dataDir)) throw new Error(`${dataDir} already holds a bot. Each bot has a folder of its own.`);
    const db = new DiskDbProvider(dataDir);
    const client = new ZunaClient({ db, deviceKey: deviceKey(dataDir), deviceName: "zuna-bot", onEvent: () => undefined, channels: true, pinServer, sealedFetch });
    await client.open();
    try {
      const { serverId, recoveryKey } = await client.registerBot(link);
      const entry = client.listServers().find((server) => server.id === serverId)!;
      writePrivate(join(dataDir, "recovery-key.txt"), `Server: ${entry.address}\nUsername: ${entry.username}\nRecovery key: ${recoveryKey}\n`);
      // The bot is the first one its own table of numbers knows, and its token starts with that number, as Telegram's do.
      const store = new BotStore(join(dataDir, "bot.db"));
      const number = store.userNumber(entry.userId);
      store.close();
      writePrivate(join(dataDir, "token"), `${number}:${base64Url(randomBytes(26))}\n`);
      return { username: entry.username, server: entry.url };
    } finally {
      client.stop();
      db.closeAll();
    }
  }

  /** Opens a bot that's been set up, and connects it. */
  static async open(dataDir: string): Promise<Bot> {
    loadCrypto();
    if (!Bot.isSetUp(dataDir)) throw new Error(`There's no bot in ${dataDir} yet. Set one up first: zuna-bot init "<setup link>"`);
    const bot = new Bot(dataDir);
    bot.client = new ZunaClient({
      db: bot.db,
      deviceKey: deviceKey(dataDir),
      deviceName: "zuna-bot",
      onEvent: (event) => bot.onEvent(event),
      channels: true,
      pinServer,
      sealedFetch,
    });
    await bot.client.open();
    const server = bot.client.listServers()[0];
    if (!server) throw new Error(`The bot's account in ${dataDir} couldn't be opened.`);
    bot.serverId = server.id;
    bot.updates.start();
    return bot;
  }

  /** Whether the bot is connected to its server and caught up. */
  get online(): boolean {
    return this.session.getConnectionState() === "online";
  }

  get username(): string {
    return this.session.getSelf().username;
  }

  async close(): Promise<void> {
    this.updates.stop();
    await this.handling.catch(() => undefined);
    this.client.stop();
    // Whatever was still being written gets its moment before the files close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.db.closeAll();
    this.store.close();
  }

  private get session(): ServerSession {
    return this.client.session(this.serverId);
  }

  // --- What the core says happened ---

  private onEvent(event: CoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
    // One at a time, in the order they came, so that updates are in order too.
    this.handling = this.handling.then(() => this.handle(event)).catch((error) => console.warn("[zuna-bot] couldn't take in an event:", error));
  }

  private async handle(event: CoreEvent): Promise<void> {
    switch (event.type) {
      case "users":
        this.users.clear();
        break;
      case "conversations":
      case "channels":
        this.chats.clear();
        this.noteChats();
        break;
      case "message":
        this.noteMessage(event.message);
        break;
      case "button":
        if (this.session.hearsChat(event.groupId)) {
          const message = await this.session.messageById(event.groupId, event.messageId);
          this.updates.push("callback_query", {
            id: event.id,
            from: this.user(event.userId),
            ...(message ? { message: this.message(message) } : {}),
            chat_instance: String(this.chatId(event.groupId)),
            data: event.data,
          });
        }
        break;
      case "signed_out":
        console.warn(`[zuna-bot] the server ended this bot's session (${event.reason}). What's in its folder is kept.`);
        break;
      case "security":
        console.warn(`[zuna-bot] ${event.message}`);
        break;
    }
  }

  /** Tells the bot's code of a message it hasn't heard of, or of an edit to one it has. */
  private noteMessage(view: MessageView): void {
    if (view.senderId === this.session.getSelf().userId || view.status !== "sent" || view.seq === null || view.system || view.deletedAt !== null) return;
    // A private bot hears its owner, and whoever is in a group with it.
    if (!this.session.hearsChat(view.groupId)) return;
    const known = this.store.told(view.groupId, view.id);
    if (!known.told) {
      this.store.setTold(view.groupId, view.id, view.editedAt);
      // What's caught up on long after it was said is nothing to answer now, as Telegram lets go of updates after a day.
      if (Date.now() - view.createdAt < DAY_MS) this.updates.push("message", this.message(view));
    } else if (view.editedAt !== null && view.editedAt !== known.editedAt) {
      this.store.setTold(view.groupId, view.id, view.editedAt);
      this.updates.push("edited_message", this.message(view));
    }
  }

  /** Tells the bot's code which groups and channels it came into, and which it's out of. */
  private noteChats(): void {
    const now = new Set([...this.chatList().values()].filter((chat) => chat.kind !== "dm").map((chat) => chat.groupId));
    const before = new Set(this.store.joinedChats());
    const self = this.user(this.session.getSelf().userId);
    const date = Math.floor(Date.now() / 1000);
    const change = (groupId: string, from: string, to: string) => {
      const chat = this.chats.get(groupId);
      // Who brought it in or took it out isn't something a bot is told for certain, so it's the group's first admin, or the bot.
      const actor = chat?.members.find((member) => member.role === "admin")?.userId;
      this.updates.push("my_chat_member", {
        chat: chat ? this.chatOf(chat) : { id: this.store.chatNumber(groupId), type: "group", title: this.store.get(`title/${groupId}`) ?? "" },
        from: actor ? this.user(actor) : self,
        date,
        old_chat_member: { user: self, status: from },
        new_chat_member: { user: self, status: to },
      });
    };
    for (const groupId of now) {
      this.store.set(`title/${groupId}`, this.chats.get(groupId)?.title ?? "");
      if (before.has(groupId)) continue;
      this.store.setJoined(groupId, true);
      change(groupId, "left", "member");
    }
    for (const groupId of before) {
      if (now.has(groupId)) continue;
      this.store.setJoined(groupId, false);
      change(groupId, "member", "left");
    }
  }

  // --- People and chats, as Telegram shapes them ---

  private userList(): Map<string, UserView> {
    if (this.users.size === 0) for (const user of this.session.getUsers()) this.users.set(user.id, user);
    return this.users;
  }

  private chatList(): Map<string, Chat> {
    if (this.chats.size > 0) return this.chats;
    const add = (conversation: ConversationView) => {
      // A chat is one the bot is in once it holds its keys, which is when it can read what it's called too.
      if (!conversation.groupId || conversation.removed || !conversation.ready || !this.session.holdsKeys(conversation.groupId)) return;
      const { groupId, kind, title, description, peerId, members } = conversation;
      this.chats.set(groupId, { groupId, kind, title, description, peerId, members });
    };
    for (const conversation of this.session.getConversations()) add(conversation);
    for (const channel of this.session.getChannels()) if (channel.conversation) add({ ...channel.conversation, title: channel.name || "Channel", description: channel.topic });
    return this.chats;
  }

  private user(userId: string): Json {
    const user = this.userList().get(userId);
    return {
      id: this.store.userNumber(userId),
      is_bot: !!user?.bot,
      first_name: user?.displayName || user?.username || "Deleted account",
      ...(user?.username ? { username: user.username } : {}),
    };
  }

  private chatId(groupId: string): number {
    const chat = this.chatList().get(groupId);
    return chat?.kind === "dm" && chat.peerId ? this.store.userNumber(chat.peerId) : this.store.chatNumber(groupId);
  }

  private chatOf(chat: Chat): Json {
    if (chat.kind === "dm" && chat.peerId) {
      const { is_bot: _, ...peer } = this.user(chat.peerId);
      return { ...peer, type: "private" };
    }
    return { id: this.store.chatNumber(chat.groupId), type: chat.kind === "channel" ? "supergroup" : "group", title: chat.title };
  }

  /** The chat a method names by its number: a person's for a direct message, or a negative one for a group or channel. */
  private chatFor(params: Params): Chat & { key: string } {
    const id = integer(params, "chat_id");
    if (id === undefined || id === 0) throw new ApiFailure(400, "Bad Request: chat not found");
    if (id > 0) {
      const userId = this.store.userId(id);
      if (!userId) throw new ApiFailure(400, "Bad Request: chat not found");
      const chat = [...this.chatList().values()].find((item) => item.kind === "dm" && item.peerId === userId);
      // Someone writes to a bot before it can write to them.
      if (!chat) throw new ApiFailure(403, "Forbidden: bot can't initiate conversation with a user");
      return { ...chat, key: `user:${userId}` };
    }
    const groupId = this.store.chatGroup(id);
    const chat = groupId ? this.chatList().get(groupId) : undefined;
    if (!groupId) throw new ApiFailure(400, "Bad Request: chat not found");
    if (!chat) throw new ApiFailure(403, "Forbidden: bot is not a member of the group chat");
    return { ...chat, key: `group:${groupId}` };
  }

  /** The message a method names by its number, which has to be in the chat it names. */
  private messageFor(params: Params, chat: Chat): { groupId: string; id: string } {
    const stored = this.store.message(required(integer(params, "message_id"), "message_id"));
    if (!stored || stored.groupId !== chat.groupId) throw new ApiFailure(400, "Bad Request: message not found");
    return stored;
  }

  private file(attachment: Attachment): Json {
    const { fileId, key, prefix, chunks, mime, name, size } = attachment;
    this.store.rememberFile({ fileId, key, prefix, chunks, mime, name, size });
    return { file_id: fileId, file_unique_id: fileId, file_size: size };
  }

  /** What a message holds besides its text: its first file, by what kind it is, or a place. */
  private contents(view: MessageView): Json {
    const out: Json = {};
    const attachment = view.attachments[0];
    if (attachment?.fileId) {
      const file = this.file(attachment);
      const named = { ...file, file_name: attachment.name, mime_type: attachment.mime };
      const sized = attachment.width && attachment.height ? { width: Math.round(attachment.width), height: Math.round(attachment.height) } : {};
      const lasting = attachment.duration !== undefined ? { duration: Math.round(attachment.duration) } : {};
      if (attachment.voice) out.voice = { ...file, mime_type: attachment.mime, duration: Math.round(attachment.duration ?? 0) };
      else if (attachment.round) out.video_note = { ...file, length: Math.round(attachment.width ?? 0), duration: Math.round(attachment.duration ?? 0) };
      else if (/^image\/(?!gif)/.test(attachment.mime) && attachment.width && attachment.height) out.photo = [{ ...file, ...sized }];
      else if (attachment.mime.startsWith("video/")) out.video = { ...named, width: 0, height: 0, duration: 0, ...sized, ...lasting };
      else if (attachment.mime.startsWith("audio/")) out.audio = { ...named, duration: 0, ...lasting };
      else out.document = named;
    }
    if (view.location) out.location = { latitude: view.location.lat, longitude: view.location.lon, ...(view.location.accuracy !== undefined ? { horizontal_accuracy: view.location.accuracy } : {}) };
    return out;
  }

  /** A message as Telegram's API gives one. */
  private message(view: MessageView): Json {
    const chat = this.chatList().get(view.groupId);
    const formatted = toTelegram(view.text);
    const contents = this.contents(view);
    const captioned = Object.keys(contents).some((key) => key !== "location");
    const out: Json = {
      message_id: this.store.messageNumber(view.groupId, view.id),
      date: Math.floor(view.createdAt / 1000),
      chat: chat ? this.chatOf(chat) : { id: this.store.chatNumber(view.groupId), type: "group", title: "" },
      from: this.user(view.senderId),
      ...contents,
    };
    if (formatted.text) {
      out[captioned ? "caption" : "text"] = formatted.text;
      if (formatted.entities.length > 0) out[captioned ? "caption_entities" : "entities"] = formatted.entities;
    }
    if (view.editedAt !== null) out.edit_date = Math.floor(view.editedAt / 1000);
    if (view.reply && !view.reply.deleted && view.reply.senderId) {
      out.reply_to_message = {
        message_id: this.store.messageNumber(view.groupId, view.reply.id),
        date: 0,
        chat: out.chat,
        from: this.user(view.reply.senderId),
        ...(view.reply.text ? { text: toTelegram(view.reply.text).text } : {}),
      };
    }
    if (view.forwarded) {
      const date = Math.floor(view.createdAt / 1000);
      out.forward_origin = view.forwarded.userId ? { type: "user", date, sender_user: this.user(view.forwarded.userId) } : { type: "hidden_user", date, sender_user_name: "" };
    }
    if (view.buttons.length > 0) {
      out.reply_markup = { inline_keyboard: view.buttons.map((row) => row.map((button) => (button.url !== undefined ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data ?? "" }))) };
    }
    return out;
  }

  // --- Sending ---

  /** The buttons a method asks for, or null if it asks for none. What Zuna has no kind of button for is refused. */
  private buttons(params: Params): MessageButton[][] | null {
    const markup = structured(params, "reply_markup");
    const keyboard = markup && typeof markup === "object" ? (markup as Json).inline_keyboard : undefined;
    // A keyboard under the message box, or forcing a reply, are things Zuna hasn't got. The message goes without.
    if (!Array.isArray(keyboard)) return null;
    const rows: MessageButton[][] = [];
    for (const row of keyboard) {
      if (!Array.isArray(row)) throw new ApiFailure(400, "Bad Request: can't parse inline keyboard button: InlineKeyboardButton must be an Object");
      const buttons: MessageButton[] = [];
      for (const button of row as Json[]) {
        const label = typeof button?.text === "string" ? button.text : "";
        if (!label) throw new ApiFailure(400, "Bad Request: can't parse inline keyboard button: Text buttons are unallowed in the inline keyboard");
        if (typeof button.url === "string") buttons.push({ text: label, url: button.url });
        else if (typeof button.callback_data === "string") buttons.push({ text: label, data: button.callback_data });
        else throw new ApiFailure(400, "Bad Request: a button here opens a link or sends its data back to the bot, and this one does neither");
      }
      if (buttons.length > 0) rows.push(buttons);
    }
    return rows.length > 0 ? rows : null;
  }

  /** A message's text and what goes with it, from what a method was called with. */
  private body(params: Params, chat: Chat, textName: "text" | "caption"): MessageBody {
    const raw = text(params, textName) ?? "";
    const markup = markupOf(raw, params.parse_mode, structured(params, textName === "text" ? "entities" : "caption_entities"));
    const body: MessageBody = { text: markup };
    const emotes = this.session.emotesIn(markup);
    if (Object.keys(emotes).length > 0) body.emotes = emotes;
    const mentions = this.mentionsIn(markup);
    if (mentions.length > 0) body.mentions = mentions;
    const reply = structured(params, "reply_parameters");
    const replyTo = integer(params, "reply_to_message_id") ?? (reply && typeof reply === "object" ? integer(reply as Params, "message_id") : undefined);
    if (replyTo !== undefined) {
      const target = this.store.message(replyTo);
      if (target?.groupId === chat.groupId) body.replyTo = target.id;
      else if (!flag(params, "allow_sending_without_reply") && !(reply && flag(reply as Params, "allow_sending_without_reply"))) throw new ApiFailure(400, "Bad Request: message to be replied not found");
    }
    const buttons = this.buttons(params);
    if (buttons) body.buttons = buttons;
    return body;
  }

  private mentionsIn(markup: string): string[] {
    const names = new Map([...this.userList().values()].filter((user) => user.username).map((user) => [user.username.toLowerCase(), user.id]));
    const found = new Set<string>();
    for (const match of markup.matchAll(/(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})/g)) {
      const id = names.get(match[1]!.toLowerCase()) ?? names.get(match[1]!.replace(/[.,:;!?]+$/, "").toLowerCase());
      if (id) found.add(id);
    }
    return [...found];
  }

  /** Waits for the server to have a message this bot is sending, and gives it as it then is. */
  private sent(groupId: string, id: string): Promise<MessageView> {
    return new Promise((resolve, reject) => {
      const finish = (view: MessageView | null, failure?: ApiFailure) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        if (view) resolve(view);
        else reject(failure ?? new ApiFailure(500, "Internal Server Error: the message is still waiting to be sent"));
      };
      const look = (view: MessageView | null | undefined) => {
        if (view?.id !== id) return;
        if (view.status === "sent" && view.seq !== null) finish(view);
        else if (view.status === "failed") finish(null, new ApiFailure(400, "Bad Request: the server didn't take the message"));
      };
      const listener = (event: CoreEvent) => {
        if (event.type === "message" || event.type === "message_moved") look(event.message);
      };
      const timer = setTimeout(() => finish(null), SEND_WAIT_MS);
      this.listeners.add(listener);
      // It may have gone already, before anyone was listening.
      void this.session.messageById(groupId, id).then(look, () => undefined);
    });
  }

  private async sendText(params: Params): Promise<Json> {
    const chat = this.chatFor(params);
    const body = this.body(params, chat, "text");
    if (!body.text) throw new ApiFailure(400, "Bad Request: message text is empty");
    const view = this.session.sendMessage(chat.key, body);
    return this.message(await this.sent(chat.groupId, view.id));
  }

  /** Sends a file, uploaded with the call or one the bot was sent before, by its ID. */
  private async sendFile(params: Params, field: string, fallbackName: string): Promise<Json> {
    const chat = this.chatFor(params);
    const body = this.body(params, chat, "caption");
    const given = params[field];
    let blob: Blob;
    let name = fallbackName;
    let mime = "";
    if (given instanceof Blob) {
      blob = given;
      if (given instanceof File && given.name) name = given.name;
      mime = given.type;
    } else if (typeof given === "string" && /^https?:\/\//i.test(given)) {
      throw new ApiFailure(400, "Bad Request: zuna-bot doesn't fetch files from addresses, which would tell that site where the bot runs. Upload the file with the call");
    } else if (typeof given === "string" && this.store.file(given)) {
      const stored = this.store.file(given)!;
      blob = await this.session.downloadFile(stored);
      ({ name, mime } = stored);
    } else {
      throw new ApiFailure(400, `Bad Request: there is no ${field} in the request`);
    }
    // A library that doesn't say what a file is calls it a stream of bytes, and its name says more.
    mime = (mime && mime !== "application/octet-stream" ? mime : mimeOf(name)).split(";")[0]!.trim();
    const size = mime.startsWith("image/") ? imageSize(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer())) : null;
    const id = await this.session.sendWithAttachments(chat.key, [{ blob, name, mime, ...(size ?? {}), ...(field === "voice" ? { voice: true } : {}) }], body);
    return this.message(await this.sent(chat.groupId, id));
  }

  private async editText(params: Params, keepText: boolean): Promise<Json> {
    if (params.inline_message_id !== undefined) throw new ApiFailure(400, "Bad Request: Zuna has no inline mode, so there are no inline messages to edit");
    const chat = this.chatFor(params);
    const target = this.messageFor(params, chat);
    const current = await this.session.messageById(target.groupId, target.id);
    if (!current || current.senderId !== this.session.getSelf().userId || current.deletedAt !== null) throw new ApiFailure(400, "Bad Request: message can't be edited");
    // Without buttons named again, an edit takes them away, as on Telegram.
    const buttons = this.buttons(params);
    if (keepText) {
      this.session.editMessage(target.groupId, target.id, current.text, current.emotes, current.mentions, buttons);
    } else {
      const body = this.body({ ...params, reply_to_message_id: undefined, reply_parameters: undefined }, chat, "text");
      if (!body.text) throw new ApiFailure(400, "Bad Request: message text is empty");
      this.session.editMessage(target.groupId, target.id, body.text, body.emotes ?? {}, body.mentions ?? [], buttons);
    }
    await this.session.flushOutbox();
    const edited = await this.session.messageById(target.groupId, target.id);
    if (!edited || edited.status === "failed") throw new ApiFailure(400, "Bad Request: the server didn't take the edit");
    return this.message(edited);
  }

  private member(chat: Chat, userId: string): Json {
    const listed = chat.kind === "dm" ? userId === chat.peerId || userId === this.session.getSelf().userId : chat.members.some((member) => member.userId === userId);
    const admin = chat.kind !== "dm" && chat.members.find((member) => member.userId === userId)?.role === "admin";
    if (!listed) return { user: this.user(userId), status: "left" };
    if (!admin) return { user: this.user(userId), status: "member" };
    return { user: this.user(userId), status: "administrator", can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true, can_change_info: true, can_promote_members: true, can_manage_video_chats: false, can_post_stories: false, can_edit_stories: false, can_delete_stories: false };
  }

  private self(): UserView {
    const self = this.userList().get(this.session.getSelf().userId);
    if (!self) throw new ApiFailure(500, "Internal Server Error: the bot hasn't caught up with its server yet");
    return self;
  }

  // --- Methods ---

  /** Runs one of the API's methods, by Telegram's name for it. */
  async call(method: string, params: Params): Promise<unknown> {
    const name = method.toLowerCase();
    try {
      return await this.run(name, params);
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (error instanceof ParseError) throw new ApiFailure(400, error.message);
      if (error instanceof ApiError) {
        const retry = error.status === 429 ? { retry_after: 1 } : undefined;
        if (error.status === 429) throw new ApiFailure(429, "Too Many Requests: retry after 1", retry);
        if (error.status === 403) throw new ApiFailure(403, `Forbidden: ${error.message}`);
        if (error.status === 0) throw new ApiFailure(502, "Bad Gateway: the bot's server couldn't be reached");
        throw new ApiFailure(400, `Bad Request: ${error.message}`);
      }
      throw new ApiFailure(400, `Bad Request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async run(name: string, params: Params): Promise<unknown> {
    switch (name) {
      case "getme": {
        const self = this.self();
        return { ...this.user(self.id), is_bot: true, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
      }
      case "logout":
      case "close":
        return true;

      case "getupdates":
        return this.updates.get(params);
      case "setwebhook":
        return this.updates.setWebhook(params);
      case "deletewebhook":
        return this.updates.deleteWebhook(params);
      case "getwebhookinfo":
        return this.updates.info();

      case "sendmessage":
        return this.sendText(params);
      case "sendphoto":
        return this.sendFile(params, "photo", "photo.jpg");
      case "senddocument":
        return this.sendFile(params, "document", "file");
      case "sendvideo":
        return this.sendFile(params, "video", "video.mp4");
      case "sendaudio":
        return this.sendFile(params, "audio", "audio.mp3");
      case "sendvoice":
        return this.sendFile(params, "voice", "voice.ogg");
      case "sendanimation":
        return this.sendFile(params, "animation", "animation.gif");
      case "sendchataction": {
        // Zuna has the one: someone is typing.
        this.session.sendTyping(this.chatFor(params).groupId);
        return true;
      }

      case "editmessagetext":
        return this.editText(params, false);
      case "editmessagereplymarkup":
        return this.editText(params, true);
      case "deletemessage": {
        const chat = this.chatFor(params);
        await this.session.deleteMessage(chat.groupId, this.messageFor(params, chat).id);
        return true;
      }
      case "pinchatmessage":
      case "unpinchatmessage": {
        const chat = this.chatFor(params);
        await this.session.setPinned(chat.groupId, this.messageFor(params, chat).id, name === "pinchatmessage");
        return true;
      }

      case "getchat": {
        const chat = this.chatFor(params);
        const bio = chat.kind === "dm" && chat.peerId ? this.userList().get(chat.peerId)?.bio : "";
        return { ...this.chatOf(chat), ...(chat.description ? { description: chat.description } : {}), ...(bio ? { bio } : {}), accent_color_id: 0, max_reaction_count: 0 };
      }
      case "getchatmember": {
        const chat = this.chatFor(params);
        const userId = this.store.userId(required(integer(params, "user_id"), "user_id"));
        if (!userId) throw new ApiFailure(400, "Bad Request: user not found");
        return this.member(chat, userId);
      }
      case "getchatadministrators": {
        const chat = this.chatFor(params);
        return chat.members.filter((member) => member.role === "admin").map((member) => this.member(chat, member.userId));
      }
      case "getchatmembercount":
      case "getchatmemberscount": {
        const chat = this.chatFor(params);
        return chat.kind === "dm" ? 2 : chat.members.length;
      }
      case "leavechat": {
        const chat = this.chatFor(params);
        if (chat.kind !== "group") throw new ApiFailure(400, "Bad Request: only a group can be left. A channel is taken away by a server admin");
        await this.session.leaveGroup(chat.groupId);
        return true;
      }

      case "getfile": {
        const stored = this.store.file(required(text(params, "file_id"), "file_id"));
        if (!stored) throw new ApiFailure(400, "Bad Request: invalid file_id");
        return { file_id: stored.fileId, file_unique_id: stored.fileId, file_size: stored.size, file_path: `files/${stored.fileId}/${encodeURIComponent(stored.name || "file")}` };
      }

      case "setmycommands": {
        const commands = structured(params, "commands");
        if (!Array.isArray(commands)) throw new ApiFailure(400, "Bad Request: commands is required");
        const listed = (commands as Json[]).map((item) => ({ command: String(item?.command ?? "").replace(/^\//, ""), description: String(item?.description ?? "") }));
        if (listed.some((item) => !/^[a-z0-9_]{1,32}$/.test(item.command) || item.description.length < 1 || item.description.length > 256)) {
          throw new ApiFailure(400, "Bad Request: BOT_COMMAND_INVALID");
        }
        await this.session.updateProfile({ commands: listed });
        return true;
      }
      case "deletemycommands":
        await this.session.updateProfile({ commands: [] });
        return true;
      case "getmycommands":
        return this.self().commands;
      case "setmyname":
        await this.session.updateProfile({ displayName: text(params, "name") || this.username });
        return true;
      case "getmyname":
        return { name: this.self().displayName };
      case "setmydescription":
      case "setmyshortdescription":
        await this.session.updateProfile({ bio: text(params, name === "setmydescription" ? "description" : "short_description") ?? "" });
        return true;
      case "getmydescription":
        return { description: this.self().bio };
      case "getmyshortdescription":
        return { short_description: this.self().bio };

      case "answercallbackquery":
        // A press shows nothing here, so there's nowhere for an answer's text to go.
        return true;
    }
    for (const [what, methods] of NO_PLACE) {
      if (methods.test(name)) throw new ApiFailure(400, `Bad Request: Zuna has no ${what}, so zuna-bot has no ${name}`);
    }
    throw new ApiFailure(404, "Not Found: method not found");
  }

  /** A file the bot's code asked for with getFile, fetched and opened here. */
  async download(fileId: string): Promise<{ blob: Blob; file: StoredFile } | null> {
    const file = this.store.file(fileId);
    return file ? { blob: await this.session.downloadFile(file), file } : null;
  }
}

const MIMES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  zip: "application/zip",
};

function mimeOf(name: string): string {
  return MIMES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** How large a picture is, read from the start of its file, for the kinds apps show: PNG, GIF, WebP and JPEG. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => bytes.length >= offset + value.length && [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes.length >= 24 && bytes[0] === 0x89 && tag(1, "PNG")) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && tag(0, "GIF8")) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8X")) return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
    if (tag(12, "VP8 ")) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (tag(12, "VP8L")) {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // A JPEG's size is in its first frame header, after whatever segments come before it.
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}
