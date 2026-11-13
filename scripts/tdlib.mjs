// Builds TDLib, Telegram's own client library, which zuna-telegram links (docs/TELEGRAM_PLAN.md),
// from a pinned commit, with the OpenSSL, zlib and gperf it needs, each from a source checked
// against its SHA-256. All of it as static libraries, with the C runtime linked statically on
// Windows, as the app's is (apps/desktop/.cargo/config.toml). Move a pin and its hash together:
// the build runs again whenever one changes.
//
// Windows needs a native Perl for OpenSSL's build, and NASM for its assembly. A Perl on PATH that
// is Windows' own, as GitHub's runners have, is used, and otherwise Strawberry Perl's portable
// build is fetched, of which only Perl itself is unpacked. Visual Studio's build tools give the
// compiler, CMake and Ninja.
//
//   node scripts/tdlib.mjs     builds it into apps/desktop/.deps/tdlib, where zuna-telegram's build
//                              looks (apps/desktop/telegram/build.rs), as the app's scripts do first.
//                              The first build takes a while, and TDLib's largest files take a
//                              couple of gigabytes of memory each to compile.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { nativeAppDeps } from "./ffmpeg.mjs";

/** TDLib at a commit of its master branch: 1.8.70, of 2026-11-09. */
const TDLIB_COMMIT = "c8828d50f5eac2fc7089ce1089d7ce9095c61b5e";

const sources = {
  tdlib: {
    url: `https://github.com/tdlib/td/archive/${TDLIB_COMMIT}.tar.gz`,
    sha256: "ebaaa9686e8756630dce1862189ddeb9dce0ea7c20fcb806a3f0c9fac56f0923",
  },
  // The long-term release, supported until 2030. Its hash is the one OpenSSL publishes beside it.
  openssl: {
    url: "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
    sha256: "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a",
  },
  zlib: {
    url: "https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz",
    sha256: "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
  },
  // Which writes TDLib's tables of file types as it builds, and nothing that ships. 3.1 is plain
  // C++, built here with a CMakeLists of ours on every system; the newer ones need gnulib's build.
  gperf: {
    url: "https://ftp.gnu.org/gnu/gperf/gperf-3.1.tar.gz",
    sha256: "588546b945bba4b70b6a3a616e80b4ab466e3f33024a352fc2198112cdbb3ae2",
  },
};

const windowsTools = {
  nasm: {
    url: "https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip",
    sha256: "161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7",
  },
  perl: {
    url: "https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54231_64bit/strawberry-perl-5.42.3.1-64bit-portable.zip",
    sha256: "6a081a811781c30aca51dbc036afd93092af91e3297901f02c17043795a10690",
  },
};

/** Changed by hand when how it's built changes, so that a build made the old way is made again. */
const RECIPE = 1;

/** Where zuna-telegram's build finds TDLib: `include` and `lib`, with OpenSSL's and zlib's. */
export const tdlibDir = join(nativeAppDeps, "tdlib");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Tried a few times, waiting longer each time, as scripts/ffmpeg.mjs does.
async function download(url, file) {
  const partial = `${file}.partial`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, file);
      return;
    } catch (error) {
      const why = error.cause?.message ?? error.message;
      if (attempt === 5) throw new Error(`${url} couldn't be fetched: ${why}`);
      console.log(`${url}: ${why}, trying again`);
      await new Promise((done) => setTimeout(done, attempt * 5000));
    }
  }
}

/** Fetches one pinned file into `dir`, checked against its hash, and says where it is. */
async function fetchPinned(dir, { url, sha256: expected }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, url.split("/").pop());
  if (existsSync(file) && sha256(file) === expected) return file;
  console.log(`Downloading ${url}`);
  await download(url, file);
  const actual = sha256(file);
  if (actual !== expected) {
    rmSync(file);
    throw new Error(`${file} has SHA-256 ${actual}, expected ${expected}`);
  }
  return file;
}

// Windows' own tar reads zip files, and the one Git Bash puts first on PATH doesn't.
const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";

/** Unpacks an archive into `dir`, emptied first, and says where its one top folder went. */
function unpack(archive, dir, ...members) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const done = spawnSync(tar, ["-xf", archive, "-C", dir, ...members], { stdio: "inherit" });
  if (done.status !== 0) throw new Error(`Unpacking ${archive} failed`);
  const entries = readdirSync(dir);
  return entries.length === 1 ? join(dir, entries[0]) : dir;
}

function runIn(cwd, environment, program, args) {
  console.log(`> ${program} ${args.join(" ")}`);
  const done = spawnSync(program, args, { cwd, env: environment, stdio: "inherit" });
  if (done.error) throw new Error(`${program} couldn't be started: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${program} ${args.join(" ")} failed in ${cwd}`);
}

