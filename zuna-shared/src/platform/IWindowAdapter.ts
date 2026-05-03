/**
 * Window adapter — native window controls.
 * `isNative` lets components conditionally show/hide the custom title bar.
 */
export interface IWindowAdapter {
  /** True in Electron (frameless window). False in browser PWA. */
  isNative: boolean;
  minimize(): void;
  maximize(): void;
  close(): void;
}
