// The desktop shell. It stays deliberately small: the window, OS integration and
// the device key. All chat logic and cryptography run in the sandboxed renderer.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";

const APP_SCHEME = "zuna-app";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const DEEP_LINK_SCHEME = "zuna";
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingDeepLink: string | null = null;
let closeToTray = true;
let notifications: Notification[] = [];

// A secure, standard scheme gives the renderer a real origin, which storage
// (OPFS) requires and which file:// doesn't provide.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Images only ever come from a joined server (emotes, icons) or from decrypted
  // blobs. Message text never loads remote content, so links can't track people.
  "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

function serveRenderer(): void {
  const root = join(__dirname, "../renderer");
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    headers.set("X-Content-Type-Options", "nosniff");
    if (filePath.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
    return new Response(response.body, { status: response.status, headers });
  });
}

/**
 * The device key encrypts everything Zuna stores locally. The operating system's
 * keychain protects it, so the database is useless if copied off the machine.
 */
function loadDeviceKey(): { key: Buffer; protected: boolean } {
  const path = join(app.getPath("userData"), "device-key");
  const usable = safeStorage.isEncryptionAvailable();
  const strong = usable && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  if (existsSync(path)) {
    const stored = readFileSync(path);
    // A 32-byte file means no keychain was available when the key was created.
    if (stored.length === 32) return { key: stored, protected: false };
    return { key: Buffer.from(safeStorage.decryptString(stored), "base64"), protected: strong };
  }
  const key = randomBytes(32);
  writeFileSync(path, usable ? safeStorage.encryptString(key.toString("base64")) : key, { mode: 0o600 });
  return { key, protected: strong };
}

function iconPath(): string {
  return join(__dirname, "../../resources/icon.png");
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 540,
    show: false,
    backgroundColor: "#0f0f11",
    icon: iconPath(),
    titleBarStyle: "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarOverlay: { color: "#0f0f11", symbolColor: "#a0a0a6", height: 31 } }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keeps the connection alive so messages and notifications arrive while hidden.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    // A development build quits with its window, so it never lingers out of sight.
    if (!quitting && closeToTray && !isDev && process.platform !== "darwin") {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("focus", () => {
    mainWindow?.webContents.send("zuna:focus", true);
    mainWindow?.flashFrame(false);
  });
  mainWindow.on("blur", () => mainWindow?.webContents.send("zuna:focus", false));

  // Messages have their own menu; text fields get the usual editing commands.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const suggestions = params.dictionarySuggestions.slice(0, 4).map((suggestion) => ({
      label: suggestion,
      click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
    }));
    Menu.buildFromTemplate([
      ...suggestions,
      ...(suggestions.length ? [{ type: "separator" as const }] : []),
      { role: "cut" as const },
      { role: "copy" as const },
      { role: "paste" as const },
      { type: "separator" as const },
      { role: "selectAll" as const },
    ]).popup();
  });

  // Links open in the user's browser, and only http(s) links at all.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0")) {
      event.preventDefault();
    }
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

function createTray(): void {
  if (process.platform === "darwin") return;
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("Zuna");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Zuna", click: showWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

function isFromApp(event: IpcMainInvokeEvent): boolean {
  const origin = event.senderFrame?.url ?? "";
  return origin.startsWith(APP_ORIGIN) || (isDev && origin.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0"));
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isFromApp(event)) throw new Error("Blocked a request from an unknown page.");
      return listener(event, ...args);
    });

  handle("zuna:device-key", () => {
    const { key, protected: isProtected } = loadDeviceKey();
    return { key: new Uint8Array(key), protected: isProtected, deviceName: `${deviceLabel()}` };
  });
  handle("zuna:platform", () => process.platform);
  handle("zuna:notify", (_event, payload: { title: string; body: string; route: unknown }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: payload.title, body: payload.body, silent: true, icon: iconPath() });
    notifications.push(notification);
    const forget = () => {
      notifications = notifications.filter((item) => item !== notification);
    };
    notification.on("click", () => {
      forget();
      showWindow();
      mainWindow?.webContents.send("zuna:open-conversation", payload.route);
    });
    notification.on("close", forget);
    notification.show();
    mainWindow?.flashFrame(true);
  });
  handle("zuna:badge", (_event, count: number) => {
    if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
    if (process.platform === "win32" && mainWindow) {
      mainWindow.setOverlayIcon(count > 0 ? overlayIcon() : null, count > 0 ? `${count} unread` : "");
    }
    tray?.setToolTip(count > 0 ? `Zuna: ${count} unread` : "Zuna");
  });
  handle("zuna:close-to-tray", (_event, enabled: boolean) => {
    closeToTray = enabled;
  });
  handle("zuna:take-deep-link", () => {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return link;
  });
  handle("zuna:open-external", (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

function deviceLabel(): string {
  const names: Record<string, string> = { win32: "Windows PC", darwin: "Mac", linux: "Linux PC" };
  return names[process.platform] ?? "Computer";
}

function overlayIcon() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49;
      const i = (y * size + x) * 4;
      pixels[i] = inside ? 0xec : 0;
      pixels[i + 1] = inside ? 0xec : 0;
      pixels[i + 2] = inside ? 0xee : 0;
      pixels[i + 3] = inside ? 0xff : 0;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function deliverDeepLink(link: string): void {
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("zuna:deep-link", link);
    showWindow();
  } else {
    pendingDeepLink = link;
  }
}

function findDeepLink(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("chat.zuna.app");
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  app.on("second-instance", (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) deliverDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  void app.whenReady().then(() => {
    // The renderer needs notifications only. Calls will ask for more when they arrive.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "notifications" || permission === "clipboard-sanitized-write");
    });
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
        : null,
    );
    serveRenderer();
    registerIpc();
    const initial = findDeepLink(process.argv);
    if (initial) pendingDeepLink = initial;
    createWindow();
    createTray();
    app.on("activate", showWindow);
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && (!tray || isDev)) app.quit();
  });
}
