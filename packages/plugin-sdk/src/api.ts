// The plugin API: what `definePlugin` hands a plugin, as the app gives it (api 1). Every call
// goes to the app's broker, which checks it against what the person granted, and refuses what
// they didn't with an error saying which permission it needed. Until Zuna's first stable
// release, this may change with any nightly.

import type { Permission } from "./manifest.ts";
import type { IconName, Render } from "./view.ts";

export type Unsubscribe = () => void;

/** The plugin, as the app knows it. */
export interface PluginInfo {
  id: string;
  version: string;
  /** Whether it was verified: read by Zuna's team, and signed with the plugins' key. */
  verified: boolean;
  permissions: Permission[];
}

/** A chat, as a plugin with `conversations.read` is told of it. */
export interface ConversationRef {
  serverId: string;
  /** What the app opens it by. */
  key: string;
  /** Its group, once it has one. */
  groupId: string | null;
  name: string;
}

/** A message, as a plugin with `messages.read` is told of it. Who wrote it is the app's, from its signature. */
export interface PluginMessage {
  serverId: string;
  groupId: string;
  id: string;
  senderId: string;
  text: string;
  createdAt: number;
  editedAt: number | null;
  /** How many files came with it, which `files.attachment` reads, with `files.read`. */
  attachments: { name: string; mime: string; size: number }[];
}

/** Where a command, button or entry was used from. The chat is there only with `conversations.read`. */
export interface ChatContext {
  /** Puts text into the message box where the cursor is, in the chat that's open. */
  composer: { insert(text: string): void };
  conversation: ConversationRef | null;
  /** What followed a slash command's name, trimmed. */
  args: string;
}

export interface Settings {
  /** A setting's value, or its default from the manifest. */
  get<T = unknown>(key: string): T;
  all(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<void>;
  onChange(listener: (key: string, value: unknown) => void): Unsubscribe;
}

/** Each plugin's own store, kept sealed by the app. Reads are at once, from what was loaded. */
export interface Storage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): string[];
}

export interface Commands {
  /** Runs a command the manifest names, by its keys or as a slash command. */
  on(id: string, run: (context: ChatContext) => void | Promise<void>): Unsubscribe;
}

export interface Ui {
  toast(text: string, kind?: "info" | "error"): void;
  /** Draws every view again, for state that isn't in storage. Storage changing does it by itself. */
  refresh(): void;
  /** The plugin's section in Settings, in place of the one the manifest's settings would give. */
  settings(render: Render): void;
  /** A side panel beside the chat. */
  panel(id: string, options: { title: string; icon?: IconName; render: Render }): void;
  openPanel(id: string): void;
  closePanel(): void;
  /** A dialog, in a frame the app draws, with the plugin's name. One at a time. */
  dialog(options: { title: string; render: Render; width?: number }): void;
  closeDialog(): void;
  /** An item in the server rail, with a page of its own over the main area. */
  page(id: string, options: { title: string; icon: IconName; render: Render }): void;
  openPage(id: string): void;
  /** A button in the chat's header. */
  headerButton(id: string, options: { icon: IconName; title: string; onClick: (context: ChatContext) => void }): void;
  /** A button beside the message box. */
  composerButton(id: string, options: { icon: IconName; title: string; onClick: (context: ChatContext) => void }): void;
  /** An entry in a message's menu, and with `hover`, an action on it under the pointer too. The message comes with `messages.read`, its ids without. */
  messageAction(id: string, options: { label: string; icon: IconName; hover?: boolean; onClick: (message: PluginMessage | { serverId: string; groupId: string; id: string }) => void }): void;
  /** An entry in a chat's menu in the conversation list. */
  conversationAction(id: string, options: { label: string; icon: IconName; onClick: (conversation: ConversationRef) => void }): void;
  /** Takes away anything registered under this id. */
  remove(id: string): void;
}

/** What a filter on a message going out is given. */
export interface Draft {
  serverId: string;
  groupId: string | null;
  conversationKey: string;
  kind: "send" | "edit";
  /** The message being edited. */
  messageId?: string;
  text: string;
}

/**
 * What a filter answers: nothing to let it go as it was, a string or `{ text }` to change it, or
 * `false` to stop it. A filter that throws or takes too long is left out, and what it was asked
 * about goes as it was, unless it was registered as `required`, which holds it unsent instead.
 */
export type FilterResult = void | undefined | true | false | string | { text: string };

/** What a decoration does to a message here, and only here: what's stored, signed and searched stays as it was. */
export interface Decoration {
  /** Shown in place of its text, under a line saying which plugin did it. */
  text?: string;
  /** Hidden, with the same line, which shows it again. */
  hidden?: boolean;
  /** A small mark beside it. */
  mark?: { icon?: IconName; label: string };
  /** Drawn under it. */
  view?: import("./view.ts").ViewNode;
}

