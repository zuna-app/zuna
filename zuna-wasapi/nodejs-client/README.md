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
