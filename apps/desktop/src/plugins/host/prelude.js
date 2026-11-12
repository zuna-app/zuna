// What a plugin's context holds besides its own script: timers, console, text encoding and
// the plugin API, built over one function that sends a message to the app (`__zunaSend`) and
// one the host calls with each message from it (`__zunaReceive`). Nothing here is trusted by
// the app: the plugin can change any of it, and the broker checks every request anyway.
(() => {
  "use strict";
  const send = globalThis.__zunaSend;
  const setTimer = globalThis.__zunaSetTimer;
  const clearTimer = globalThis.__zunaClearTimer;
  const utf8Encode = globalThis.__zunaUtf8Encode;
  const utf8Decode = globalThis.__zunaUtf8Decode;
  for (const name of ["__zunaSend", "__zunaSetTimer", "__zunaClearTimer", "__zunaUtf8Encode", "__zunaUtf8Decode"]) delete globalThis[name];

  const post = (message) => send(JSON.stringify(message));

  // --- Logging ---
  const show = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const log = (level) => (...values) => post({ t: "log", level, text: values.map(show).join(" ").slice(0, 4000) });
  globalThis.console = { log: log("info"), info: log("info"), debug: log("debug"), warn: log("warn"), error: log("error") };

  // --- Timers ---
  const timers = new Map();
  let nextTimer = 1;
  const addTimer = (fn, ms, args, repeats) => {
    if (typeof fn !== "function") throw new TypeError("A timer runs a function.");
    const id = nextTimer++;
    timers.set(id, { fn, args, repeats });
    setTimer(id, Math.max(0, Number(ms) || 0), repeats);
    return id;
  };
  globalThis.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  globalThis.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    if (timers.delete(id)) clearTimer(id);
  };
  globalThis.queueMicrotask = (fn) => void Promise.resolve().then(fn);

  // --- Text ---
  globalThis.TextEncoder = class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(text = "") {
      return utf8Encode(String(text));
    }
  };
  globalThis.TextDecoder = class TextDecoder {
    get encoding() {
      return "utf-8";
    }
    decode(bytes) {
      return bytes === undefined ? "" : utf8Decode(bytes);
    }
  };

  // Bytes go to the app as base64, as the core's wire carries them.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const toBase64 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
    }
    return out;
  };
  const fromBase64 = (text) => {
    const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let at = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      if (at < out.length) out[at++] = (n >> 16) & 255;
      if (i + 2 < clean.length && at < out.length) out[at++] = (n >> 8) & 255;
      if (i + 3 < clean.length && at < out.length) out[at++] = n & 255;
    }
    return out;
  };
  const bytesOf = (value) => (value instanceof Uint8Array ? value : typeof value === "string" ? utf8Encode(value) : new Uint8Array(value));

  // --- Asking the broker ---
  const asks = new Map();
  let nextAsk = 1;
  const ask = (op, args = {}) =>
    new Promise((resolve, reject) => {
      const n = nextAsk++;
      asks.set(n, { resolve, reject });
      post({ t: "ask", n, op, args });
    });
  const tell = (op, args) =>
    void ask(op, args).catch((error) => console.warn(`${op}: ${error.message}`));

  // --- State ---
  let info = null;
  let storage = {};
  let settings = {};
  let setup = null;
  const commands = new Map();
  const listeners = new Map(); // core event type -> Set of listeners
  const settingListeners = new Set();
  const messageListeners = new Set();
  const filters = new Map(); // id -> { kind, fn }
  const actions = new Map(); // registered id -> onClick
  let decorator = null;
  let nextFilter = 1;

  // --- Views ---
  // A view's handlers are named by where they are in it, so drawing it again with the same shape
  // sends the same tree, which isn't sent again.
  const views = new Map(); // view id -> render
  const sent = new Map(); // view id -> JSON last sent
  const handlers = new Map(); // handler id -> function
  const HANDLERS = ["onClick", "onChange", "onSubmit"];
  const encode = (viewId, node, path, out) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === "string" || typeof node === "number") return { type: "string", props: { text: String(node) }, children: [] };
    if (typeof node !== "object" || typeof node.type !== "string") return null;
    const props = {};
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (HANDLERS.includes(key)) {
        if (typeof value === "function") {
          const id = `${viewId}|${path}|${key}`;
          handlers.set(id, value);
          out.add(id);
          props[key] = id;
        }
      } else if (typeof value !== "function") props[key] = value;
    }
    const children = [];
    (node.children ?? []).forEach((child, index) => {
      const encoded = encode(viewId, child, `${path}.${child?.props?.key ?? index}`, out);
      if (encoded) children.push(encoded);
    });
    return { type: node.type, props, children };
  };
  const viewHandlers = new Map(); // view id -> Set of handler ids
  const encodeView = (viewId, tree) => {
    for (const id of viewHandlers.get(viewId) ?? []) handlers.delete(id);
    const ids = new Set();
    const encoded = encode(viewId, tree, "0", ids);
    viewHandlers.set(viewId, ids);
    return encoded;
  };
  const renderAll = () => {
    const state = Object.freeze({ ...storage });
    for (const [viewId, render] of views) {
      let tree;
      try {
        tree = render(state);
      } catch (error) {
        console.error(`Drawing ${viewId} failed:`, error);
        continue;
      }
      const encoded = encodeView(viewId, tree);
      const json = JSON.stringify(encoded);
      if (sent.get(viewId) === json) continue;
      sent.set(viewId, json);
      tell("ui.view", { id: viewId, tree: encoded });
    }
  };
  const addView = (viewId, render) => {
    if (typeof render !== "function") throw new TypeError("A view is drawn by a function.");
    views.set(viewId, render);
    sent.delete(viewId);
  };
  const dropView = (viewId) => {
    views.delete(viewId);
    sent.delete(viewId);
    for (const id of viewHandlers.get(viewId) ?? []) handlers.delete(id);
    viewHandlers.delete(viewId);
  };

  const context = (raw) => ({
    composer: { insert: (text) => tell("composer.insert", { text: String(text) }) },
    conversation: raw?.conversation ?? null,
    args: raw?.args ?? "",
  });

  const register = (kind, id, options, extra = {}) => {
    const key = `${kind}:${id}`;
    if (options && typeof options.onClick === "function") actions.set(key, options.onClick);
    if (options && typeof options.render === "function") addView(key, options.render);
    tell("ui.register", { kind, id, title: options?.title, icon: options?.icon, label: options?.label, hover: !!options?.hover, width: options?.width, ...extra });
  };

  const unsubscribe = (set, item) => () => void set.delete(item);
  const addFilter = (kind, fn, required = false) => {
    if (typeof fn !== "function") throw new TypeError("A filter is a function.");
    const id = `${kind}-${nextFilter++}`;
    filters.set(id, { kind, fn });
    tell("filter.register", { id, kind, required: !!required });
    return () => {
      if (filters.delete(id)) tell("filter.unregister", { id });
    };
  };
  const subscribe = (type, listener) => {
    if (typeof listener !== "function") throw new TypeError("A listener is a function.");
    let set = listeners.get(type);
    if (!set) {
      listeners.set(type, (set = new Set()));
      tell("subscribe", { type });
    }
    set.add(listener);
    return unsubscribe(set, listener);
  };

  const response = (raw) => ({
    status: raw.status,
    headers: raw.headers ?? {},
    bytes: () => fromBase64(raw.body),
    text: () => utf8Decode(fromBase64(raw.body)),
    json: () => JSON.parse(utf8Decode(fromBase64(raw.body))),
  });

  const api = () => ({
    plugin: Object.freeze({ id: info.id, version: info.version, verified: info.verified, permissions: [...info.permissions] }),
    log: (...values) => console.log(...values),
    settings: {
      get: (key) => settings[key],
      all: () => ({ ...settings }),
      set: async (key, value) => {
        await ask("settings.set", { key, value });
        settings[key] = value;
      },
      onChange: (listener) => (settingListeners.add(listener), unsubscribe(settingListeners, listener)),
    },
    storage: {
      get: (key) => storage[key],
      keys: () => Object.keys(storage),
      set: async (key, value) => {
        const copy = value === undefined ? null : JSON.parse(JSON.stringify(value));
        await ask("storage.set", { key: String(key), value: copy });
        storage = { ...storage, [key]: copy };
      },
      delete: async (key) => {
        await ask("storage.delete", { key: String(key) });
        const { [key]: _gone, ...rest } = storage;
        storage = rest;
      },
    },
    commands: {
      on: (id, run) => {
        commands.set(String(id), run);
        return () => commands.delete(String(id));
      },
    },
    ui: {
      toast: (text, kind = "info") => tell("ui.toast", { text: String(text), kind }),
      refresh: () => renderAll(),
      settings: (render) => register("settings", "settings", { render }),
      panel: (id, options) => register("panel", id, options),
      openPanel: (id) => tell("ui.open", { kind: "panel", id }),
      closePanel: () => tell("ui.close", { kind: "panel" }),
      dialog: (options) => {
        dropView("dialog:dialog");
        register("dialog", "dialog", options);
        tell("ui.open", { kind: "dialog", id: "dialog" });
      },
      closeDialog: () => tell("ui.close", { kind: "dialog" }),
      page: (id, options) => register("page", id, options),
      openPage: (id) => tell("ui.open", { kind: "page", id }),
      headerButton: (id, options) => register("headerButton", id, options),
      composerButton: (id, options) => register("composerButton", id, options),
      messageAction: (id, options) => register("messageAction", id, options),
      conversationAction: (id, options) => register("conversationAction", id, options),
      remove: (id) => {
        for (const kind of ["panel", "page", "headerButton", "composerButton", "messageAction", "conversationAction"]) {
          actions.delete(`${kind}:${id}`);
          dropView(`${kind}:${id}`);
        }
        tell("ui.remove", { id: String(id) });
      },
    },
    messages: {
      on: (listener) => {
        messageListeners.add(listener);
        if (!listeners.has("message")) subscribe("message", () => {});
        return unsubscribe(messageListeners, listener);
      },
      onOutgoing: (filter, options) => addFilter("outgoing", filter, options?.required),
      decorate: (fn) => {
        if (typeof fn !== "function") throw new TypeError("A decorator is a function.");
        decorator = fn;
        tell("decorate.register", {});
        return () => {
          if (decorator === fn) {
            decorator = null;
            tell("decorate.unregister", {});
          }
        };
      },
      history: (serverId, groupId, before) => ask("messages.history", { serverId, groupId, before }),
      search: (serverId, query, groupId) => ask("messages.search", { serverId, query, groupId }),
      send: (serverId, conversationKey, text) => ask("messages.send", { serverId, conversationKey, text: String(text) }),
      edit: (serverId, groupId, id, text) => ask("messages.edit", { serverId, groupId, id, text: String(text) }),
      delete: (serverId, groupId, id) => ask("messages.delete", { serverId, groupId, id }),
      react: (serverId, groupId, id, emoji) => ask("messages.react", { serverId, groupId, id, emoji: String(emoji) }),
    },
    activity: {
      onTyping: (filter) => addFilter("typing", filter),
      onRead: (filter) => addFilter("read", filter),
      onTypingShown: (filter) => addFilter("typingShown", filter),
    },
    notifications: {
      show: (title, body) => tell("notify.show", { title: String(title), body: String(body) }),
      onNotify: (filter) => addFilter("notify", filter),
    },
    core: {
      call: (server, method, ...args) => ask("core.call", { server, method, args }),
      on: (type, listener) => subscribe(String(type), listener),
    },
    voice: {
      members: (serverId) => ask("voice.members", { serverId }),
      join: (serverId, channelId) => ask("voice.join", { serverId, channelId }),
      leave: () => ask("voice.leave", {}),
      setMuted: (muted) => ask("voice.mute", { muted: !!muted }),
      setDeafened: (deafened) => ask("voice.deafen", { deafened: !!deafened }),
    },
    net: {
      fetch: async (url, init = {}) => {
        const body = init.body === undefined ? null : toBase64(bytesOf(init.body));
        return response(await ask("net.fetch", { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body }));
      },
    },
    files: {
      open: async (options = {}) => {
        const file = await ask("files.open", { title: options.title ?? null, extensions: options.extensions ?? [] });
        return file ? { name: file.name, bytes: fromBase64(file.bytes) } : null;
      },
      save: (name, bytes) => ask("files.save", { name: String(name), bytes: toBase64(bytesOf(bytes)) }),
      attachment: async (serverId, groupId, messageId, index) => {
        const file = await ask("files.attachment", { serverId, groupId, messageId, index });
        return { name: file.name, mime: file.mime, bytes: fromBase64(file.bytes) };
      },
      asset: async (path) => fromBase64(await ask("files.asset", { path: String(path) })),
    },
    clipboard: {
      read: () => ask("clipboard.read", {}),
      write: (text) => ask("clipboard.write", { text: String(text) }),
    },
  });

  // What a filter answered, as the app reads it: { pass }, { text } or { stop }.
  const filterAnswer = (kind, value) => {
    if (kind === "outgoing") {
      if (value === false) return { stop: true };
      if (typeof value === "string") return { text: value };
      if (value && typeof value === "object" && typeof value.text === "string") return { text: value.text };
      return { pass: true };
    }
    if (kind === "notify") {
      if (value === false) return { stop: true };
      if (value && typeof value === "object") return { title: typeof value.title === "string" ? value.title : undefined, body: typeof value.body === "string" ? value.body : undefined };
      return { pass: true };
    }
    return value === false ? { stop: true } : { pass: true };
  };

  const encodeDecoration = (message, decoration) => {
    if (!decoration || typeof decoration !== "object") return null;
    const out = {};
    if (typeof decoration.text === "string") out.text = decoration.text;
    if (decoration.hidden === true) out.hidden = true;
    if (decoration.mark && typeof decoration.mark.label === "string") out.mark = { label: decoration.mark.label, icon: typeof decoration.mark.icon === "string" ? decoration.mark.icon : undefined };
    if (decoration.view) out.view = encodeView(`decoration:${message.serverId}/${message.groupId}/${message.id}`, decoration.view);
    return out;
  };

  // --- What the app asks ---
  const calls = {
    async command({ id, context: raw }) {
      const run = commands.get(id);
      if (!run) throw new Error(`Nothing runs the command ${id}.`);
      await run(context(raw));
    },
    async handler({ id, value }) {
      const fn = handlers.get(id);
      if (fn) await fn(value);
    },
    // A button in the header or beside the message box is handed where it was pressed; an entry
    // on a message or a chat, that message or chat.
    async action({ id, kind, target }) {
      const fn = actions.get(id);
      if (fn) await fn(kind === "context" ? context(target) : target);
    },
    async filter({ id, payload }) {
      const filter = filters.get(id);
      if (!filter) return { pass: true };
      return filterAnswer(filter.kind, await filter.fn(payload));
    },
    async decorate({ messages }) {
      if (!decorator) return messages.map(() => null);
      const out = [];
      for (const message of messages) {
        try {
          out.push(encodeDecoration(message, await decorator(message)));
        } catch (error) {
          console.error("A decoration failed:", error);
          out.push(null);
        }
      }
      return out;
    },
  };

  const events = {
    core({ event }) {
      if (event.type === "message" && event.message) for (const listener of messageListeners) listener(event.message, !!event.isNew);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    settings({ key, value }) {
      settings[key] = value;
      for (const listener of settingListeners) listener(key, value);
    },
    timer({ id }) {
      const timer = timers.get(id);
      if (!timer) return;
      if (!timer.repeats) timers.delete(id);
      timer.fn(...timer.args);
    },
  };

  const fail = (error) => ({ message: error instanceof Error ? error.message : String(error) });

  globalThis.__zunaDefine = (fn) => {
    if (typeof fn === "function" && !setup) setup = fn;
  };

  globalThis.__zunaReceive = (json) => {
    const message = JSON.parse(json);
    switch (message.t) {
      case "boot":
        info = message.plugin;
        settings = { ...message.settings };
        storage = { ...message.storage };
        return;
      case "reply": {
        const entry = asks.get(message.n);
        if (!entry) return;
        asks.delete(message.n);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error?.message ?? "The app refused."));
        return;
      }
      case "call": {
        const run = calls[message.fn];
        Promise.resolve()
          .then(() => (run ? run(message.args ?? {}) : Promise.reject(new Error(`No such call: ${message.fn}`))))
          .then(
            (value) => post({ t: "done", n: message.n, ok: true, value: value ?? null }),
            (error) => post({ t: "done", n: message.n, ok: false, error: fail(error) }),
          );
        return;
      }
      case "event": {
        try {
          events[message.name]?.(message.data ?? {});
        } catch (error) {
          console.error(`Handling ${message.name} failed:`, error);
        }
        return;
      }
    }
  };

  // Run by the host once the plugin's script has: runs its setup, then says it's ready.
  globalThis.__zunaStart = () => {
    if (!setup) {
      post({ t: "ready" });
      return;
    }
    Promise.resolve()
      .then(() => setup(api()))
      .then(
        () => {
          renderAll();
          post({ t: "ready" });
        },
        (error) => post({ t: "failed", error: show(error) }),
      );
  };

  // Run by the host after each message it handled, so whatever changed is drawn again.
  globalThis.__zunaAfter = () => {
    if (info) renderAll();
  };
})();
