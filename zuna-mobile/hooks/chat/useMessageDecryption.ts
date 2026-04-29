import { useCallback, useEffect, useRef, useState } from 'react';
import { decrypt } from '@/lib/crypto/x25519';
import { Message, AttachmentMeta } from '@/types/serverTypes';

export function useMessageDecryption(messages: Message[], sharedSecret: string | null) {
  const [decryptedMap, setDecryptedMap] = useState<Map<string, string>>(new Map());
  const [metaMap, setMetaMap] = useState<Map<string, AttachmentMeta>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const prevSecret = useRef(sharedSecret);

  // Clear cache when shared secret changes
  useEffect(() => {
    if (prevSecret.current !== sharedSecret) {
      prevSecret.current = sharedSecret;
      setDecryptedMap(new Map());
      setMetaMap(new Map());
      inFlight.current.clear();
    }
  }, [sharedSecret]);

  useEffect(() => {
    if (!sharedSecret) return;

    const toDecrypt = messages.filter((m) => {
      if (m.plaintext) return false;
      if (!m.cipherText || !m.iv || !m.authTag) return false;
      const key = `${m.cipherText}|${m.iv}|${m.authTag}`;
      if (decryptedMap.has(key)) return false;
      if (inFlight.current.has(key)) return false;
      return true;
    });

    if (toDecrypt.length === 0) return;

    const secret = sharedSecret;
    for (const msg of toDecrypt) {
      const key = `${msg.cipherText}|${msg.iv}|${msg.authTag}`;
      inFlight.current.add(key);

      try {
        const plaintext = decrypt(secret, {
          ciphertext: msg.cipherText,
          iv: msg.iv,
          authTag: msg.authTag,
        });
        setDecryptedMap((prev) => {
          const next = new Map(prev);
          next.set(key, plaintext);
          return next;
        });
      } catch {
        setDecryptedMap((prev) => {
          const next = new Map(prev);
          next.set(key, '[decryption failed]');
          return next;
        });
      } finally {
        inFlight.current.delete(key);
      }

      // Decrypt attachment metadata if present
      if (msg.attachmentMetadata && msg.attachmentMetadataIv && msg.attachmentMetadataAuthTag) {
        const metaKey = `meta:${msg.attachmentMetadata}`;
        if (!metaMap.has(metaKey) && !inFlight.current.has(metaKey)) {
          inFlight.current.add(metaKey);
          try {
            const metaStr = decrypt(secret, {
              ciphertext: msg.attachmentMetadata,
              iv: msg.attachmentMetadataIv,
              authTag: msg.attachmentMetadataAuthTag,
            });
            const meta = JSON.parse(metaStr) as AttachmentMeta;
            setMetaMap((prev) => {
              const next = new Map(prev);
              next.set(metaKey, meta);
              return next;
            });
          } catch {
          } finally {
            inFlight.current.delete(metaKey);
          }
        }
      }
    }
  }, [messages, sharedSecret]);

  const getPlaintext = useCallback(
    (msg: Message): string | undefined => {
      if (msg.plaintext) return msg.plaintext;
      const key = `${msg.cipherText}|${msg.iv}|${msg.authTag}`;
      return decryptedMap.get(key);
    },
    [decryptedMap]
  );

  const getAttachmentMeta = useCallback(
    (msg: Message): AttachmentMeta | undefined => {
      if (!msg.attachmentMetadata) return undefined;
      const key = `meta:${msg.attachmentMetadata}`;
      return metaMap.get(key);
    },
    [metaMap]
  );

  return { getPlaintext, getAttachmentMeta };
}
