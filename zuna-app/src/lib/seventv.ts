// 7TV API v2 / v3 types and helpers.
// Uses the browser's built-in fetch — no node-fetch needed in the renderer.

const BASE_V2 = "https://api.7tv.app/v2";
const BASE_V3 = "https://api.7tv.app/v3";

// ─── V2 types ────────────────────────────────────────────────────────────────

export type UserIdentifier = "object_id" | "twitch_id" | "login";

export interface EmoteV2 {
  id: string;
  name: string;
  owner: UserV2;
  visibility: number;
  visibility_simple: string[];
  mime: string;
  status: number;
  tags: string[];
  width: number[];
  height: number[];
  urls: string[][];
}

export interface UserV2 {
  id: string;
  twitch_id: string;
  login: string;
  display_name: string;
  role: Role;
}

export interface Role {
  id: string;
  name: string;
  position: number;
  color: number;
  allowed: number;
  denied: number;
  default: boolean;
}

export type GlobalEmotesResponse = {
  badges: Badge[];
  paints: Paint[];
};

export type Badge = {
  id: string;
  name: string;
  tooltip: string;
  urls: string[][];
  users: string[];
};

export type Paint = {
  id: string;
  name: string;
  users: string[];
  function: string;
  color: number;
  stops: Stop[];
  repeat: boolean;
  angle: number;
  shape: string;
  drop_shadow: DropShadow;
  drop_shadows: DropShadow[];
  animation: Animation;
};

export type Stop = { at: number; color: number };
export type DropShadow = {
  x_offset: number;
  y_offset: number;
  radius: number;
  color: number;
};
export type Animation = { speed: number; keyframes: unknown };

// ─── V3 types ────────────────────────────────────────────────────────────────

export interface EmoteFile {
  name: string;
  static_name: string;
  width: number;
  height: number;
  frame_count: number;
  size: number;
  format: string;
}

export interface Host {
  url: string;
  files: EmoteFile[];
}

export interface EmoteData {
  id: string;
  name: string;
  flags: number;
  lifecycle: number;
  state: string[];
  listed: boolean;
  animated: boolean;
  owner: UserV3;
  host: Host;
}

export interface EmoteV3 {
  id: string;
  name: string;
  flags: number;
  timestamp: number;
  actor_id: string;
  data: EmoteData;
}

export interface EmoteSet {
  id: string;
  name: string;
  flags: number;
  tags: string[];
  immutable: boolean;
  privileged: boolean;
  emotes: EmoteV3[];
}

export interface UserV3 {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  style: unknown;
  roles: string[];
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`7TV request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export const SevenTV = {
  getUser: (username: string) =>
    apiFetch<UserV2>(`${BASE_V2}/users/${encodeURIComponent(username)}`),

  getEmote: (emoteId: string) =>
    apiFetch<EmoteV2>(`${BASE_V2}/emotes/${encodeURIComponent(emoteId)}`),

  getEmotes: (username: string) =>
    apiFetch<EmoteV2[]>(
      `${BASE_V2}/users/${encodeURIComponent(username)}/emotes`,
    ),

  getGlobalEmotesV2: () => apiFetch<EmoteV2[]>(`${BASE_V2}/emotes/global`),

  getBadges: async (identifier: UserIdentifier) => {
    const data = await apiFetch<GlobalEmotesResponse>(
      `${BASE_V2}/badges?user_identifier=${encodeURIComponent(identifier)}`,
    );
    return data.badges;
  },

  getPaints: async (identifier: UserIdentifier) => {
    const data = await apiFetch<GlobalEmotesResponse>(
      `${BASE_V2}/badges?user_identifier=${encodeURIComponent(identifier)}`,
    );
    return data.paints;
  },

  getEmoteSet: (emoteSetId: string) =>
    apiFetch<EmoteSet>(
      `${BASE_V3}/emote-sets/${encodeURIComponent(emoteSetId)}`,
    ),

  getGlobalEmoteSet: () => apiFetch<EmoteSet>(`${BASE_V3}/emote-sets/global`),
};

// ─── URL helpers ─────────────────────────────────────────────────────────────

/** Returns the best CDN URL for an EmoteV3 (prefers WebP 1x, falls back to first file). */
export function emoteUrl(emote: EmoteV3, preferSize = "1x"): string | null {
  const { host } = emote.data;
  if (!host?.files?.length) return null;

  const preferred = host.files.find((f) => f.name === `${preferSize}.webp`);
  const fallback = host.files[0];
  const file = preferred ?? fallback;

  // host.url is protocol-relative like //cdn.7tv.app/emote/<id>
  return `https:${host.url}/${file.name}`;
}
