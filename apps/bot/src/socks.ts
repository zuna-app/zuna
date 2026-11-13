// A SOCKS5 client (RFC 1928, with RFC 1929's username and password), for `--proxy`: every
// connection the bot makes to its server opens through the proxy first, giving it the
// server's name to resolve, and TLS, with a pin where the server has one, is done over that.

import { isIP, connect, type Socket } from "node:net";
import type { buildConnector } from "undici";

export interface Proxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** A proxy from `socks5://user:password@host:port`, as --proxy and ZUNA_BOT_PROXY take it. */
export function parseProxy(text: string): Proxy {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${text.replace(/\/\/[^@/]*@/, "//…@")} isn't a proxy's address: give socks5://host:port, or socks5://user:password@host:port.`);
  }
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") throw new Error("zuna-bot goes through a SOCKS5 proxy alone: socks5://host:port.");
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  if ((username?.length ?? 0) > 255 || (password?.length ?? 0) > 255) throw new Error("SOCKS5 usernames and passwords can be at most 255 bytes each.");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 1080), username, password };
}

/** Where the proxy is, without the username and password, for what's printed. */
export const shown = (proxy: Proxy): string => (proxy.host.includes(":") ? `[${proxy.host}]:${proxy.port}` : `${proxy.host}:${proxy.port}`);

function address(host: string, port: number): Buffer {
  const bare = host.replace(/^\[|\]$/g, "");
  const tail = Buffer.from([port >> 8, port & 0xff]);
  if (isIP(bare) === 4) return Buffer.concat([Buffer.from([1, ...bare.split(".").map(Number)]), tail]);
  if (isIP(bare) === 6) {
    const [front, back = ""] = bare.split("::");
    const groups = (part: string) => part.split(":").filter(Boolean);
    const all = bare.includes("::") ? [...groups(front!), ...Array(8 - groups(front!).length - groups(back).length).fill("0"), ...groups(back)] : groups(bare);
    return Buffer.concat([Buffer.from([4, ...all.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff])]), tail]);
  }
  const name = Buffer.from(bare, "utf8");
  return Buffer.concat([Buffer.from([3, name.length]), name, tail]);
}

/** Opens a connection to `host` through the proxy. */
export function socksConnect(proxy: Proxy, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    let buffer = Buffer.alloc(0);
    let step: "method" | "auth" | "reply" = "method";
    const fail = (why: string) => {
      socket.destroy();
      reject(new Error(why));
    };
    socket.setTimeout(15_000, () => fail("The proxy didn't answer."));
    socket.once("error", (error) => fail(`Can't reach the proxy at ${shown(proxy)}: ${error.message}`));
    const request = () => socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address(host, port)]));
    socket.once("connect", () => socket.write(Buffer.from(proxy.username !== undefined ? [5, 2, 0, 2] : [5, 1, 0])));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (step === "method" && buffer.length >= 2) {
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 0) {
          step = "reply";
          request();
        } else if (method === 2 && proxy.username !== undefined) {
          step = "auth";
          const name = Buffer.from(proxy.username, "utf8");
          const secret = Buffer.from(proxy.password ?? "", "utf8");
          socket.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([secret.length]), secret]));
        } else return fail("The proxy wants a username and password, and none was given, or not these.");
      }
      if (step === "auth" && buffer.length >= 2) {
        if (buffer[1] !== 0) return fail("The proxy refused the username or password.");
        buffer = buffer.subarray(2);
        step = "reply";
        request();
      }
      if (step === "reply" && buffer.length >= 5) {
        if (buffer[1] !== 0) return fail(`The proxy couldn't reach ${host}:${port} (${buffer[1]}).`);
        const length = buffer[3] === 1 ? 4 : buffer[3] === 4 ? 16 : 1 + buffer[4]!;
        if (buffer.length < 4 + length + 2) return;
        socket.off("data", onData);
        socket.setTimeout(0);
        socket.removeAllListeners("error");
        const rest = buffer.subarray(4 + length + 2);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on("data", onData);
  });
}

/** A connector that opens every connection through the proxy, with TLS over it by `tls` where there's any. */
export function socksConnector(proxy: Proxy, tls: buildConnector.connector): buildConnector.connector {
  return (options, callback) => {
    const port = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
    socksConnect(proxy, options.hostname, port).then(
      (socket) => (options.protocol === "https:" ? tls({ ...options, httpSocket: socket }, callback) : callback(null, socket)),
      (error: Error) => callback(error, null),
    );
  };
}