/**
 * The environment Visual Studio's x64 command prompt has: cl, link, nmake, and the CMake and
 * Ninja that come with its build tools.
 */
function visualStudioEnvironment() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const installation = found.stdout?.trim().split(/\r?\n/)[0];
  if (!installation) throw new Error("Building TDLib needs Visual Studio's C++ build tools.");
  const vcvars = join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const dump = spawnSync("cmd.exe", ["/d", "/s", "/c", `"call "${vcvars}" >nul && set"`], { encoding: "utf8", windowsVerbatimArguments: true });
  if (dump.status !== 0) throw new Error(`${vcvars} failed`);
  const environment = {};
  for (const line of dump.stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) environment[line.slice(0, at)] = line.slice(at + 1);
  }
  return environment;
}

/** A Perl that's Windows' own, with the modules OpenSSL's Configure takes, or None. */
function nativePerl() {
  const check = spawnSync("perl", ["-MIPC::Cmd", "-MLocale::Maketext::Simple", "-e", "print $^O"], { encoding: "utf8" });
  return check.status === 0 && check.stdout.trim() === "MSWin32" ? "perl" : null;
}

/**
 * How many compilers run at once: TDLib's largest files take about two gigabytes each, so no more
 * than memory allows, and at least one.
 */
function jobs() {
  const memory = Math.max(freemem(), totalmem() / 2);
  return Math.max(1, Math.min(availableParallelism(), Math.floor(memory / (2.5 * 1024 ** 3))));
}

// gperf 3.1's own build is autotools. This builds the same program from its sources anywhere CMake
// runs, with the configuration its configure would write for a compiler without variable arrays.
const GPERF_CMAKE = `cmake_minimum_required(VERSION 3.10)
project(gperf CXX C)
add_library(gperflib STATIC lib/getline.cc lib/getopt.c lib/getopt1.c lib/hash.cc)
target_include_directories(gperflib PUBLIC lib)
file(GLOB GPERF_SOURCES src/*.cc)
add_executable(gperf \${GPERF_SOURCES})
target_include_directories(gperf PRIVATE src \${CMAKE_CURRENT_BINARY_DIR})
target_link_libraries(gperf gperflib)
`;
const GPERF_CONFIG = `#define PACKAGE_BUGREPORT "bug-gperf@gnu.org"
#define PACKAGE_NAME "GNU gperf"
#define PACKAGE_STRING "GNU gperf 3.1"
#define PACKAGE_TARNAME "gperf"
#define PACKAGE_URL "https://www.gnu.org/software/gperf/"
#define PACKAGE_VERSION "3.1"
`;

/** What a CMake project is configured with here: a release, static, with the static C runtime on Windows. */
function cmakeCommon(generator) {
  return [
    ...(generator ? ["-G", generator] : []),
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    ...(process.platform === "darwin" ? ["-DCMAKE_OSX_DEPLOYMENT_TARGET=14.2"] : []),
  ];
}

