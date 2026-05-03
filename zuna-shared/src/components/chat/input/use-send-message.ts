import React, { useState, useCallback } from "react";
import { encrypt } from "../../../crypto/x25519";

interface UseSendMessageParams {
  sharedSecret: string | null;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  pendingFile: File | null;
  onPendingFileChange: (file: File | null) => void;
  onSend: (
    cipherText: string,
    iv: string,
    authTag: string,
    plaintext: string,
  ) => void;
  onSendFile?: (file: File, plaintext: string) => void;
  setWriting: (writing: boolean) => void;
  writeTimeoutRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  setOgDismissed: React.Dispatch<React.SetStateAction<string | null>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  codeMode?: boolean;
  codeLang?: string;
  setCodeMode?: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useSendMessage({
  sharedSecret,
  value,
  setValue,
  pendingFile,
  onPendingFileChange,
  onSend,
  onSendFile,
  setWriting,
  writeTimeoutRef,
  setOgDismissed,
  textareaRef,
  codeMode,
  codeLang,
  setCodeMode,
}: UseSendMessageParams) {
  const [isSending, setIsSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!sharedSecret || isSending) return;

    if (pendingFile) {
      if (!onSendFile) return;
      const text = value.trim();
      onPendingFileChange(null);
      setValue("");
      setOgDismissed(null);
      if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
      setWriting(false);
      onSendFile(pendingFile, text);
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    const rawText = value.trim();
    if (!rawText) return;
    const text =
      codeMode && rawText
        ? `\`\`\`${codeLang ?? ""}\n${rawText}\n\`\`\``
        : rawText;

    setIsSending(true);
    setValue("");
    setOgDismissed(null);
    if (codeMode && setCodeMode) setCodeMode(false);
    if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
    setWriting(false);

    try {
      const encrypted = encrypt(sharedSecret, text);
      onSend(encrypted.ciphertext, encrypted.iv, encrypted.authTag, text);
    } catch (err) {
      console.error("[ChatInput] encryption failed:", err);
      setValue(rawText);
    } finally {
      setIsSending(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [
    value,
    sharedSecret,
    isSending,
    pendingFile,
    onSend,
    onSendFile,
    onPendingFileChange,
    setWriting,
    setOgDismissed,
    codeMode,
    codeLang,
    setCodeMode,
  ]);

  return { isSending, handleSend };
}
