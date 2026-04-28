import { BrowserWindow, screen } from "electron";
import * as path from "path";

const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 600;

let notificationWindowHost: BrowserWindow | null = null;

const loadNotificationRenderer = (window: BrowserWindow) => {
  if (NOTIFICATION_HOST_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(NOTIFICATION_HOST_WINDOW_VITE_DEV_SERVER_URL);
    url.pathname = "/";
    window.loadURL(url.toString());
    return;
  }

  window.loadFile(
    path.join(
      __dirname,
      `../renderer/${NOTIFICATION_HOST_WINDOW_VITE_NAME}/index.html`,
    ),
  );
};

export const createNotificationWindowHost = () => {
  if (notificationWindowHost && !notificationWindowHost.isDestroyed()) {
    return notificationWindowHost;
  }

  notificationWindowHost = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notificationWindowHost.on("closed", () => {
    notificationWindowHost = null;
  });

  loadNotificationRenderer(notificationWindowHost);

  return notificationWindowHost;
};

export const showNotificationWindowHost = (options?: {
  height?: number;
  x?: number;
  y?: number;
  mainWindow?: BrowserWindow;
}) => {
  const host = createNotificationWindowHost();
  const width = DEFAULT_WIDTH;
  const height = options?.height ?? host.getBounds().height;

  host.setSize(width, height);

  if (typeof options?.x === "number" && typeof options?.y === "number") {
    host.setPosition(options.x, options.y);
  } else {
    const referencePoint =
      options?.mainWindow && !options.mainWindow.isDestroyed()
        ? (() => {
            const b = options.mainWindow.getBounds();
            return {
              x: b.x + Math.floor(b.width / 2),
              y: b.y + Math.floor(b.height / 2),
            };
          })()
        : screen.getCursorScreenPoint();

    const display = screen.getDisplayNearestPoint(referencePoint);
    const {
      x,
      y,
      width: displayWidth,
      height: displayHeight,
    } = display.workArea;
    const padding = 16;
    const targetX = x + displayWidth - width - padding;
    const targetY = y + displayHeight - height - padding;
    host.setPosition(targetX, targetY);
  }

  if (!host.isVisible()) {
    host.showInactive();
  }
};

export const hideNotificationWindowHost = () => {
  if (!notificationWindowHost || notificationWindowHost.isDestroyed()) {
    return;
  }

  notificationWindowHost.hide();
};

export const resizeNotificationWindowHost = (
  height: number,
  mainWindow?: BrowserWindow,
) => {
  if (!notificationWindowHost || notificationWindowHost.isDestroyed()) {
    return;
  }

  const padding = 16;
  const width = DEFAULT_WIDTH;

  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    const center = {
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    };
    const {
      x,
      y,
      width: dw,
      height: dh,
    } = screen.getDisplayNearestPoint(center).workArea;
    notificationWindowHost.setBounds({
      x: x + dw - width - padding,
      y: y + dh - height - padding,
      width,
      height,
    });
  } else {
    const bounds = notificationWindowHost.getBounds();
    notificationWindowHost.setBounds({
      x: bounds.x,
      y: bounds.y + (bounds.height - height),
      width: bounds.width,
      height,
    });
  }
};

export const isNotificationWindowHostVisible = () => {
  if (!notificationWindowHost || notificationWindowHost.isDestroyed()) {
    return false;
  }

  return notificationWindowHost.isVisible();
};

export const getNotificationWindowHost = () => notificationWindowHost;
