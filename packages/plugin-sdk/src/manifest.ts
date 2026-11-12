// A plugin's manifest, plugin.json: what the app knows of a plugin without running it, and
// everything it can ever ask for (docs/PLUGINS.md). The app parses it again itself, in
// apps/desktop/src/plugins/manifest.rs, and refuses anything this file would.

/** The plugin API's version, which a plugin names as `api`. An app runs only plugins made for its own. */
export const API_VERSION = 1;

/** Everything a plugin can be granted, worst first, as the install dialog lists them. */
export const PERMISSIONS = [
  { id: "messages.read", told: "Reads your messages", strong: true },
  { id: "messages.send", told: "Writes and deletes messages as you", strong: true },
  { id: "network", told: "Contacts the internet", strong: true },
  { id: "files.read", told: "Reads files and photos sent to you", strong: false },
  { id: "messages.intercept", told: "Changes what you send before it's encrypted", strong: false },
  { id: "activity.intercept", told: "Changes what others learn of your activity", strong: false },
  { id: "messages.decorate", told: "Changes how messages are shown to you", strong: false },
  { id: "notifications", told: "Shows and hides notifications", strong: false },
  { id: "clipboard.read", told: "Reads your clipboard", strong: false },
  { id: "clipboard.write", told: "Writes to your clipboard", strong: false },
  { id: "voice.control", told: "Joins, leaves and mutes voice for you", strong: false },
  { id: "voice.read", told: "Sees who's in voice", strong: false },
  { id: "users.read", told: "Sees the people on your servers", strong: false },
  { id: "conversations.read", told: "Sees your chats and who's in them", strong: false },
  { id: "servers.read", told: "Sees which servers you're on", strong: false },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["id"];

/** A setting the app draws itself, in a section of its own in Settings. */
export type SettingSpec =
  | { key: string; type: "switch"; label: string; hint?: string; default?: boolean }
  | { key: string; type: "select"; label: string; hint?: string; choices: string[]; default?: string }
  | { key: string; type: "text"; label: string; hint?: string; placeholder?: string; default?: string }
  | { key: string; type: "slider"; label: string; hint?: string; default?: number };

/** A command, run by its keys, or typed as `/slash` in the message box. */
export interface CommandSpec {
  id: string;
  title: string;
  /** One keystroke as GPUI writes it, such as `ctrl-shift-t`. Bound only if nothing else has it. */
  keys?: string;
  /** Typed as `/name` in the message box, with what follows it as the command's argument. */
  slash?: string;
}

/** A theme: values for the app's color tokens, each `#rrggbb` or `#rrggbbaa`. */
export interface ThemeSpec {
  id: string;
  name: string;
  colors: Partial<Record<ThemeToken, string>>;
}

/** The tokens a theme may set (apps/desktop/src/theme.rs). */
export const THEME_TOKENS = [
  "bg0", "bg1", "bg2", "bg3", "bg4", "bg5", "bgChat", "line", "lineStrong", "hover", "hoverStrong",
  "text1", "text2", "text3", "accent", "accentHover", "onAccent", "accentSoft", "accentText",
  "bubbleOwn", "bubbleOwnText", "bubbleOther", "bubbleMeta", "link", "green", "red", "amber",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Manifest {
  manifest: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  license: string;
  source?: string;
  icon?: string;
  /** The script, `main.js`. A plugin that's only a theme has none. */
  main?: string;
  api: number;
  /** The app's build number, as updates compare them. */
  minBuild?: number;
  permissions: Permission[];
  /** The hosts `network` reaches, by name. */
  hosts?: string[];
  contributes?: {
    settings?: SettingSpec[];
    commands?: CommandSpec[];
    themes?: ThemeSpec[];
  };
}

/** The largest a package may be. */
export const MAX_PACKAGE = 8 << 20;

const ID = /^[a-z0-9-]{3,40}$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/;
const COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ASSET = /^assets\/[a-zA-Z0-9_.\/-]{1,200}$/;

/** Everything wrong with a manifest, as the app would refuse it: an empty list when nothing is. */
export function checkManifest(value: unknown): string[] {
  const problems: string[] = [];
  const fail = (problem: string) => problems.push(problem);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["plugin.json isn't an object."];
  const m = value as Record<string, unknown>;
  const known = new Set(["manifest", "id", "name", "version", "description", "author", "license", "source", "icon", "main", "api", "minBuild", "permissions", "hosts", "contributes"]);
  for (const key of Object.keys(m)) if (!known.has(key)) fail(`plugin.json has "${key}", which a manifest doesn't.`);
  if (m.manifest !== 1) fail(`"manifest" is 1.`);
  if (typeof m.id !== "string" || !ID.test(m.id)) fail(`"id" is 3 to 40 lower-case letters, digits and hyphens.`);
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 40) fail(`"name" is 1 to 40 characters.`);
  if (typeof m.version !== "string" || !VERSION.test(m.version)) fail(`"version" is MAJOR.MINOR.PATCH.`);
  if (typeof m.description !== "string" || m.description.length > 300) fail(`"description" is at most 300 characters.`);
  const author = m.author as Record<string, unknown> | undefined;
  if (typeof author !== "object" || author === null || typeof author.name !== "string" || !author.name.trim() || author.name.length > 60) fail(`"author" has a "name".`);
  else if (author.url !== undefined && (typeof author.url !== "string" || !author.url.startsWith("https://"))) fail(`"author.url" is an https:// address.`);
  if (typeof m.license !== "string" || !m.license.trim() || m.license.length > 60) fail(`"license" names one, as SPDX does.`);
  if (m.source !== undefined && (typeof m.source !== "string" || !m.source.startsWith("https://"))) fail(`"source" is an https:// address.`);
  if (m.icon !== undefined && (typeof m.icon !== "string" || !ASSET.test(m.icon) || m.icon.includes(".."))) fail(`"icon" is a file under assets/.`);
  if (m.main !== undefined && m.main !== "main.js") fail(`"main" is main.js, when there is one.`);
  if (m.api !== API_VERSION) fail(`"api" is ${API_VERSION}, the plugin API this SDK is for.`);
  if (m.minBuild !== undefined && (!Number.isInteger(m.minBuild) || (m.minBuild as number) < 0)) fail(`"minBuild" is a build number.`);
  const permissions = m.permissions;
  const ids = new Set<string>(PERMISSIONS.map((p) => p.id));
  if (!Array.isArray(permissions)) fail(`"permissions" is a list, empty if it needs none.`);
  else {
    for (const p of permissions) if (typeof p !== "string" || !ids.has(p)) fail(`"${String(p)}" isn't a permission.`);
    if (new Set(permissions).size !== permissions.length) fail(`"permissions" names one twice.`);
    if (permissions.includes("messages.decorate") && !permissions.includes("messages.read")) fail(`"messages.decorate" needs "messages.read", as a decoration is made from the message.`);
    if (permissions.length > 0 && m.main === undefined) fail(`A plugin with no main.js asks for no permissions.`);
  }
  const hosts = m.hosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts) || hosts.length > 20) fail(`"hosts" is a list of at most 20.`);
    else for (const host of hosts) if (typeof host !== "string" || !HOST.test(host)) fail(`"${String(host)}" isn't a host's name.`);
    if (Array.isArray(hosts) && hosts.length > 0 && !(Array.isArray(permissions) && permissions.includes("network"))) fail(`"hosts" needs the "network" permission.`);
  }
  if (Array.isArray(permissions) && permissions.includes("network") && !(Array.isArray(hosts) && hosts.length > 0)) fail(`"network" needs "hosts", every one it contacts.`);
  const contributes = m.contributes as Record<string, unknown> | undefined;
  if (contributes !== undefined) {
    if (typeof contributes !== "object" || contributes === null) fail(`"contributes" is an object.`);
    else {
      for (const key of Object.keys(contributes)) if (!["settings", "commands", "themes"].includes(key)) fail(`"contributes" has "${key}", which it doesn't take.`);
      checkSettings(contributes.settings, fail);
      checkCommands(contributes.commands, m.main !== undefined, fail);
      checkThemes(contributes.themes, fail);
    }
  }
  return problems;
}

