// Shares a picture made for it, at a bitrate a screen rarely holds, through the native app's
// encoder and LiveKit over a network that loses packets, with a native watcher, and fails unless
// the watcher saw nearly every frame without asking for a keyframe. What gets a share through a
// lost packet is a retransmission, which needs the app to offer a retransmission stream
// (apps/desktop/patches/webrtc-sys.patch) and LiveKit to still have the packet (LIVEKIT_CONFIG in
// scripts/lib.mjs), and both run short as the bitrate climbs (docs/SCREEN_SHARE.md, "Lost packets").
//
//   node apps/desktop/test/loss-check.mjs [--kbps 25000] [--seconds 45] [--codec h264] [--loss 0.5] [--delay 15] [--fps 60] [--noise 12] [--encoder nvenc] [--livekit-default] [--verbose]
//
// On Linux, with iproute2's tc and network namespaces an account may make for itself, and nothing
// of this machine's own network changed: the apps run in one namespace and LiveKit in another,
// with a router between them that holds each packet for `--delay` milliseconds and loses
// `--loss` percent of them, each way. So a packet waits in the network, as on a real one, and not
// in its sender's socket, where a delay on the loopback would keep it until the socket was full.
// `--noise` is how much of the picture changes in each frame, in percent, and `--livekit-default`
// runs LiveKit as it comes, to see what the configuration is for.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVEKIT_CONFIG, ensureLiveKit, env, root } from "../../../scripts/lib.mjs";
import { prepare, token } from "./share-run.mjs";

if (process.platform !== "linux") {
  console.error("This check shapes its network with Linux's namespaces and tc.");
  process.exit(2);
}

const args = process.argv.slice(2);
const option = (name, otherwise) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args.splice(at, 2)[1] : otherwise;
};
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && Boolean(args.splice(at, 1));
};
const kbps = option("kbps", "25000");
const seconds = Number(option("seconds", "45"));
const codec = option("codec", "h264");
const loss = option("loss", "0.5");
const delay = option("delay", "15");
const fps = Number(option("fps", "60"));
const noise = option("noise", "12");
const encoder = option("encoder", "nvenc");
const liveKitDefault = flag("livekit-default");
const verbose = flag("verbose");
const inside = flag("inside");

const target = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");
const cargo = ["--quiet", "--release", "--example", "loss-check", "--features", "share-check,zuna-screenshare/bench"];
const cargoEnv = { ...env, CARGO_TARGET_DIR: target };
const [serverAddress, appsAddress] = ["10.99.1.2", "10.99.2.2"];

