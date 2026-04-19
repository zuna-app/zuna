import { useCallback, useEffect, useRef, useState } from "react";
import { Server } from "@/types/serverTypes";
import { jotaiStore, serverTokensAtom } from "@/hooks/auth/useAuthorizer";

/**
 * In-memory blob URL cache keyed by `<serverId>/<attachmentId>`.
 * Blob URLs are revoked when the entry is evicted (LRU, max 100).
 */
const MAX_CACHE = 100;
const cache = new Map<string, string>(); // key -> objectURL
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
  mimeType: string,
): Promise<string> {
  const res = await fetch(
    `http://${serverAddress}/api/attachment/download?id=${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const encryptedBytes = new Uint8Array(arrayBuffer);

  const decryptedBytes = await window.security.decryptFile(
    encryptedBytes,
    senderIdentityKey,
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
 * Returns { url, loading, error, download }.
 *
 * `autoFetch` — immediately start downloading (used for image previews).
 */
export function useAttachmentDownload(
  server: Server,
  attachmentId: string | undefined,
  senderIdentityKey: string,
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
    if (!attachmentId || inFlightRef.current) return;

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
  }, [attachmentId, cacheKey, server, senderIdentityKey, mimeType]);

  useEffect(() => {
    if (autoFetch && attachmentId && !url && !loading) {
      doDownload();
    }
  }, [autoFetch, attachmentId, url, loading, doDownload]);

  /**
   * Trigger a browser "Save As" download for non-image files.
   */
  const saveFile = useCallback(
    async (filename: string) => {
      let objectUrl = url;
      if (!objectUrl) {
        await doDownload();
        objectUrl = cacheGet(cacheKey) ?? null;
      }
      if (!objectUrl) return;
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.click();
    },
    [url, doDownload, cacheKey],
  );

  return { url, loading, error, download: doDownload, saveFile };
}
