// Deletes everything the test server and the development app have stored, so the
// next start is like a fresh install. It only ever touches .dev-data in this
// repository, so an installed copy of Zuna is never affected.
import { existsSync, renameSync, rmSync } from "node:fs";
import { devData, devServerRunning } from "./lib.mjs";

if (!existsSync(devData)) {
  console.log("Already clean. There's no development data.");
  process.exit(0);
}

if (await devServerRunning()) {
  console.error("The test server is still running. Close its window or press Ctrl+C in it, then try again.");
  process.exit(1);
}

// On Windows this fails while anything inside is in use, so it's all or nothing.
const removing = `${devData}-removing-${Date.now()}`;
try {
  renameSync(devData, removing);
} catch (error) {
  if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
  console.error("Something is still using the development data. Close the development app, then try again.");
  process.exit(1);
}
rmSync(removing, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

console.log("Clean. The next start of the app and the test server will be like a fresh install.");
