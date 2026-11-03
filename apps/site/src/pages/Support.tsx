import { BookOpen, Bug, LifeBuoy, ShieldAlert } from "lucide-react";
import { doc, REPO } from "../pages";

const PATHS = [
  {
    icon: LifeBuoy,
    title: "Help with your account",
    text: "Your server's admins run your server, so a new invite or anything about your account there goes to them first, not to the project.",
  },
  {
    icon: BookOpen,
    title: "Running a server",
    text: "The self-hosting guide covers Docker, the single binary, reverse proxies, backups, voice and phone notifications, with a section for when things go wrong.",
    link: { href: doc("docs/SELF_HOSTING.md#troubleshooting"), label: "Troubleshooting" },
  },
  {
    icon: Bug,
    title: "Something's broken",
    text: "Open an issue with what you did, what you expected and what happened, and which app and version you were using.",
    link: { href: `${REPO}/issues`, label: "Open an issue" },
  },
  {
    icon: ShieldAlert,
    title: "A security problem",
    text: "Please report it privately, through \"Report a vulnerability\" on the repository's Security tab, rather than in a public issue.",
    link: { href: `${REPO}/security`, label: "Report a vulnerability" },
  },
];

export function Support() {
  return (
    <article className="page prose">
      <div className="wrap prose-wrap">
        <p className="eyebrow">Support</p>
        <h1 className="display">Getting help.</h1>
        <p className="lead">Zuna is run by the people who host it, so where to go depends on what's wrong.</p>
        <div className="support-grid">
          {PATHS.map((path) => (
            <section key={path.title} className="card">
              <path.icon className="card-icon" size={22} aria-hidden="true" />
              <h2>{path.title}</h2>
              <p>{path.text}</p>
              {path.link && <a href={path.link.href}>{path.link.label}</a>}
            </section>
          ))}
        </div>

        <h2>Forgot your password?</h2>
        <p>
          Sign in with the recovery key you saved when you signed up, and choose a new password. If you've lost both and no device is still signed in, nobody can
          get your messages back, not even your server's admins, because nobody else ever had the keys.
        </p>

        <h2>Notifications don't arrive on iPhone or iPad</h2>
        <p>
          Check that notifications are allowed for Zuna in Settings, and ask your server's admins whether pushes are on (<code>ZUNA_PUSH_RELAYS</code>). While
          you're using Zuna on another device, the phone waits 30 seconds and skips what you've already read there. <a href="/privacy/#push">How pushes work</a>
        </p>

        <h2>Someone's emoji changed</h2>
        <p>
          The sixteen emoji you compare change when someone's keys are replaced, such as after they change their password or remove a device. Compare them again
          with that person, on a call or face to face, before you trust the chat.
        </p>
      </div>
    </article>
  );
}
