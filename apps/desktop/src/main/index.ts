// The desktop shell. It stays deliberately small: the window, OS integration and
// the device key. All chat logic and cryptography run in the sandboxed renderer.

import { randomBytes } from "node:crypto";
import { keyWatchSupport, startKeyWatch } from "./global-key";
import { PORTAL_SCREEN, PORTAL_WINDOW, portalSources, startNativeScreen, type NativeScreenOptions } from "./native-screen";
import { listSoundApps, nativeSoundAvailable, onX11, startNativeSound, windowSoundApp, type NativeSound } from "./native-sound";
import { notificationState, startNotifications, type Notifications } from "./notifications";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { allowLocalLinks, previewable, privateAddress } from "@zuna/core/links";
import { startPreviewProxy } from "./preview-proxy";
import { nativeScreenPath } from "./native-screen";
import { startUpdates } from "./updates";

const APP_SCHEME = "zuna-app";
const WEB_SCHEME = "zuna-web";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const DEEP_LINK_SCHEME = "zuna";
/** An origin of its own, whose storage and whose requests to this process aren't the app's. */
const NOTIFICATIONS_HOST = "notifications";
const isDev = !app.isPackaged;

// Only a development build's previews may reach this machine, for its test pages.
allowLocalLinks(isDev);

// Chromium decodes video on an NVIDIA GPU under Linux in software unless asked to use
// VA-API, which goes through NVIDIA's VA-API driver where it's installed and otherwise
// falls back to software. Hardware takes a tenth of the time for a share in H.264.
// Only on Wayland: on X11 it decodes every frame and paints each one white.
// Windows and macOS decode in hardware anyway. Features someone passes are kept.
if (process.platform === "linux" && !onX11()) {
  const features = [app.commandLine.getSwitchValue("enable-features"), "VaapiOnNvidiaGPUs"].filter(Boolean).join(",");
  app.commandLine.appendSwitch("enable-features", features);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingDeepLink: string | null = null;
let closeToTray = true;
let notifications: Notification[] = [];
/** Windows's own notifications aren't made for a chat, so there the app draws them. */
let ownNotifications: Notifications | null = null;
let unread: { count: number; overlay: Electron.NativeImage | null; tray: Electron.NativeImage | null } = { count: 0, overlay: null, tray: null };
let deviceKeyHandedOut = false;
let displaySources = new Map<string, Electron.DesktopCapturerSource>();
/** What the next request to capture the display gets, as picked in the app. */
let nextDisplay: { id: string; audio: boolean } | null = null;
let nativeScreen: ReturnType<typeof startNativeScreen> | null = null;
let nativeSound: NativeSound | null = null;
let stopKeyWatch: (() => void) | null = null;

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

// The notifications' page shows other people's words and has no reason to reach anything.
const NOTIFICATIONS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
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
    headers.set("Content-Security-Policy", url.host === NOTIFICATIONS_HOST ? NOTIFICATIONS_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY);
    headers.set("X-Content-Type-Options", "nosniff");
    if (filePath.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
    return new Response(response.body, { status: response.status, headers });
  });
}

const WEB_MAX_BYTES = 5 << 20;
const WEB_MAX_REDIRECTS = 5;
const WEB_USER_AGENT = "Mozilla/5.0 (compatible; Zuna link preview)";

/** A development build's test pages, on this machine. */
const testPage = (host: string) => isDev && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"));

/**
 * Whether an address may be fetched for a preview: the name itself, and where it
 * leads. A public name can point at this machine or a private network, and what a
 * preview finds there would go into the message.
 */
async function safeToFetch(web: Electron.Session, url: string): Promise<boolean> {
  if (!previewable(url)) return false;
  const host = new URL(url).hostname;
  if (testPage(host)) return true;
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

/** A session for previews, with no cookies. */
function previewSession(partition: string): Electron.Session {
  const web = session.fromPartition(partition);
  web.setUserAgent(WEB_USER_AGENT);
  web.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "set-cookie"));
    callback({ responseHeaders });
  });
  return web;
}

/**
 * Link previews. The core runs in a worker, which can't read other sites, so
 * it fetches pages through here: zuna-web://fetch/?url=…&max=…. Requests go
 * out from a session of their own without cookies, and only to the addresses
 * previews allow. They connect through `startPreviewProxy`, which reaches the
 * address it checked, unless the system has a proxy for that link, which is
 * then where they go, as before.
 */
