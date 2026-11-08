// Turns encrypted files into displayable URLs, and prepares images for upload.

import type { AvatarRef, Attachment } from "@zuna/core";
import { useEffect, useState } from "react";
import { useApp } from "@/state/store";

/** Decrypted files kept for drawing again, by count and by what they hold, whichever is reached first. */
const MAX_CACHED = 300;
const MAX_CACHED_BYTES = 256 << 20;
const cache = new Map<string, Promise<string>>();
/** URLs that are ready, so a remounted image can render on its first frame. */
const ready = new Map<string, string>();
/** How big each ready file is, and all of them together. */
const sizes = new Map<string, number>();
let cachedBytes = 0;

/** Lets the oldest files go, never the newest, until the cache is within both limits. */
function trimCache(): void {
  while (cache.size > 1 && (cache.size > MAX_CACHED || cachedBytes > MAX_CACHED_BYTES)) {
    const [oldestId, oldest] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(oldestId);
    ready.delete(oldestId);
    cachedBytes -= sizes.get(oldestId) ?? 0;
    sizes.delete(oldestId);
    // Anything still drawing it has a while to let go first.
    void oldest.then((url) => setTimeout(() => URL.revokeObjectURL(url), 60_000)).catch(() => undefined);
  }
}

function fetchDecrypted(serverId: string, ref: { fileId: string; key: string; prefix: string; chunks: number; mime?: string }): Promise<string> {
  const cached = cache.get(ref.fileId);
  if (cached) {
    // Moving it to the end of the map keeps recently used files cached.
    cache.delete(ref.fileId);
    cache.set(ref.fileId, cached);
    return cached;
  }
  const pending = useApp
    .getState()
    .session(serverId)
    .downloadFile(ref)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      // It may have been let go while it downloaded, and is then only handed to whoever asked.
      if (cache.get(ref.fileId) === pending) {
        ready.set(ref.fileId, url);
        sizes.set(ref.fileId, blob.size);
        cachedBytes += blob.size;
        trimCache();
      }
      return url;
    });
  cache.set(ref.fileId, pending);
  pending.catch(() => {
    if (cache.get(ref.fileId) === pending) cache.delete(ref.fileId);
  });
  trimCache();
  return pending;
}

export function useDecryptedUrl(serverId: string | null, ref: AvatarRef | Attachment | null | undefined, enabled = true) {
  const fileId = ref?.fileId;
  const [url, setUrl] = useState<string | null>(() => (fileId && ready.get(fileId)) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl((fileId && ready.get(fileId)) || null);
    setFailed(false);
    if (!serverId || !ref?.fileId || !enabled) return;
    let cancelled = false;
    fetchDecrypted(serverId, ref)
      .then((value) => {
        if (!cancelled) setUrl(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, fileId, enabled]);
  return { url, failed };
}

/** A frame's shorter side, enough for a tile on a sharp screen. */
const FRAME_SIDE = 260;
const frames = new Map<string, Promise<string>>();
const readyFrames = new Map<string, string>();

function takeFrame(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let done = false;
    const finish = (frame?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (frame) resolve(frame);
      else reject(new Error("That video couldn't be read."));
    };
    const timer = setTimeout(finish, 10_000);
    video.preload = "auto";
    video.muted = true;
    video.onloadedmetadata = () => {
      if (!video.videoWidth) finish();
      else video.currentTime = momentIn(Number.isFinite(video.duration) ? video.duration : undefined);
    };
    video.onseeked = () => {
      try {
        const ratio = Math.min(1, FRAME_SIDE / Math.min(video.videoWidth, video.videoHeight));
        finish(drawFrame(video, ratio).toDataURL("image/jpeg", 0.8));
      } catch {
        finish();
      }
    };
    video.onerror = () => finish();
    video.src = url;
  });
}

function fetchFrame(serverId: string, attachment: Attachment): Promise<string> {
  const cached = frames.get(attachment.fileId);
  if (cached) {
    frames.delete(attachment.fileId);
    frames.set(attachment.fileId, cached);
    return cached;
  }
  const pending = fetchDecrypted(serverId, attachment)
    .then(takeFrame)
    .then((frame) => {
      readyFrames.set(attachment.fileId, frame);
      return frame;
    });
  frames.set(attachment.fileId, pending);
  pending.catch(() => frames.delete(attachment.fileId));
  if (frames.size > MAX_CACHED) {
    const oldestId = frames.keys().next().value as string;
    frames.delete(oldestId);
    readyFrames.delete(oldestId);
  }
  return pending;
}

