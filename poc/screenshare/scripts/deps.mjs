// Fetches what the demo needs into .deps: a pinned FFmpeg build, checked against
// its SHA-256, and LiveKit's server, built from a pinned tag.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFfmpeg as fetchFfmpeg } from '../../../scripts/ffmpeg.mjs'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const depsDir = join(root, '.deps')
export const isWindows = process.platform === 'win32'

const liveKitTag = 'v1.13.11'

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

export const ensureFfmpeg = () => fetchFfmpeg(depsDir)

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
