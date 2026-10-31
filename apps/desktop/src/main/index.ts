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
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { allowLocalLinks, previewable, privateAddress } from "@zuna/core/links";

const APP_SCHEME = "zuna-app";
const WEB_SCHEME = "zuna-web";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const DEEP_LINK_SCHEME = "zuna";
const isDev = !app.isPackaged;

// Only a development build's previews may reach this machine, for its test pages.
allowLocalLinks(isDev);

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
  { scheme: WEB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Images are never fetched by address. Emotes and icons from a joined server are
  // fetched first and shown from memory, and everything else is decrypted or inline,
  // so nothing in a message can make this app contact anyone.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  // Plain HTTP only reaches this machine, where someone may run a server of their own.
  `connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* ${WEB_SCHEME}:`,
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

const WEB_MAX_BYTES = 5 << 20;
const WEB_MAX_REDIRECTS = 5;
const WEB_USER_AGENT = "Mozilla/5.0 (compatible; Zuna link preview)";

/**
 * Whether an address may be fetched for a preview: the name itself, and where it
 * leads. A public name can point at this machine or a private network, and what a
 * preview finds there would go into the message.
 */
async function safeToFetch(web: Electron.Session, url: string): Promise<boolean> {
  if (!previewable(url)) return false;
  const host = new URL(url).hostname;
  if (isDev && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"))) return true;
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  try {
    const { endpoints } = await web.resolveHost(host);
    return endpoints.length > 0 && !endpoints.some((endpoint) => privateAddress(endpoint.address));
  } catch {
    return false;
  }
}

/**
 * Fetches a page or picture for a link preview, keeping at most `maxBytes`.
 * Redirects are followed one at a time, so each address is checked too.
 */
function fetchForPreview(web: Electron.Session, url: string, maxBytes: number): Promise<{ url: string; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let current = url;
    let redirects = 0;
    const request = net.request({ url, session: web, redirect: "manual", useSessionCookies: false });
    const timer = setTimeout(() => request.abort(), 10_000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("The page isn't available."));
    };
    request.setHeader("accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5");
    request.on("redirect", (_status, _method, location) => {
      current = new URL(location, current).toString();
      if (++redirects > WEB_MAX_REDIRECTS) {
        request.abort();
        return;
      }
      void safeToFetch(web, current).then((safe) => {
        if (safe) request.followRedirect();
        else request.abort();
      });
    });
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        request.abort();
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      const finish = () => {
        clearTimeout(timer);
        const type = response.headers["content-type"];
        resolve({ url: current, type: String(Array.isArray(type) ? type[0] : (type ?? "")), body: Buffer.concat(parts).subarray(0, maxBytes) });
      };
      response.on("data", (chunk) => {
        parts.push(chunk);
        size += chunk.length;
        // Only as much as a preview needs, however large the page is.
        if (size >= maxBytes) {
          finish();
          request.abort();
        }
      });
      response.on("end", finish);
      response.on("error", fail);
    });
    request.on("abort", fail);
    request.on("error", fail);
    request.end();
  });
}

/**
 * Link previews. The core runs in a worker, which can't read other sites, so
 * it fetches pages through here: zuna-web://fetch/?url=…&max=…. Requests go
 * out from a session of their own without cookies, and only to the addresses
 * previews allow.
 */
function serveWeb(): void {
  const web = session.fromPartition(WEB_SCHEME);
  web.setUserAgent(WEB_USER_AGENT);
  web.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "set-cookie"));
    callback({ responseHeaders });
  });
  protocol.handle(WEB_SCHEME, async (request) => {
    const params = new URL(request.url).searchParams;
    const target = params.get("url") ?? "";
    const maxBytes = Math.min(Number(params.get("max")) || 0, WEB_MAX_BYTES);
    if (maxBytes <= 0 || !(await safeToFetch(web, target))) return new Response("Not allowed", { status: 400 });
    try {
      const page = await fetchForPreview(web, target, maxBytes);
      return new Response(new Uint8Array(page.body), {
        headers: {
          "content-type": page.type,
          "x-zuna-url": page.url,
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "x-zuna-url",
        },
      });
    } catch {
      return new Response("Not available", { status: 502 });
    }
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
    return { key: new Uint8Array(key), protected: isProtected, deviceName: `${deviceLabel()}`, localLinks: isDev };
  });
  handle("zuna:platform", () => process.platform);
  // macOS asks the person once before an app may record. Chromium's fake microphone, in tests, needs no asking.
  handle("zuna:microphone", async () => {
    if (process.platform !== "darwin" || app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return true;
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
    return systemPreferences.askForMediaAccess("microphone");
  });
  // Whether the person is at the computer, for where notifications go: "active",
  // "idle" after this many seconds without input anywhere, or "locked".
  handle("zuna:idle-state", (_event, seconds: number) => powerMonitor.getSystemIdleState(Math.max(1, Math.round(seconds))));
  for (const [event, state] of [["lock-screen", "away"], ["suspend", "away"], ["unlock-screen", "back"], ["resume", "back"]] as const) {
    powerMonitor.on(event as "lock-screen", () => mainWindow?.webContents.send("zuna:presence", state));
  }
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
    // The renderer needs notifications, and the microphone for voice messages. Calls will ask for more when they arrive.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const microphoneOnly = permission === "media" && "mediaTypes" in details && (details.mediaTypes ?? []).every((type) => type === "audio");
      callback(permission === "notifications" || permission === "clipboard-sanitized-write" || microphoneOnly);
    });
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
        : null,
    );
    serveRenderer();
    serveWeb();
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
