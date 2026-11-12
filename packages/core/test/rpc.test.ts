import { describe, expect, it } from "vitest";
import { CoreError, connectCore, serveCore, type RpcPort } from "../src/rpc";

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

describe("the interface's side of it", () => {
  /** Two ends of a channel, as a worker's port and the page's are. */
  function linked() {
    const page: RpcPort = { postMessage: (data) => void queueMicrotask(() => worker.onmessage?.({ data } as MessageEvent)), onmessage: null };
    const worker: RpcPort = { postMessage: (data) => void queueMicrotask(() => page.onmessage?.({ data } as MessageEvent)), onmessage: null };
    return { page, worker };
  }

  it("calls the core and gets its answers, its failures and its events", async () => {
    const { page, worker } = linked();
    const session = {
      getSelf: () => ({ userId: "me" }),
      getUsers: () => {
        throw Object.assign(new Error("not now"), { code: "busy", status: 503 });
      },
    };
    const client = { listServers: async () => ["one"], session: () => session };
    const send = serveCore(worker, async () => client as never);
    const events: unknown[] = [];
    const core = connectCore(page, (event) => events.push(event));
    expect(await core.client.listServers()).toEqual(["one"]);
    const remote = core.session("server");
    expect(core.session("server")).toBe(remote);
    expect(await remote.getSelf()).toEqual({ userId: "me" });
    const failure = await remote.getUsers().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreError);
    expect(failure).toMatchObject({ message: "not now", code: "busy", status: 503, name: "CoreError" });
    await expect((core.client as unknown as { noSuchThing(): Promise<void> }).noSuchThing()).rejects.toThrow("The core has no such thing to do.");
    send({ type: "connection", serverId: "server", state: "online" } as never);
    await new Promise((done) => setTimeout(done, 0));
    expect(events).toEqual([{ type: "connection", serverId: "server", state: "online" }]);
  });

  it("passes over what isn't a reply it waits for, and says something went wrong without a message", async () => {
    const page: RpcPort = { postMessage: () => undefined, onmessage: null };
    const events: unknown[] = [];
    const core = connectCore(page, (event) => events.push(event));
    page.onmessage!({ data: { kind: "reply", id: 99, ok: true, value: 1 } } as MessageEvent);
    page.onmessage!({ data: { kind: "other" } } as MessageEvent);
    const waiting = core.client.listServers();
    page.onmessage!({ data: { kind: "reply", id: 1, ok: false } } as MessageEvent);
    await expect(waiting).rejects.toThrow("Something went wrong.");
    expect(events).toEqual([]);

    // A core that's asked something that isn't a call answers nothing.
    const replies: unknown[] = [];
    const worker: RpcPort = { postMessage: (message) => void replies.push(message), onmessage: null };
    serveCore(worker, () => ({}) as never);
    await worker.onmessage!({ data: { kind: "event" } } as MessageEvent);
    await worker.onmessage!({ data: { kind: "call", id: 1, serverId: null, method: 5, args: [] } } as MessageEvent);
    expect(replies).toEqual([{ kind: "reply", id: 1, ok: false, error: expect.objectContaining({ message: "The core has no such thing to do." }) }]);
  });
});
