import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { jotaiStore, PlatformProvider, App } from "@zuna/shared";
import { ElectronPlatform } from "./platform/ElectronPlatform";

import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <JotaiProvider store={jotaiStore}>
      <PlatformProvider platform={ElectronPlatform}>
        <App />
      </PlatformProvider>
    </JotaiProvider>
  </QueryClientProvider>,
);
