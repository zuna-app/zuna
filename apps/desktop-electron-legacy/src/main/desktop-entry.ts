// On Linux the applications menu, `zuna://` links and the global shortcuts portal all find
// the app by its .desktop file, `zuna-legacy.desktop`, named after `desktopName` in package.json,
// which Electron also names its systemd scope after. The .deb, .rpm and pacman packages
// install it in /usr/share/applications. An AppImage or a .tar.gz has nowhere to put one,
// so it writes this person's own each time it starts, pointing at wherever it is now, and
// takes it away again once a package has one.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const NAME = "zuna-legacy.desktop";
/** Marks a .desktop file as one this wrote, so it never changes or removes anyone else's. */
const MARK = "X-Zuna-Written-By-Itself=true";

function dataHome(): string {
  const set = process.env.XDG_DATA_HOME;
  return set?.startsWith("/") ? set : join(homedir(), ".local/share");
}

/** Where packages install, without this person's own, which some systems list too. */
function systemDataDirs(): string[] {
  const home = resolve(dataHome());
  return (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((dir) => dir.startsWith("/") && resolve(dir) !== home);
}

/** A string value as the desktop entry specification escapes it. */
function escaped(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

/** A path as one argument of Exec, quoted as the specification asks, before a string's own escapes. */
function execArgument(path: string): string {
  if (/^[\w/.+-]+$/.test(path)) return path;
  return escaped(`"${path.replace(/["`$\\]/g, "\\$&")}"`).replace(/%/g, "%%");
}

/** The program to start: an AppImage by its own path, as what runs is a copy that's gone once it stops. */
function program(): string {
  const { APPIMAGE, APPDIR } = process.env;
  // Another AppImage's, handed down through whatever started this one, isn't this.
  if (APPIMAGE && APPDIR && process.execPath.startsWith(`${APPDIR}/`)) return APPIMAGE;
  return process.execPath;
}

/** Writes this person's `zuna-legacy.desktop` for an AppImage or a .tar.gz, or takes it away once a package has one. */
export function keepDesktopEntry(icon: string): void {
  if (process.platform !== "linux" || !app.isPackaged) return;
  const own = join(dataHome(), "applications", NAME);
  try {
    const existing = existsSync(own) ? readFileSync(own, "utf8") : null;
    const ours = existing?.split("\n").includes(MARK) ?? false;
    if (systemDataDirs().some((dir) => existsSync(join(dir, "applications", NAME)))) {
      // This person's own goes first, so it would hide the package's.
      if (ours) rmSync(own, { force: true });
      return;
    }
    if (existing !== null && !ours) return;
    const path = program();
    // A line break in the path would start a line of its own.
    if (/[\x00-\x1f\x7f]/.test(path)) return;

    // What runs from an AppImage is gone once it stops, so the menu's icon is a copy.
    const picture = join(dataHome(), "icons", "zuna-legacy.png");
    const drawn = readFileSync(icon);
    if (!existsSync(picture) || !readFileSync(picture).equals(drawn)) {
      mkdirSync(dirname(picture), { recursive: true });
      writeFileSync(picture, drawn);
    }

    const { description } = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { description?: string };
    // As the packages' own, from electron-builder.yml, and gone from the menu once the program is.
    const text = [
      "[Desktop Entry]",
      // As the packages' own, so the menu tells it from the native app, which is Zuna.
      "Name=Zuna Legacy",
      ...(description ? [`Comment=${escaped(description)}`] : []),
      `Exec=${execArgument(path)} %U`,
      `TryExec=${escaped(path)}`,
      "Terminal=false",
      "Type=Application",
      `Icon=${escaped(picture)}`,
      "StartupWMClass=zuna-legacy",
      "MimeType=x-scheme-handler/zuna;",
      "Categories=Network;InstantMessaging;",
      MARK,
      "",
    ].join("\n");
    if (text === existing) return;
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, text, { mode: 0o644 });
  } catch (error) {
    console.warn("[zuna] couldn't add Zuna to the applications menu:", error);
  }
}
