// An iOS client under test: the app's core host, driven over its control
// channel with the same RPC calls the app's UI makes.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCore, type CoreConnection, type RemoteSession } from "@zuna/core/rpc";
import type { CoreEvent, MessageView } from "@zuna/core";
import { waitFor } from "../../../packages/core/test/helpers";
import { hostBinary } from "./paths";
import { launch, simulatorId, terminate } from "./simulator";
import { decodeWire, encodeWire } from "./wire";

export interface HostOptions {
  /** Interpret JavaScript only, as JavaScriptCore does on iOS. */
  noJit?: boolean;
  deviceName?: string;
  /** "process" runs the headless host on macOS; "simulator" runs the real app in the E2E simulator. */
  target?: "process" | "simulator";
}

export const phoneTarget = (process.env.ZUNA_E2E_TARGET === "simulator" ? "simulator" : "process") as HostOptions["target"];

export class HostApp {
  readonly dir: string;
  readonly events: CoreEvent[] = [];
  core!: CoreConnection;
  serverId = "";
  private process: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private log = "";

  constructor(
    readonly name: string,
    private readonly options: HostOptions = {},
    dir?: string,
  ) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), `zuna-host-${name}-`));
  }

  /** Starts the host (a process, or the app in the simulator) and connects to it. */
  async open(): Promise<this> {
    this.log = "";
    const port = this.options.target === "simulator" ? this.launchInSimulator() : await this.spawnProcess();
    const socket = await this.connect(port);
    this.socket = socket;
    const port_ = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => socket.send(encodeWire(message)),
    };
    socket.onmessage = (event) => {
      const data = decodeWire(String(event.data));
      if (data?.kind === "host-result") {
        this.evaluations.get(data.id)?.(data.value);
        this.evaluations.delete(data.id);
        return;
      }
      port_.onmessage?.({ data } as MessageEvent);
    };
    this.core = connectCore(port_, (event) => this.events.push(event));

    const servers = await this.core.client.listServers();
    if (servers[0]) this.serverId = servers[0].id;
    return this;
  }

  private async spawnProcess(): Promise<number> {
    const env = { ...process.env, ...(this.options.noJit ? { JSC_useJIT: "0" } : {}) };
    const child = spawn(hostBinary, ["--data", this.dir, "--device-name", this.options.deviceName ?? "iPhone"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout!.on("data", (chunk) => (this.log += chunk));
    child.stderr!.on("data", (chunk) => (this.log += chunk));
    await waitFor(() => /ZUNA_HOST_READY port=\d+/.test(this.log), `${this.name} to start`, 30_000).catch((error) => {
      throw new Error(`${error.message}\n${this.log}`);
    });
    return Number(this.log.match(/ZUNA_HOST_READY port=(\d+)/)![1]);
  }

  private launchedOnce = false;

  /** Launches the app in the E2E simulator, with fresh data the first time. */
  private launchInSimulator(): number {
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const args = ["-ZunaControlPort", String(port)];
    if (!this.launchedOnce) args.push("-ZunaResetData", "YES");
    this.launchedOnce = true;
    launch(simulatorId(), args);
    return port;
  }

  /** Connects to the control channel, retrying while the host is still starting. */
  private async connect(port: number): Promise<WebSocket> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        return await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}`);
          socket.onopen = () => resolve(socket);
          socket.onerror = () => reject(new Error(`couldn't connect to ${this.name}`));
        });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  get session(): RemoteSession {
    return this.core.session(this.serverId);
  }

  async userId(): Promise<string> {
    return (await this.session.getSelf()).userId;
  }

  async register(link: string, username: string, password = "correct horse battery"): Promise<string> {
    const preview = await this.core.client.previewInvite(link);
    const result = await this.core.client.register(preview, username, password, { displayName: username });
    this.serverId = result.serverId;
    await this.online();
    return result.recoveryKey;
  }

  async login(url: string, username: string, password = "correct horse battery"): Promise<void> {
    this.serverId = await this.core.client.login(url, username, password);
    await this.online();
  }

  async online(timeoutMs = 30_000): Promise<void> {
    await waitFor(async () => (await this.session.getConnectionState()) === "online", `${this.name} to come online`, timeoutMs);
  }

  /** The texts of a conversation that are on screen, in order, like `TestApp.texts`. */
  async texts(key: string): Promise<string[]> {
    return (await this.messages(key))
      .filter((view) => !view.system && !view.deletedAt)
      .map((view) => (view.status === "sent" ? view.text : `<${view.status}>`));
  }

  async messages(key: string): Promise<MessageView[]> {
    const conversation = (await this.session.getConversations()).find((item) => item.key === key);
    if (!conversation?.groupId) return [];
    const page = await this.session.loadMessages(conversation.groupId);
    return page.messages.filter((view) => view.seq !== null);
  }

  async setOffline(offline: boolean): Promise<void> {
    this.socket?.send(JSON.stringify({ kind: "host", command: "offline", value: offline }));
  }

  private evaluations = new Map<number, (value: string) => void>();
  private nextEvaluation = 1;

  /** Runs a script inside the host's JavaScript context (Debug builds only). */
  evaluate(script: string): Promise<string> {
    const id = this.nextEvaluation++;
    return new Promise((resolve) => {
      this.evaluations.set(id, resolve);
      this.socket?.send(JSON.stringify({ kind: "host", command: "evaluate", id, script }));
    });
  }

  /** Stops the process, keeping its data for `open()` to pick up again. */
  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    if (this.options.target === "simulator") {
      terminate(simulatorId());
      return;
    }
    const child = this.process;
    this.process = null;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    }
  }

  async restart(): Promise<void> {
    await this.close();
    await this.open();
    await this.online();
  }

  get output(): string {
    return this.log;
  }
}
