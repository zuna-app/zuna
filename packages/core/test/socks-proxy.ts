// A SOCKS5 proxy for tests (RFC 1928), with a username and password when it's given one
// (RFC 1929), `CONNECT` and `UDP ASSOCIATE`. It writes down everything it was asked: a name
// or an address, which port, how the client signed in, and the port of every connection and
// socket it opened on a client's behalf. Switches make it refuse UDP, refuse the password,
// hang, or drop everything at once.
//
// Beside it, `Recorder`: a door in front of a test server or a test LiveKit, which writes down
// the port each connection and packet came from. Every port it saw being one the proxy opened
// is what shows that nothing reached the server without going through the proxy.
//
// `socksAgent` is the client side for Node: an undici dispatcher whose every connection goes
// through a proxy, as the apps' hosts send theirs with the setting on.

import { lookup } from "node:dns/promises";
import { createSocket, type RemoteInfo, type Socket as UdpSocket } from "node:dgram";
import { isIP, connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Agent, buildConnector } from "undici";

export type AddressKind = "name" | "ipv4" | "ipv6";

/** One request a client made of the proxy. */
export interface SocksRequest {
  command: "connect" | "udp";
  host: string;
  kind: AddressKind;
  port: number;
  /** Who signed in, or null for a client that didn't. */
  user: string | null;
}

/** Where one datagram a client sent through an association was going. */
export interface SocksDatagram {
  host: string;
  kind: AddressKind;
  port: number;
}

const REPLY = { ok: 0, failure: 1, notAllowed: 2, unreachable: 4, refused: 5, unsupported: 7, badAddress: 8 } as const;

/** An address as SOCKS5 writes it: its type, the address, and the port. */
export function encodeAddress(host: string, port: number): Buffer {
  const kind = isIP(host);
  let head: Buffer;
  if (kind === 4) head = Buffer.from([1, ...host.split(".").map(Number)]);
  else if (kind === 6) head = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host, "utf8");
    if (name.length > 255) throw new Error("A name SOCKS5 can carry is at most 255 bytes.");
    head = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port);
  return Buffer.concat([head, tail]);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail] = host.replace(/^\[|\]$/g, "").split("::") as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(":").filter(Boolean) : []);
  const front = groups(head);
  const back = groups(tail);
  const all = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  const out = Buffer.alloc(16);
  all.forEach((group, index) => out.writeUInt16BE(parseInt(group, 16), index * 2));
  return out;
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

/** Reads an address at `at`, or null when the buffer doesn't hold all of it yet. */
export function decodeAddress(buffer: Buffer, at: number): { host: string; kind: AddressKind; port: number; end: number } | null {
  if (buffer.length <= at) return null;
  const type = buffer[at]!;
  let host: string;
  let kind: AddressKind;
  let end: number;
  if (type === 1) {
    end = at + 1 + 4;
    if (buffer.length < end + 2) return null;
    host = [...buffer.subarray(at + 1, end)].join(".");
    kind = "ipv4";
  } else if (type === 4) {
    end = at + 1 + 16;
    if (buffer.length < end + 2) return null;
    host = ipv6Text(buffer.subarray(at + 1, end));
    kind = "ipv6";
  } else if (type === 3) {
    if (buffer.length < at + 2) return null;
    end = at + 2 + buffer[at + 1]!;
    if (buffer.length < end + 2) return null;
    host = buffer.subarray(at + 2, end).toString("utf8");
    kind = "name";
  } else {
    throw new Error(`An address of type ${type}, which SOCKS5 doesn't have.`);
  }
  return { host, kind, port: buffer.readUInt16BE(end), end: end + 2 };
}

