// The top level of the client: the list of joined servers and a session for each.

import * as wasm from "@zuna/crypto";
import {
  login,
  previewInvite,
  recover,
  register,
  type AccountState,
} from "./account";
import { normalizeServerUrl, Api, ApiError } from "./api";
import { coreFromJson, coreToJson, randomId } from "./crypto";
import type { RotationPlan } from "./generations";
import { equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from "./encoding";
import { migrate, type DbProvider, type LocalDb, type SqlValue } from "./db";
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
    sealPublic: account.sealPublic && toBase64(account.sealPublic),
    sealSecret: account.sealSecret && toBase64(account.sealSecret),
    sealOlder: account.sealOlder && toBase64(account.sealOlder),
    core: coreToJson(account.core),
  });
}

export function decodeAccount(json: string): AccountState {
  const raw = JSON.parse(json);
  return {
    ...raw,
    devicePublic: fromBase64(raw.devicePublic),
    deviceSecret: fromBase64(raw.deviceSecret),
    certificate: fromBase64(raw.certificate),
    accountKey: fromBase64(raw.accountKey),
    sealPublic: raw.sealPublic ? fromBase64(raw.sealPublic) : undefined,
    sealSecret: raw.sealSecret ? fromBase64(raw.sealSecret) : undefined,
    sealOlder: raw.sealOlder ? fromBase64(raw.sealOlder) : undefined,
    core: coreFromJson(raw.core),
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
  /** The app shows channels. One that doesn't takes no part in them, so its device does no work for them. */
  channels?: boolean;
  /** The app has calls in direct messages and groups. One that doesn't hears nothing of them. */
  calls?: boolean;
}

const PREVIEWS_KEPT = 50;
/** How long what's on this device stays after a server ended its session, unless the person clears it first. */
const SIGNED_OUT_KEPT_MS = 30 * 24 * 3600 * 1000;

/**
 * A database that can stop taking writes, while the app is suspended: another
 * process may use the same data meanwhile, such as the iOS share extension.
 * A write refused means what's in memory may no longer match what's stored.
 */
class PausableDb implements LocalDb {
  paused = false;
  refused = false;

  constructor(private readonly db: LocalDb) {}

  private check(): void {
    if (!this.paused) return;
    this.refused = true;
    throw new Error("This device's data is in use elsewhere for a moment. Please try again.");
  }

  run(sql: string, params?: SqlValue[]): void {
    this.check();
    this.db.run(sql, params);
  }

  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[] {
    return this.db.all<T>(sql, params);
  }

  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T | undefined {
    return this.db.get<T>(sql, params);
  }

  transaction<T>(fn: () => T): T {
    this.check();
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

export class ZunaClient {
  private sessions = new Map<string, ServerSession>();
  private index!: LocalDb;
  /** Every database the sessions and the index write to, so they can be paused together. */
  private dbs: PausableDb[] = [];
  /** Sessions `reload()` put away, whose late events nobody should hear. */
  private replaced = new WeakSet<ServerSession>();
  private active = false;
  private previews = new Map<string, Promise<LinkPreview | null>>();

  constructor(private readonly options: ZunaClientOptions) {}

  private pausable(db: LocalDb): PausableDb {
    const pausable = new PausableDb(db);
    this.dbs.push(pausable);
    return pausable;
  }

  async open(): Promise<void> {
    this.index = this.pausable(await this.options.db.open(INDEX_DB));
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

  private storedAccount(serverId: string): AccountState {
    const row = this.index.get<{ account: Uint8Array }>("SELECT account FROM servers WHERE id = ?", [serverId])!;
    return decodeAccount(fromUtf8(wasm.aeadOpen(this.serverKey(serverId), row.account, label("account"))));
  }

  private async createSession(serverId: string, account: AccountState): Promise<ServerSession> {
    const db = this.pausable(await this.options.db.open(serverDbName(serverId)));
    migrate(db);
    // A session put away by `reload()` writes through the index it began with, which is paused, and says nothing more.
    const index = this.index;
    const session: ServerSession = new ServerSession(
      serverId,
      account,
      db,
      this.serverKey(serverId),
      (event) => {
        if (!this.replaced.has(session)) this.handle(event);
      },
      this.options.deviceName,
      this.options.files,
      this.options.channels ?? false,
      this.options.calls ?? false,
    );
    // Nothing is erased on the server's word: that's for the person to decide.
    session.onSignedOut = (reason) => {
      index.run("UPDATE servers SET signed_out = ?, signed_out_at = COALESCE(signed_out_at, ?) WHERE id = ?", [reason, Date.now(), serverId]);
    };
    session.onSignedIn = () => {
      index.run("UPDATE servers SET signed_out = NULL, signed_out_at = NULL WHERE id = ?", [serverId]);
    };
    session.onAccountChanged = (changed) => {
      const sealed = wasm.aeadSeal(this.serverKey(serverId), utf8(encodeAccount(changed)), label("account"));
      index.run("UPDATE servers SET account = ? WHERE id = ?", [sealed, serverId]);
    };
    if (this.options.web) session.linkPreview = (url) => this.linkPreview(url);
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

  private async addAccount(account: AccountState, isNewDevice: boolean, plan?: RotationPlan): Promise<string> {
    const existing = this.listServers().find((server) => server.url === account.serverUrl);
    if (existing) {
      // An account never begins with another key, so what's here isn't given up for a server that says it did.
      if (existing.userId === account.userId && !equalBytes(this.storedAccount(existing.id).core.rootPublic, account.core.rootPublic)) {
        throw new Error("What the server sent for this account doesn't match what this device knows about it. Nothing here was changed.");
      }
      await this.forgetServer(existing.id);
    }
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
    if (plan) {
      // Stored until it's done: if the network is what's in the way, it finishes later.
      await session.rotate(plan).catch(async (error) => {
        if (error instanceof ApiError && error.retryable) return;
        await this.forgetServer(serverId);
        throw error;
      });
    }
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
    const { account, plan } = await login(url, username, password);
    return this.addAccount(account, true, plan);
  }

  async recover(url: string, username: string, recoveryKey: string, newPassword: string): Promise<string> {
    const { account, plan } = await recover(url, username, recoveryKey, newPassword);
    return this.addAccount(account, true, plan);
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

  /**
   * Closes every connection while the app can't run (an iOS app in the
   * background), and takes no writes until `resume()`, since the share
   * extension may use the same data meanwhile.
   */
  suspend(): void {
    for (const session of this.sessions.values()) session.suspend();
    for (const db of this.dbs) db.paused = true;
  }

  /**
   * Reconnects after `suspend()` and catches up on what happened meanwhile.
   * If something tried to write while suspended, such as a send that was
   * still under way, everything is read again first, as in `reload()`, and
   * this says so.
   */
  async resume(): Promise<boolean> {
    if (this.dbs.some((db) => db.refused)) {
      await this.reload();
      return true;
    }
    for (const db of this.dbs) db.paused = false;
    for (const session of this.sessions.values()) session.resume();
    return false;
  }

  /**
   * Reads everything again from this device's databases and reconnects, for
   * an app that was suspended while another process used them, such as the
   * iOS share extension: what it held in memory, its MLS groups above all,
   * may be behind what's stored. Work left over from before can't write.
   */
  async reload(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.stop();
      this.replaced.add(session);
    }
    for (const db of this.dbs) db.paused = true;
    this.sessions.clear();
    this.dbs = [];
    await this.open();
  }

  stop(): void {
    for (const session of this.sessions.values()) session.stop();
  }
}
