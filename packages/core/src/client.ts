// The top level of the client: the list of joined servers and a session for each.

import * as wasm from "@zuna/crypto";
import {
  login,
  previewInvite,
  recover,
  register,
  type AccountState,
} from "./account";
import { normalizeServerUrl, Api } from "./api";
import { randomId, type VaultCore } from "./crypto";
import { fromBase64, fromUtf8, toBase64, utf8 } from "./encoding";
import { migrate, type DbProvider, type LocalDb } from "./db";
import type { FileAdapter } from "./files";
import { findLink, makeLinkPreview, type WebAdapter } from "./links";
import { ServerSession } from "./session";
import type { CoreEvent, InvitePreview, LinkPreview, MessageBody, Profile, ServerEntry, ServerInfo } from "./types";

export const INDEX_DB = "zuna-index";
export const label = (text: string) => utf8(`zuna/local/${text}`);

/** The key a server's local data is sealed with, derived from the device key. */
export const serverKeyFor = (deviceKey: Uint8Array, serverId: string) =>
  wasm.hkdfSha256(deviceKey, new Uint8Array(0), utf8(`zuna/local/server/${serverId}`), 32);

/** A server's local database. */
export const serverDbName = (serverId: string) => `zuna-server-${serverId}`;

function encodeAccount(account: AccountState): string {
  return JSON.stringify({
    ...account,
    devicePublic: toBase64(account.devicePublic),
    deviceSecret: toBase64(account.deviceSecret),
    certificate: toBase64(account.certificate),
    accountKey: toBase64(account.accountKey),
    core: {
      identityPublic: toBase64(account.core.identityPublic),
      identitySecret: toBase64(account.core.identitySecret),
      hpkePublic: toBase64(account.core.hpkePublic),
      hpkeSecret: toBase64(account.core.hpkeSecret),
      communityKey: toBase64(account.core.communityKey),
    },
  });
}

export function decodeAccount(json: string): AccountState {
  const raw = JSON.parse(json);
  const core: VaultCore = {
    identityPublic: fromBase64(raw.core.identityPublic),
    identitySecret: fromBase64(raw.core.identitySecret),
    hpkePublic: fromBase64(raw.core.hpkePublic),
    hpkeSecret: fromBase64(raw.core.hpkeSecret),
    communityKey: fromBase64(raw.core.communityKey),
  };
  return {
    ...raw,
    devicePublic: fromBase64(raw.devicePublic),
    deviceSecret: fromBase64(raw.deviceSecret),
    certificate: fromBase64(raw.certificate),
    accountKey: fromBase64(raw.accountKey),
    core,
  };
}

export interface ZunaClientOptions {
  db: DbProvider;
  /** Protected by the operating system's keychain in the desktop app. */
  deviceKey: Uint8Array;
  deviceName: string;
  onEvent: (event: CoreEvent) => void;
  /** How files are read and returned. Blobs by default. */
  files?: FileAdapter;
  /** How link previews fetch pages. Without it, links have no previews. */
  web?: WebAdapter;
}

const PREVIEWS_KEPT = 50;
/** How long what's on this device stays after a server ended its session, unless the person clears it first. */
const SIGNED_OUT_KEPT_MS = 30 * 24 * 3600 * 1000;

export class ZunaClient {
  private sessions = new Map<string, ServerSession>();
  private index!: LocalDb;
  private active = false;
  private previews = new Map<string, Promise<LinkPreview | null>>();

  constructor(private readonly options: ZunaClientOptions) {}

