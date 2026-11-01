import { describe, expect, it } from "vitest";
import { serveCore, type RpcPort } from "../src/rpc";

describe("the bridge from the interface to the core", () => {
  /** A core whose methods only say they ran, and the replies it sends back. */
  function core() {
    const ran: string[] = [];
    const session = { getSelf: () => ran.push("getSelf"), saveEpochKey: () => ran.push("saveEpochKey") };
    const client = { listServers: () => ran.push("listServers"), session: () => session, constructor: () => ran.push("constructor") };
    const replies: { ok: boolean }[] = [];
    const port: RpcPort = { postMessage: (message) => replies.push(message as { ok: boolean }), onmessage: null };
    serveCore(port, () => client as never);
    const call = async (serverId: string | null, method: string) => {
      await port.onmessage!({ data: { kind: "call", id: 1, serverId, method, args: [] } } as MessageEvent);
      return replies.at(-1)!.ok;
    };
    return { ran, call };
  }

  it("calls the client's and a session's public methods", async () => {
    const { ran, call } = core();
    expect(await call(null, "listServers")).toBe(true);
    expect(await call("server", "getSelf")).toBe(true);
    expect(ran).toEqual(["listServers", "getSelf"]);
  });

  it("calls nothing else, whatever name arrives", async () => {
    const { ran, call } = core();
    for (const [serverId, method] of [["server", "saveEpochKey"], [null, "constructor"], [null, "__proto__"], ["server", "listServers"], [null, "getSelf"]] as const) {
      expect(await call(serverId, method), method).toBe(false);
    }
    expect(ran).toEqual([]);
  });
});
