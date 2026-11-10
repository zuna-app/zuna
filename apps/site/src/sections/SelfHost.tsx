import { Check, Copy } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { GitHubMark } from "../components/brand";
import { doc } from "../pages";

/** The two ways to host from a terminal, as the README's "Host a server" gives them, what follows each, and its whole guide. */
const METHODS = [
  {
    id: "docker",
    name: "Docker",
    caption: "# With Docker",
    guide: doc("docs/SELF_HOSTING.md"),
    commands: [
      "git clone https://github.com/zuna-app/zuna.git",
      "cd zuna/deploy",
      "ZUNA_DOMAIN=chat.example.com docker compose up -d",
      "docker compose logs zuna",
    ],
    output: [
      "# The log shows a one-time setup link.",
      "# Open it in Zuna to create your owner account.",
      "# Calls' media has its own ports: open 7881/tcp and 7882/udp.",
    ],
    steps: [
      { title: "Point a domain at a Linux machine", text: "A small VPS or a box at home, on amd64 or arm64." },
      { title: "Clone it and start it", text: "One docker compose command runs Zuna, and LiveKit for voice. HTTPS certificates are handled for you." },
      { title: "Open the setup link in Zuna", text: "The log prints it once. Make the owner account, then invite people from the app." },
    ],
  },
  {
    // deploy/install.sh, as docs/LINUX.md describes it.
    id: "systemd",
    name: "systemd",
    caption: "# Without Docker, with systemd",
    guide: doc("docs/LINUX.md"),
    commands: ["sudo git clone https://github.com/zuna-app/zuna.git \\\n    /opt/zuna", "sudo /opt/zuna/deploy/install.sh"],
    output: [
      "# Asks how people reach it, then about the proxy and firewall.",
      "# Runs Zuna and LiveKit for calls with systemd, behind Caddy,",
      "# your nginx or Apache, or a proxy you set up, and checks it.",
      "# Later: sudo zuna-update. A build that won't start is undone.",
    ],
    steps: [
      { title: "Point a domain at a Linux machine", text: "One with systemd, such as Debian, Ubuntu or Fedora. Or go by its IP address." },
      { title: "Clone it and run the installer", text: "It asks a few questions, builds the server from git with LiveKit for voice, and sets up the proxy, or shows you what to add." },
      { title: "Open the setup link in Zuna", text: "Once the server answers at its address, the installer shows it, with a QR code. Make the owner account and invite people." },
    ],
  },
] as const;

const EXTRAS = [
  { label: "Voice channels and calls", href: doc("docs/SELF_HOSTING.md#voice-channels"), text: "LiveKit carries them, and only ever sees encrypted media." },
  { label: "The web app", href: doc("docs/WEB.md"), text: "Host zuna-web for friends who'd rather use a browser." },
  { label: "Backups", href: doc("docs/SELF_HOSTING.md#backups"), text: "Everything is in one data folder, copied with SQLite's backup command." },
];

export function SelfHost() {
  const [chosen, setChosen] = useState(0);
  const [copied, setCopied] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const method = METHODS[chosen]!;

  const copy = () => {
    void navigator.clipboard?.writeText(method.commands.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  const choose = (index: number) => {
    setChosen(index);
    setCopied(false);
  };
  /** Arrow keys move between the tabs, as a tab list's do. */
  const move = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (chosen + step + METHODS.length) % METHODS.length;
    choose(next);
    tabs.current[next]?.focus();
  };

  return (
    <section className="section" id="host">
      <div className="wrap host">
        <div className="host-copy reveal">
          <p className="eyebrow">Self-hosting</p>
          <h2 className="heading">One command. One folder to back up.</h2>
          <p className="lead">There's no Zuna cloud: nothing central to breach, sell or shut down. Your server is yours, and it's up in a couple of minutes.</p>
          <div className="steps-stack">
            {METHODS.map((option, index) => (
              <ol key={option.id} className={`steps ${index === chosen ? "is-active" : ""}`}>
                {option.steps.map((step, number) => (
                  <li key={step.title}>
                    <span className="step-number">{number + 1}</span>
                    <span>
                      <b>{step.title}</b>
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
            ))}
          </div>
        </div>
        <div className="host-side reveal">
          <div className="terminal">
            <div className="terminal-bar">
              <span className="terminal-lights" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div className="terminal-tabs" role="tablist" aria-label="How to host" onKeyDown={move}>
                {METHODS.map((option, index) => (
                  <button
                    key={option.id}
                    ref={(element) => {
                      tabs.current[index] = element;
                    }}
                    type="button"
                    role="tab"
                    id={`host-tab-${option.id}`}
                    aria-controls={`host-panel-${option.id}`}
                    aria-selected={index === chosen}
                    tabIndex={index === chosen ? 0 : -1}
                    onClick={() => choose(index)}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
              <button type="button" className="terminal-copy" onClick={copy}>
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="terminal-panels">
              {METHODS.map((option, index) => (
                <pre
                  key={option.id}
                  className={`terminal-body ${index === chosen ? "is-active" : ""}`}
                  role="tabpanel"
                  id={`host-panel-${option.id}`}
                  aria-labelledby={`host-tab-${option.id}`}
                >
                  <code className="terminal-out terminal-caption">{option.caption}</code>
                  {option.commands.map((command) => (
                    <code key={command}>
                      <span className="terminal-prompt">$ </span>
                      {command}
                    </code>
                  ))}
                  {option.output.map((line) => (
                    <code key={line} className="terminal-out">
                      {line}
                    </code>
                  ))}
                </pre>
              ))}
            </div>
          </div>
          <a className="host-guide" href={method.guide}>
            <GitHubMark size={16} />
            The full installation guide, on GitHub
          </a>
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