function checkSettings(settings: unknown, fail: (problem: string) => void): void {
  if (settings === undefined) return;
  if (!Array.isArray(settings) || settings.length > 40) return void fail(`"contributes.settings" is a list of at most 40.`);
  const keys = new Set<string>();
  for (const s of settings as Record<string, unknown>[]) {
    if (typeof s?.key !== "string" || !KEY.test(s.key) || keys.has(s.key)) fail(`A setting's "key" is a name of its own.`);
    else keys.add(s.key);
    if (typeof s?.label !== "string" || !s.label.trim() || s.label.length > 80) fail(`A setting has a "label".`);
    if (s?.hint !== undefined && (typeof s.hint !== "string" || s.hint.length > 200)) fail(`A setting's "hint" is at most 200 characters.`);
    switch (s?.type) {
      case "switch":
        if (s.default !== undefined && typeof s.default !== "boolean") fail(`A switch's default is true or false.`);
        break;
      case "select":
        if (!Array.isArray(s.choices) || s.choices.length === 0 || s.choices.length > 50 || s.choices.some((c) => typeof c !== "string" || c.length > 80)) fail(`A select has 1 to 50 "choices".`);
        else if (s.default !== undefined && !(s.choices as string[]).includes(s.default as string)) fail(`A select's default is one of its choices.`);
        break;
      case "text":
        if (s.default !== undefined && (typeof s.default !== "string" || s.default.length > 500)) fail(`A text setting's default is at most 500 characters.`);
        break;
      case "slider":
        if (s.default !== undefined && (typeof s.default !== "number" || s.default < 0 || s.default > 1)) fail(`A slider's default is from 0 to 1.`);
        break;
      default:
        fail(`A setting's "type" is switch, select, text or slider.`);
    }
  }
}

