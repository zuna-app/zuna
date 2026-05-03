import { createContext, useContext, type ReactNode } from "react";
import type { IPlatform } from "./IPlatform";

const PlatformContext = createContext<IPlatform | null>(null);

interface PlatformProviderProps {
  platform: IPlatform;
  children: ReactNode;
}

export function PlatformProvider({
  platform,
  children,
}: PlatformProviderProps) {
  return (
    <PlatformContext.Provider value={platform}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): IPlatform {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    throw new Error("usePlatform must be used inside <PlatformProvider>");
  }
  return ctx;
}
