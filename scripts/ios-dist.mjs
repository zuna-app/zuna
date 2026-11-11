// Sends the iPhone app to TestFlight, in two halves that .github/workflows/release.yml runs as two
// jobs: one builds it holding no secret at all, the other signs and uploads it, running nothing but
// Xcode and this script. docs/RELEASES.md, "The iPhone app on TestFlight", says how it fits.
//
//   node scripts/ios-dist.mjs archive                    archives the app, unsigned, into dist/ios/Zuna.xcarchive
//   node scripts/ios-dist.mjs upload [archive]           signs it with the testflight environment's secrets, checks it, uploads it
//   node scripts/ios-dist.mjs export [archive]           signs it with Xcode's own account and checks it, uploading nothing
//   node scripts/ios-dist.mjs secrets <folder> --issuer <id>   checks the signing files in a folder and makes them those secrets
//
// Xcode won't sign an iPhone app ad hoc, and an archive built with no signature loses its
// entitlements on export: the export takes them from each binary's signature, so without one the
// app would go out with no push, app group or shared keychain, and nothing would say so. So
// `archive` signs each bundle ad hoc itself, with codesign and the entitlements files in apps/ios,
// and the export replaces that signature with the real one, keeping them. `upload` and `export`
// then check every bundle of what they made against those files.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testOnlyCode } from "./check-ios-release.mjs";
import { env, root } from "./lib.mjs";
import { TESTFLIGHT } from "./release.mjs";
import { askHidden, connectKey, fail, field, folderAndIssuer, holdEnvironment, keychainWith, main, needSecrets, one, plist, plistOf, read, run, searchFirst, setSecrets } from "./signing.mjs";

export { plist };

const iosDir = join(root, "apps", "ios");
const out = join(root, "dist", "ios");
const ARCHIVE = join(out, "Zuna.xcarchive");

/** The environment whose secrets sign and upload the app, and the tags that reach it. */
const ENVIRONMENT = TESTFLIGHT;
const TAGS = "v*-nightly.*";

/** Every bundle the app ships, by its identifier, with the secret its App Store profile is kept in. */
export const PROFILES = {
  "chat.zuna.mobile": "IOS_PROFILE_APP",
  "chat.zuna.mobile.notifications": "IOS_PROFILE_NOTIFICATIONS",
  "chat.zuna.mobile.broadcast": "IOS_PROFILE_BROADCAST",
  "chat.zuna.mobile.share": "IOS_PROFILE_SHARE",
};

/** Everything `upload` needs, as the environment's secrets. */
export const SECRETS = ["IOS_DISTRIBUTION_P12", "IOS_DISTRIBUTION_P12_PASSWORD", ...Object.values(PROFILES), "APP_STORE_CONNECT_KEY", "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_ISSUER_ID"];

/** The team the app is signed for, from the XcodeGen spec. */
const team = () => /^\s*DEVELOPMENT_TEAM:\s*(\w+)/m.exec(readFileSync(join(iosDir, "project.yml"), "utf8"))[1];

/** The app's extensions, then the app: the order a signature has to go in, inside out. */
function bundlesOf(app) {
  const plugins = join(app, "PlugIns");
  const extensions = existsSync(plugins) ? readdirSync(plugins).filter((name) => name.endsWith(".appex")).sort().map((name) => join(plugins, name)) : [];
  return [...extensions, app];
}

/** A bundle's entitlements file in apps/ios, named after its target, which its executable is too. */
function entitlementsFile(bundle) {
  const name = field(join(bundle, "Info.plist"), "CFBundleExecutable");
  const file = join(iosDir, name, `${name}.entitlements`);
  return existsSync(file) ? file : null;
}

/** What a bundle's entitlements file asks for, with the team's prefix where Xcode would put it. */
export function filled(entitlements, prefix) {
  const fill = (value) => (typeof value === "string" ? value.replaceAll("$(AppIdentifierPrefix)", prefix) : Array.isArray(value) ? value.map(fill) : value);
  return Object.fromEntries(Object.entries(entitlements).map(([key, value]) => [key, fill(value)]));
}

/**
 * What's wrong with a bundle of a TestFlight build, signed: its entitlements against what its
 * file asks for, with push on Apple's production service, as a distribution profile makes it.
 */
export function entitlementProblems(name, wanted, got) {
  const problems = [];
  for (const [key, value] of Object.entries(wanted)) {
    const expected = key === "aps-environment" ? "production" : value;
    if (JSON.stringify(got[key]) !== JSON.stringify(expected)) problems.push(`${name} has ${key} ${JSON.stringify(got[key]) ?? "missing"}, not ${JSON.stringify(expected)}.`);
  }
  if (got["get-task-allow"] !== false) problems.push(`${name} can be debugged: get-task-allow isn't false.`);
  if (got["beta-reports-active"] !== true) problems.push(`${name} isn't signed for TestFlight: beta-reports-active isn't true.`);
  return problems;
}

