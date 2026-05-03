/**
 * Shell adapter — open links in the system's default browser.
 * Implementations: ElectronShellAdapter (shell.openExternal), WebShellAdapter (window.open).
 */
export interface IShellAdapter {
  openExternal(url: string): void;
}
