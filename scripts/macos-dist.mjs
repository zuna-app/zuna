// Signs, notarizes and packages the macOS app that scripts/macos-app.mjs builds. In
// .github/workflows/release.yml one job builds the app holding no secret, signed ad hoc, and
// another signs it again here with the macos environment's Developer ID and notary key, building
// nothing and running nothing from npm. `npm run dist:macos` runs the same steps with this Mac's
// keychain instead. docs/RELEASES.md, "The app on macOS", says how it fits.
//
//   node scripts/macos-dist.mjs sign <Zuna.app> [backgrounds folder]
//       signs it with the macos environment's secrets, notarizes and staples it, then makes a DMG
//       of it, signed, notarized and stapled too, as dist/macos/Zuna-<ZUNA_LABEL>-arm64.dmg
//   node scripts/macos-dist.mjs secrets <folder> --issuer <id>
//       checks a Developer ID .p12 and an App Store Connect key in a folder, and makes them those secrets

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./lib.mjs";
import { askHidden, connectKey, fail, folderAndIssuer, holdEnvironment, keychainWith, main, needSecrets, one, plist, run, searchFirst, setSecrets } from "./signing.mjs";

/** The environment whose secrets sign and notarize the app, which every release's tag reaches. */
export const ENVIRONMENT = "macos";
const TAGS = "v*";
export const SECRETS = ["MACOS_DEVELOPER_ID_P12", "MACOS_DEVELOPER_ID_P12_PASSWORD", "NOTARY_KEY", "NOTARY_KEY_ID", "NOTARY_ISSUER_ID"];
const DEVELOPER_ID = "Developer ID Application";

/** What the app may reach under the hardened runtime: the microphone, and a share's sound read from a tap's aggregate device, the camera and the location. */
export const RIGHTS = {
  "com.apple.security.device.audio-input": true,
  "com.apple.security.device.camera": true,
  "com.apple.security.personal-information.location": true,
};

/** The DMG's name: the label its release carries, as the Windows installer's and the Linux packages' are. */
export const dmgName = (label) => `Zuna-${label}-arm64.dmg`;

/** The DMG's window's backgrounds, drawn at 1× and 2× by scripts/macos-app.mjs, which dmgbuild makes one TIFF of. */
export const BACKGROUNDS = ["dmg-background.png", "dmg-background@2x.png"];

/**
 * Signs a bundle, what's inside first, then the bundle, which seals them. With an identity, under
 * the hardened runtime with the app's entitlements: a release's timestamped, as notarizing asks,
 * and a development build's debuggable. Ad hoc (no identity) without, as an ad hoc signature has
 * no team for the runtime to check the libraries the app loads against.
 */