/** Reads from a socket until `parse` has what it needs. */
class Reader {
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private ended = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
  }

  private onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.waiting?.();
  };

  private onClose = () => {
    this.ended = true;
    this.waiting?.();
  };

  async read<T>(parse: (buffer: Buffer) => { value: T; used: number } | null): Promise<T> {
    for (;;) {
      const parsed = parse(this.buffer);
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.used);
        return parsed.value;
      }
      if (this.ended) throw new Error("The connection closed.");
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = null;
    }
  }

  /** Stops reading, and gives back whatever came after what was parsed. */
  release(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    return this.buffer;
  }
}

export interface SocksProxyOptions {
  /** With these, a client must sign in with them, and nothing else is accepted. */
  username?: string;
  password?: string;
}

export class SocksProxy {
  port = 0;
  readonly host = "127.0.0.1";
  readonly requests: SocksRequest[] = [];
  readonly datagrams: SocksDatagram[] = [];
  /** The local port of every connection and socket this proxy opened toward a destination. */
  readonly opened = new Set<number>();
  /** Every request for a UDP association is refused, as Tor and `ssh -D` refuse it. */
  refuseUdp = false;
  /** Every password is wrong. */
  refusePassword = false;
  /** Connections are taken and never answered. */
  hang = false;

  private server: Server | null = null;
  private readonly live = new Set<Socket>();
  private readonly sockets = new Set<UdpSocket>();

  constructor(private readonly options: SocksProxyOptions = {}) {}

