import { useCallback, useEffect, useRef, useState } from "react";
import { decryptFileWithChannelKey } from "../../crypto/channel";
import { jotaiStore, serverTokensAtom } from "../../store/atoms";
import type { Server } from "../../types/serverTypes";

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

async function downloadAndDecryptChannel(
  serverAddress: string,
  token: string,
  attachmentId: string,
  channelKey: string,
  mimeType: string,
): Promise<string> {
  const res = await fetch(
    `https://${serverAddress}/api/attachment/download?id=${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const decryptedBytes = decryptFileWithChannelKey(
    new Uint8Array(arrayBuffer),
    channelKey,
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
 * Downloads, decrypts, and caches a channel attachment as a blob URL.
 * Uses the symmetric channel key instead of X25519 key exchange.
 */
export function useChannelAttachmentDownload(
  server: Server,
  attachmentId: string | undefined,
  channelKey: string | null,
  mimeType: string,
  autoFetch = false,
) {
  const cacheKey = attachmentId ? `${server.id}/${attachmentId}` : "";
  const [url, setUrl] = useState<string | null>(() =>
    cacheKey ? (cacheGet(cacheKey) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const doDownload = useCallback(async () => {
    if (!attachmentId || !channelKey || inFlightRef.current) return;

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
      const objectUrl = await downloadAndDecryptChannel(
        server.address,
        token,
        attachmentId,
        channelKey,
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
  }, [attachmentId, channelKey, mimeType, cacheKey, server.id, server.address]);

  useEffect(() => {
    if (autoFetch && attachmentId && channelKey && !url) {
      doDownload();
    }
  }, [autoFetch, attachmentId, channelKey, url, doDownload]);

  return {
    url,
    loading,
    error,
    download: doDownload,
    saveFile: async (filename?: string) => {
      let objectUrl = url;
      if (!objectUrl) {
        // Trigger download and wait for it to complete
        await doDownload();
        objectUrl = cacheGet(cacheKey) ?? null;
      }
      if (!objectUrl) return;
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename ?? "attachment";
      a.click();
    },
  };
}
