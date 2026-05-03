import { useCallback, useEffect, useRef, useState } from "react";
import { decryptFile } from "../../crypto/file";
import { jotaiStore, serverTokensAtom } from "../../store/atoms";
import type { Server } from "../../types/serverTypes";
import { usePlatform } from "../../platform/PlatformContext";

// In-memory blob URL LRU cache keyed by `<serverId>/<attachmentId>`.
const MAX_CACHE = 100;
const cache = new Map<string, string>();
const cacheOrder: string[] = [];

function cacheGet(key: string): string | undefined {
  return cache.get(key);
}

function cacheSet(key: string, url: string) {
  if (cache.has(key)) return;
  cache.set(key, url);
  cacheOrder.push(key);
  if (cacheOrder.length > MAX_CACHE) {
    const evicted = cacheOrder.shift()!;
    const evictedUrl = cache.get(evicted);
    if (evictedUrl) URL.revokeObjectURL(evictedUrl);
    cache.delete(evicted);
  }
}

async function downloadAndDecrypt(
  serverAddress: string,
  token: string,
  attachmentId: string,
  senderIdentityKey: string,
  ownPrivateKey: string,
  mimeType: string,
): Promise<string> {
  const res = await fetch(
    `https://${serverAddress}/api/attachment/download?id=${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const decryptedBytes = decryptFile(
    new Uint8Array(arrayBuffer),
    senderIdentityKey,
    ownPrivateKey,
  );

  const blob = new Blob(
    [
      decryptedBytes.buffer.slice(
        decryptedBytes.byteOffset,
        decryptedBytes.byteOffset + decryptedBytes.byteLength,
      ) as ArrayBuffer,
    ],
    { type: mimeType || "application/octet-stream" },
  );
  return URL.createObjectURL(blob);
}

/**
 * Downloads, decrypts, and caches a single attachment as a blob URL.
 * Requires `ownPrivateKey` from the vault (encPrivateKey).
 */
export function useAttachmentDownload(
  server: Server,
  attachmentId: string | undefined,
  senderIdentityKey: string,
  mimeType: string,
  ownPrivateKey: string | null,
  autoFetch = false,
) {
  const cacheKey = attachmentId ? `${server.id}/${attachmentId}` : "";
  const [url, setUrl] = useState<string | null>(() =>
    cacheKey ? (cacheGet(cacheKey) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const platform = usePlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;

  const doDownload = useCallback(async () => {
    if (!attachmentId || !ownPrivateKey || inFlightRef.current) return;

    const cached = cacheGet(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }

    inFlightRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const token = jotaiStore.get(serverTokensAtom).get(server.id) ?? "";
      const objectUrl = await downloadAndDecrypt(
        server.address,
        token,
        attachmentId,
        senderIdentityKey,
        ownPrivateKey,
        mimeType,
      );
      cacheSet(cacheKey, objectUrl);
      setUrl(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [
    attachmentId,
    senderIdentityKey,
    ownPrivateKey,
    mimeType,
    cacheKey,
    server.id,
    server.address,
  ]);

  useEffect(() => {
    if (autoFetch && attachmentId && ownPrivateKey && !url) {
      doDownload();
    }
  }, [autoFetch, attachmentId, ownPrivateKey, url, doDownload]);

  return {
    url,
    loading,
    error,
    download: doDownload,
    saveFile: async (filename?: string) => {
      if (!url) return;
      const p = platformRef.current;
      if (p?.shell) {
        // Web: trigger browser download (platform-agnostic)
      }
      // Web: trigger browser download
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? "attachment";
      a.click();
    },
  };
}
