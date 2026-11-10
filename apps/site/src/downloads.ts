import { REPO } from "./pages";

export interface Release {
  version: string;
  assets: { name: string; url: string; size: number }[];
}

declare const __RELEASE__: Release | null;

export const RELEASE: Release | null = __RELEASE__;
export const RELEASES_PAGE = `${REPO}/releases/latest`;

export type System = "windows" | "mac" | "linux" | "ios" | "android";

export interface Download {
  label: string;
  url: string;
  /** Megabytes, when there's a release to measure. */
  size?: number;
}

/**
 * What a release carries (docs/RELEASES.md), by the names the native app's scripts give them
 * (scripts/windows-app.mjs and linux-app.mjs). There's no macOS build on releases yet.
 */
const FILES: Record<"windows" | "linux", { label: string; match: RegExp }[]> = {
  windows: [{ label: "Installer (.exe)", match: /^Zuna-Native-Setup-.*\.exe$/ }],
  linux: [
    { label: "AppImage", match: /\.AppImage$/ },
    { label: "Debian, Ubuntu (.deb)", match: /\.deb$/ },
    { label: "Fedora, openSUSE (.rpm)", match: /\.rpm$/ },
    { label: "Arch (.pkg.tar.zst)", match: /\.pkg\.tar\.zst$/ },
    { label: "Anywhere (.tar.gz)", match: /\.tar\.gz$/ },
  ],
};

export function downloadsFor(system: "windows" | "linux"): Download[] {
  return FILES[system].map(({ label, match }) => {
    const asset = RELEASE?.assets.find((a) => match.test(a.name));
    return asset ? { label, url: asset.url, size: Math.round(asset.size / 1e6) } : { label, url: RELEASES_PAGE };
  });
}

export const SYSTEM_NAMES: Record<System, string> = {
  windows: "Windows",
  mac: "macOS",
  linux: "Linux",
  ios: "iPhone",
  android: "Android",
};

export function detectSystem(): System | null {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return null;
}
