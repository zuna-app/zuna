import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { GitHubMark } from "../components/brand";
import { doc } from "../pages";

/**
 * How to host from a terminal, as the README's "Host a server" gives it: public/install.sh, which gets
 * the code and starts deploy/install.sh, as docs/LINUX.md describes it, what follows, and its whole guide.
 * Docker is coming soon, once it sets up what the installer does.
 */
const HOST = {
  guide: doc("docs/LINUX.md"),
  commands: ["curl -fsSL https://zuna.chat/install.sh | sudo sh"],
  output: [
    "# Gets the code, then asks how people reach it, about the",
    "# proxy and firewall, and stable releases or nightly.",
    "# Runs Zuna and LiveKit for calls with systemd, behind Caddy,",
    "# your nginx or Apache, or a proxy you set up, and checks it.",
    "# It can update itself every night, and undoes a build that",
    "# won't start. Run it again to update, change or uninstall.",
  ],
  steps: [
    { title: "Point a domain at a Linux machine", text: "One with systemd, such as Debian, Ubuntu or Fedora. Or go by its IP address." },
    { title: "Run one command", text: "It gets the code, asks a few questions, builds the server with LiveKit for voice, and sets up the proxy, or shows you what to add." },
    { title: "Open the setup link in Zuna", text: "Once the server answers at its address, the installer shows it, with a QR code. Make the owner account and invite people." },
  ],
} as const;

const EXTRAS = [
  { label: "Voice channels and calls", href: doc("docs/SELF_HOSTING.md#voice-channels"), text: "LiveKit carries them, and only ever sees encrypted media." },
  { label: "The web app", href: doc("docs/WEB.md"), text: "Host zuna-web for friends who'd rather use a browser." },
  { label: "Backups", href: doc("docs/SELF_HOSTING.md#backups"), text: "Everything is in one data folder, copied with SQLite's backup command." },
];

export function SelfHost() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(HOST.commands.join("\n")).then(() => {
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
          <ol className="steps host-steps">
            {HOST.steps.map((step, number) => (
              <li key={step.title}>
                <span className="step-number">{number + 1}</span>
                <span>
                  <b>{step.title}</b>
                  {step.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="host-side reveal">
          <div className="terminal">
            <div className="terminal-bar">
              <span className="terminal-lights" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="terminal-title">Linux, with systemd</span>
              <button type="button" className="terminal-copy" onClick={copy}>
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="terminal-body">
              {HOST.commands.map((command) => (
                <code key={command}>
                  <span className="terminal-prompt">$ </span>
                  {command}
                </code>
              ))}
              {HOST.output.map((line) => (
                <code key={line} className="terminal-out">
                  {line}
                </code>
              ))}
            </pre>
          </div>
          <a className="host-guide" href={HOST.guide}>
            <GitHubMark size={16} />
            The full installation guide, on GitHub
          </a>
          <p className="host-soon">Docker is coming soon.</p>
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
