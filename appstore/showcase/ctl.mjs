// The app's control channel from the shell:
//   node ctl.mjs eval '<script>'          a host evaluate, whose value is printed
//   node ctl.mjs call <serverId|-> <method> '<args as JSON array>'
//   node ctl.mjs host <command> '<extra fields as JSON>'
const [kind, a, b, c] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${process.env.PHONE_PORT ?? 9575}`);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const id = 1;
const message = kind === "eval" ? { kind: "host", command: "evaluate", id, script: a }
  : kind === "host" ? { kind: "host", command: a, id, ...(b ? JSON.parse(b) : {}) }
  : { kind: "call", id, serverId: a === "-" ? null : a, method: b, args: c ? JSON.parse(c) : [] };
ws.onmessage = (event) => {
  const reply = JSON.parse(String(event.data));
  if ((reply.kind === "reply" || reply.kind === "host-result") && reply.id === id) {
    console.log(String(JSON.stringify(reply.kind === "reply" ? (reply.ok ? reply.value : reply.error) : reply.value, null, 1)).slice(0, 4000));
    process.exit(0);
  }
};
ws.send(JSON.stringify(message));
setTimeout(() => { console.log("timeout"); process.exit(1); }, 20000);
