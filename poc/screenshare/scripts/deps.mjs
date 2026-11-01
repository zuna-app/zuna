// Fetches what the demo needs into .deps: a pinned FFmpeg build, checked against
// its SHA-256, and LiveKit's server, built from a pinned tag. Update a version and
// its hash together.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const depsDir = join(root, '.deps')
export const isWindows = process.platform === 'win32'

const ffmpegTag = 'autobuild-2026-10-31-12-59'
const ffmpegBuild = 'ffmpeg-n8.1.3-27-g8dca1586f4'
const ffmpegBuilds = {
  win32: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${ffmpegTag}/${ffmpegBuild}-win64-lgpl-shared-8.1.zip`,
    sha256: '5cef7bc48e513f3cee7c881e8b2999d835541edb1846c3e89443a67f8f8556ab',
  },
  linux: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${ffmpegTag}/${ffmpegBuild}-linux64-lgpl-shared-8.1.tar.xz`,
    sha256: '493e89a48da02b9a7d217b60f7f60c3c917c9bed73459d8a106e5e987da082ef',
  },
}

const liveKitTag = 'v1.13.11'

async function download(url, file) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const partial = `${file}.partial`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  renameSync(partial, file)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

export async function ensureFfmpeg() {
  const entry = ffmpegBuilds[process.platform]
  if (!entry) throw new Error(`No FFmpeg build for ${process.platform}`)

  const dir = join(depsDir, 'ffmpeg')
  const stamp = join(dir, '.sha256')
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === entry.sha256) return dir

  mkdirSync(depsDir, { recursive: true })
  const archive = join(depsDir, entry.url.split('/').pop())
  if (!existsSync(archive) || sha256(archive) !== entry.sha256) {
    console.log(`Downloading ${entry.url}`)
    await download(entry.url, archive)
  }
  const actual = sha256(archive)
  if (actual !== entry.sha256) {
    rmSync(archive)
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${entry.sha256}`)
  }

  const unpacked = `${dir}.unpacking`
  rmSync(dir, { recursive: true, force: true })
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  // Windows' own tar reads zip files, and the one Git Bash puts first on PATH doesn't.
  run(isWindows ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-xf', archive, '-C', unpacked])
  renameSync(join(unpacked, readdirSync(unpacked)[0]), dir)
  rmSync(unpacked, { recursive: true, force: true })
  writeFileSync(stamp, entry.sha256)
  return dir
}

// Stripped, since Windows Defender quarantines Go binaries with debug symbols.
export function ensureLiveKit() {
  const binary = join(depsDir, isWindows ? 'livekit-server.exe' : 'livekit-server')
  const stamp = `${binary}.tag`
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8') === liveKitTag) return binary

  const source = join(depsDir, 'livekit-src')
  mkdirSync(depsDir, { recursive: true })
  rmSync(source, { recursive: true, force: true })
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', liveKitTag, 'https://github.com/livekit/livekit', source])
  run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', binary, './cmd/server'], source)
  writeFileSync(stamp, liveKitTag)
  return binary
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await ensureFfmpeg())
  console.log(ensureLiveKit())
}