/**
 * A frame from a video sent in a message, as a picture, for a tile too small to
 * play it in. A video element in each would hold a decoder each, and there are
 * only so many. Null until it's here, and for a video this device can't decode.
 */
export function useVideoFrame(serverId: string | null, attachment: Attachment | null, enabled = true): string | null {
  const fileId = attachment?.fileId;
  const [frame, setFrame] = useState<string | null>(() => (fileId && readyFrames.get(fileId)) || null);
  useEffect(() => {
    setFrame((fileId && readyFrames.get(fileId)) || null);
    if (!serverId || !attachment?.fileId || !enabled) return;
    let cancelled = false;
    fetchFrame(serverId, attachment)
      .then((value) => !cancelled && setFrame(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId, fileId, enabled]);
  return frame;
}

// Pictures from a joined server, such as emotes and server icons, are fetched
// here and shown from memory. The content security policy lets images come from
// nowhere else, so nothing in a message can make the app contact anyone.

const MAX_REMOTE_CACHED = 1000;
const remoteCache = new Map<string, Promise<string>>();
const remoteReady = new Map<string, string>();

function fetchRemoteImage(address: string): Promise<string> {
  const cached = remoteCache.get(address);
  if (cached) {
    remoteCache.delete(address);
    remoteCache.set(address, cached);
    return cached;
  }
  const pending = fetch(address, { credentials: "omit", referrerPolicy: "no-referrer" }).then(async (response) => {
    if (!response.ok) throw new Error("That picture isn't available.");
    const blob = await response.blob();
    // Only pictures, whatever the address gives back.
    if (!blob.type.startsWith("image/") || blob.type === "image/svg+xml") throw new Error("That isn't a picture.");
    const url = URL.createObjectURL(blob);
    remoteReady.set(address, url);
    return url;
  });
  remoteCache.set(address, pending);
  pending.catch(() => remoteCache.delete(address));
  if (remoteCache.size > MAX_REMOTE_CACHED) {
    const [oldestAddress, oldest] = remoteCache.entries().next().value as [string, Promise<string>];
    remoteCache.delete(oldestAddress);
    remoteReady.delete(oldestAddress);
    void oldest.then((url) => setTimeout(() => URL.revokeObjectURL(url), 60_000)).catch(() => undefined);
  }
  return pending;
}

/** A picture from a joined server, once it's here. `enabled` holds it back, such as until it's on screen. */
export function useRemoteImage(address: string | null | undefined, enabled = true) {
  const [url, setUrl] = useState<string | null>(() => (address && remoteReady.get(address)) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl((address && remoteReady.get(address)) || null);
    setFailed(false);
    if (!address || !enabled) return;
    let cancelled = false;
    fetchRemoteImage(address)
      .then((value) => {
        if (!cancelled) setUrl(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [address, enabled]);
  return { url, failed };
}

const EMOTE_FILES = ["1x", "2x", "3x"];
const PREFETCH_AT_ONCE = 2;
const prefetched = new Set<string>();

/**
 * Fetches a server's whole emote set in the background, into the browser's cache
 * and no further. A message showing an emote then asks the server for nothing, so
 * the server can't tell from that who read what, or when.
 */
export function prefetchEmotes(serverUrl: string, emotes: { id: string }[]): void {
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const queue = emotes.flatMap((emote) => EMOTE_FILES.map((file) => `${serverUrl}/api/emotes/${emote.id}/${file}.webp`)).filter((address) => !prefetched.has(address));
  const work = async () => {
    for (let address = queue.pop(); address; address = queue.pop()) {
      prefetched.add(address);
      await fetch(address, { credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache" })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
    }
  };
  for (let count = 0; count < PREFETCH_AT_ONCE; count++) void work();
}

/** Pictures and videos bigger than this wait for a click: this is what downloads with no click, and it all goes in memory. */
const AUTO_LOAD_BYTES = 20 << 20;
const AUTO_LOAD_CHUNKS = 21;

/** The file's chunks, unlike its stated size, can't be lied about: decrypting checks them. */
export const loadsByItself = (attachment: Attachment): boolean => attachment.size <= AUTO_LOAD_BYTES && attachment.chunks <= AUTO_LOAD_CHUNKS;

/** Saves a file. One already drawn is saved from memory; anything else isn't kept there once saved. */
export async function downloadAttachment(serverId: string, attachment: Attachment): Promise<void> {
  const shown = ready.get(attachment.fileId);
  const url = shown ?? URL.createObjectURL(await useApp.getState().session(serverId).downloadFile(attachment));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.style.display = "none";
  // Some WebKit versions only save from a link that's in the page, and before its URL is let go.
  document.body.append(link);
  link.click();
  link.remove();
  if (!shown) setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image couldn't be read."));
    };
    image.src = url;
  });
}

function drawScaled(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Crops an image to a centered square for an avatar or server icon. */
export async function prepareAvatar(file: Blob, size = 256): Promise<Blob> {
  const image = await loadImage(file);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("That image couldn't be processed."))), "image/webp", 0.9);
  });
}

