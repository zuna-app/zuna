// The iPhone's peer connection for a Telegram call against the core's signalling
// (docs/TELEGRAM_CALLS_PLAN.md, "What the iPhone has to get right"), as the desktop's
// `voice/telegram/media/tests.rs` checks its own: the offers LiveKit's WebRTC makes in the app, in
// each shape, kept as the core's fixtures (`ios-offer-*.sdp` in packages/core/test/fixtures/telegram-calls),
// and the answers the core writes from them (`ios-answer-*.sdp`, by `telegram-calls.test.ts`) set on
// real peer connections in the app, which must take them, the caller as ICE's controlling agent and
// the one called as its controlled one, as Telegram's own apps take them to be. Nothing connects:
// no relay is given, and nothing is gathered.
//
//   npm run test:ios:telegram-calls [-- --update]
//
// A new LiveKit may write its offers differently, which this catches. With --update, the offers are
// written again, then the core's answers from them, and then those are set: read the change.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostApp } from "./host";
import { root } from "./paths";
import { boot, buildApp, installFresh, simulatorId, terminate } from "./simulator";

const update = process.argv.includes("--update");
const fixtures = join(root, "packages", "core", "test", "fixtures", "telegram-calls");
const failures: string[] = [];
function check(name: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}
const log = (message: string) => console.log(`[telegram-call-run] ${message}`);

/** The shapes, and what each sends once its answer is taken: the sound, and the caller's camera once it's on. */
const SHAPES: Record<string, { caller: boolean; sending: string[] }> = {
  caller: { caller: true, sending: ["microphone"] },
  callee: { caller: false, sending: ["microphone"] },
  "caller-camera": { caller: true, sending: ["microphone", "camera"] },
};

/** What makes an offer the same shape as another: its sections, their codecs and header extensions, not its keys or SSRCs. */
const shape = (sdp: string) => sdp.split(/\r?\n/).filter((line) => /^(m=|a=mid:|a=rtpmap:|a=extmap:|a=sendonly|a=recvonly|a=fmtp:)/.test(line));

log("building the core bundle and the app");
execFileSync(process.execPath, [join(root, "apps", "ios", "core-bundle", "build.mjs")], { stdio: "inherit" });
buildApp();
const udid = simulatorId();
boot(udid);
installFresh(udid);
const phone = await new HostApp("phone", { target: "simulator" }).open();

try {
  // First, before anything has made the calls' factory: CallKit starts a call's audio before its
  // peer connection is made, and the factory made after it must leave the sound on.
  const audio = JSON.parse(await phone.hostCommand("telegramCallAudio")) as { enabled?: boolean };
  check("the first call's sound stays on when its audio started before the factory", audio.enabled === true, JSON.stringify(audio));

  const offers = JSON.parse(await phone.hostCommand("telegramCallOffers")) as Record<string, string>;
  for (const name of Object.keys(SHAPES)) {
    const sdp = offers[name] ?? "";
    check(`${name}: an offer is made`, sdp.startsWith("v=0"), sdp.slice(0, 120));
    // Relaying only: an offer made before gathering names no candidate and no address.
    check(`${name}: it names no candidate`, !sdp.includes("a=candidate"));
    check(`${name}: it has a data channel on port 5000`, sdp.includes("m=application") && sdp.includes("a=sctp-port:5000"));
    if (name === "callee") check("callee: the data channel's section is first, after its answer", sdp.indexOf("m=application") < sdp.indexOf("m=audio"));
    const path = join(fixtures, `ios-offer-${name}.sdp`);
    if (update) {
      writeFileSync(path, sdp);
      continue;
    }
    const kept = existsSync(path) ? readFileSync(path, "utf8") : "";
    check(`${name}: the offer is of the shape the core was tested with`, JSON.stringify(shape(sdp)) === JSON.stringify(shape(kept)), kept ? "" : `${path} is missing: run with --update`);
  }

  if (update) {
    log("writing the core's answers to the offers again");
    execFileSync("npx", ["vitest", "run", "test/telegram-calls.test.ts", "-t", "the iPhone sets"], {
      cwd: join(root, "packages", "core"),
      env: { ...process.env, UPDATE_TELEGRAM_CALL_FIXTURES: "1" },
      stdio: "inherit",
    });
  }

  const pairs: Record<string, { prepared: string; answer: string }> = {};
  for (const name of Object.keys(SHAPES)) {
    const read = (what: string) => readFileSync(join(fixtures, `ios-${what}-${name}.sdp`), "utf8");
    pairs[name] = { prepared: read("prepared"), answer: read("answer") };
  }
  const report = JSON.parse(await phone.hostCommand("telegramCallAnswers", { path: JSON.stringify(pairs) })) as Record<string, { error?: string; receiving?: number; sending?: string[]; roles?: string[]; orientation?: boolean }>;
  for (const [name, { caller, sending }] of Object.entries(SHAPES)) {
    const result = report[name] ?? {};
    check(`${name}: the core's answer is taken`, !result.error, result.error);
    // What the other side said it sends now comes to this side, where the answer said so.
    check(`${name}: the other side's sound is taken`, (result.receiving ?? 0) >= 1, `${result.receiving} receiving`);
    check(`${name}: this side's streams are taken as they should be`, JSON.stringify(result.sending) === JSON.stringify(sending), JSON.stringify(result.sending));
    // The caller controls ICE, as Telegram's apps take it to, and the one called never claims to,
    // which they'd answer with nothing but role conflicts.
    const role = caller ? "controlling" : "controlled";
    check(`${name}: ICE's role is ${role}`, (result.roles?.length ?? 0) > 0 && result.roles!.every((each) => each === role), JSON.stringify(result.roles));
    check(`${name}: a video section's next offer keeps the picture's orientation`, result.orientation === true);
  }
} finally {
  await phone.close();
  terminate(udid);
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed:\n${failures.map((name) => `  ${name}`).join("\n")}`);
process.exit(failures.length === 0 ? 0 : 1);
