// Watches the stream and measures it. The page is also the test scene when it's on
// the monitor being captured: a clock in pixels at the top left, read back out of the
// received video, gives the real delay from screen to decoded frame.
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track } from '/livekit-client.mjs'

const params = new URLSearchParams(location.search)
const e2eeKey = params.get('key')
const joinsWanted = Number(params.get('joins'))
const label = params.get('label')
const hud = document.getElementById('hud')
const video = document.getElementById('video')

const report = (type, fields) => console.log(`@@${JSON.stringify({ type, ...fields })}`)

// --- The clock ---

const CLOCK_BITS = 24
const CHECK_BITS = 6
const BLOCK = 24
const clockBlocks = []
{
  const clock = document.getElementById('clock')
  // White then black at each end, so a read can tell whether it's looking at the clock.
  for (let i = 0; i < CLOCK_BITS + CHECK_BITS + 4; i++) {
    const block = document.createElement('i')
    clock.append(block)
    clockBlocks.push(block)
  }
  clockBlocks[0].style.background = '#fff'
  clockBlocks[1].style.background = '#000'
  clockBlocks[clockBlocks.length - 2].style.background = '#fff'
  clockBlocks[clockBlocks.length - 1].style.background = '#000'
}

const checkOf = (value) => {
  let check = 0
  for (let v = value; v > 0; v >>>= CHECK_BITS) check ^= v & ((1 << CHECK_BITS) - 1)
  return check
}

function drawClock(now) {
  const value = Math.floor(now) & ((1 << CLOCK_BITS) - 1)
  const check = checkOf(value)
  for (let bit = 0; bit < CLOCK_BITS; bit++) {
    clockBlocks[2 + bit].style.background = (value >>> bit) & 1 ? '#fff' : '#000'
  }
  for (let bit = 0; bit < CHECK_BITS; bit++) {
    clockBlocks[2 + CLOCK_BITS + bit].style.background = (check >>> bit) & 1 ? '#fff' : '#000'
  }
}

// --- Colours, to check what comes out against what went in ---

const SWATCHES = [
  ['white', [255, 255, 255]], ['grey', [128, 128, 128]], ['red', [220, 40, 40]], ['green', [40, 200, 80]],
  ['blue', [50, 80, 230]], ['yellow', [240, 200, 40]], ['magenta', [200, 50, 180]], ['dark', [24, 26, 32]],
]
{
  const swatches = document.getElementById('swatches')
  for (const [, [r, g, b]] of SWATCHES) {
    const swatch = document.createElement('i')
    swatch.style.background = `rgb(${r},${g},${b})`
    swatches.append(swatch)
  }
}

// --- Something moving: text scrolling, since text is what a screen share has to keep sharp ---

const SOURCE = `pub fn on_frame(&mut self, input: Input) -> Result<()> {
    self.poll_feedback()?;
    let force_key = self.take_key_request();
    let pts = self.pts();
    let began = Instant::now();
    self.encoder.send(input, pts, force_key)?;
    self.last_change = began;
    self.after_encode(began, false)
}`.split('\n')

const motionOn = params.get('motion') !== '0'
const canvas = document.getElementById('motion')
const paint = canvas.getContext('2d', { alpha: false })
const scale = devicePixelRatio
function sizeCanvas() {
  canvas.width = innerWidth * scale
  canvas.height = innerHeight * scale
  canvas.style.width = `${innerWidth}px`
  canvas.style.height = `${innerHeight}px`
}
sizeCanvas()
addEventListener('resize', sizeCanvas)

function drawMotion(now) {
  const { width, height } = canvas
  paint.setTransform(scale, 0, 0, scale, 0, 0)
  const w = width / scale
  const h = height / scale
  paint.fillStyle = '#16181d'
  paint.fillRect(0, 0, w, h)

  const scroll = (now * 0.12) % (SOURCE.length * 20)
  paint.font = '15px Consolas, ui-monospace, monospace'
  paint.fillStyle = '#d7dce5'
  for (let line = -1; line * 20 < h + 20; line++) {
    const text = SOURCE[((line % SOURCE.length) + SOURCE.length) % SOURCE.length]
    paint.fillText(text, 24, 100 + line * 20 - scroll)
    paint.fillText(text, 620, 100 + line * 20 - scroll / 2)
  }
  for (let i = 0; i < 6; i++) {
    const t = now / 900 + i
    paint.fillStyle = `hsl(${(now / 12 + i * 60) % 360} 70% 55%)`
    paint.fillRect(w * (0.5 + 0.4 * Math.sin(t)), h * (0.5 + 0.4 * Math.cos(t * 1.3)), 90, 90)
  }
}

