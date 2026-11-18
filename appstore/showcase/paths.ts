// Where the showcase scripts keep what they make, and the pictures they give people.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The people's faces, the servers' icons and the photos they share. */
export const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));
/** Each person's device, the invites, and the servers' setup links: ZUNA_SHOWCASE, or .dev-data/showcase. */
export const DATA = process.env.ZUNA_SHOWCASE ?? join(ROOT, ".dev-data", "showcase");
