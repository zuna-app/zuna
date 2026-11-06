// Runs the whole thing and reports on it: LiveKit, the publisher, and a viewer in
// real Electron. With --seconds it measures for that long and prints the results;
// without it, it keeps going until Ctrl+C for watching by eye.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureFfmpeg, ensureLiveKit, isWindows, root } from './deps.mjs'

const flags = {
  encoder: 'auto', fps: '60', bitrate: '20000', seconds: '0', e2ee: 'yes', label: '', joins: '0',
  input: 'gpu', 'idr-fix': 'yes', display: '', crop: '', motion: '1', build: 'yes', 'keyframe-seconds': '10',
  // What the viewer tries to decrypt with: the right key, another one, or none, which
  // is what the server sees.
  'viewer-key': 'right',
  // Chromium features for the viewer, such as VaapiOnNvidiaGPUs.
  'viewer-features': '',
}
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i].replace(/^--/, '')
  if (!(name in flags)) {
    console.error(`Unknown option --${name}. Options: ${Object.keys(flags).map((flag) => `--${flag}`).join(' ')}`)
    process.exit(2)
  }
  flags[name] = process.argv[i + 1]
}

const seconds = Number(flags.seconds)
const label = flags.label || `${flags.encoder}-${flags.input}-${flags.fps}fps-${flags.bitrate}k`
const resultsDir = join(root, 'results')
const e2eeKey = flags.e2ee === 'yes' ? 'stand-in-for-a-key-from-mls-exporter' : ''
const viewerKey = { right: e2eeKey, wrong: 'some-other-key-entirely', none: '' }[flags['viewer-key']]

// cl.exe doesn't take paths over 260 characters, and LiveKit's headers go past that
// from a target folder this deep in a checkout.
const crate = join(root, '..', '..', 'apps', 'screenshare')
const targetDir = isWindows ? join(process.env.LOCALAPPDATA, 'zss') : join(crate, 'target')

function msvcToolchain() {
  const list = spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' }).stdout ?? ''
  const found = list.split('\n').map((line) => line.split(' ')[0]).find((name) => name.endsWith('-pc-windows-msvc'))
  if (!found) throw new Error('Building on Windows needs a Rust MSVC toolchain: rustup toolchain install stable-x86_64-pc-windows-msvc')
  return found
}

function build() {
  if (!existsSync(join(root, 'node_modules', 'livekit-client'))) {
    const npm = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['install'], { cwd: root, stdio: 'inherit', shell: isWindows })
    if (npm.status !== 0) throw new Error('npm install failed')
  }
  const args = [...(isWindows ? [`+${msvcToolchain()}`] : []), 'build', '--release']
  const result = spawnSync('cargo', args, { cwd: crate, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: targetDir, ZUNA_FFMPEG_DIR: join(root, '.deps', 'ffmpeg') } })
  if (result.status !== 0) throw new Error('Building the publisher failed')
}

const children = []
function start(name, command, args, onLine, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  createInterface({ input: child.stdout }).on('line', onLine)
  createInterface({ input: child.stderr }).on('line', (line) => {
    // LiveKit in development mode logs every packet's worth of detail.
    if (name === 'livekit' && !/\t(WARN|ERROR)\t/.test(line)) return
    if (!/^\s*$/.test(line)) console.error(`[${name}] ${line}`)
  })
  return child
}

// Waits for them to go, since on Linux they take a moment after SIGTERM, and a run
// started straight after would find LiveKit's ports still taken.
function stopAll() {
  const running = children.reverse().filter((child) => child.exitCode === null && child.signalCode === null)
  const exited = running.map((child) => new Promise((resolve) => child.once('exit', resolve)))
  for (const child of running) child.kill()
  const force = setTimeout(() => running.forEach((child) => child.kill('SIGKILL')), 5000)
  return Promise.all(exited).finally(() => clearTimeout(force))
}
process.on('SIGINT', () => {
  stopAll()
  process.exit(0)
})

const parse = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function electronPath() {
  return createRequire(join(root, 'package.json'))('electron')
}

// What the GPU says it's doing, as the check that this really is hardware encoding.
function nvidiaEncoderStats() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency,utilization.encoder,utilization.decoder,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const [sessions, fps, latencyUs, encoderUtilization, decoderUtilization, gpuUtilization] = result.stdout.trim().split(',').map(Number)
  return { sessions, fps, latencyUs, encoderUtilization, decoderUtilization, gpuUtilization }
}