export interface Messages {
  /** Each message as it arrives or changes. Needs `messages.read`. */
  on(listener: (message: PluginMessage, isNew: boolean) => void): Unsubscribe;
  /** Changes or stops what the person sends before it's encrypted. Needs `messages.intercept`. */
  onOutgoing(filter: (draft: Draft) => FilterResult | Promise<FilterResult>, options?: { required?: boolean }): Unsubscribe;
  /** Changes how messages look here. Needs `messages.decorate`. */
  decorate(decorator: (message: PluginMessage) => Decoration | null | undefined | Promise<Decoration | null | undefined>): Unsubscribe;
  /** Needs `messages.read`. */
  history(serverId: string, groupId: string, before?: number): Promise<{ messages: PluginMessage[]; hasMore: boolean }>;
  /** Needs `messages.read`. */
  search(serverId: string, query: string, groupId?: string): Promise<PluginMessage[]>;
  /** Sends a message as the person. Needs `messages.send`. */
  send(serverId: string, conversationKey: string, text: string): Promise<void>;
  /** Needs `messages.send`. */
  edit(serverId: string, groupId: string, id: string, text: string): Promise<void>;
  /** Needs `messages.send`. */
  delete(serverId: string, groupId: string, id: string): Promise<void>;
  /** Needs `messages.send`. */
  react(serverId: string, groupId: string, id: string, emoji: string): Promise<void>;
}

export interface Activity {
  /** Asked before the app says the person is typing. `false` keeps it from going. Needs `activity.intercept`. */
  onTyping(filter: (event: { serverId: string; groupId: string }) => boolean | void | Promise<boolean | void>): Unsubscribe;
  /** Asked before the app marks messages read. `false` keeps it from going. Needs `activity.intercept`. */
  onRead(filter: (event: { serverId: string; groupId: string | null; conversationKey: string | null }) => boolean | void | Promise<boolean | void>): Unsubscribe;
  /** Asked before someone typing is shown. `false` hides it. Needs `activity.intercept`. */
  onTypingShown(filter: (event: { serverId: string; groupId: string; userId: string }) => boolean | void): Unsubscribe;
}

export interface Notifications {
  /** Shows a notification of the plugin's own. Needs `notifications`. */
  show(title: string, body: string): void;
  /** Asked before the app notifies of a message: `false` holds it back, `{ title, body }` rewords it. Needs `notifications` and `messages.read`. */
  onNotify(filter: (notification: { serverId: string; title: string; body: string; conversationKey: string }) => boolean | void | { title?: string; body?: string } | Promise<boolean | void | { title?: string; body?: string }>): Unsubscribe;
}

export interface Core {
  /** A method of the client (`server` null) or a server's session, which the table in the SDK classifies. */
  call<T = unknown>(server: string | null, method: string, ...args: unknown[]): Promise<T>;
  /** The core's events of a kind the plugin's permissions cover. */
  on(type: string, listener: (event: Record<string, unknown>) => void): Unsubscribe;
}

export interface Voice {
  /** Who's in voice where. Needs `voice.read`. */
  members(serverId: string): Promise<unknown[]>;
  /** Needs `voice.control`. */
  join(serverId: string, channelId: string): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
}

export interface Response {
  status: number;
  headers: Record<string, string>;
  text(): string;
  json<T = unknown>(): T;
  bytes(): Uint8Array;
}

export interface Net {
  /** Reaches only the hosts the manifest names, over HTTPS, with nothing of the account. Needs `network`. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<Response>;
}

export interface Files {
  /** Shows the app's own dialog, and gives the one file the person picked, or null. */
  open(options?: { title?: string; extensions?: string[] }): Promise<{ name: string; bytes: Uint8Array } | null>;
  /** Asks the person where to save, and saves there. */
  save(name: string, bytes: Uint8Array | string): Promise<boolean>;
  /** A file that came with a message. Needs `files.read`. */
  attachment(serverId: string, groupId: string, messageId: string, index: number): Promise<{ name: string; mime: string; bytes: Uint8Array }>;
  /** A file of the plugin's own package, under assets/. */
  asset(path: string): Promise<Uint8Array>;
}

export interface Clipboard {
  /** Needs `clipboard.read`. */
  read(): Promise<string>;
  /** Needs `clipboard.write`. */
  write(text: string): Promise<void>;
}

/** What a plugin is handed. */
export interface Zuna {
  readonly plugin: PluginInfo;
  readonly settings: Settings;
  readonly storage: Storage;
  readonly commands: Commands;
  readonly ui: Ui;
  readonly messages: Messages;
  readonly activity: Activity;
  readonly notifications: Notifications;
  readonly core: Core;
  readonly voice: Voice;
  readonly net: Net;
  readonly files: Files;
  readonly clipboard: Clipboard;
  /** Lines in the developer's log, beside console's. */
  log(...values: unknown[]): void;
}
