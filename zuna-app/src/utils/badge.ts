import { app, BrowserWindow, nativeImage } from "electron";
import { execFile } from "child_process";

export async function setBadgeCount(count: number) {
  if (process.platform === "win32") {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    const badgeIcon = await createWindowsBadgeIcon(count);
    mainWindow.setOverlayIcon(badgeIcon, `${count} unread messages`);
  }

  else if (process.platform === "linux") {
    const launcherEntry = `{'count-visible': <${count > 0}>, 'count': <${count}>}`;
    const args = [
      "emit",
      "--session",
      "--object-path",
      "/com/canonical/unity/launcherentry/0",
      "--signal",
      "com.canonical.Unity.LauncherEntry.Update",
      "application://zuna-app.desktop",
      launcherEntry,
    ];

    execFile("gdbus", args, error => {
      if (error) {
        console.warn("Failed to set Linux badge count:", error);
      }
    });
  }

  else if (process.platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
  }
}

function createBadgeSVG(count: number) {
  const text = count > 99 ? "99+" : String(count);

  let fontSize = 25;
  if (text.length === 2) fontSize = 19;
  if (text.length >= 3) fontSize = 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <circle cx="16" cy="16" r="15" fill="#E81123"/>
      <text x="16" y="24"
            font-size="${fontSize}"
            font-weight="bold"
            text-anchor="middle"
            fill="white"
            font-family="Segoe UI, Arial, sans-serif">
        ${text}
      </text>
  </svg>`;
}

async function createWindowsBadgeIcon(count: number) {
  if (process.platform !== "win32") {
    return null;
  }

  const svg = createBadgeSVG(count);

  const { default: sharp } = await import("sharp");
  const png = await sharp(Buffer.from(svg))
    .resize(32, 32) // render high-res first
    .png()
    .toBuffer();

  return nativeImage.createFromBuffer(png).resize({ width: 16, height: 16 });
}