function frameLoop(now) {
  drawClock(now)
  if (motionOn) drawMotion(now)
  requestAnimationFrame(frameLoop)
}
requestAnimationFrame(frameLoop)

// --- Reading the clock and colours back out of the video ---

const reader = document.createElement('canvas')
const readerPaint = reader.getContext('2d', { willReadFrequently: true })
const latencies = []
let lastColours = null
let framesPresented = 0
let firstFrameAt = null
let unreadFrames = 0

function readClock(frameWidth) {
  const blockSize = BLOCK * scale
  const count = clockBlocks.length
  reader.width = count * blockSize
  reader.height = blockSize
  readerPaint.drawImage(video, 0, 0, reader.width, blockSize, 0, 0, reader.width, blockSize)
  const pixels = readerPaint.getImageData(0, 0, reader.width, 1 + Math.floor(blockSize / 2)).data
  const bitAt = (index) => {
    const x = Math.floor((index + 0.5) * blockSize)
    const at = (Math.floor(blockSize / 2) * reader.width + x) * 4
    return pixels[at + 1] > 128 ? 1 : 0
  }
  if (bitAt(0) !== 1 || bitAt(1) !== 0 || bitAt(count - 2) !== 1 || bitAt(count - 1) !== 0) return null
  let value = 0
  for (let bit = 0; bit < CLOCK_BITS; bit++) value |= bitAt(2 + bit) << bit
  let check = 0
  for (let bit = 0; bit < CHECK_BITS; bit++) check |= bitAt(2 + CLOCK_BITS + bit) << bit
  if (check !== checkOf(value)) return null
  return frameWidth ? value : null
}

function readColours() {
  const size = 48 * scale
  reader.width = SWATCHES.length * size
  reader.height = size
  readerPaint.drawImage(video, 0, 24 * scale, reader.width, size, 0, 0, reader.width, size)
  const pixels = readerPaint.getImageData(0, Math.floor(size / 2), reader.width, 1).data
  return SWATCHES.map(([name, expected], index) => {
    const at = Math.floor((index + 0.5) * size) * 4
    const got = [pixels[at], pixels[at + 1], pixels[at + 2]]
    return { name, expected, got, worst: Math.max(...got.map((value, channel) => Math.abs(value - expected[channel]))) }
  })
}

function onVideoFrame(now, metadata) {
  framesPresented++
  firstFrameAt ??= now
  const value = readClock(metadata.width)
  if (value === null) {
    unreadFrames++
  } else {
    const latency = (Math.floor(performance.now()) - value) & ((1 << CLOCK_BITS) - 1)
    if (latency < 10000) latencies.push(latency)
  }
  if (framesPresented % 60 === 0) lastColours = readColours()
  video.requestVideoFrameCallback(onVideoFrame)
}

// --- Stats from WebRTC ---

let track = null
let previous = null

async function inboundStats() {
  if (!track?.receiver) return null
  const stats = await track.receiver.getStats()
  let inbound = null
  let codec = null
  stats.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry
  })
  if (inbound?.codecId) codec = stats.get(inbound.codecId)
  return inbound && { ...inbound, codecMime: codec?.mimeType, codecFmtp: codec?.sdpFmtpLine }
}

const percentile = (values, fraction) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

