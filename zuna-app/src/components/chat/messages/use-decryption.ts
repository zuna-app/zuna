import { useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "@/types/serverTypes";
import { messageKey, type AttachmentMeta } from "./types";

export function useMessageDecryption(
  messages: Message[],
  sharedSecret: string | null,
  memberId: string,
) {
  const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map());
  const [decryptedMeta, setDecryptedMeta] = useState<
    Map<string, AttachmentMeta>
  >(new Map());

  const inFlightRef = useRef<Set<string>>(new Set());
  const metaInFlightRef = useRef<Set<string>>(new Set());
  const lastSharedSecretRef = useRef<string | null>(null);

  useEffect(() => {
    setDecrypted(new Map());
    setDecryptedMeta(new Map());
    inFlightRef.current.clear();
    metaInFlightRef.current.clear();
    lastSharedSecretRef.current = null;
  }, [memberId]);

  useEffect(() => {
    if (!sharedSecret) return;

    const secretChanged = sharedSecret !== lastSharedSecretRef.current;
    if (secretChanged) {
      lastSharedSecretRef.current = sharedSecret;
      inFlightRef.current.clear();
      setDecrypted(new Map());
    }

    const toDecrypt = messages.filter((m) => {
      if (m.plaintext) return false;
      const key = messageKey(m);
      if (inFlightRef.current.has(key)) return false;
      if (!secretChanged && decrypted.has(key)) return false;
      return true;
    });

    if (!toDecrypt.length) return;

    toDecrypt.forEach((m) => inFlightRef.current.add(messageKey(m)));

    Promise.all(
      toDecrypt.map(async (m) => {
        try {
          const text = await window.security.decrypt(sharedSecret, {
            ciphertext: m.cipherText,
            iv: m.iv,
            authTag: m.authTag,
          });
          return [messageKey(m), text] as const;
        } catch {
          return [messageKey(m), "[decryption failed]"] as const;
        }
      }),
    ).then((results) => {
      results.forEach(([key]) => inFlightRef.current.delete(key));
      setDecrypted((prev) => {
        const next = new Map(prev);
        for (const [key, text] of results) next.set(key, text);
        return next;
      });
    });
  }, [messages, sharedSecret]);

  useEffect(() => {
    if (!sharedSecret) return;

    const toDecryptMeta = messages.filter((m) => {
      if (
        !m.attachmentMetadata ||
        !m.attachmentMetadataIv ||
        !m.attachmentMetadataAuthTag
      )
        return false;
      if (m.attachmentFilename) return false;
      const key = messageKey(m);
      if (metaInFlightRef.current.has(key)) return false;
      if (decryptedMeta.has(key)) return false;
      return true;
    });

    if (!toDecryptMeta.length) return;

    toDecryptMeta.forEach((m) => metaInFlightRef.current.add(messageKey(m)));

    Promise.all(
      toDecryptMeta.map(async (m) => {
        const key = messageKey(m);
        try {
          const json = await window.security.decrypt(sharedSecret, {
            ciphertext: m.attachmentMetadata!,
            iv: m.attachmentMetadataIv!,
            authTag: m.attachmentMetadataAuthTag!,
          });
          const meta = JSON.parse(json) as AttachmentMeta;
          return [key, meta] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    ).then((results) => {
      results.forEach(([key]) => metaInFlightRef.current.delete(key));
      setDecryptedMeta((prev) => {
        const next = new Map(prev);
        for (const [key, meta] of results) {
          if (meta) next.set(key, meta);
        }
        return next;
      });
    });
  }, [messages, sharedSecret]);

  const getRawText = useCallback(
    (msg: Message): string =>
      msg.plaintext ?? decrypted.get(messageKey(msg)) ?? "…",
    [decrypted],
  );

  const getAttachmentMeta = useCallback(
    (msg: Message): AttachmentMeta | null => {
      if (msg.attachmentFilename) {
        return { name: msg.attachmentFilename, size: 0, mimeType: "" };
      }
      return decryptedMeta.get(messageKey(msg)) ?? null;
    },
    [decryptedMeta],
  );

  return { getRawText, getAttachmentMeta };
}