// On Linux the compositor does part of the work, such as reading each frame back from
// the GPU for shared memory, so its CPU time counts too.
// This person's, since a login screen can have an Xorg of its own, and Wayland's first.
const compositorNames = ['kwin_wayland', 'gnome-shell', 'sway', 'Hyprland', 'niri', 'weston', 'Xorg']
function findCompositor() {
  if (isWindows) return null
  const found = []
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    try {
      const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      if (compositorNames.includes(name) && statSync(`/proc/${pid}`).uid === process.getuid()) found.push({ pid, name })
    } catch {
      // It ended while this looked.
    }
  }
  found.sort((a, b) => compositorNames.indexOf(a.name) - compositorNames.indexOf(b.name))
  return found[0] ?? null
}

// User and system time, which Linux counts in hundredths of a second.
function cpuSeconds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    return (Number(fields[11]) + Number(fields[12])) / 100
  } catch {
    return null
  }
}

// A process and all it started, such as Electron's page and its GPU process, which is
// where the viewer decodes.
function treeCpuSeconds(root) {
  const parents = new Map()
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      parents.set(pid, stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1])
    } catch {
      // It ended while this looked.
    }
  }
  let total = 0
  for (const pid of parents.keys()) {
    let at = pid
    while (at && at !== root && at !== '1') at = parents.get(at)
    if (at === root) total += cpuSeconds(pid) ?? 0
  }
  return total
}