export function signApp(app, signer, { distribution }) {
  const work = mkdtempSync(join(tmpdir(), "zuna-macos-"));
  try {
    const rights = join(work, "zuna.entitlements");
    writeFileSync(rights, plist({ ...RIGHTS, ...(distribution ? {} : { "com.apple.security.get-task-allow": true }) }));
    const options = signer ? ["--options", "runtime", distribution ? "--timestamp" : "--timestamp=none"] : ["--timestamp=none"];
    const sign = (path, entitled) => {
      const signed = spawnSync("codesign", ["--force", "--sign", signer ?? "-", ...options, ...(signer && entitled ? ["--entitlements", rights] : []), path], { stdio: ["ignore", "ignore", "inherit"] });
      if (signed.status !== 0) fail(`codesign couldn't sign ${path}`);
    };
    // The media library and FFmpeg's libraries, which name each other through @rpath.
    const frameworks = join(app, "Contents", "Frameworks");
    if (existsSync(frameworks)) for (const name of readdirSync(frameworks).filter((name) => name.endsWith(".dylib")).sort()) sign(join(frameworks, name), false);
    sign(app, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Zips a bundle as `ditto` keeps one, with its links and extended attributes, so that its signature holds. */
export function zipApp(app, out) {
  rmSync(out, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, out]);
}

/** Sends a zip or a DMG to Apple's notary service and waits for its answer, with Apple's log if it's refused. */
function notarize(file, auth, hint) {
  console.log(`> notarizing ${basename(file)}, which takes a few minutes`);
  const sent = spawnSync("xcrun", ["notarytool", "submit", file, ...auth, "--wait", "--output-format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  let answer = {};
  try {
    answer = JSON.parse((sent.stdout ?? "").trim().split("\n").at(-1));
  } catch {}
  if (answer.status === "Accepted") return;
  if (answer.id) spawnSync("xcrun", ["notarytool", "log", answer.id, ...auth], { stdio: "inherit" });
  fail(`Apple's notary service didn't accept ${basename(file)}${answer.status ? `: ${answer.status}` : ""}.${answer.id ? "" : ` ${hint}`}`);
}

/**
 * dmgbuild, which lays out a DMG's window as electron-builder's were: the bundle of it with its
 * own Python that electron-builder publishes, fetched once and pinned by the hash its dmg-builder
 * 26.18 pins.
 */
async function dmgbuild() {
  const name = "dmgbuild-bundle-arm64-75c8a6c.tar.gz";
  const hash = "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb";
  const dir = join(homedir(), "Library", "Caches", "zuna-dmgbuild-75c8a6c");
  const program = join(dir, "dmgbuild");
  if (existsSync(program)) return program;
  const response = await fetch(`https://github.com/electron-userland/electron-builder-binaries/releases/download/dmg-builder@1.2.5/${name}`);
  if (!response.ok) fail(`dmgbuild: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== hash) fail("dmgbuild's bundle isn't the one pinned.");
  const unpacking = `${dir}.part`;
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(unpacking, { recursive: true });
  writeFileSync(join(unpacking, name), archive);
  run("tar", ["-xzf", join(unpacking, name), "-C", unpacking]);
  rmSync(join(unpacking, name));
  rmSync(dir, { recursive: true, force: true });
  renameSync(unpacking, dir);
  return program;
}

/**
 * Notarizes a signed app and staples Apple's ticket to it, then makes a DMG of it to drag into
 * Applications, signed, notarized and stapled too, and asks Gatekeeper about both, as it would
 * about a download. `zip` adds the app zipped, as an update would be fetched. Gives the files made.
 */
export async function packageApp(app, { signer, auth, hint, backgrounds, out, label, zip = false }) {
  for (const file of BACKGROUNDS) if (!existsSync(join(backgrounds, file))) fail(`${join(backgrounds, file)} isn't there: scripts/macos-app.mjs draws it beside the app.`);
  run("codesign", ["--verify", "--strict", "--deep", "--verbose=2", app]);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "zuna-macos-"));
  try {
    // The app first, so that the one in the DMG carries its ticket and opens offline too.
    const upload = join(work, "Zuna-notarize.zip");
    zipApp(app, upload);
    notarize(upload, auth, hint);
    run("xcrun", ["stapler", "staple", app]);
    // The DMG: the app beside a link to Applications, on its background.
    const image = join(out, dmgName(label));
    rmSync(image, { force: true });
    const settings = join(work, "dmg.json");
    writeFileSync(
      settings,
      JSON.stringify({
        title: "Zuna",
        icon: join(app, "Contents", "Resources", "zuna.icns"),
        background: join(backgrounds, BACKGROUNDS[0]),
        "icon-size": 128,
        "text-size": 12,
        window: { position: { x: 400, y: 240 }, size: { width: 660, height: 400 } },
        format: "ULFO",
        contents: [
          { x: 170, y: 170, type: "file", path: app, hide_extension: true },
          { x: 490, y: 170, type: "link", path: "/Applications" },
        ],
      }),
    );
    run(await dmgbuild(), ["-s", settings, "Zuna", image]);
    run("codesign", ["--sign", signer, "--timestamp", image]);
    notarize(image, auth, hint);
    run("xcrun", ["stapler", "staple", image]);
    const made = [image];
    if (zip) {
      made.push(join(out, `Zuna-${label}-arm64.zip`));
      zipApp(app, made[1]);
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", image]);
    console.log(`> wrote ${made.join(" and ")}`);
    return made;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- In the release workflow ---

/** Signs an app built with an ad hoc signature with the environment's Developer ID, and packages it. */
async function sign([path, backgroundsPath]) {
  const app = resolve(path ?? "");
  if (!path || !existsSync(join(app, "Contents", "Info.plist"))) fail("node scripts/macos-dist.mjs sign <Zuna.app> [backgrounds folder]");
  const label = process.env.ZUNA_LABEL;
  if (!label) fail("ZUNA_LABEL isn't set, which names the DMG as its release.");
  needSecrets(SECRETS, ENVIRONMENT, 'docs/RELEASES.md, "The app on macOS"');
  const work = mkdtempSync(join(tmpdir(), "zuna-macos-"));
  const undo = [];
  try {
    const signing = keychainWith(work, Buffer.from(process.env.MACOS_DEVELOPER_ID_P12, "base64"), process.env.MACOS_DEVELOPER_ID_P12_PASSWORD, DEVELOPER_ID);
    undo.push(signing.remove);
    undo.push(searchFirst(signing.keychain));
    console.log(`Signing with ${signing.identity}.`);
    const keyId = process.env.NOTARY_KEY_ID.trim();
    if (!/^[A-Z0-9]{6,}$/.test(keyId)) fail("NOTARY_KEY_ID isn't a key's ID, like the 2X9R4HXF34 in AuthKey_2X9R4HXF34.p8.");
    const key = join(work, `AuthKey_${keyId}.p8`);
    writeFileSync(key, `${process.env.NOTARY_KEY.trim()}\n`, { mode: 0o600 });
    const auth = ["--key", key, "--key-id", keyId, "--issuer", process.env.NOTARY_ISSUER_ID.trim()];
    signApp(app, signing.certificate, { distribution: true });
    await packageApp(app, { signer: signing.certificate, auth, hint: "Check the macos environment's NOTARY_ secrets.", backgrounds: resolve(backgroundsPath ?? dirname(app)), out: join(root, "dist", "macos"), label });
  } finally {
    for (const step of undo.reverse()) step();
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Checks a Developer ID .p12 and an App Store Connect key in a folder, the key against Apple's
 * notary service itself, and makes them the macos environment's secrets, making the environment
 * first if it isn't there. Nothing is shown.
 */
async function secrets(args) {
  const { dir, issuer, files } = folderAndIssuer(args, "node scripts/macos-dist.mjs secrets <folder> --issuer <issuer ID>");
  const p12 = one(dir, files, "Developer ID certificate as .p12", (name) => name.endsWith(".p12"));
  const keyFile = one(dir, files, "App Store Connect key, AuthKey_<ID>.p8", (name) => /^AuthKey_[A-Z0-9]+\.p8$/.test(name));
  const key = connectKey(keyFile);
  if (!key.text.startsWith("-----BEGIN PRIVATE KEY-----")) fail(`${basename(keyFile)} isn't a private key as App Store Connect gives it.`);

  const password = await askHidden(`The password ${basename(p12)} was exported with: `);
  const work = mkdtempSync(join(tmpdir(), "zuna-macos-"));
  try {
    const signing = keychainWith(work, readFileSync(p12), password, DEVELOPER_ID);
    signing.remove();
    console.log(`${basename(p12)} holds ${signing.identity}.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // The key against the notary service, which says at once whether it may notarize.
  const asked = spawnSync("xcrun", ["notarytool", "history", "--key", keyFile, "--key-id", key.id, "--issuer", issuer, "--output-format", "json"], { encoding: "utf8" });
  if (asked.status !== 0) fail(`Apple's notary service refused AuthKey_${key.id}.p8 with that issuer ID:\n${(asked.stderr || asked.stdout).trim()}\nIt needs a team key, with Developer access or more.`);
  console.log(`Apple's notary service takes AuthKey_${key.id}.p8.`);

  holdEnvironment(ENVIRONMENT, TAGS);
  const values = { MACOS_DEVELOPER_ID_P12: readFileSync(p12).toString("base64"), MACOS_DEVELOPER_ID_P12_PASSWORD: password, NOTARY_KEY: key.text, NOTARY_KEY_ID: key.id, NOTARY_ISSUER_ID: issuer };
  setSecrets(ENVIRONMENT, Object.fromEntries(SECRETS.map((name) => [name, values[name]])));
  console.log(
    `\nSet the ${SECRETS.length} secrets of the ${ENVIRONMENT} environment. The next release that changes the app has a DMG.\n` +
      `Delete ${basename(p12)} and ${basename(keyFile)} now: GitHub has them, and the certificate and its key stay in this Mac's keychain.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main({ sign, secrets }, process.argv.slice(2));
}
