"use strict";

const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const pid = process.argv[2];
const httpPort = parseInt(process.argv[3] || "3000", 10);

if (!pid) {
  console.error("Usage: node server.js <target_pid> [http_port]");
  console.error("Example: node server.js 1234 3000");
  process.exit(1);
}

const pipeName = `\\\\.\\pipe\\zuna-wasapi-${pid}`;

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const SUBTYPE_PCM_DWORD0 = 0x00000001;
const SUBTYPE_IEEE_FLOAT_DWORD0 = 0x00000003;

function parseWaveFormat(buf) {
  if (buf.length < 18) throw new Error("WFX buffer too small");

  const wFormatTag = buf.readUInt16LE(0);
  const nChannels = buf.readUInt16LE(2);
  const nSamplesPerSec = buf.readUInt32LE(4);
  const nAvgBytesPerSec = buf.readUInt32LE(8);
  const nBlockAlign = buf.readUInt16LE(12);
  const wBitsPerSample = buf.readUInt16LE(14);
  const cbSize = buf.readUInt16LE(16);

  let isFloat = wFormatTag === WAVE_FORMAT_IEEE_FLOAT;
  let isPcm = wFormatTag === WAVE_FORMAT_PCM;

  if (
    wFormatTag === WAVE_FORMAT_EXTENSIBLE &&
    cbSize >= 22 &&
    buf.length >= 40
  ) {
    // SubFormat starts at offset 24 inside WAVEFORMATEX (offset 8 inside cbSize extension)
    const sub0 = buf.readUInt32LE(24);
    isFloat = sub0 === SUBTYPE_IEEE_FLOAT_DWORD0;
    isPcm = sub0 === SUBTYPE_PCM_DWORD0;
  }

  return {
    wFormatTag,
    nChannels,
    nSamplesPerSec,
    nAvgBytesPerSec,
    nBlockAlign,
    wBitsPerSample,
    cbSize,
    isFloat,
    isPcm,
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, "public", urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();
let audioFormat = null;

wss.on("connection", (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[ws] Browser connected  (${addr})`);
  ws.socket && ws.socket.setNoDelay(true);
  if (ws._socket) ws._socket.setNoDelay(true);
  clients.add(ws);

  if (audioFormat) {
    ws.send(JSON.stringify({ type: "format", ...audioFormat }));
  }

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[ws] Browser disconnected (${addr})`);
  });
  ws.on("error", (e) => console.error("[ws] client error:", e.message));
});

function broadcastText(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

function broadcastBinary(buf) {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(buf, { binary: true });
  }
}

let pipeConn = null;
let pipeBuffer = Buffer.alloc(0);
let parseState = "wfxSize";
let wfxSize = 0;

function onPipeData(chunk) {
  pipeBuffer = Buffer.concat([pipeBuffer, chunk]);

  if (parseState === "wfxSize") {
    if (pipeBuffer.length < 4) return;
    wfxSize = pipeBuffer.readUInt32LE(0);
    pipeBuffer = pipeBuffer.subarray(4);
    parseState = "wfxData";
    console.log(`[pipe] WFX header size: ${wfxSize} bytes`);
  }

  if (parseState === "wfxData") {
    if (pipeBuffer.length < wfxSize) return;
    const wfxBuf = pipeBuffer.subarray(0, wfxSize);
    pipeBuffer = pipeBuffer.subarray(wfxSize);
    parseState = "pcm";

    audioFormat = parseWaveFormat(wfxBuf);
    console.log("[pipe] Audio format:", audioFormat);
    broadcastText({ type: "format", ...audioFormat });
  }

  if (parseState === "pcm" && pipeBuffer.length > 0) {
    broadcastBinary(pipeBuffer);
    pipeBuffer = Buffer.alloc(0);
  }
}

function connectPipe() {
  console.log(`[pipe] Connecting to: ${pipeName}`);

  const conn = net.createConnection(pipeName);
  pipeConn = conn;

  conn.on("connect", () => {
    console.log("[pipe] Connected!");
    conn.setNoDelay(true);
    parseState = "wfxSize";
    pipeBuffer = Buffer.alloc(0);
    broadcastText({ type: "status", connected: true });
  });

  conn.on("data", onPipeData);

  conn.on("error", (err) => {
    const msg = err.message || String(err);
    if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED")) {
      console.log("[pipe] Server not ready, retrying in 2 s…");
    } else {
      console.error("[pipe] Error:", msg);
    }
  });

  conn.on("close", () => {
    console.log("[pipe] Connection closed. Reconnecting in 2 s…");
    broadcastText({ type: "status", connected: false });
    audioFormat = null;
    pipeConn = null;
    setTimeout(connectPipe, 2000);
  });
}

httpServer.listen(httpPort, "0.0.0.0", () => {
  console.log(`\n=== zuna-wasapi browser bridge ===`);
  console.log(`  Target PID : ${pid}`);
  console.log(`  Pipe       : ${pipeName}`);
  console.log(`  Browser UI : http://localhost:${httpPort}`);
  console.log(`==================================\n`);
  connectPipe();
});