function checkCommands(commands: unknown, scripted: boolean, fail: (problem: string) => void): void {
  if (commands === undefined) return;
  if (!Array.isArray(commands) || commands.length > 40) return void fail(`"contributes.commands" is a list of at most 40.`);
  if (commands.length > 0 && !scripted) fail(`Commands need a main.js to run them.`);
  for (const c of commands as Record<string, unknown>[]) {
    if (typeof c?.id !== "string" || !KEY.test(c.id)) fail(`A command's "id" is a name of its own.`);
    if (typeof c?.title !== "string" || !c.title.trim() || c.title.length > 80) fail(`A command has a "title".`);
    if (c?.keys !== undefined && (typeof c.keys !== "string" || !/^[a-z0-9-]{1,40}$/.test(c.keys))) fail(`A command's "keys" are one keystroke as GPUI writes it, such as ctrl-shift-t.`);
    if (c?.slash !== undefined && (typeof c.slash !== "string" || !/^[a-z0-9-]{1,32}$/.test(c.slash))) fail(`A command's "slash" is 1 to 32 lower-case letters, digits and hyphens.`);
  }
}

function checkThemes(themes: unknown, fail: (problem: string) => void): void {
  if (themes === undefined) return;
  if (!Array.isArray(themes) || themes.length > 10) return void fail(`"contributes.themes" is a list of at most 10.`);
  const tokens = new Set<string>(THEME_TOKENS);
  for (const t of themes as Record<string, unknown>[]) {
    if (typeof t?.id !== "string" || !KEY.test(t.id)) fail(`A theme's "id" is a name of its own.`);
    if (typeof t?.name !== "string" || !t.name.trim() || t.name.length > 40) fail(`A theme has a "name".`);
    const colors = t?.colors;
    if (typeof colors !== "object" || colors === null) fail(`A theme has "colors".`);
    else
      for (const [token, color] of Object.entries(colors)) {
        if (!tokens.has(token)) fail(`"${token}" isn't a color a theme sets.`);
        if (typeof color !== "string" || !COLOR.test(color)) fail(`A theme's colors are #rrggbb or #rrggbbaa.`);
      }
  }
}
