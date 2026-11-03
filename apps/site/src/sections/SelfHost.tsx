import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { doc } from "../pages";

/** The commands from the README's "Host a server". */
const COMMANDS = [
  "git clone https://github.com/SocketByte/zuna-chat.git",
  "cd zuna-chat/deploy",
  "ZUNA_DOMAIN=chat.example.com docker compose up -d",
  "docker compose logs zuna",
];

const STEPS = [
  { title: "Point a domain at a Linux machine", text: "A small VPS or a box at home, on amd64 or arm64." },
  { title: "Clone it and start it", text: "One docker compose command. HTTPS certificates are handled for you, and everything lives in one folder." },
  { title: "Open the setup link in Zuna", text: "The log prints it once. Make the owner account, then invite people from the app." },
];

const EXTRAS = [
  { label: "Voice channels and calls", href: doc("docs/SELF_HOSTING.md#voice-channels"), text: "Add LiveKit, which only ever sees encrypted media." },
  { label: "The web app", href: doc("docs/WEB.md"), text: "Host zuna-web for friends who'd rather use a browser." },
  { label: "Without Docker", href: doc("docs/LINUX.md"), text: "One script builds it from git and runs it with systemd." },
];

export function SelfHost() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(COMMANDS.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <section className="section" id="host">
      <div className="wrap host">
        <div className="host-copy reveal">
          <p className="eyebrow">Self-hosting</p>
          <h2 className="heading">One command. One folder to back up.</h2>
          <p className="lead">There's no Zuna cloud: nothing central to breach, sell or shut down. Your server is yours, and it's up in a couple of minutes.</p>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="step-number">{index + 1}</span>
                <span>
                  <b>{step.title}</b>
                  {step.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="terminal reveal">
          <div className="terminal-bar">
            <span className="terminal-lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>bash</span>
            <button type="button" className="terminal-copy" onClick={copy}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="terminal-body">
            {COMMANDS.map((command) => (
              <code key={command}>
                <span className="terminal-prompt">$ </span>
                {command}
              </code>
            ))}
            <code className="terminal-out"># The log shows a one-time setup link.</code>
            <code className="terminal-out"># Open it in Zuna to create your owner account.</code>
          </pre>
        </div>
        <ul className="extras reveal">
          {EXTRAS.map((extra) => (
            <li key={extra.label}>
              <a href={extra.href}>{extra.label}</a>
              <span>{extra.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