  /** The proxy as a URL, as zuna-bot's `--proxy` takes it. */
  get url(): string {
    const { username, password } = this.options;
    const auth = username !== undefined ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@` : "";
    return `socks5://${auth}${this.host}:${this.port}`;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((socket) => {
      this.track(socket);
      this.serve(socket).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, this.host, resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  /** Drops every connection and association there is, as a proxy that went away would. */
  goAway(): void {
    for (const socket of this.live) socket.destroy();
    for (const socket of this.sockets) socket.close();
    this.live.clear();
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    this.goAway();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private track(socket: Socket): void {
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private async serve(client: Socket): Promise<void> {
    const reader = new Reader(client);
    if (this.hang) return;
    const methods = await reader.read((buffer) => {
      if (buffer.length < 2) return null;
      if (buffer[0] !== 5) throw new Error("Not SOCKS5.");
      const count = buffer[1]!;
      if (buffer.length < 2 + count) return null;
      return { value: [...buffer.subarray(2, 2 + count)], used: 2 + count };
    });
    const wantsPassword = this.options.username !== undefined;
    const method = wantsPassword ? (methods.includes(2) ? 2 : 0xff) : methods.includes(0) ? 0 : 0xff;
    client.write(Buffer.from([5, method]));
    if (method === 0xff) return void client.end();
    let user: string | null = null;
    if (method === 2) {
      const [name, password] = await reader.read((buffer) => {
        if (buffer.length < 2) return null;
        if (buffer[0] !== 1) throw new Error("Not RFC 1929.");
        const nameEnd = 2 + buffer[1]!;
        if (buffer.length < nameEnd + 1) return null;
        const passwordEnd = nameEnd + 1 + buffer[nameEnd]!;
        if (buffer.length < passwordEnd) return null;
        return { value: [buffer.subarray(2, nameEnd).toString("utf8"), buffer.subarray(nameEnd + 1, passwordEnd).toString("utf8")], used: passwordEnd };
      });
      const right = !this.refusePassword && name === this.options.username && password === (this.options.password ?? "");
      client.write(Buffer.from([1, right ? 0 : 1]));
      if (!right) return void client.end();
      user = name;
    }
    const request = await reader.read((buffer) => {
      if (buffer.length < 4) return null;
      if (buffer[0] !== 5) throw new Error("Not SOCKS5.");
      const address = decodeAddress(buffer, 3);
      return address ? { value: { command: buffer[1]!, ...address }, used: address.end } : null;
    });
    const reply = (code: number, host = "0.0.0.0", port = 0) => client.write(Buffer.concat([Buffer.from([5, code, 0]), encodeAddress(host, port)]));
    if (request.command === 1) {
      this.requests.push({ command: "connect", host: request.host, kind: request.kind, port: request.port, user });
      const upstream = netConnect({ host: request.host, port: request.port });
      this.track(upstream);
      upstream.once("connect", () => this.opened.add(upstream.localPort!));
      const connected = await new Promise<boolean>((resolve) => {
        upstream.once("connect", () => resolve(true));
        upstream.once("error", () => resolve(false));
      });
      if (!connected) {
        reply(REPLY.refused);
        return void client.end();
      }
      reply(REPLY.ok, upstream.localAddress ?? "0.0.0.0", upstream.localPort ?? 0);
      const rest = reader.release();
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      return;
    }
    if (request.command === 3) {
      this.requests.push({ command: "udp", host: request.host, kind: request.kind, port: request.port, user });
      if (this.refuseUdp) {
        reply(REPLY.unsupported);
        return void client.end();
      }
      await this.associate(client, reader, reply);
      return;
    }
    reply(REPLY.unsupported);
    client.end();
  }

  /**
   * A UDP association: one socket toward the client, one toward everywhere else, for as long
   * as the client's connection lasts. Only the first address a datagram comes from is the
   * client's: anything from anywhere else on that side is dropped.
   */
  private async associate(client: Socket, reader: Reader, reply: (code: number, host?: string, port?: number) => void): Promise<void> {
    const inside = createSocket("udp4");
    const outside = createSocket("udp4");
    this.sockets.add(inside);
    this.sockets.add(outside);
    await Promise.all([new Promise<void>((resolve) => inside.bind(0, this.host, resolve)), new Promise<void>((resolve) => outside.bind(0, "127.0.0.1", resolve))]);
    this.opened.add(outside.address().port);
    let from: RemoteInfo | null = null;
    const names = new Map<string, string>();
    inside.on("message", async (packet, sender) => {
      if (from && (from.address !== sender.address || from.port !== sender.port)) return;
      from ??= sender;
      if (packet.length < 4 || packet[2] !== 0) return;
      let address;
      try {
        address = decodeAddress(packet, 3);
      } catch {
        return;
      }
      if (!address) return;
      this.datagrams.push({ host: address.host, kind: address.kind, port: address.port });
      let ip = address.host;
      if (address.kind === "name") {
        ip = names.get(address.host) ?? (await lookup(address.host, { family: 4 }).then((found) => found.address).catch(() => ""));
        if (!ip) return;
        names.set(address.host, ip);
      }
      if (address.kind === "ipv6") return;
      outside.send(packet.subarray(address.end), address.port, ip);
    });
    outside.on("message", (packet, sender) => {
      if (!from) return;
      inside.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeAddress(sender.address, sender.port), packet]), from.port, from.address);
    });
    const close = () => {
      for (const socket of [inside, outside]) {
        if (this.sockets.delete(socket)) socket.close();
      }
    };
    client.on("close", close);
    inside.on("error", close);
    outside.on("error", close);
    reply(REPLY.ok, this.host, inside.address().port);
    // Nothing more comes on the connection: it only keeps the association open.
    reader.release();
    client.resume();
  }
}

/**
 * A door in front of a test server or LiveKit that writes down where each connection and
 * packet came from, and passes everything on as it is.
 */
export class Recorder {
  port = 0;
  /** The port each connection came from, in order. */
  readonly ports: number[] = [];
  /** The port each UDP packet came from, once per port. */
  readonly udpPorts = new Set<number>();
  private server: Server | null = null;
  private udp: UdpSocket | null = null;
  private readonly live = new Set<Socket>();
  private readonly upstreams = new Map<string, UdpSocket>();

