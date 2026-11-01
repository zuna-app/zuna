// The viewer, in the same Electron and Chromium the app ships. It decodes with
// nothing but what Chromium has, because viewers need no native code in this design.
const { app, BrowserWindow, screen } = require('electron')
const { createHmac } = require('node:crypto')
const { createReadStream, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { extname, join } = require('node:path')

const arg = (name, fallback) => {
  const prefix = `--${name}=`
  const found = process.argv.find((value) => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const base64url = (value) => Buffer.from(value).toString('base64url')

function token(apiKey, apiSecret, room, identity) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({
    iss: apiKey,
    sub: identity,
    nbf: now - 10,
    exp: now + 3600,
    video: { room, roomJoin: true, canSubscribe: true, canPublish: false },
  }))
  const signature = createHmac('sha256', apiSecret).update(`${header}.${claims}`).digest('base64url')
  return `${header}.${claims}.${signature}`
}

const contentTypes = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.map': 'application/json' }

// Served over http://127.0.0.1, because module workers won't load from file:// and
// WebCodecs and E2EE need a secure context, which this counts as.
function serve() {
  const clientDist = join(__dirname, '..', 'node_modules', 'livekit-client', 'dist')
  const routes = {
    '/': join(__dirname, 'index.html'),
    '/viewer.mjs': join(__dirname, 'viewer.mjs'),
    '/livekit-client.mjs': join(clientDist, 'livekit-client.esm.mjs'),
    '/livekit-client.e2ee.worker.mjs': join(clientDist, 'livekit-client.e2ee.worker.mjs'),
  }
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const file = routes[new URL(request.url, 'http://x').pathname]
      if (!file || !existsSync(file)) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(response)
    })
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

// On Linux the script that started this stops it with SIGTERM, which Electron takes
// its time over, and then exits. A write after that has nobody to go to.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => app.exit(0))

// Such as VaapiOnNvidiaGPUs, without which Chromium on Linux won't decode through VA-API
// on an NVIDIA GPU.
const features = arg('features', '')
if (features) app.commandLine.appendSwitch('enable-features', features)

// Keeps Chromium from throttling or re-timing the page that the numbers come from.
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app.whenReady().then(async () => {
  const port = await serve()
  const displays = screen.getAllDisplays()
  const chosen = displays[Number(arg('display', displays.length - 1))] ?? screen.getPrimaryDisplay()
  const resultsDir = arg('results', join(__dirname, '..', 'results'))
  mkdirSync(resultsDir, { recursive: true })

  const query = new URLSearchParams({
    url: arg('url', 'ws://127.0.0.1:7880'),
    token: token(arg('api-key', 'devkey'), arg('api-secret', 'secret'), arg('room', 'zuna-demo'), arg('identity', 'viewer')),
    key: arg('e2ee-key', ''),
    joins: arg('joins', '0'),
    label: arg('label', 'run'),
    seconds: arg('seconds', '0'),
    motion: arg('motion', '1'),
  })

  const window = new BrowserWindow({
    x: chosen.bounds.x,
    y: chosen.bounds.y,
    width: chosen.bounds.width,
    height: chosen.bounds.height,
    frame: false,
    fullscreen: true,
    alwaysOnTop: arg('on-top', '1') === '1',
    backgroundColor: '#101114',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  })

  // The page talks to the script that started this through its console.
  window.webContents.on('console-message', (event) => {
    const message = event.message
    if (message.startsWith('@@png ')) {
      const { name, data } = JSON.parse(message.slice(6))
      writeFileSync(join(resultsDir, `${name}.png`), Buffer.from(data, 'base64'))
    } else if (message.startsWith('@@')) {
      process.stdout.write(`${message.slice(2)}\n`)
    } else if (event.level === 'error') {
      process.stderr.write(`[page] ${message}\n`)
    }
  })
  window.webContents.on('render-process-gone', (_, details) => {
    process.stderr.write(`Renderer gone: ${details.reason}\n`)
    app.exit(1)
  })

  const { x, y } = chosen.nativeOrigin ?? chosen.bounds
  process.stdout.write(`${JSON.stringify({ type: 'display', x, y, width: chosen.size.width, height: chosen.size.height, scale: chosen.scaleFactor })}\n`)
  await window.loadURL(`http://127.0.0.1:${port}/?${query}`)
})

app.on('window-all-closed', () => app.quit())
