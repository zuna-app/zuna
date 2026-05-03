import "./index.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { useAtomValue } from "jotai";
import {
  jotaiStore,
  PlatformProvider,
  App,
  serverListAtom,
  serverTokensAtom,
  usePlatform,
} from "@zuna/shared";
import { WebPlatform } from "./platform/WebPlatform";
import React, { useEffect, useRef } from "react";
import {
  initGatewayPush,
  sendUserCacheToSW,
  sendVaultKeysToSW,
  type UserCacheMap,
} from "./gateway/gatewayPush";

/**
 * Subscribes to Web Push for each authenticated server's gateway and keeps
 * the service worker supplied with the vault keys needed to decrypt payloads.
 * Renders nothing — purely a side-effect component.
 */
function GatewayPushManager() {
  const { vault, cache } = usePlatform();
  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  const serverTokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const initializedRef = useRef(false);

  // Initialize push subscriptions once we have authenticated servers
  useEffect(() => {
    if (serverTokens.size === 0 || serverList.length === 0) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    void (async () => {
      const encPrivateKey = await vault.get("encPrivateKey");
      if (!encPrivateKey) return;
      await initGatewayPush(encPrivateKey as string, serverList);

      const users =
        (await cache.get<UserCacheMap>("user-cache", "users")) ?? {};
      await sendUserCacheToSW(users);
    })();
  }, [serverTokens, serverList, vault, cache]);

  // Re-send vault keys to the SW whenever its controller changes (SW update)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (serverTokens.size === 0 || serverList.length === 0) return;

    const handleControllerChange = () => {
      void (async () => {
        const encPrivateKey = await vault.get("encPrivateKey");
        if (!encPrivateKey) return;
        await sendVaultKeysToSW(encPrivateKey as string, serverList);

        const users =
          (await cache.get<UserCacheMap>("user-cache", "users")) ?? {};
        await sendUserCacheToSW(users);
      })();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
    };
  }, [serverTokens, serverList, vault, cache]);

  return null;
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <JotaiProvider store={jotaiStore}>
      <PlatformProvider platform={WebPlatform}>
        <App />
        <GatewayPushManager />
      </PlatformProvider>
    </JotaiProvider>
  </QueryClientProvider>,
);