/** A provisioning profile, read. */
function profileOf(file) {
  const xml = read("security", ["cms", "-D", "-i", file]);
  const value = (key) => field(null, key, xml);
  const certificates = [];
  for (let index = 0; ; index++) {
    const der = value(`DeveloperCertificates.${index}`);
    if (der === undefined) break;
    certificates.push(createHash("sha1").update(Buffer.from(der, "base64")).digest("hex").toUpperCase());
  }
  const app = value("Entitlements.application-identifier") ?? "";
  return {
    uuid: value("UUID"),
    name: value("Name"),
    team: value("TeamIdentifier.0"),
    bundle: app.slice(app.indexOf(".") + 1),
    debuggable: value("Entitlements.get-task-allow") === "true",
    devices: value("ProvisionedDevices") !== undefined || value("ProvisionsAllDevices") === "true",
    expires: new Date(value("ExpirationDate") ?? 0),
    certificates,
  };
}

/** Why a profile can't sign a bundle for TestFlight with a certificate, or null when it can. */
export function profileProblem(profile, { bundle, team, certificate, now = new Date() }) {
  if (profile.bundle !== bundle) return `it's the profile of ${profile.bundle || "no app"}, not of ${bundle}.`;
  if (profile.team !== team) return `it's team ${profile.team}'s, not ${team}'s.`;
  if (profile.devices || profile.debuggable) return "it's a development or ad hoc profile, not an App Store one.";
  if (!(profile.expires > now)) return `it expired on ${profile.expires.toISOString().slice(0, 10)}.`;
  if (certificate && !profile.certificates.includes(certificate)) return "it wasn't made with the distribution certificate given with it. Make it again, choosing that certificate.";
  return null;
}

// --- Archiving ---