  /** Starts in front of `target`'s TCP port, and its UDP port too when `udp` is given. */
  async start(target: { host: string; port: number; udp?: number }, port = 0): Promise<this> {
    this.server = createServer((incoming) => {
      this.ports.push(incoming.remotePort!);
      const outgoing = netConnect({ host: target.host, port: target.port });
      for (const socket of [incoming, outgoing]) {
        this.live.add(socket);
        socket.on("close", () => this.live.delete(socket));
        socket.on("error", () => socket.destroy());
      }
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
      incoming.on("close", () => outgoing.destroy());
      outgoing.on("close", () => incoming.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
    if (target.udp !== undefined) {
      const udp = createSocket("udp4");
      this.udp = udp;
      await new Promise<void>((resolve) => udp.bind(this.port, "127.0.0.1", resolve));
      udp.on("message", (packet, sender) => {
        this.udpPorts.add(sender.port);
        const key = `${sender.address}:${sender.port}`;
        let upstream = this.upstreams.get(key);
        if (!upstream) {
          const socket = createSocket("udp4");
          upstream = socket;
          this.upstreams.set(key, socket);
          socket.on("message", (answer) => udp.send(answer, sender.port, sender.address));
          socket.on("error", () => undefined);
        }
        upstream.send(packet, target.udp!, target.host);
      });
    }
    return this;
  }

  /** The ports this saw that `proxy` didn't open: none, when everything went through it. */
  strangers(proxy: SocksProxy): number[] {
    return [...this.ports, ...this.udpPorts].filter((port) => !proxy.opened.has(port));
  }

  async stop(): Promise<void> {
    for (const socket of this.live) socket.destroy();
    for (const socket of this.upstreams.values()) socket.close();
    this.udp?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}

/** How a client reaches a proxy. */
export interface ProxyAddress {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxy(url: string): ProxyAddress {
  const parsed = new URL(url);
  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") throw new Error("Only a socks5:// proxy.");
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: Number(parsed.port || 1080),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/** Opens a connection to `host` through a proxy, giving the proxy the name to resolve. */
export async function socksConnect(proxy: ProxyAddress, host: string, port: number, timeoutMs = 15_000): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: proxy.port });
  const reader = new Reader(socket);
  const timer = setTimeout(() => socket.destroy(new Error("The proxy didn't answer.")), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const password = proxy.username !== undefined;
    socket.write(Buffer.from(password ? [5, 1, 2] : [5, 1, 0]));
    const method = await reader.read((buffer) => (buffer.length < 2 ? null : { value: buffer[1]!, used: 2 }));
    if (method === 2) {
      const name = Buffer.from(proxy.username ?? "", "utf8");
      const secret = Buffer.from(proxy.password ?? "", "utf8");
      socket.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([secret.length]), secret]));
      const status = await reader.read((buffer) => (buffer.length < 2 ? null : { value: buffer[1]!, used: 2 }));
      if (status !== 0) throw new Error("The proxy refused the username or password.");
    } else if (method !== 0) {
      throw new Error("The proxy wants a way of signing in this client doesn't have.");
    }
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeAddress(host.replace(/^\[|\]$/g, ""), port)]));
    const code = await reader.read((buffer) => {
      if (buffer.length < 4) return null;
      const address = decodeAddress(buffer, 3);
      return address ? { value: buffer[1]!, used: address.end } : null;
    });
    if (code !== 0) throw new Error(`The proxy couldn't connect (${code}).`);
    const rest = reader.release();
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A connector whose every connection goes through `proxy`: TLS, where there is any, is done
 * over the proxy's connection by `tls`, which is how a connector checks certificates.
 */
export function socksConnector(proxy: ProxyAddress, tls: buildConnector.connector = buildConnector({})): buildConnector.connector {
  return (options, callback) => {
    const port = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
    socksConnect(proxy, options.hostname, port).then(
      (socket) => {
        if (options.protocol !== "https:") return callback(null, socket);
        tls({ ...options, httpSocket: socket }, callback);
      },
      (error: Error) => callback(error, null),
    );
  };
}

/** An undici dispatcher sending everything through `proxy`. */
export function socksAgent(proxy: ProxyAddress): Agent {
  return new Agent({ connect: socksConnector(proxy) });
}