function serveWeb(): void {
  const proxied = previewSession(WEB_SCHEME);
  const checked = previewSession(`${WEB_SCHEME}-checked`);
  const ready = startPreviewProxy(testPage).then(({ port }) => checked.setProxy({ proxyRules: `https=127.0.0.1:${port}` }));
  protocol.handle(WEB_SCHEME, async (request) => {
    const params = new URL(request.url).searchParams;
    const target = params.get("url") ?? "";
    const maxBytes = Math.min(Number(params.get("max")) || 0, WEB_MAX_BYTES);
    if (maxBytes <= 0 || !(await safeToFetch(proxied, target))) return new Response("Not allowed", { status: 400 });
    try {
      await ready;
      const direct = (await session.defaultSession.resolveProxy(target)) === "DIRECT";
      const page = await fetchForPreview(direct ? checked : proxied, target, maxBytes);
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

/**
 * Whether the system shows times with AM and PM. The interface is in English,
 * whose own default is the 12-hour clock, so the system's choice is passed on.
 */
function uses12HourClock(): boolean {
  if (process.platform === "darwin") {
    if (systemPreferences.getUserDefault("AppleICUForce24HourTime", "boolean")) return false;
    if (systemPreferences.getUserDefault("AppleICUForce12HourTime", "boolean")) return true;
  }
  try {
    const cycle = new Intl.DateTimeFormat(app.getSystemLocale() || undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12";
  } catch {
    return false;
  }
}

function iconPath(): string {
  return join(__dirname, "../../resources/icon.png");
}

/** The tray's icon, sharp on the main screen. */
function trayIcon(): Electron.NativeImage {
  const side = process.platform === "win32" ? Math.round(16 * screen.getPrimaryDisplay().scaleFactor) : 16;
  return nativeImage.createFromPath(iconPath()).resize({ width: side, height: side, quality: "best" });
}

/** The tray's icon with the unread count over it. Both are premultiplied, so this just lays one on the other. */
function withCounter(icon: Electron.NativeImage, counter: Electron.NativeImage): Electron.NativeImage {
  const size = icon.getSize();
  const below = icon.toBitmap();
  const above = counter.resize({ ...size, quality: "best" }).toBitmap();
  const pixels = Buffer.alloc(below.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const through = 1 - above[i + 3]! / 255;
    for (let channel = 0; channel < 4; channel++) pixels[i + channel] = Math.round(above[i + channel]! + below[i + channel]! * through);
  }
  return nativeImage.createFromBitmap(pixels, size);
}

function showUnread(): void {
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(unread.count);
  if (process.platform === "win32") {
    mainWindow?.setOverlayIcon(unread.overlay, unread.count > 0 ? `${unread.count} unread` : "");
    tray?.setImage(unread.tray ?? trayIcon());
  }
  tray?.setToolTip(unread.count > 0 ? `Zuna: ${unread.count} unread` : "Zuna");
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
      additionalArguments: [`--zuna-clock=${uses12HourClock() ? 12 : 24}`, ...(nativeSoundAvailable() ? ["--zuna-native-sound"] : [])],
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
    ownNotifications?.close();
  });
  // A taskbar button loses its overlay with the window, and there's none at all until it first shows.
  mainWindow.on("show", showUnread);
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
    if (!isOwnPage(url)) event.preventDefault();
  });
  // The device key goes out once for each page load, to the code that starts the
  // app. Anything that gets into the page later has nobody to ask for it.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) deviceKeyHandedOut = false;
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
  tray = new Tray(trayIcon());
  showUnread();
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

/** Whether an address is one of the app's own pages, and not just one that starts the same way. */
function isOwnPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === "app") return true;
    const dev = process.env["ELECTRON_RENDERER_URL"];
    return isDev && !!dev && parsed.origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

/** The main window's page, and no other, whatever it's served from. */
function isFromApp(event: IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && isOwnPage(event.senderFrame?.url ?? "");
}

function registerIpc(): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isFromApp(event)) throw new Error("Blocked a request from an unknown page.");
      return listener(event, ...args);
    });

  handle("zuna:device-key", () => {
    if (deviceKeyHandedOut) throw new Error("The device key was already handed out.");
    deviceKeyHandedOut = true;
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
  handle("zuna:camera", async () => {
    if (process.platform !== "darwin" || app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return true;
    if (systemPreferences.getMediaAccessStatus("camera") === "granted") return true;
    return systemPreferences.askForMediaAccess("camera");
  });
  // What can be shared, for the picker in the app. A screen's name and picture come
  // from the system, and where it is lets the native capture find the same one.
  handle("zuna:display-sources", async () => {
    // Under Wayland the portal's dialog picks, once Share is pressed, and the native program asks it.
    const portal = await portalSources();
    if (portal) {
      displaySources = new Map();
      const picked = { thumbnail: "", native: true, systemPicks: true };
      return [
        ...(portal.screen ? [{ ...picked, id: PORTAL_SCREEN, name: "Entire screen", kind: "screen" }] : []),
        ...(portal.window ? [{ ...picked, id: PORTAL_WINDOW, name: "A window", kind: "window", ownerUnknown: true }] : []),
      ];
    }
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 340, height: 212 }, fetchWindowIcons: false });
    const native = nativeScreenAvailable();
    displaySources = new Map(sources.map((source) => [source.id, source]));
    return sources
      // Nobody needs to share this window into this window.
      .filter((source) => source.id !== mainWindow?.getMediaSourceId())
      .map((source) => {
        const kind = source.id.startsWith("screen:") ? "screen" : "window";
        return {
          id: source.id,
          name: source.name,
          kind,
          thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
          // Windows captures a window by its HWND. Linux only through the portal, as above.
          native: native && (kind === "screen" || process.platform === "win32"),
          // Chromium under Wayland gets a window from the portal, which doesn't say whose it is.
          ownerUnknown: kind === "window" && process.platform === "linux" && !onX11(),
        };
      });
  });
  handle("zuna:choose-display-source", (_event, id: string, audio: boolean) => {
    nextDisplay = { id, audio: !!audio };
  });
  handle("zuna:native-screen-start", async (event, options: Omit<NativeScreenOptions, "at" | "window" | "kind"> & { source: string }) => {
    nativeScreen?.stop();
    const display = screenForSource(options.source);
    // Electron's id for a window on Windows is its HWND.
    const window = process.platform === "win32" ? (/^window:(\d+):/.exec(options.source)?.[1] ?? null) : null;
    const started = startNativeScreen(
      { ...options, at: display, window, kind: options.source === PORTAL_WINDOW ? "window" : "screen" },
      (problem) => {
        if (nativeScreen !== started) return;
        nativeScreen = null;
        event.sender.send("zuna:native-screen-ended", problem);
      },
      (stats) => {
        if (nativeScreen === started && !event.sender.isDestroyed()) event.sender.send("zuna:native-screen-stats", stats);
      },
    );
    nativeScreen = started;
    return started.ready;
  });
  handle("zuna:native-screen-key", (_event, key: Uint8Array, keyIndex: number) => nativeScreen?.setKey(key, keyIndex));
  handle("zuna:native-screen-stop", () => {
    nativeScreen?.stop();
    nativeScreen = null;
  });
  // The computer's sound for a share, everything but Zuna or one app's, from the native program.
  handle("zuna:sound-apps", () => listSoundApps());
  handle("zuna:sound-window-app", (_event, source: unknown) => (typeof source === "string" ? windowSoundApp(source) : null));
  handle("zuna:native-sound-start", async (event, app: unknown) => {
    nativeSound?.stop();
    const { sound, ready } = startNativeSound(typeof app === "string" ? app : null, event.sender, (problem) => {
      if (nativeSound !== sound) return;
      nativeSound = null;
      if (!event.sender.isDestroyed()) event.sender.send("zuna:native-sound-ended", problem);
    });
    nativeSound = sound;
    try {
      await ready;
    } catch (error) {
      if (nativeSound === sound) nativeSound = null;
      throw error;
    }
  });
  handle("zuna:native-sound-stop", () => {
    nativeSound?.stop();
    nativeSound = null;
  });
  // Only the key asked about is ever reported, and only while someone holds it for talking.
  handle("zuna:watch-key", (event, code: string | null) => {
    stopKeyWatch?.();
    const send = (channel: string, value: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, value);
    };
    stopKeyWatch = code ? startKeyWatch(code, (down) => send("zuna:key", down), (trigger) => send("zuna:key-bound", trigger)) : null;
    return !!stopKeyWatch;
  });
  handle("zuna:key-watch-support", () => keyWatchSupport());
  // Whether the person is at the computer, for where notifications go: "active",
  // "idle" after this many seconds without input anywhere, or "locked".
  handle("zuna:idle-state", (_event, seconds: number) => powerMonitor.getSystemIdleState(Math.max(1, Math.round(seconds))));
  for (const [event, state] of [["lock-screen", "away"], ["suspend", "away"], ["unlock-screen", "back"], ["resume", "back"]] as const) {
    powerMonitor.on(event as "lock-screen", () => mainWindow?.webContents.send("zuna:presence", state));
  }
  const openConversation = (route: unknown) => {
    showWindow();
    mainWindow?.webContents.send("zuna:open-conversation", route);
  };
  if (process.platform === "win32") {
    const page = isDev && process.env["ELECTRON_RENDERER_URL"] ? `${process.env["ELECTRON_RENDERER_URL"]}/notifications.html` : `${APP_SCHEME}://${NOTIFICATIONS_HOST}/notifications.html`;
    ownNotifications = startNotifications({
      url: page,
      display: () => (mainWindow ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay()),
      open: openConversation,
      reply: (reply) => mainWindow?.webContents.send("zuna:notification-reply", reply),
    });
  }
  handle("zuna:notification-state", () => (process.platform === "win32" ? notificationState() : { show: true, sound: true, waitForInput: true }));
  handle("zuna:clear-notifications", (_event, which: unknown) => ownNotifications?.clear(which));
  handle("zuna:notify", (_event, payload: { title: string; body: string; route: unknown }) => {
    mainWindow?.flashFrame(true);
    if (ownNotifications) {
      ownNotifications.show(payload);
      return;
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: payload.title, body: payload.body, silent: true, icon: iconPath() });
    notifications.push(notification);
    const forget = () => {
      notifications = notifications.filter((item) => item !== notification);
    };
    notification.on("click", () => {
      forget();
      openConversation(payload.route);
    });
    notification.on("close", forget);
    notification.show();
  });
  handle("zuna:badge", (_event, count: number, pictures?: { overlay: string; tray: string }) => {
    const shown = count > 0 && pictures ? { overlay: nativeImage.createFromDataURL(pictures.overlay), tray: withCounter(trayIcon(), nativeImage.createFromDataURL(pictures.tray)) } : { overlay: null, tray: null };
    unread = { count, ...shown };
    showUnread();
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

/** Whether a program for capturing natively came with this build, for this system. */
function nativeScreenAvailable(): boolean {
  return (process.platform === "win32" || process.platform === "linux") && !!nativeScreenPath();
}

/** Where on the desktop the screen a source shows is, in the pixels the native capture counts in. */
function screenForSource(source: string): { x: number; y: number } | null {
  const displayId = displaySources.get(source)?.display_id;
  const display = screen.getAllDisplays().find((item) => String(item.id) === displayId);
  if (!display) return null;
  const inPixels = process.platform === "win32" ? screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y }) : display.bounds;
  return { x: inPixels.x + 1, y: inPixels.y + 1 };
}

