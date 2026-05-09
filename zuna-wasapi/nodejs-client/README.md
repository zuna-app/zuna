# zuna-wasapi Node.js browser client

Bridges the `zuna-wasapi` named-pipe stream to any browser using WebSockets +
the Web Audio API (AudioWorklet).

```
zuna-wasapi.exe <PID>  ──named-pipe──►  node server.js <PID>  ──WS──►  browser
```

## Setup

```powershell
cd nodejs-client
npm install
```

## Run

**Step 1** – start the WASAPI capturer (in a separate window):
```powershell
.\cmake-build-debug\zuna_wasapi.exe <target_pid>
```

**Step 2** – start the Node.js bridge:
```powershell
node server.js <target_pid>          # HTTP on :3000
node server.js <target_pid> 8080     # or a custom port
```

**Step 3** – open your browser:
```
http://localhost:3000
```

Click **▶ Play** to start audio playback.

---

## Architecture

| Layer | File | Responsibility |
|-------|------|----------------|
| C++ server | `main.cpp` | WASAPI capture → named pipe |
| Node.js bridge | `server.js` | reads pipe, HTTP server, WebSocket relay |
| AudioWorklet | `public/audio-processor.js` | runs in audio thread, queues + plays PCM |
| Browser UI | `public/index.html` | WebSocket client, controls, visualiser |

### Wire formats

**Pipe → Node (from `main.cpp`)**
```
[DWORD  wfxSize ]  4 bytes LE
[BYTE[] wfxData ]  WAVEFORMATEX (+ extension)
[BYTE[] pcm     ]  endless interleaved raw PCM
```

**Node → Browser (WebSocket)**
- Text frame: JSON `{ type: "format", nChannels, nSamplesPerSec, wBitsPerSample, isFloat, … }`
- Text frame: JSON `{ type: "status", connected: true|false }`
- Binary frame: raw PCM chunk (ArrayBuffer) — same bytes as read from pipe

## Notes

- WASAPI typically outputs 32-bit IEEE-float, 2 channels, 48 000 Hz.  The
  AudioContext is created with `sampleRate` matching the pipe header, so no
  resampling is needed.
- A ~120 ms pre-buffer prevents start-up glitches.  If you hear stuttering,
  increase `_preBufferFrames` in `audio-processor.js`.
- The Node.js server auto-reconnects if the pipe closes (e.g. the C++ process
  is restarted).
- Requires Node.js ≥ 18 and a modern Chromium/Firefox browser (AudioWorklet).