export interface PreparedFile {
  blob: Blob;
  name: string;
  mime: string;
  width?: number;
  height?: number;
  thumb?: string;
  duration?: number;
  previewUrl?: string;
}

/** Reads the details a message needs: dimensions and a tiny blurred preview. */
export async function prepareFile(file: File): Promise<PreparedFile> {
  const prepared: PreparedFile = {
    blob: file,
    name: file.name || "file",
    mime: file.type || "application/octet-stream",
  };
  if (file.type.startsWith("image/")) {
    try {
      const image = await loadImage(file);
      prepared.width = image.naturalWidth;
      prepared.height = image.naturalHeight;
      prepared.previewUrl = URL.createObjectURL(file);
      const ratio = Math.min(1, 48 / Math.max(image.naturalWidth, image.naturalHeight));
      prepared.thumb = drawScaled(image, image.naturalWidth * ratio, image.naturalHeight * ratio).toDataURL("image/jpeg", 0.5);
    } catch {
      // Not decodable here; it'll be sent as a plain file.
    }
  } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    const details = await readMediaDetails(file);
    Object.assign(prepared, details);
    prepared.previewUrl = URL.createObjectURL(file);
  }
  return prepared;
}

/**
 * How big a video's picture is, the frame shown before it loads, from the
 * sharpest down. It travels inside the message, which takes at most 22 KB of it.
 */
const POSTER_STEPS = [
  { size: 320, quality: 0.65 },
  { size: 240, quality: 0.55 },
  { size: 160, quality: 0.5 },
];
const POSTER_LENGTH = 22 << 10;

/** Where a video's picture comes from: a moment in, since many videos start on a black frame. */
const momentIn = (duration: number | undefined) => Math.min(0.5, (duration ?? 0) / 3);

function drawFrame(video: HTMLVideoElement, ratio: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
  canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function readMediaDetails(file: File): Promise<Partial<PreparedFile>> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith("video/");
    const element = document.createElement(isVideo ? "video" : "audio");
    let details: Partial<PreparedFile> = {};
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      resolve(details);
    };
    // A video the system can't decode still goes, only without its picture.
    const timer = setTimeout(finish, 4000);
    element.preload = "auto";
    element.muted = true;
    element.onloadedmetadata = () => {
      const video = element as HTMLVideoElement;
      details = {
        duration: Number.isFinite(element.duration) ? element.duration : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      };
      if (!isVideo || !video.videoWidth) finish();
      else video.currentTime = momentIn(details.duration);
    };
    element.onseeked = () => {
      const video = element as HTMLVideoElement;
      try {
        for (const { size, quality } of POSTER_STEPS) {
          const ratio = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
          const poster = drawFrame(video, ratio).toDataURL("image/jpeg", quality);
          if (poster.length <= POSTER_LENGTH) {
            details.thumb = poster;
            break;
          }
        }
      } catch {
        // No picture, then.
      }
      finish();
    };
    element.onerror = finish;
    element.src = url;
  });
}