if (!inside) {
  // What needs this machine's own network comes first: LiveKit, FFmpeg, webrtc-sys and the build.
  const liveKit = ensureLiveKit();
  await prepare();
  execFileSync("cargo", ["build", ...cargo], { cwd: join(root, "apps", "desktop"), env: cargoEnv, stdio: "inherit" });
  // In a user namespace this account is root of, with a network of its own, which the rest is made in.
  const run = spawn("unshare", ["-Urn", process.execPath, fileURLToPath(import.meta.url), "--inside", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ZUNA_LIVEKIT: liveKit } });
  run.on("error", (error) => {
    console.error(`Couldn't make a network namespace: ${error.message}`);
    process.exit(2);
  });
  run.on("exit", (code) => process.exit(code ?? 1));
} else {
  const sh = (command) => execFileSync("sh", ["-c", command], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  // A namespace is whatever a process is in, so each is held open by one that only sleeps.
  const namespace = () => spawn("unshare", ["-n", "sleep", "infinity"], { stdio: "ignore" });
  const [server, apps] = [namespace(), namespace()];
  const started = [server, apps];
  const stop = () => started.forEach((child) => child.kill());
  process.on("exit", stop);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const within = (child) => ["nsenter", "-t", String(child.pid), "-n"];
  const shaping = `limit 20000 delay ${delay}ms loss ${loss}%`;
  try {
    sh(`ip link set lo up && sysctl -qw net.ipv4.ip_forward=1
      ip link add to-server type veth peer name eth0 netns ${server.pid} && ip addr add 10.99.1.1/24 dev to-server && ip link set to-server up
      ip link add to-apps type veth peer name eth0 netns ${apps.pid} && ip addr add 10.99.2.1/24 dev to-apps && ip link set to-apps up
      ${within(server).join(" ")} sh -c "ip link set lo up && ip addr add ${serverAddress}/24 dev eth0 && ip link set eth0 up && ip route add default via 10.99.1.1"
      ${within(apps).join(" ")} sh -c "ip link set lo up && ip addr add ${appsAddress}/24 dev eth0 && ip link set eth0 up && ip route add default via 10.99.2.1"
      tc qdisc add dev to-server root netem ${shaping} && tc qdisc add dev to-apps root netem ${shaping}`);
  } catch {
    console.error("Couldn't set the network up: this needs ip and tc with netem, and veth.");
    process.exit(2);
  }

  const [prefix, ...nsenter] = within(server);
  const liveKit = spawn(prefix, [...nsenter, process.env.ZUNA_LIVEKIT, "--dev", "--bind", "0.0.0.0", "--node-ip", serverAddress, ...(liveKitDefault ? [] : ["--config-body", LIVEKIT_CONFIG])], { stdio: "ignore" });
  started.push(liveKit);
  const listening = () => {
    try {
      sh(`${within(server).join(" ")} sh -c "ss -ltn | grep -q :7880"`);
      return true;
    } catch {
      return false;
    }
  };
  for (let waited = 0; !listening(); waited += 100) {
    if (waited > 20_000 || liveKit.exitCode !== null) {
      console.error("LiveKit didn't start.");
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const room = `loss-check-${randomBytes(3).toString("hex")}`;
  const [enter, ...entering] = within(apps);
  const share = spawn(enter, [...entering, "cargo", "run", ...cargo, "--", `ws://${serverAddress}:7880`, token("sharer", room, true), token("watcher", room, false), randomBytes(16).toString("hex"), String(seconds)], {
    cwd: join(root, "apps", "desktop"),
    env: { ...cargoEnv, ZUNA_SHARE_KBPS: kbps, ZUNA_SHARE_CODEC: codec, ZUNA_SHARE_FPS: String(fps), ZUNA_SHARE_ENCODER: encoder, ZUNA_NOISE_PERCENT: noise },
  });
  let output = "";
  share.stdout.on("data", (data) => (output += data));
  share.stderr.on("data", (data) => (output += data));
  const code = await new Promise((resolve) => share.on("exit", resolve));
  const lines = output.split("\n");
  const json = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  // A socket whose buffer filled lost packets of its own, which would be this machine's doing.
  const overflowed = (child) => sh(`${within(child).join(" ")} nstat -az UdpRcvbufErrors UdpSndbufErrors`).split("\n").slice(1).reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[1]) || 0), 0);
  const overflows = overflowed(server) + overflowed(apps);
  stop();

  const each = json.filter((line) => line.second).map((line) => line.second);
  if (verbose) for (const second of each) console.log(JSON.stringify(second));
  // The first 12 seconds are the bitrate climbing, a keyframe at each step.
  const settled = each.filter((second) => second.t > 12);
  if (!settled.length) {
    console.log(`The share didn't run (exit ${code}):\n${lines.slice(-25).join("\n")}`);
    process.exit(1);
  }
  const mean = (name) => settled.reduce((sum, second) => sum + second[name], 0) / settled.length;
  const total = (name) => settled.reduce((sum, second) => sum + second[name], 0);
  const serverSaw = json.find((line) => line.serverSaw)?.serverSaw;
  const stalled = settled.filter((second) => second.decoded < fps / 2).length;
  console.log(`${codec} asked for ${kbps} kbit/s, over ${Number(delay) * 2} ms there and back and ${loss}% lost each way, LiveKit ${liveKitDefault ? "as it comes" : "as configured"}, after the first 12 s:`);
  console.log(`  arrived        ${mean("mbit").toFixed(2)} Mbit/s, ${Math.round(mean("packets"))} packets a second`);
  console.log(`  decoded        ${mean("decoded").toFixed(1)} frames a second of ${fps}, ${stalled} of ${settled.length} seconds under half`);
  console.log(`  lost on the way to the watcher  ${total("lost")} packets, asked for again ${total("nacks")} times`);
  console.log(`  keyframes asked for by the watcher  ${total("plis")}, freezes ${total("freezes")}`);
  console.log(`  never reached LiveKit  ${serverSaw ? serverSaw.packetsLost : "-"} packets`);
  console.log(`  packets this machine's sockets dropped  ${overflows}`);

  const failed = [];
  if (code !== 0) failed.push(`the share exited with ${code}`);
  if (mean("decoded") < fps * 0.95) failed.push(`the watcher decoded ${mean("decoded").toFixed(1)} frames a second`);
  if (total("plis") > 1) failed.push(`the watcher asked for ${total("plis")} keyframes`);
  if (stalled) failed.push(`the picture stopped in ${stalled} seconds`);
  if (overflows) failed.push(`${overflows} packets were dropped by this machine's own sockets, so the numbers aren't the network's`);
  console.log(failed.length ? `\nFAILED: ${failed.join(", ")}.` : "\nThe share came through.");
  process.exit(failed.length ? 1 : 0);
}
