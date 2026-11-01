// Publishes with every native log turned on, then looks for the encryption key in what
// came out. The native frame cryptor has been reported to log key material
// (webrtc-sdk/webrtc#308), and logs end up in bug reports.
import { spawn } from 'node:child_process'
import { createHash, hkdfSync } from 'node:crypto'
import { join } from 'node:path'
import { ensureLiveKit, isWindows, root } from './deps.mjs'

const key = 'stand-in-for-a-key-from-mls-exporter'
const salt = 'LKFrameEncryptionKey'
const targetDir = isWindows ? join(process.env.LOCALAPPDATA, 'zss') : join(root, 'publisher', 'target')
const publisher = join(targetDir, 'release', isWindows ? 'zuna-screenshare.exe' : 'zuna-screenshare')

const liveKit = spawn(ensureLiveKit(), ['--dev', '--bind', '127.0.0.1', '--node-ip', '127.0.0.1'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 1500))

let output = ''
const run = spawn(publisher, ['--e2ee-key', key, '--seconds', '6', '--monitor', process.argv[2] ?? '0'], {
  env: { ...process.env, ZUNA_WEBRTC_LOG: '1', RUST_LOG: 'trace' },
})
run.stdout.on('data', (data) => (output += data))
run.stderr.on('data', (data) => (output += data))
await new Promise((resolve) => run.on('exit', resolve))
liveKit.kill()

const raw = Buffer.from(key)
const derived = Buffer.from(hkdfSync('sha256', raw, Buffer.from(salt), Buffer.alloc(128), 16))
const forms = (name, bytes) => ({
  [`${name} as text`]: bytes.toString('latin1'),
  [`${name} as hex`]: bytes.toString('hex'),
  [`${name} as HEX`]: bytes.toString('hex').toUpperCase(),
  [`${name} as base64`]: bytes.toString('base64'),
  [`${name} as a byte list`]: [...bytes].join(', '),
})
const looksFor = { ...forms('the key', raw), ...forms('the derived key', derived) }

const lines = output.split('\n')
const webrtcLines = lines.filter((line) => line.includes('libwebrtc')).length
const cryptorLines = lines.filter((line) => /cryptor|FrameCryptor/i.test(line))
const leaks = Object.entries(looksFor).filter(([, form]) => output.includes(form)).map(([name]) => name)

console.log(`${lines.length} lines of log, ${webrtcLines} from libwebrtc, ${cryptorLines.length} about the frame cryptor`)
for (const line of cryptorLines.slice(0, 12)) console.log(`  ${line.slice(0, 200)}`)
console.log(`Key digest, to tell runs apart: ${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`)
console.log(leaks.length ? `FOUND IN THE LOG: ${leaks.join(', ')}` : 'Not found in the log in any form looked for.')
process.exit(leaks.length ? 1 : 0)