/** Makes sure TDLib is built in `<depsDir>/tdlib`, and says where that is. */
export async function ensureTdlib(depsDir = nativeAppDeps) {
  const windows = process.platform === "win32";
  const pins = { ...sources, ...(windows ? windowsTools : {}) };
  const stamp = createHash("sha256")
    .update(JSON.stringify({ RECIPE, pins: Object.values(pins).map((pin) => pin.sha256) }))
    .digest("hex");
  const prefix = join(depsDir, "tdlib");
  const stampFile = join(prefix, ".stamp");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return prefix;

  const work = join(depsDir, "tdlib-build");
  const archives = {};
  for (const [name, pin] of Object.entries(pins)) {
    if (name === "perl" && nativePerl()) continue;
    archives[name] = await fetchPinned(work, pin);
  }

  const started = Date.now();
  console.log("Building TDLib and what it needs, which only happens once...");
  const environment = windows ? visualStudioEnvironment() : { ...process.env };
  const generator = windows ? "Ninja" : null;
  const parallel = String(jobs());
  const cmake = (cwd, args) => runIn(cwd, environment, "cmake", args);

  rmSync(prefix, { recursive: true, force: true });
  const staging = `${prefix}.building`;
  rmSync(staging, { recursive: true, force: true });
  const unpacked = join(work, "src");
  const built = join(work, "build");
  rmSync(built, { recursive: true, force: true });

  // gperf, for TDLib's build alone.
  const gperfSource = unpack(archives.gperf, join(unpacked, "gperf"));
  writeFileSync(join(gperfSource, "CMakeLists.txt"), GPERF_CMAKE);
  mkdirSync(join(built, "gperf"), { recursive: true });
  writeFileSync(join(built, "gperf", "config.h"), GPERF_CONFIG);
  cmake(join(built, "gperf"), [...cmakeCommon(generator), gperfSource]);
  cmake(join(built, "gperf"), ["--build", ".", "--parallel", parallel]);
  const gperf = join(built, "gperf", windows ? "gperf.exe" : "gperf");

  // zlib, static.
  const zlibSource = unpack(archives.zlib, join(unpacked, "zlib"));
  mkdirSync(join(built, "zlib"), { recursive: true });
  cmake(join(built, "zlib"), [
    ...cmakeCommon(generator),
    `-DCMAKE_INSTALL_PREFIX=${staging}`,
    "-DZLIB_BUILD_SHARED=OFF",
    "-DZLIB_BUILD_STATIC=ON",
    "-DZLIB_BUILD_TESTING=OFF",
    zlibSource,
  ]);
  cmake(join(built, "zlib"), ["--build", ".", "--parallel", parallel]);
  cmake(join(built, "zlib"), ["--install", "."]);
  const zlibLibrary = join(staging, "lib", readdirSync(join(staging, "lib")).find((file) => /^(libz\.a|zs\.lib|zlibstatic\.lib)$/.test(file)) ?? "");
  if (!existsSync(zlibLibrary)) throw new Error(`No static zlib in ${join(staging, "lib")}`);

  // OpenSSL, static, without its programs, tests or loadable modules.
  const opensslSource = unpack(archives.openssl, join(unpacked, "openssl"));
  const opensslOptions = ["no-shared", "no-apps", "no-tests", "no-docs", "no-module", `--prefix=${staging}`, `--openssldir=${join(staging, "ssl")}`, "--libdir=lib"];
  if (windows) {
    let perl = nativePerl();
    if (!perl) {
      // Only its `perl` folder, which unpack names, as the one folder there.
      perl = join(unpack(archives.perl, join(work, "perl"), "perl"), "bin", "perl.exe");
    }
    const nasmDir = unpack(archives.nasm, join(work, "nasm"));
    const opensslEnvironment = { ...environment, PATH: `${nasmDir};${environment.PATH ?? environment.Path}` };
    delete opensslEnvironment.Path;
    runIn(opensslSource, opensslEnvironment, perl, ["Configure", "VC-WIN64A", ...opensslOptions]);
    runIn(opensslSource, opensslEnvironment, "nmake", ["/nologo", "build_sw"]);
    runIn(opensslSource, opensslEnvironment, "nmake", ["/nologo", "install_sw"]);
  } else {
    runIn(opensslSource, environment, "./Configure", opensslOptions);
    runIn(opensslSource, environment, "make", [`-j${parallel}`, "build_sw"]);
    runIn(opensslSource, environment, "make", ["install_sw"]);
  }
  const [cryptoLibrary, sslLibrary] = windows ? ["libcrypto.lib", "libssl.lib"] : ["libcrypto.a", "libssl.a"];

  // TDLib, as static libraries, without its tests, benchmarks or shared library.
  const tdlibSource = unpack(archives.tdlib, join(unpacked, "tdlib"));
  mkdirSync(join(built, "tdlib"), { recursive: true });
  cmake(join(built, "tdlib"), [
    ...cmakeCommon(generator),
    `-DCMAKE_INSTALL_PREFIX=${staging}`,
    "-DTD_INSTALL_SHARED_LIBRARIES=OFF",
    "-DTD_INSTALL_STATIC_LIBRARIES=ON",
    "-DTD_ENABLE_JNI=OFF",
    "-DBUILD_TESTING=OFF",
    `-DGPERF_EXECUTABLE=${gperf}`,
    `-DOPENSSL_ROOT_DIR=${staging}`,
    "-DOPENSSL_USE_STATIC_LIBS=TRUE",
    `-DOPENSSL_INCLUDE_DIR=${join(staging, "include")}`,
    `-DOPENSSL_CRYPTO_LIBRARY=${join(staging, "lib", cryptoLibrary)}`,
    `-DOPENSSL_SSL_LIBRARY=${join(staging, "lib", sslLibrary)}`,
    `-DZLIB_INCLUDE_DIR=${join(staging, "include")}`,
    `-DZLIB_LIBRARY=${zlibLibrary}`,
    tdlibSource,
  ]);
  cmake(join(built, "tdlib"), ["--build", ".", "--target", "tdjson_static", "--parallel", parallel]);
  cmake(join(built, "tdlib"), ["--install", "."]);

  writeFileSync(join(staging, "VERSION"), `TDLib ${TDLIB_COMMIT}\n`);
  writeFileSync(join(staging, ".stamp"), stamp);
  renameSync(staging, prefix);
  // What it was built from stays for the next build, and the build itself goes.
  rmSync(built, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
  console.log(`TDLib built in ${Math.round((Date.now() - started) / 60000)} minutes.`);
  return prefix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`TDLib is in ${await ensureTdlib(nativeAppDeps)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
