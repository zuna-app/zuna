import WebSocket from "ws";

/**
 * Thin wrapper around WebSocket that speaks the Zuna message envelope:
 *   { type, token, payload }
 *
 * On connection:
 *   1. A raw WebSocket connection is made to ws://<address>/ws
 *   2. An "auth" frame is immediately sent.
 *   3. connect() resolves once the server replies with "auth_confirmation".
 */
export class ZunaWebSocket {
  constructor(address, token) {
    this.address = address;
    this.token = token;
    this._ws = null;
    this._handlers = new Map(); // type → fn(payload)
    this._anyHandler = null; // called for every message
  }

  /**
   * Open the WebSocket connection and authenticate.
   * Returns a Promise that resolves once auth_confirmation is received.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.address}/ws`);
      this._ws = ws;

      ws.on("open", () => {
        this._rawSend("auth", {});
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "auth_confirmation") {
          resolve();
        }

        if (this._anyHandler) this._anyHandler(msg);

        const h = this._handlers.get(msg.type);
        if (h) h(msg.payload ?? {});
      });

      ws.on("error", (err) => {
        reject(err);
      });

      ws.on("close", () => {
        // Notify any registered close handler
        const h = this._handlers.get("_close");
        if (h) h({});
      });
    });
  }

  /**
   * Send a typed message over the socket.
   * @param {string} type - Message type (e.g. "message", "ping", "mark_read")
   * @param {object} payload
   */
  send(type, payload = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this._rawSend(type, payload);
  }

  _rawSend(type, payload = {}) {
    this._ws.send(JSON.stringify({ type, token: this.token, payload }));
  }

  /** Register a handler for a specific message type. */
  on(type, handler) {
    this._handlers.set(type, handler);
  }

  /** Remove a handler for a specific message type. */
  off(type) {
    this._handlers.delete(type);
  }

  /** Register a handler called for every inbound message (raw envelope). */
  onAny(handler) {
    this._anyHandler = handler;
  }

  close() {
    if (this._ws) this._ws.close();
    this._ws = null;
  }

  get isOpen() {
    return this._ws?.readyState === WebSocket.OPEN;
  }
}
