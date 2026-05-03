import { useRef, useCallback, useEffect } from "react";

export function useWritingIndicator(
  onWrite: ((writing: boolean) => void) | undefined,
) {
  const isWritingRef = useRef(false);
  const writeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;

  const setWriting = useCallback((writing: boolean) => {
    if (isWritingRef.current === writing) return;
    isWritingRef.current = writing;
    onWriteRef.current?.(writing);
  }, []);

  useEffect(() => {
    return () => {
      if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
      if (isWritingRef.current) onWriteRef.current?.(false);
    };
  }, []);

  return { setWriting, writeTimeoutRef };
}
