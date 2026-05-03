import type { IPlatform } from "@zuna/shared";
import { WebVaultAdapter } from "./WebVaultAdapter";
import {
  WebCacheAdapter,
  WebWindowAdapter,
  WebShellAdapter,
  WebNotificationAdapter,
} from "./WebAdapters";

export const WebPlatform: IPlatform = {
  vault: WebVaultAdapter,
  cache: WebCacheAdapter,
  window: WebWindowAdapter,
  shell: WebShellAdapter,
  notification: WebNotificationAdapter,
};
