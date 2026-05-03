import "./index.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { jotaiStore, PlatformProvider, App } from "@zuna/shared";
import { WebPlatform } from "./platform/WebPlatform";
import React, { useState } from "react";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <JotaiProvider store={jotaiStore}>
      <PlatformProvider platform={WebPlatform}>
        <App />
      </PlatformProvider>
    </JotaiProvider>
  </QueryClientProvider>,
);