function deviceLabel(): string {
  const names: Record<string, string> = { win32: "Windows PC", darwin: "Mac", linux: "Linux PC" };
  return names[process.platform] ?? "Computer";
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
    // The renderer needs notifications, the microphone and camera for voice channels and voice messages, and
    // where this device is for sharing it, which it only asks for when someone chooses to.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "notifications" || permission === "clipboard-sanitized-write" || permission === "geolocation" || permission === "media" || permission === "display-capture" || permission === "speaker-selection");
    });
    // A share that can't go natively goes through Chromium, as everything does on macOS. What it gets is
    // what was picked in the app, and nothing happens unless something has been. Its sound only comes
    // from Chromium on Windows in a build without the native program, which takes it otherwise.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const wanted = nextDisplay;
        nextDisplay = null;
        // Where the portal picks, Chromium asks it as well, for a share that couldn't go natively.
        if (wanted?.id === PORTAL_SCREEN || wanted?.id === PORTAL_WINDOW) {
          desktopCapturer.getSources({ types: [wanted.id === PORTAL_WINDOW ? "window" : "screen"] }).then(
            ([picked]) => callback(picked ? { video: picked } : {}),
            () => callback({}),
          );
          return;
        }
        const chosen = wanted ? displaySources.get(wanted.id) : undefined;
        const audio = wanted?.audio && process.platform === "win32";
        if (!chosen) {
          callback({});
          return;
        }
        callback(audio ? { video: chosen, audio: "loopback" } : { video: chosen });
      },
      // macOS can't say what there is to share without being asked first, and its own picker needs no asking.
      { useSystemPicker: process.platform === "darwin" },
    );
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
    startUpdates();
    app.on("activate", showWindow);
  });

  app.on("before-quit", () => {
    quitting = true;
    nativeScreen?.stop();
    nativeSound?.stop();
    stopKeyWatch?.();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && (!tray || isDev)) app.quit();
  });
}
