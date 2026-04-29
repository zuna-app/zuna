import { useEffect } from 'react';
import { registerHandler } from './wsRegistry';
import { Server } from '@/types/serverTypes';

export function useWsHandler<P = unknown>(
  server: Server,
  type: string,
  handler: (payload: P) => void,
) {
  useEffect(() => {
    const unregister = registerHandler<P>(server.id, type, handler);
    return unregister;
    // handler is intentionally not in deps — callers must wrap with useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, type]);
}
