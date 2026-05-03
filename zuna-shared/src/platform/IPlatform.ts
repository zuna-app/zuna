import type { IVaultAdapter } from "./IVaultAdapter";
import type { ICacheAdapter } from "./ICacheAdapter";
import type { IWindowAdapter } from "./IWindowAdapter";
import type { IShellAdapter } from "./IShellAdapter";
import type { INotificationAdapter } from "./INotificationAdapter";

/**
 * Master platform interface.
 * Pass an implementation to <PlatformProvider platform={...}> at the app root.
 */
export interface IPlatform {
  vault: IVaultAdapter;
  cache: ICacheAdapter;
  window: IWindowAdapter;
  shell: IShellAdapter;
  notification: INotificationAdapter;
}