async function reportStats() {
  const now = await inboundStats()
  if (!now) return
  const seconds = previous ? (now.timestamp - previous.timestamp) / 1000 : 1
  const delta = (name) => (previous ? (now[name] ?? 0) - (previous[name] ?? 0) : now[name] ?? 0)
  const decoded = delta('framesDecoded')
  const sample = latencies.splice(0)
  const fields = {
    fps: delta('framesDecoded') / seconds,
    kbps: (delta('bytesReceived') * 8) / seconds / 1000,
    width: now.frameWidth,
    height: now.frameHeight,
    decoder: now.decoderImplementation,
    powerEfficient: now.powerEfficientDecoder,
    codec: now.codecMime,
    fmtp: now.codecFmtp,
    decodeMs: decoded ? (delta('totalDecodeTime') / decoded) * 1000 : null,
    jitterBufferMs: delta('jitterBufferEmittedCount') ? (delta('jitterBufferDelay') / delta('jitterBufferEmittedCount')) * 1000 : null,
    framesDropped: delta('framesDropped'),
    freezes: delta('freezeCount'),
    freezeMs: delta('totalFreezesDuration') * 1000,
    pli: delta('pliCount'),
    fir: delta('firCount'),
    nack: delta('nackCount'),
    packetsLost: delta('packetsLost'),
    keyFrames: delta('keyFramesDecoded'),
    latencyMs: percentile(sample, 0.5),
    latencyP95Ms: percentile(sample, 0.95),
    latencySamples: sample.length,
    unreadFrames,
    colourWorst: lastColours && Math.max(...lastColours.map((swatch) => swatch.worst)),
  }
  unreadFrames = 0
  previous = now
  report('viewer', fields)
  hud.textContent = [
    `${fields.codec ?? '?'}  ${fields.width}x${fields.height}  ${e2eeKey ? 'E2EE on' : 'E2EE off'}`,
    `decoder   ${fields.decoder}`,
    `fps       ${fields.fps.toFixed(1)}`,
    `bitrate   ${(fields.kbps / 1000).toFixed(1)} Mbit/s`,
    `latency   ${fields.latencyMs ?? '?'} ms  (p95 ${fields.latencyP95Ms ?? '?'} ms)`,
    `decode    ${fields.decodeMs?.toFixed(1) ?? '?'} ms   jitter buffer ${fields.jitterBufferMs?.toFixed(1) ?? '?'} ms`,
    `freezes   ${fields.freezes}   dropped ${fields.framesDropped}   lost ${fields.packetsLost}   PLI ${fields.pli}`,
  ].join('\n')
}

// --- Connecting ---

async function connect() {
  const options = { adaptiveStream: false, dynacast: false }
  if (e2eeKey) {
    const keyProvider = new ExternalE2EEKeyProvider()
    await keyProvider.setKey(new TextEncoder().encode(e2eeKey).buffer)
    options.encryption = { keyProvider, worker: new Worker('/livekit-client.e2ee.worker.mjs', { type: 'module' }) }
    const room = new Room(options)
    await room.setE2EEEnabled(true)
    return room
  }
  return new Room(options)
}

function firstFrame(room) {
  return new Promise((resolve) => {
    const take = (subscribed) => {
      if (subscribed.source !== Track.Source.ScreenShare && subscribed.kind !== Track.Kind.Video) return
      track = subscribed
      subscribed.attach(video)
      const started = performance.now()
      video.requestVideoFrameCallback(() => resolve(performance.now() - started))
    }
    room.on(RoomEvent.TrackSubscribed, take)
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) take(publication.track)
      }
    }
  })
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Joining again and again is what shows up keyframes being dropped: a viewer that
// joins has nothing to show until a keyframe gets through.
async function joinTest() {
  const results = []
  for (let attempt = 0; attempt < joinsWanted; attempt++) {
    const room = await connect()
    const began = performance.now()
    await room.connect(params.get('url'), params.get('token'))
    const shown = await Promise.race([firstFrame(room), settle(15000).then(() => null)])
    const stats = await inboundStats()
    const fromJoin = shown === null ? null : performance.now() - began
    results.push(fromJoin)
    report('join', { attempt, firstFrameMs: fromJoin, pli: stats?.pliCount ?? null, keyFrames: stats?.keyFramesDecoded ?? null })
    track?.detach(video)
    track = null
    await room.disconnect()
    await settle(1000)
  }
  report('joins', { results })
}

async function saveFrame(name) {
  if (!video.videoWidth) return
  const frame = document.createElement('canvas')
  frame.width = video.videoWidth
  frame.height = video.videoHeight
  frame.getContext('2d').drawImage(video, 0, 0)
  const data = frame.toDataURL('image/png').split(',')[1]
  console.log(`@@png ${JSON.stringify({ name, data })}`)
}

async function main() {
  if (joinsWanted > 0) {
    await joinTest()
    report('done', {})
    return
  }

  const room = await connect()
  room.on(RoomEvent.EncryptionError, (error) => report('error', { message: String(error) }))
  room.on(RoomEvent.Disconnected, (reason) => report('disconnected', { reason }))
  await room.connect(params.get('url'), params.get('token'))
  report('connected', { participants: room.remoteParticipants.size })

  const shownAfter = await firstFrame(room)
  report('firstFrame', { ms: shownAfter })
  video.requestVideoFrameCallback(onVideoFrame)

  setInterval(reportStats, 1000)
  // Halfway through, for looking at what the text really looks like after a while.
  const seconds = Number(params.get('seconds'))
  if (seconds > 0) {
    setTimeout(() => saveFrame(`${label}-received`), (seconds * 1000) / 2)
    setTimeout(() => report('colours', { swatches: lastColours }), seconds * 900)
  }
}

main().catch((error) => {
  report('error', { message: String(error?.stack ?? error) })
  hud.textContent = String(error)
})
