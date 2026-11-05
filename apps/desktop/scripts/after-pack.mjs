// Runs once electron-builder has put the app together, before it makes the packages.
// Electron's zip for Linux has every file writable by anyone (0777 and 0666), which the
// .deb, .rpm and pacman package kept, so any user on the computer could change the app
// in /opt/Zuna that someone else runs. Nobody but the owner writes anything in it now.
import { lstat, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";

async function ownerWritesOnly(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await chmod(path, stats.mode & 0o7755);
  if (stats.isDirectory()) {
    for (const name of await readdir(path)) await ownerWritesOnly(join(path, name));
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName === "linux") await ownerWritesOnly(context.appOutDir);
}