/** Archives the app in Release with no signature, then signs each bundle ad hoc with its entitlements. */
function archive() {
  for (const built of ["ZunaKit/Frameworks/ZunaCryptoFFI.xcframework", "ZunaKit/Sources/ZunaHost/Resources/zuna-core.js"]) {
    if (!existsSync(join(iosDir, built))) fail(`apps/ios/${built} isn't there: npm run build:ios first.`);
  }
  const build = process.env.ZUNA_BUILD || read("git", ["rev-list", "--count", "HEAD"]).trim();
  if (!/^\d+$/.test(build)) fail(`"${build}" isn't a build number.`);

  run("xcodegen", ["generate", "--spec", "project.yml", "--quiet"], { cwd: iosDir });
  rmSync(ARCHIVE, { recursive: true, force: true });
  run(
    "xcodebuild",
    [
      "-project", "Zuna.xcodeproj", "-scheme", "Zuna", "-configuration", "Release", "-destination", "generic/platform=iOS",
      "-archivePath", ARCHIVE, "-derivedDataPath", join(iosDir, "build", "ArchiveData"),
      `CURRENT_PROJECT_VERSION=${build}`, "CODE_SIGNING_ALLOWED=NO", "-quiet", "archive",
    ],
    { cwd: iosDir },
  );

  const app = join(ARCHIVE, "Products", "Applications", "Zuna.app");
  const prefix = `${team()}.`;
  const work = mkdtempSync(join(tmpdir(), "zuna-ios-"));
  try {
    for (const bundle of bundlesOf(app)) {
      const frameworks = join(bundle, "Frameworks");
      if (existsSync(frameworks)) {
        for (const name of readdirSync(frameworks).filter((name) => name.endsWith(".framework") || name.endsWith(".dylib"))) {
          run("codesign", ["--force", "--sign", "-", "--timestamp=none", join(frameworks, name)]);
        }
      }
      const args = ["--force", "--sign", "-", "--timestamp=none"];
      const file = entitlementsFile(bundle);
      if (file) {
        const prefixed = join(work, basename(file));
        writeFileSync(prefixed, readFileSync(file, "utf8").replaceAll("$(AppIdentifierPrefix)", prefix));
        args.push("--entitlements", prefixed);
      }
      run("codesign", [...args, bundle]);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  run("codesign", ["--verify", "--deep", "--strict", app]);

  const found = testOnlyCode(app);
  if (found.length > 0) fail(`The archived app contains test-only code: ${found.join(", ")}`);
  console.log(`Archived Zuna ${field(join(app, "Info.plist"), "CFBundleShortVersionString")}, build ${build}, in ${ARCHIVE}: signed ad hoc with its entitlements, and with no test-only code.`);
}

// --- Signing, checking and uploading ---

/** The certificate, profiles and App Store Connect key from the environment, put where Xcode and altool look. */
function installSigning(work, teamId) {
  needSecrets(SECRETS, ENVIRONMENT, 'docs/RELEASES.md, "The iPhone app on TestFlight"');
  const undo = [];
  const remove = () => {
    for (const step of undo.reverse()) step();
  };
  try {
    const signing = keychainWith(work, Buffer.from(process.env.IOS_DISTRIBUTION_P12, "base64"), process.env.IOS_DISTRIBUTION_P12_PASSWORD, "Apple Distribution");
    undo.push(signing.remove);
    undo.push(searchFirst(signing.keychain));
    console.log(`Signing with ${signing.identity}.`);

    const folder = join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles");
    mkdirSync(folder, { recursive: true });
    const profiles = {};
    for (const [bundle, secret] of Object.entries(PROFILES)) {
      const file = join(work, `${secret}.mobileprovision`);
      writeFileSync(file, Buffer.from(process.env[secret], "base64"));
      const profile = profileOf(file);
      const problem = profileProblem(profile, { bundle, team: teamId, certificate: signing.certificate });
      if (problem) fail(`${secret}: ${problem}`);
      const installed = join(folder, `${profile.uuid}.mobileprovision`);
      if (!existsSync(installed)) {
        copyFileSync(file, installed);
        undo.push(() => rmSync(installed, { force: true }));
      }
      profiles[bundle] = profile.uuid;
    }

    const keyId = process.env.APP_STORE_CONNECT_KEY_ID.trim();
    if (!/^[A-Z0-9]{6,}$/.test(keyId)) fail("APP_STORE_CONNECT_KEY_ID isn't a key's ID, like the 2X9R4HXF34 in AuthKey_2X9R4HXF34.p8.");
    const keys = join(work, "private_keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, `AuthKey_${keyId}.p8`), `${process.env.APP_STORE_CONNECT_KEY.trim()}\n`, { mode: 0o600 });
    return { profiles, keys, keyId, issuer: process.env.APP_STORE_CONNECT_ISSUER_ID.trim(), remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/** Fails unless every bundle of the exported app is this build, signed for distribution, with its entitlements. */
function check(ipa, build, prefix, work) {
  const unpacked = join(work, "ipa");
  run("ditto", ["-x", "-k", ipa, unpacked]);
  const app = join(unpacked, "Payload", "Zuna.app");
  const problems = [];
  for (const bundle of bundlesOf(app)) {
    const name = basename(bundle);
    const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", bundle], { encoding: "utf8" });
    if (verified.status !== 0) problems.push(`${name}'s signature doesn't verify: ${verified.stderr.trim()}`);
    if (!/^Authority=Apple Distribution: /m.test(spawnSync("codesign", ["-dvv", bundle], { encoding: "utf8" }).stderr)) problems.push(`${name} isn't signed with an Apple Distribution certificate.`);
    const version = field(join(bundle, "Info.plist"), "CFBundleVersion");
    if (version !== build) problems.push(`${name} is build ${version}, not ${build}.`);
    const file = entitlementsFile(bundle);
    const xml = read("codesign", ["-d", "--entitlements", "-", "--xml", bundle]).trim();
    const got = xml ? JSON.parse(read("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml })) : {};
    problems.push(...entitlementProblems(name, file ? filled(plistOf(file), prefix) : {}, got));
  }
  if (field(join(app, "Info.plist"), "TFInternalTestingOnly") !== "true") problems.push("Zuna.app isn't marked for the team's own testers only (TFInternalTestingOnly).");
  if (problems.length > 0) fail(`The exported app isn't what TestFlight should get:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  console.log(`Checked the exported app: every bundle is build ${build}, signed for distribution, with the entitlements apps/ios asks for, and it's for the team's own testers only.`);
}

/** Exports the archive for App Store Connect, checks it, and uploads it or keeps it in dist/ios. */
function distribute(path, upload) {
  const archived = resolve(path ?? ARCHIVE);
  const app = join(archived, "Products", "Applications", "Zuna.app");
  if (!existsSync(app)) fail(`${archived} isn't an archive of Zuna: it has no Products/Applications/Zuna.app.`);
  const build = field(join(app, "Info.plist"), "CFBundleVersion");
  const teamId = team();
  const work = mkdtempSync(join(tmpdir(), "zuna-ios-"));
  let signing = null;
  try {
    // Nightlies are for the people on the team: a build marked so can't go to outside testers or the App Store.
    const options = { method: "app-store-connect", destination: "export", teamID: teamId, uploadSymbols: true, manageAppVersionAndBuildNumber: false, testFlightInternalTestingOnly: true };
    const extra = [];
    if (upload) {
      signing = installSigning(work, teamId);
      Object.assign(options, { signingStyle: "manual", signingCertificate: "Apple Distribution", provisioningProfiles: signing.profiles });
    } else {
      Object.assign(options, { signingStyle: "automatic" });
      extra.push("-allowProvisioningUpdates");
    }
    const optionsFile = join(work, "ExportOptions.plist");
    writeFileSync(optionsFile, plist(options));
    const exported = join(work, "export");
    run("xcodebuild", ["-exportArchive", "-archivePath", archived, "-exportOptionsPlist", optionsFile, "-exportPath", exported, ...extra], { cwd: iosDir });
    const ipa = join(exported, "Zuna.ipa");
    check(ipa, build, `${teamId}.`, work);

    if (upload) {
      run("xcrun", ["altool", "--upload-package", ipa, "--api-key", signing.keyId, "--api-issuer", signing.issuer], { env: { ...env, API_PRIVATE_KEYS_DIR: signing.keys } });
      console.log(`Uploaded build ${build} to TestFlight. App Store Connect processes it before the team's testers get it.`);
    } else {
      mkdirSync(out, { recursive: true });
      const kept = join(out, `Zuna-${build}.ipa`);
      copyFileSync(ipa, kept);
      console.log(`Exported and checked build ${build}, in ${kept}. Nothing was uploaded: TestFlight gets its builds from release.yml.`);
    }
  } finally {
    signing?.remove();
    rmSync(work, { recursive: true, force: true });
  }
}

// --- The environment's secrets ---

/**
 * Checks the files in a folder, made as docs/RELEASES.md says, and makes them the testflight
 * environment's secrets, making the environment first if it isn't there. Nothing is shown.
 */
async function secrets(args) {
  const { dir, issuer, files } = folderAndIssuer(args, "node scripts/ios-dist.mjs secrets <folder> --issuer <issuer ID>");
  const p12 = one(dir, files, "certificate as .p12", (name) => name.endsWith(".p12"));
  const key = connectKey(one(dir, files, "App Store Connect key, AuthKey_<ID>.p8", (name) => /^AuthKey_[A-Z0-9]+\.p8$/.test(name)));
  if (!key.text.startsWith("-----BEGIN PRIVATE KEY-----")) fail(`AuthKey_${key.id}.p8 isn't a private key as App Store Connect gives it.`);
  const teamId = team();

  const password = await askHidden(`The password ${basename(p12)} was exported with: `);
  const work = mkdtempSync(join(tmpdir(), "zuna-ios-"));
  const values = { IOS_DISTRIBUTION_P12: readFileSync(p12).toString("base64"), IOS_DISTRIBUTION_P12_PASSWORD: password };
  try {
    const signing = keychainWith(work, readFileSync(p12), password, "Apple Distribution");
    signing.remove();
    console.log(`${basename(p12)} holds ${signing.identity}.`);
    // The file's name kept apart from the profile's own, which is whatever it was called on the developer site.
    const profiles = files.filter((name) => name.endsWith(".mobileprovision")).map((file) => ({ ...profileOf(join(dir, file)), file }));
    for (const [bundle, secret] of Object.entries(PROFILES)) {
      const usable = profiles.filter((profile) => !profileProblem(profile, { bundle, team: teamId, certificate: signing.certificate }));
      if (usable.length !== 1) {
        const others = profiles.filter((profile) => profile.bundle === bundle).map((profile) => `${profile.file}: ${profileProblem(profile, { bundle, team: teamId, certificate: signing.certificate }) ?? "one of several that would do"}`);
        fail(`${dir} should hold one App Store profile of ${bundle}, made with that certificate, and holds ${usable.length}.${others.length > 0 ? `\n  ${others.join("\n  ")}` : ""}`);
      }
      console.log(`${usable[0].file} ("${usable[0].name}") signs ${bundle}, until ${usable[0].expires.toISOString().slice(0, 10)}.`);
      values[secret] = readFileSync(join(dir, usable[0].file)).toString("base64");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  Object.assign(values, { APP_STORE_CONNECT_KEY: key.text, APP_STORE_CONNECT_KEY_ID: key.id, APP_STORE_CONNECT_ISSUER_ID: issuer });

  holdEnvironment(ENVIRONMENT, TAGS);
  setSecrets(ENVIRONMENT, Object.fromEntries(SECRETS.map((name) => [name, values[name]])));
  console.log(
    `\nSet the ${SECRETS.length} secrets of the ${ENVIRONMENT} environment. The next nightly that changes the iPhone app goes to TestFlight.\n` +
      `Delete ${basename(p12)} and AuthKey_${key.id}.p8 now: GitHub has them, the certificate's key is in your keychain too, and a lost one is replaced by revoking it and making a new one.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main({ archive: () => archive(), upload: ([archived]) => distribute(archived, true), export: ([archived]) => distribute(archived, false), secrets }, process.argv.slice(2));
}
