import { useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "@/types/serverTypes";
import { messageKey, type AttachmentMeta } from "./types";
import { decrypt } from "../../../crypto/x25519";

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
  const cipherFingerprintRef = useRef<Map<string, string>>(new Map());

  const getCipherFingerprint = (m: Message) =>
    `${m.cipherText}|${m.iv}|${m.authTag}`;

  useEffect(() => {
    setDecrypted(new Map());
    setDecryptedMeta(new Map());
    inFlightRef.current.clear();
    metaInFlightRef.current.clear();
    cipherFingerprintRef.current.clear();
    lastSharedSecretRef.current = null;
  }, [memberId]);

  useEffect(() => {
    if (!sharedSecret) return;

    const secretChanged = sharedSecret !== lastSharedSecretRef.current;
    if (secretChanged) {
      lastSharedSecretRef.current = sharedSecret;
      inFlightRef.current.clear();
      cipherFingerprintRef.current.clear();
      setDecrypted(new Map());
    }

    const toDecrypt = messages.filter((m) => {
      if (m.plaintext) return false;
      const key = messageKey(m);
      const fingerprint = getCipherFingerprint(m);
      const prevFingerprint = cipherFingerprintRef.current.get(key);
      const payloadChanged = prevFingerprint !== fingerprint;
      if (inFlightRef.current.has(key)) return false;
      if (!secretChanged && !payloadChanged && decrypted.has(key)) return false;
      return true;
    });

    if (!toDecrypt.length) return;

    toDecrypt.forEach((m) => inFlightRef.current.add(messageKey(m)));

    Promise.all(
      toDecrypt.map(async (m) => {
        const key = messageKey(m);
        const fingerprint = getCipherFingerprint(m);
        try {
          const text = decrypt(sharedSecret, {
            ciphertext: m.cipherText,
            iv: m.iv,
            authTag: m.authTag,
          });
          return [key, text, fingerprint] as const;
        } catch {
          return [key, "[decryption failed]", fingerprint] as const;
        }
      }),
    ).then((results) => {
      results.forEach(([key]) => inFlightRef.current.delete(key));
      setDecrypted((prev) => {
        const next = new Map(prev);
        for (const [key, text, fingerprint] of results) {
          next.set(key, text);
          cipherFingerprintRef.current.set(key, fingerprint);
        }
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
          const json = decrypt(sharedSecret, {
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
