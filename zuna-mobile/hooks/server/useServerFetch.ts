import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { jotaiStore, serverTokensAtom } from '@/store/atoms';
import { Server } from '@/types/serverTypes';

export function useAuthorizedServerFetch(server: Server) {
  const tokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const token = tokens.get(server.id) ?? '';

  const authorizedFetch = useCallback(
    (path: string, options: RequestInit = {}) => {
      return fetch(`https://${server.address}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(options.headers ?? {}),
        },
      });
    },
    [server.address, token],
  );

  return { authorizedFetch, token };
}
