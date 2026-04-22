/**
 * REST API client for the Zuna server.
 * Uses the native fetch API (Node 18+).
 */
export class ZunaAPI {
  constructor(address) {
    this.address = address;
    this.token = null;
  }

  setToken(token) {
    this.token = token;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  async _post(path, body) {
    const res = await fetch(`https://${this.address}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text}`);
    return JSON.parse(text);
  }

  async _get(path) {
    if (!this.token) throw new Error("Not authenticated. Call login() first.");
    const res = await fetch(`https://${this.address}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text}`);
    return JSON.parse(text);
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  /**
   * Register a new account on the server.
   * Returns { id }.
   */
  async join({ username, identityKey, signingKey }) {
    return this._post("/api/auth/join", {
      username,
      identity_key: identityKey,
      signing_key: signingKey,
      server_password: "test1234",
      avatar: "",
    });
  }

  /**
   * Step 1 of login: obtain a nonce to sign.
   * Returns { nonce, server_name, server_logo }.
   */
  async handshake(username) {
    return this._post("/api/auth/handshake", { username });
  }

  /**
   * Step 2 of login: exchange a signed nonce for a bearer token.
   * Returns { token }.
   */
  async login(username, signature) {
    return this._post("/api/auth/login", { username, signature });
  }

  // ─── Chat ───────────────────────────────────────────────────────────────────

  /**
   * Fetch the list of direct-message chats.
   * Returns { chats: ChatMemberDTO[] }.
   */
  async chatList() {
    return this._get("/api/chat/list");
  }

  /**
   * Fetch paginated messages for a chat.
   * cursor defaults to the max int64 value (newest page).
   * Returns { messages: MessageDTO[] } ordered newest-first from the server.
   */
  async chatMessages(chatId, limit = 50, cursor = "9223372036854775807") {
    const params = new URLSearchParams({
      chat_id: chatId,
      limit: String(limit),
      cursor,
    });
    return this._get(`/api/chat/messages?${params}`);
  }
}
