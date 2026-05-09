# zuna-wasapi Node.js browser client

## Architecture

| Layer          | File                        | Responsibility                           |
| -------------- | --------------------------- | ---------------------------------------- |
| C++ server     | `main.cpp`                  | WASAPI capture -> named pipe             |
| Node.js bridge | `server.js`                 | reads pipe, HTTP server, WebSocket relay |
| AudioWorklet   | `public/audio-processor.js` | runs in audio thread, queues + plays PCM |
| Browser UI     | `public/index.html`         | WebSocket client, controls, visualiser   |

### Wire formats

**Pipe -> Node (from `main.cpp`)**

```
[DWORD  wfxSize ]  4 bytes LE
[BYTE[] wfxData ]  WAVEFORMATEX (+ extension)
[BYTE[] pcm     ]  endless interleaved raw PCM
```

**Node -> Browser (WebSocket)**

- Text frame: JSON `{ type: "format", nChannels, nSamplesPerSec, wBitsPerSample, isFloat, ... }`
- Text frame: JSON `{ type: "status", connected: true|false }`
- Binary frame: raw PCM chunk (ArrayBuffer) - same bytes as read from pipe

## Notes

- WASAPI typically outputs 32-bit IEEE-float, 2 channels, 48 000 Hz. The
  AudioContext is created with `sampleRate` matching the pipe header, so no
  resampling is needed.
- A ~120 ms pre-buffer prevents start-up glitches. If you hear stuttering,
  increase `_preBufferFrames` in `audio-processor.js`.
- The Node.js server auto-reconnects if the pipe closes (e.g. the C++ process
  is restarted).
- Requires Node.js ≥ 18 and a modern Chromium/Firefox browser (AudioWorklet).
