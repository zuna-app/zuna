// Turns encrypted files into displayable URLs, and prepares images for upload.

import type { AvatarRef, Attachment } from "@zuna/core";
import { useEffect, useState } from "react";
import { useApp } from "@/state/store";

const MAX_CACHED = 300;
const cache = new Map<string, Promise<string>>();
/** URLs that are ready, so a remounted image can render on its first frame. */
const ready = new Map<string, string>();

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
      ready.set(ref.fileId, url);
      return url;
    });
  cache.set(ref.fileId, pending);
  pending.catch(() => cache.delete(ref.fileId));
  if (cache.size > MAX_CACHED) {
    const [oldestId, oldest] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(oldestId);
    ready.delete(oldestId);
    void oldest.then((url) => setTimeout(() => URL.revokeObjectURL(url), 60_000));
  }
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

export async function downloadAttachment(serverId: string, attachment: Attachment): Promise<void> {
  const url = await fetchDecrypted(serverId, attachment);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.click();
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

function readMediaDetails(file: File): Promise<Partial<PreparedFile>> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const finish = (details: Partial<PreparedFile>) => {
      URL.revokeObjectURL(url);
      resolve(details);
    };
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const video = element as HTMLVideoElement;
      finish({
        duration: Number.isFinite(element.duration) ? element.duration : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      });
    };
    element.onerror = () => finish({});
    element.src = url;
  });
}
