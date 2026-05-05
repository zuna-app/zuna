const BASE_V3 = 'https://api.7tv.app/v3';

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

export interface UserV3 {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  style: unknown;
  roles: string[];
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

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`7TV request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export const SevenTV = {
  getEmoteSet: (emoteSetId: string) =>
    apiFetch<EmoteSet>(`${BASE_V3}/emote-sets/${encodeURIComponent(emoteSetId)}`),

  getGlobalEmoteSet: () => apiFetch<EmoteSet>(`${BASE_V3}/emote-sets/global`),
};

export function emoteUrl(emote: EmoteV3, preferSize = '1x'): string | null {
  const { host } = emote.data;
  if (!host?.files?.length) return null;

  const preferred = host.files.find((file) => file.name === `${preferSize}.webp`);
  const fallback = host.files[0];
  const file = preferred ?? fallback;

  return `https:${host.url}/${file.name}`;
}

export function getEmoteDisplaySize(
  emote: EmoteV3,
  preferSize = '1x',
): { width: number; height: number } | null {
  const files = emote.data.host.files;
  if (!files.length) return null;

  const preferred = files.find((file) => file.name === `${preferSize}.webp`);
  const fallback = files[0];
  const file = preferred ?? fallback;

  if (!file.width || !file.height) return null;

  return { width: file.width, height: file.height };
}