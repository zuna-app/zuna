// zuna-bot's commands, with the bot and its API stood in for: what each command does with its
// flags and the environment, what it says, and how it stops.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const bot = { username: "echo", close: vi.fn(async () => undefined) };
  const served = { port: 8123, close: vi.fn(async () => undefined) };
  return {
    bot,
    served,
    setUp: vi.fn(async () => ({ username: "echo", server: "https://chat.example" })),
    isSetUp: vi.fn((_dir: string) => false),
    open: vi.fn(async (_dir: string) => bot),
    serve: vi.fn(async (_bot: unknown, _options: { host: string; port: number }) => served),
  };
});

vi.mock("../src/bot", () => ({ Bot: { setUp: fakes.setUp, isSetUp: fakes.isSetUp, open: fakes.open } }));
vi.mock("../src/server", () => ({ serve: fakes.serve }));

const dir = mkdtempSync(join(tmpdir(), "zuna-bot-main-"));
let logs: string[];
let errors: string[];
let exits: (number | undefined)[];
let handlers: Record<string, () => void>;
const savedArgv = process.argv;
const ENV = ["ZUNA_BOT_DATA", "ZUNA_BOT_LINK", "ZUNA_BOT_PORT", "ZUNA_BOT_HOST"];

beforeEach(() => {
  logs = [];
  errors = [];
  exits = [];
  handlers = {};
  for (const name of ENV) delete process.env[name];
  vi.clearAllMocks();
  fakes.isSetUp.mockReturnValue(false);
  vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => void exits.push(code)) as never);
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    handlers[event] = handler;
    return process;
  }) as never);
});

afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs zuna-bot with these arguments, until it has said or done something final. */
async function zunaBot(...args: string[]) {
  process.argv = ["node", "zuna-bot", ...args];
  await import("../src/main");
  await vi.waitFor(() => expect(logs.length + errors.length + exits.length).toBeGreaterThan(0));
  // Whatever else it says in the same go.
  await new Promise((done) => setTimeout(done, 10));
}

describe("zuna-bot", () => {
  it("says how it's used, with no command or with help", async () => {
    await zunaBot();
    expect(logs[0]).toMatch(/^zuna-bot runs a Zuna bot/);
    vi.resetModules();
    logs = [];
    await zunaBot("help");
    expect(logs[0]).toMatch(/zuna-bot init "<setup link>"/);
    expect(exits).toEqual([]);
  });

  it("refuses a command it hasn't got", async () => {
    await zunaBot("frobnicate");
    expect(errors).toEqual(['zuna-bot has no "frobnicate". Try zuna-bot help.']);
    expect(exits).toEqual([1]);
  });

  it("sets a bot up from the link given, in the folder given", async () => {
    await zunaBot("init", "https://chat.example/invite/x#k=1", "--data", dir);
    expect(fakes.setUp).toHaveBeenCalledWith(resolve(dir), "https://chat.example/invite/x#k=1");
    expect(logs).toEqual([
      "echo is set up on https://chat.example.",
      `Its keys are in ${resolve(dir)}. Whoever can read that folder is the bot.`,
      `Its recovery key is in ${join(resolve(dir), "recovery-key.txt")}: keep a copy somewhere else, as it's the only way back if the folder is lost.`,
      "Start it with: zuna-bot run",
    ]);
  });

  it("takes the link and the folder from a flag with = or the environment, and asks for a link when there's none", async () => {
    process.env.ZUNA_BOT_DATA = dir;
    await zunaBot("init", "--link=https://chat.example/invite/y#k=2");
    expect(fakes.setUp).toHaveBeenCalledWith(resolve(dir), "https://chat.example/invite/y#k=2");
    vi.resetModules();
    process.env.ZUNA_BOT_LINK = "https://chat.example/invite/z#k=3";
    await zunaBot("init");
    expect(fakes.setUp).toHaveBeenLastCalledWith(resolve(dir), "https://chat.example/invite/z#k=3");
    vi.resetModules();
    delete process.env.ZUNA_BOT_LINK;
    errors = [];
    exits = [];
    await zunaBot("init");
    expect(errors[0]).toMatch(/^Give the setup link/);
    expect(exits).toEqual([1]);
  });

  it("prints the token of a bot that's set up, and says when there's none", async () => {
    await zunaBot("token", "--data", dir);
    expect(errors).toEqual([`There's no bot in ${resolve(dir)} yet.`]);
    vi.resetModules();
    errors = [];
    fakes.isSetUp.mockReturnValue(true);
    writeFileSync(join(dir, "token"), "1:abc\n");
    await zunaBot("token", "--data", dir);
    expect(logs).toEqual(["1:abc"]);
  });

  it("runs a bot on this machine alone by default, and stops it once on a signal", async () => {
    fakes.isSetUp.mockReturnValue(true);
    await zunaBot("run", "--data", dir);
    expect(fakes.setUp).not.toHaveBeenCalled();
    expect(fakes.serve).toHaveBeenCalledWith(fakes.bot, { host: "127.0.0.1", port: 8081 });
    expect(logs).toEqual([`echo's API is at http://127.0.0.1:8123, with the token in ${join(resolve(dir), "token")}.`]);
    handlers.SIGTERM!();
    handlers.SIGINT!();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(fakes.served.close).toHaveBeenCalledTimes(1);
    expect(fakes.bot.close).toHaveBeenCalledTimes(1);
  });

  it("sets a bot up first when run with a link and nothing set up, and warns when it listens beyond this machine", async () => {
    process.env.ZUNA_BOT_PORT = "9000";
    process.env.ZUNA_BOT_HOST = "::";
    await zunaBot("run", "--data", dir, "--link", "https://chat.example/invite/w#k=4");
    expect(fakes.setUp).toHaveBeenCalledWith(resolve(dir), "https://chat.example/invite/w#k=4");
    expect(fakes.serve).toHaveBeenCalledWith(fakes.bot, { host: "::", port: 9000 });
    expect(logs.slice(-2)).toEqual([`echo's API is at http://[::]:8123, with the token in ${join(resolve(dir), "token")}.`, "It's listening beyond this machine. Anyone who reaches it with the token is the bot."]);
  });

  it("says why it couldn't run, whatever was thrown", async () => {
    fakes.open.mockRejectedValueOnce("not an error");
    await zunaBot("run", "--data", dir);
    expect(errors).toEqual(["not an error"]);
    expect(exits).toEqual([1]);
  });
});