  async open(): Promise<void> {
    this.index = await this.options.db.open(INDEX_DB);
    this.index.run(`CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      account BLOB NOT NULL,
      name TEXT NOT NULL,
      has_icon INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = this.index.all<{ name: string }>("PRAGMA table_info(servers)").map((column) => column.name);
    if (!columns.includes("signed_out")) {
      this.index.run("ALTER TABLE servers ADD COLUMN signed_out TEXT");
      this.index.run("ALTER TABLE servers ADD COLUMN signed_out_at INTEGER");
    }
    const rows = this.index.all<{ id: string; account: Uint8Array; signed_out_at: number | null }>("SELECT id, account, signed_out_at FROM servers ORDER BY position");
    for (const row of rows) {
      if (row.signed_out_at && Date.now() - row.signed_out_at > SIGNED_OUT_KEPT_MS) {
        this.index.run("DELETE FROM servers WHERE id = ?", [row.id]);
        await this.options.db.remove(serverDbName(row.id));
        continue;
      }
      const json = fromUtf8(wasm.aeadOpen(this.serverKey(row.id), row.account, label("account")));
      const session = await this.createSession(row.id, decodeAccount(json));
      session.start();
    }
  }

  /** Whether the person is using this device right now, for every server (see ServerSession.setActive). */
  setActive(active: boolean): void {
    this.active = active;
    for (const session of this.sessions.values()) session.setActive(active);
  }

  private serverKey(serverId: string): Uint8Array {
    return serverKeyFor(this.options.deviceKey, serverId);
  }

  private async createSession(serverId: string, account: AccountState): Promise<ServerSession> {
    const db = await this.options.db.open(serverDbName(serverId));
    migrate(db);
    const session = new ServerSession(
      serverId,
      account,
      db,
      this.serverKey(serverId),
      (event) => this.handle(event),
      this.options.deviceName,
      this.options.files,
    );
    // Nothing is erased on the server's word: that's for the person to decide.
    session.onSignedOut = (reason) => {
      this.index.run("UPDATE servers SET signed_out = ?, signed_out_at = COALESCE(signed_out_at, ?) WHERE id = ?", [reason, Date.now(), serverId]);
    };
    session.onSignedIn = () => {
      this.index.run("UPDATE servers SET signed_out = NULL, signed_out_at = NULL WHERE id = ?", [serverId]);
    };
    session.setActive(this.active);
    this.sessions.set(serverId, session);
    return session;
  }

  private handle(event: CoreEvent): void {
    if (event.type === "settings") this.saveServerInfo(event.serverId, event.info);
    this.options.onEvent(event);
  }

  private saveServerInfo(serverId: string, info: ServerInfo): void {
    this.index.run("UPDATE servers SET name = ?, has_icon = ? WHERE id = ?", [info.name, info.has_icon ? 1 : 0, serverId]);
  }

  private async addAccount(account: AccountState, isNewDevice: boolean): Promise<string> {
    const existing = this.listServers().find((server) => server.url === account.serverUrl);
    if (existing) await this.forgetServer(existing.id);
    const serverId = randomId();
    const sealed = wasm.aeadSeal(this.serverKey(serverId), utf8(encodeAccount(account)), label("account"));
    const info = await new Api(account.serverUrl).info();
    const position = (this.index.get<{ next: number }>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM servers")?.next ?? 1);
    this.index.run("INSERT INTO servers(id, position, account, name, has_icon) VALUES(?, ?, ?, ?, ?)", [
      serverId,
      position,
      sealed,
      info.name,
      info.has_icon ? 1 : 0,
    ]);
    const session = await this.createSession(serverId, account);
    if (isNewDevice) await session.prepareNewDevice();
    session.start();
    return serverId;
  }

  // --- Joining ---

  previewInvite(link: string): Promise<InvitePreview> {
    return previewInvite(link);
  }

  async serverInfo(url: string): Promise<ServerInfo> {
    return new Api(normalizeServerUrl(url)).info();
  }

  async register(invite: InvitePreview, username: string, password: string, profile: Profile): Promise<{ serverId: string; recoveryKey: string }> {
    const result = await register({ invite, serverUrl: invite.url, username, password, profile });
    const serverId = await this.addAccount(result.account, true);
    return { serverId, recoveryKey: result.recoveryKey };
  }

  async login(url: string, username: string, password: string): Promise<string> {
    return this.addAccount(await login(url, username, password), true);
  }

  async recover(url: string, username: string, recoveryKey: string, newPassword: string): Promise<string> {
    return this.addAccount(await recover(url, username, recoveryKey, newPassword), true);
  }

  // --- Servers ---

  listServers(): ServerEntry[] {
    const rows = this.index.all<{ id: string; account: Uint8Array; name: string; has_icon: number; signed_out: string | null }>(
      "SELECT id, account, name, has_icon, signed_out FROM servers ORDER BY position",
    );
    return rows.map((row) => {
      const account = JSON.parse(fromUtf8(wasm.aeadOpen(this.serverKey(row.id), row.account, label("account"))));
      return {
        id: row.id,
        url: account.serverUrl,
        name: row.name,
        hasIcon: row.has_icon !== 0,
        username: account.username,
        userId: account.userId,
        role: this.sessions.get(row.id)?.getSelf().role ?? account.role,
        signedOut: row.signed_out ?? null,
      };
    });
  }

  reorderServers(ids: string[]): void {
    this.index.transaction(() => {
      ids.forEach((id, position) => this.index.run("UPDATE servers SET position = ? WHERE id = ?", [position, id]));
    });
  }

  session(serverId: string): ServerSession {
    const session = this.sessions.get(serverId);
    if (!session) throw new Error("That server isn't connected.");
    return session;
  }

  // --- Messages across servers ---

  /** The first link in a draft that can have a preview. */
  findLink(text: string): string | null {
    return findLink(text);
  }

  /**
   * Makes a link's preview on this device, which fetches the page, so only
   * when the person allows link previews. Recent ones are remembered while
   * someone types.
   */
  linkPreview(url: string): Promise<LinkPreview | null> {
    const web = this.options.web;
    if (!web) return Promise.resolve(null);
    let preview = this.previews.get(url);
    if (!preview) {
      preview = makeLinkPreview(web, url).catch(() => null);
      this.previews.set(url, preview);
      if (this.previews.size > PREVIEWS_KEPT) this.previews.delete(this.previews.keys().next().value!);
    }
    return preview;
  }

  /**
   * Forwards messages to a conversation on any server, in the order given. On
   * the same server each says whose it was and shares its files. On another
   * server it only says it's forwarded, since its author isn't known there,
   * and its files are uploaded there again.
   */
  async forwardMessages(fromServerId: string, groupId: string, ids: string[], toServerId: string, toKey: string): Promise<void> {
    const source = this.session(fromServerId);
    // All of them are checked before any is sent.
    const originals = ids.map((id) => ({ id, ...source.forwardable(groupId, id) }));
    if (fromServerId === toServerId) {
      for (const original of originals) source.forwardMessage(groupId, original.id, toKey);
      return;
    }
    const target = this.session(toServerId);
    for (const { id: _, senderId: __, attachments, ...original } of originals) {
      const body: MessageBody = { ...original, forwarded: {} };
      if (!attachments?.length) {
        target.sendMessage(toKey, body);
        continue;
      }
      const files = [];
      for (const { fileId, key, prefix, chunks, ...details } of attachments) {
        files.push({ ...details, blob: await source.downloadFile({ fileId, key, prefix, chunks, mime: details.mime }) });
      }
      await target.sendWithAttachments(toKey, files, body);
    }
  }

  /**
   * Signs out of a server and erases everything stored for it on this device.
   * This, and signing in again, are the only things that erase it: the person's
   * own decisions.
   */
  async leaveServer(serverId: string): Promise<void> {
    await this.sessions.get(serverId)?.signOut();
    await this.forgetServer(serverId);
  }

  private async forgetServer(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    session?.stop();
    this.sessions.delete(serverId);
    this.index.run("DELETE FROM servers WHERE id = ?", [serverId]);
    await this.options.db.remove(serverDbName(serverId));
  }

  nudge(): void {
    for (const session of this.sessions.values()) session.nudge();
  }

  /** Closes every connection while the app can't run (an iOS app in the background). */
  suspend(): void {
    for (const session of this.sessions.values()) session.suspend();
  }

  /** Reconnects after `suspend()` and catches up on what happened meanwhile. */
  resume(): void {
    for (const session of this.sessions.values()) session.resume();
  }

  stop(): void {
    for (const session of this.sessions.values()) session.stop();
  }
}
