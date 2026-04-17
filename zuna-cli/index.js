#!/usr/bin/env node
/**
 * zuna-cli — interactive CLI client for the Zuna chat server.
 *
 * Usage:
 *   node index.js
 *
 * Keys are generated once and stored at ~/.zuna-cli.json.
 * Servers (address + username) are saved there too across sessions.
 */

import readline from "readline";
import * as storage from "./src/storage.js";
import { ZunaAPI } from "./src/api.js";
import { ZunaWebSocket } from "./src/ws.js";
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  signMessage,
  computeSharedSecret,
  encrypt,
  decrypt,
} from "./src/crypto.js";

// ─── Readline helpers ─────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function print(msg = "") {
  console.log(msg);
}

function printLine() {
  print("─".repeat(60));
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function loginToServer(api, server, store) {
  const { nonce } = await api.handshake(server.username);
  const signature = signMessage(store.sigPrivateKey, nonce);
  const { token } = await api.login(server.username, signature);
  api.setToken(token);
  return token;
}

// ─── Chat view ────────────────────────────────────────────────────────────────

async function runChatView(api, wsc, server, member, store) {
  let sharedSecret;
  try {
    sharedSecret = computeSharedSecret(
      store.encPrivateKey,
      member.identity_key,
    );
  } catch (err) {
    print(`  [error] Cannot compute shared secret: ${err.message}`);
    return;
  }

  // Load the most recent page of messages
  let cursorMin = "9223372036854775807";
  const fetchPage = async (cursor) => {
    const data = await api.chatMessages(member.chat_id, 50, cursor);
    return (data.messages ?? []).reverse(); // server returns newest-first; we want oldest-first
  };

  const printMessage = (msg) => {
    const isOwn = msg.sender_id === server.id;
    const who = isOwn ? "You" : member.username;
    const time = new Date(msg.sent_at).toLocaleTimeString();
    const readMark = msg.read_at > 0 ? " [read]" : "";
    let text;
    try {
      text = decrypt(sharedSecret, {
        ciphertext: msg.cipher_text,
        iv: msg.iv,
        authTag: msg.auth_tag,
      });
    } catch {
      text = "<decryption failed>";
    }
    print(`  [${time}] ${who}: ${text}${readMark}  (id:${msg.id})`);
  };

  let messages = await fetchPage(cursorMin);
  if (messages.length > 0) {
    cursorMin = String(messages[0].id); // oldest message id for /more
  }

  printLine();
  print(`  Chat with ${member.username}  |  chat_id: ${member.chat_id}`);
  printLine();
  if (messages.length === 0) {
    print("  (no messages yet)");
  } else {
    for (const m of messages) printMessage(m);
  }
  printLine();
  print("  Commands: /exit  /more  /read <id>  /ping  /help");
  printLine();

  // Track pending message acks: localId → plaintext
  let localIdCounter = 0;
  const pendingAcks = new Map();

  // ── WebSocket handlers ────────────────────────────────────────────────────

  wsc.on("message_receive", (payload) => {
    if (payload.chat_id !== member.chat_id) return;
    let text;
    try {
      text = decrypt(sharedSecret, {
        ciphertext: payload.cipher_text,
        iv: payload.iv,
        authTag: payload.auth_tag,
      });
    } catch {
      text = "<decryption failed>";
    }
    const time = new Date(payload.created_at).toLocaleTimeString();
    // Clear current prompt line, print message, restore prompt
    process.stdout.write("\r\x1b[K");
    print(`  [${time}] ${member.username}: ${text}  (id:${payload.id})`);
    rl.prompt(true);
  });

  wsc.on("message_ack", (payload) => {
    if (payload.chat_id !== member.chat_id) return;
    const plain = pendingAcks.get(payload.local_id) ?? "…";
    pendingAcks.delete(payload.local_id);
    const time = new Date(payload.created_at).toLocaleTimeString();
    process.stdout.write("\r\x1b[K");
    print(`  [${time}] You: ${plain}  (id:${payload.id})`);
    rl.prompt(true);
  });

  wsc.on("message_read_info", (payload) => {
    process.stdout.write("\r\x1b[K");
    print(`  ${member.username} read message id:${payload.message_id}`);
    rl.prompt(true);
  });

  // ── Interactive input loop ────────────────────────────────────────────────

  rl.setPrompt(`  ${member.username} > `);
  rl.prompt();

  return new Promise((resolve) => {
    const onLine = async (line) => {
      const text = line.trim();

      if (!text) {
        rl.prompt();
        return;
      }

      if (text === "/exit" || text === "/list") {
        rl.removeListener("line", onLine);
        wsc.off("message_receive");
        wsc.off("message_ack");
        wsc.off("message_read_info");
        rl.setPrompt("> ");
        print("");
        resolve();
        return;
      }

      if (text === "/help") {
        print("  /exit        — back to chat list");
        print("  /more        — load older messages");
        print("  /read <id>   — mark a message as read");
        print("  /ping        — measure server latency");
        print("  /seen        — request last-seen info for all users");
        print("  (anything else is sent as a message)");
        rl.prompt();
        return;
      }

      if (text === "/more") {
        try {
          const older = await fetchPage(cursorMin);
          if (older.length === 0) {
            print("  (no more messages)");
          } else {
            cursorMin = String(older[0].id);
            print("  ── older messages ──");
            for (const m of older) printMessage(m);
            print("  ────────────────────");
          }
        } catch (err) {
          print(`  [error] ${err.message}`);
        }
        rl.prompt();
        return;
      }

      if (text === "/ping") {
        const ts = Date.now();
        const pongHandler = (payload) => {
          if (payload.ts === ts) {
            process.stdout.write("\r\x1b[K");
            print(`  Pong! Latency: ${Date.now() - ts} ms`);
            rl.prompt(true);
            wsc.off("pong");
          }
        };
        wsc.on("pong", pongHandler);
        setTimeout(() => {
          wsc.off("pong");
        }, 8000);
        wsc.send("ping", { ts });
        rl.prompt();
        return;
      }

      if (text === "/seen") {
        wsc.on("last_seen_response", (payload) => {
          process.stdout.write("\r\x1b[K");
          print("  ── Last seen ──");
          for (const entry of payload.last_seen ?? []) {
            const status = entry.online
              ? "online"
              : `last seen ${new Date(entry.last_seen).toLocaleString()}`;
            print(`  ${entry.user_id}: ${status}`);
          }
          print("  ───────────────");
          rl.prompt(true);
          wsc.off("last_seen_response");
        });
        wsc.send("last_seen_request", {});
        rl.prompt();
        return;
      }

      if (text.startsWith("/read ")) {
        const idStr = text.slice(6).trim();
        const messageId = parseInt(idStr, 10);
        if (isNaN(messageId)) {
          print("  Usage: /read <numeric message id>");
        } else {
          wsc.send("mark_read", {
            message_id: messageId,
            timestamp: Date.now(),
          });
          print(`  Sent mark_read for message id:${messageId}`);
        }
        rl.prompt();
        return;
      }

      // ── Default: send a chat message ──────────────────────────────────────
      try {
        const { ciphertext, iv, authTag } = encrypt(sharedSecret, text);
        const localId = ++localIdCounter;
        pendingAcks.set(localId, text);
        wsc.send("message", {
          chat_id: member.chat_id,
          cipher_text: ciphertext,
          iv,
          auth_tag: authTag,
          local_id: localId,
        });
        // The message is printed when message_ack is received from the server.
      } catch (err) {
        print(`  [error] Failed to encrypt/send: ${err.message}`);
        rl.prompt();
      }
    };

    rl.on("line", onLine);
  });
}

// ─── Server session ──────────────────────────────────────────────────────────

async function runServerSession(server, store) {
  const api = new ZunaAPI(server.address);

  print(`\nLogging in to ${server.address} as ${server.username}…`);
  try {
    await loginToServer(api, server, store);
    print("  Authenticated.");
  } catch (err) {
    print(`  [error] Login failed: ${err.message}`);
    return;
  }

  print("  Connecting WebSocket…");
  const wsc = new ZunaWebSocket(server.address, api.token);
  try {
    await wsc.connect();
    print("  WebSocket ready.\n");
  } catch (err) {
    print(`  [error] WebSocket error: ${err.message}`);
    return;
  }

  // ── Chat list loop ────────────────────────────────────────────────────────
  while (true) {
    let chats;
    try {
      const data = await api.chatList();
      chats = data.chats ?? [];
    } catch (err) {
      print(`  [error] Failed to fetch chats: ${err.message}`);
      break;
    }

    printLine();
    print("  Chat list");
    printLine();
    if (chats.length === 0) {
      print("  (no chats yet — other users need to join the server)");
    } else {
      chats.forEach((m, i) => {
        print(`  ${i + 1}. ${m.username}  (chat_id: ${m.chat_id})`);
      });
    }
    printLine();

    const input = await ask(
      '  Select chat number, or "back" to go to the server list: ',
    );

    if (input === "back" || input === "b" || input === "") break;

    const idx = parseInt(input, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= chats.length) {
      print("  Invalid selection.\n");
      continue;
    }

    const member = chats[idx];
    await runChatView(api, wsc, server, member, store);
  }

  wsc.close();
}

// ─── Join server ──────────────────────────────────────────────────────────────

async function joinServer(store) {
  print("\n  Join / register on a Zuna server");
  printLine();
  const address = await ask("  Server address (host:port): ");
  const username = await ask("  Choose a username: ");

  if (!address || !username) {
    print("  Cancelled.");
    return;
  }

  const api = new ZunaAPI(address);
  print("  Registering…");
  let data;
  try {
    data = await api.join({
      username,
      identityKey: store.encPublicKey,
      signingKey: store.sigPublicKey,
    });
  } catch (err) {
    print(`  [error] Registration failed: ${err.message}`);
    return;
  }

  const server = {
    id: data.id,
    address,
    name: address,
    username,
  };

  store.servers.push(server);
  storage.save(store);
  print(`  Joined! Your user id: ${data.id}`);
  print(`  Server saved. Use "login" from the main menu.\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  print("");
  print("  ╔══════════════════════════════╗");
  print("  ║       zuna-cli  v1.0.0       ║");
  print("  ╚══════════════════════════════╝");
  print("");

  let store = storage.load();

  // Generate keys on first run
  if (!store.sigPrivateKey || !store.encPrivateKey) {
    print("  First time setup — generating identity keys…");
    const sigPair = generateSigningKeyPair();
    const encPair = generateEncryptionKeyPair();
    store.sigPublicKey = sigPair.publicKey;
    store.sigPrivateKey = sigPair.privateKey;
    store.encPublicKey = encPair.publicKey;
    store.encPrivateKey = encPair.privateKey;
    storage.save(store);
    print(`  Keys written to ${storage.storagePath()}\n`);
  }

  // ── Main menu loop ────────────────────────────────────────────────────────
  while (true) {
    printLine();
    print("  Main Menu");
    printLine();
    print("  Saved servers:");
    if (store.servers.length === 0) {
      print("    (none)");
    } else {
      store.servers.forEach((s, i) => {
        print(`    ${i + 1}. ${s.address}  →  ${s.username}  (id: ${s.id})`);
      });
    }
    print("");
    print("  j  — join a new server (register)");
    print("  r  — remove a saved server");
    print("  q  — quit");
    printLine();

    const input = await ask("  Select a server number or option: ");

    if (input === "q") {
      print("  Bye!\n");
      rl.close();
      process.exit(0);
    }

    if (input === "j") {
      // Reload store in case it was mutated
      store = storage.load();
      await joinServer(store);
      store = storage.load();
      continue;
    }

    if (input === "r") {
      if (store.servers.length === 0) {
        print("  No servers to remove.");
        continue;
      }
      const numStr = await ask("  Enter server number to remove: ");
      const idx = parseInt(numStr, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < store.servers.length) {
        store.servers.splice(idx, 1);
        storage.save(store);
        print("  Removed.");
      } else {
        print("  Invalid number.");
      }
      continue;
    }

    const idx = parseInt(input, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= store.servers.length) {
      print("  Invalid selection.");
      continue;
    }

    const server = store.servers[idx];
    await runServerSession(server, store);
    store = storage.load(); // reload in case anything changed
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