// The cores used from one call to the next.
function cpuMeter(read) {
  let before = { at: performance.now(), cpu: read() }
  return () => {
    const now = { at: performance.now(), cpu: read() }
    const cores = now.cpu !== null && before.cpu !== null ? (now.cpu - before.cpu) / ((now.at - before.at) / 1000) : null
    before = now
    return cores
  }
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
const max = (values) => (values.length ? Math.max(...values) : null)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const present = (values) => values.filter((value) => value !== null && value !== undefined)

async function main() {
  if (flags.build === 'yes') {
    await ensureFfmpeg()
    build()
  }
  const liveKit = ensureLiveKit()
  const publisherPath = join(targetDir, 'release', isWindows ? 'zuna-screenshare.exe' : 'zuna-screenshare')
  mkdirSync(resultsDir, { recursive: true })

  const publisherStats = []
  const viewerStats = []
  const gpuStats = []
  const compositorStats = []
  const viewerCpuStats = []
  const joinResults = []
  const run = { label, flags, description: null, colours: null, firstFrameMs: null, errors: [] }

  // It says why it couldn't start on stdout, and nothing else.
  start('livekit', liveKit, ['--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1'], (line) => console.error(`[livekit] ${line}`), {})
  await new Promise((resolve) => setTimeout(resolve, 1500))

  let finish
  const finished = new Promise((resolve) => {
    finish = resolve
  })

  const publisherArgs = ['--encoder', flags.encoder, '--fps', flags.fps, '--bitrate-kbps', flags.bitrate, '--keyframe-seconds', flags['keyframe-seconds']]
  if (e2eeKey) publisherArgs.push('--e2ee-key', e2eeKey)
  if (flags.input === 'cpu') publisherArgs.push('--cpu-input')
  if (flags['idr-fix'] === 'no') publisherArgs.push('--no-idr-fix')
  if (flags.crop) publisherArgs.push('--crop', flags.crop)

  const startPublisher = (display) => {
    const where = display ? ['--monitor-at', `${display.x + 1},${display.y + 1}`] : []
    start('publisher', publisherPath, [...publisherArgs, ...where], (line) => {
      const message = parse(line)
      if (message?.type === 'ready') {
        run.description = message.description
        console.log(`Publishing: ${message.description}, ${message.e2ee ? 'encrypted' : 'not encrypted'}`)
        if (!isWindows) startViewer()
      } else if (message?.type === 'stats') {
        publisherStats.push(message)
      }
    }, { LD_LIBRARY_PATH: join(root, '.deps', 'ffmpeg', 'lib') }).on('exit', (code) => {
      if (code) {
        run.errors.push(`The publisher exited with ${code}`)
        finish()
      }
    })
  }

  const viewerArgs = [
    join(root, 'viewer', 'main.cjs'),
    `--label=${label}`, `--seconds=${seconds}`, `--results=${resultsDir}`, `--joins=${flags.joins}`, `--motion=${flags.motion}`,
    ...(viewerKey ? [`--e2ee-key=${viewerKey}`] : []),
    ...(flags.display ? [`--display=${flags.display}`] : []),
    ...(flags['viewer-features'] ? [`--features=${flags['viewer-features']}`] : []),
  ]
  let viewerStarted = false
  let viewerCores = null
  const startViewer = () => {
    viewerStarted = true
    // Timed from here, since on Linux the portal's dialog comes first and waits for as
    // long as the person takes.
    if (seconds > 0) setTimeout(finish, seconds * 1000)
    const viewer = start('viewer', electronPath(), viewerArgs, onViewerLine)
    if (!isWindows) viewerCores = cpuMeter(() => treeCpuSeconds(String(viewer.pid)))
  }
  const onViewerLine = (line) => {
    const message = parse(line)
    if (!message) return
    switch (message.type) {
      // On Windows the viewer says where it is, and the publisher captures that monitor.
      case 'display': if (isWindows) startPublisher(message); break
      case 'viewer': viewerStats.push(message); console.log(`  ${message.width}x${message.height} ${message.fps.toFixed(0)} fps ${(message.kbps / 1000).toFixed(1)} Mbit/s, ${message.latencyMs ?? '?'} ms`); break
      case 'firstFrame': run.firstFrameMs = message.ms; break
      case 'colours': run.colours = message.swatches; break
      case 'join': joinResults.push(message); console.log(`  Join ${message.attempt + 1}: first frame after ${message.firstFrameMs === null ? 'nothing in 15 s' : `${Math.round(message.firstFrameMs)} ms`}, ${message.pli} PLI`); break
      case 'done': finish(); break
      case 'error': run.errors.push(message.message); console.error(`Viewer: ${message.message}`); break
      default: break
    }
  }

  // On Linux the portal's dialog comes first, since the test window covers a whole
  // monitor and could hide it. Pick the monitor that window then opens on. On X11
  // that's the last one unless --display says otherwise. Wayland doesn't let a window
  // choose, so there it's the monitor in use, where the dialog appears.
  if (isWindows) {
    startViewer()
  } else {
    const where = process.env.WAYLAND_DISPLAY ? 'the one this dialog is on' : 'the last one, or --display'
    console.log(`Choose what to share in the dialog: the monitor the test window will open on, ${where}.`)
    startPublisher()
  }

  const compositor = findCompositor()
  const compositorCores = compositor && cpuMeter(() => cpuSeconds(compositor.pid))
  const sampler = setInterval(() => {
    const sample = nvidiaEncoderStats()
    if (sample) gpuStats.push(sample)
    // Only once the viewer runs, and not while the portal's dialog waits.
    const compositorNow = compositorCores ? compositorCores() : null
    if (viewerStarted && compositorNow !== null) compositorStats.push({ name: compositor.name, cpuCores: compositorNow })
    const viewerNow = viewerCores ? viewerCores() : null
    if (viewerNow !== null) viewerCpuStats.push(viewerNow)
  }, 1000)

  await finished
  clearInterval(sampler)
  await stopAll()

  writeReport(run, publisherStats, viewerStats, gpuStats, compositorStats, viewerCpuStats, joinResults)
}

function writeReport(run, publisherStats, viewerStats, gpuStats, compositorStats, viewerCpuStats, joinResults) {
  // The start is a ramp, and the steady part is what these numbers describe.
  const settled = (stats) => stats.slice(Math.min(10, Math.floor(stats.length / 3)))
  const steadyPublisher = settled(publisherStats)
  const steadyViewer = settled(viewerStats)
  const steadyGpu = settled(gpuStats).filter((sample) => sample.sessions > 0)
  const steadyCompositor = settled(compositorStats)

  const reachedCap = publisherStats.find((stats) => stats.encoderKbps >= Number(flags.bitrate))
  const summary = {
    label: run.label,
    description: run.description,
    errors: run.errors,
    codec: steadyViewer.at(-1)?.codec,
    fmtp: steadyViewer.at(-1)?.fmtp,
    size: steadyViewer.at(-1) && `${steadyViewer.at(-1).width}x${steadyViewer.at(-1).height}`,
    firstFrameMs: run.firstFrameMs,
    secondsToReachBitrateCap: reachedCap?.t ?? null,
    sender: {
      fps: mean(steadyPublisher.map((stats) => stats.fps)),
      repeatFps: mean(steadyPublisher.map((stats) => stats.repeatFps)),
      kbps: mean(steadyPublisher.map((stats) => stats.kbps)),
      encodeMs: mean(steadyPublisher.map((stats) => stats.encodeMsAvg)),
      encodeMsWorst: max(steadyPublisher.map((stats) => stats.encodeMsMax)),
      cpuCores: mean(steadyPublisher.map((stats) => stats.cpuCores)),
      keys: sum(publisherStats.map((stats) => stats.keys)),
      keyRequests: sum(publisherStats.map((stats) => stats.keyRequests)),
      bitrateChanges: sum(publisherStats.map((stats) => stats.bitrateChanges)),
      rejected: sum(publisherStats.map((stats) => stats.rejected)),
      idrRewritten: publisherStats.at(-1)?.idrRewritten ?? 0,
      idrLeftAlone: publisherStats.at(-1)?.idrLeftAlone ?? 0,
    },
    compositor: steadyCompositor.length ? { name: steadyCompositor[0].name, cpuCores: mean(steadyCompositor.map((sample) => sample.cpuCores)) } : null,
    gpu: steadyGpu.length ? { encoderUtilization: mean(steadyGpu.map((sample) => sample.encoderUtilization)), decoderUtilization: mean(steadyGpu.map((sample) => sample.decoderUtilization)), sessions: max(steadyGpu.map((sample) => sample.sessions)), reportedFps: mean(steadyGpu.map((sample) => sample.fps)) } : null,
    viewer: {
      fps: mean(steadyViewer.map((stats) => stats.fps)),
      kbps: mean(steadyViewer.map((stats) => stats.kbps)),
      framesDecoded: viewerStats.at(-1)?.framesDecoded ?? 0,
      bytesReceived: viewerStats.at(-1)?.bytesReceived ?? 0,
      decodeMs: mean(present(steadyViewer.map((stats) => stats.decodeMs))),
      jitterBufferMs: mean(present(steadyViewer.map((stats) => stats.jitterBufferMs))),
      latencyMs: mean(present(steadyViewer.map((stats) => stats.latencyMs))),
      latencyP95Ms: max(present(steadyViewer.map((stats) => stats.latencyP95Ms))),
      latencySamples: sum(steadyViewer.map((stats) => stats.latencySamples)),
      unreadFrames: sum(steadyViewer.map((stats) => stats.unreadFrames)),
      freezes: sum(viewerStats.map((stats) => stats.freezes)),
      freezeMs: sum(viewerStats.map((stats) => stats.freezeMs)),
      framesDropped: sum(steadyViewer.map((stats) => stats.framesDropped)),
      pli: sum(viewerStats.map((stats) => stats.pli)),
      packetsLost: sum(viewerStats.map((stats) => stats.packetsLost)),
      cpuCores: mean(settled(viewerCpuStats)),
      colourWorst: run.colours ? Math.max(...run.colours.map((swatch) => swatch.worst)) : null,
    },
    colours: run.colours,
    joins: joinResults.length ? joinResults.map((join) => join.firstFrameMs) : undefined,
    timeline: publisherStats.map((stats) => ({ t: stats.t, fps: stats.fps, kbps: stats.kbps, targetKbps: stats.targetKbps, encoderKbps: stats.encoderKbps, keys: stats.keys, keyRequests: stats.keyRequests })),
    viewerTimeline: viewerStats.map((stats) => ({ fps: stats.fps, kbps: stats.kbps, latencyMs: stats.latencyMs, jitterBufferMs: stats.jitterBufferMs, freezes: stats.freezes, pli: stats.pli })),
  }
  writeFileSync(join(resultsDir, `${run.label}.json`), JSON.stringify(summary, null, 2))
  const { timeline: _timeline, viewerTimeline: _viewerTimeline, colours: _colours, ...printed } = summary
  console.log(JSON.stringify(printed, null, 2))
  console.log(`Saved to ${join(resultsDir, `${run.label}.json`)}`)
}

main().then(() => process.exit(0)).catch(async (error) => {
  console.error(error)
  await stopAll()
  process.exit(1)
})
