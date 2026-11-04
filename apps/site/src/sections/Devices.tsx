import { BellRing, CheckCheck, History, LifeBuoy, PhoneCall, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "../components/brand";

/** What follows someone from device to device, each from the core and its tests (e2e.test.ts, the synced preferences, notify.ts). */
const SYNCED: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <History size={20} />,
    title: "Your whole history",
    text: "Every message your server keeps comes to each new device, still encrypted, even with your other devices switched off.",
  },
  {
    icon: <CheckCheck size={20} />,
    title: "Where you stopped reading",
    text: "Read a chat on your phone and it's read on your desktop too, unread counts and all.",
  },
  {
    icon: <Pin size={20} />,
    title: "Your chats, set up once",
    text: "Pinned, muted and hidden chats, ones you marked unread, and who you've verified or blocked.",
  },
  {
    icon: <BellRing size={20} />,
    title: "Notifications where you are",
    text: "While you're at your desktop, your phone waits 30 seconds, and stays quiet about anything you read meanwhile.",
  },
  {
    icon: <PhoneCall size={20} />,
    title: "Calls that find you",
    text: "A call rings on every device until you answer on one, and moves to another with a click.",
  },
  {
    icon: <LifeBuoy size={20} />,
    title: "Nothing lost with a phone",
    text: "Lost every device? Your password, or your recovery key, brings it all back on a new one.",
  },
];

/**
 * Signal as of November 2026, from its blog, its support pages, reports of its betas and its own issue tracker. The page doesn't date it, so check
 * it again when Signal ships something. Behind each line: a number-free sign-up is a paid beta on Android only; a linked device gets chats and the
 * last 45 days of media from the phone; history comes back only from a Secure Backup turned on before; screen sharing has no frame rate or
 * resolution to set, and users report it choppy (Signal-Desktop #6727, #6920); its apps only use Signal's servers; it has no channels.
 * Zuna's frame rate and resolution are each the most a share can be set to, not one share doing both.
 */
const COMPARED = [
  { what: "Sign-up", zuna: "Username and password", signal: "A phone number" },
  { what: "New device", zuna: "Signs in on its own", signal: "Scans a QR code on your phone" },
  { what: "History", zuna: "All of it, from your server", signal: "From your phone, 45 days of media" },
  { what: "Lost phone", zuna: "Sign in again, it's all there", signal: "Gone, unless you set up backups" },
  { what: "Screen sharing", zuna: "Up to 240 fps or 4K", signal: "Often choppy, users report" },
  { what: "Hosting", zuna: "Your own server, one command", signal: "Signal's servers only" },
  { what: "Channels", zuna: "Text and voice channels", signal: "None, just group chats" },
];

export function Devices() {
  return (
    <section className="section" id="devices">
      <div className="wrap">
        <div className="section-head reveal">
          <p className="eyebrow">Every device</p>
          <h2 className="heading">Pick up on any device where you left off.</h2>
          <p className="lead">
            Sign in on a laptop, a phone or a browser, and it has everything: your history, what you've read and how your chats are set up. There's no phone to scan
            a code with, and no other device has to be on.
          </p>
        </div>
        <ul className="sync-grid">
          {SYNCED.map((item) => (
            <li key={item.title} className="reveal">
              <span className="card-icon" aria-hidden="true">
                {item.icon}
              </span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
        <div className="versus reveal">
          <h3 className="sr-only">Zuna next to Signal</h3>
          <div className="versus-head" aria-hidden="true">
            <span className="versus-zuna">
              <Logo size={24} /> Zuna
            </span>
            <span className="versus-vs">vs</span>
            <span className="versus-signal">Signal</span>
          </div>
          <ul className="versus-list">
            {COMPARED.map((row) => (
              <li key={row.what}>
                <h4 className="versus-topic">{row.what}</h4>
                <p className="versus-zuna">
                  <span className="sr-only">Zuna: </span>
                  {row.zuna}
                </p>
                <p className="versus-signal">
                  <span className="sr-only">Signal: </span>
                  {row.signal}
                </p>
              </li>
            ))}
          </ul>
        </div>
        {/* "Security fixes may not add a step, prompt or setting" is one of the decisions to keep in CLAUDE.md. */}
        <div className="versus-after reveal">
          <p className="versus-claim">Encryption you never have to think about.</p>
          <p>
            Zuna puts comfort first. There's no phone to keep close, no backup to turn on and no code to compare before you can talk, and no security fix may add a
            step, a prompt or a setting. You just chat, and everything stays end-to-end encrypted underneath.
          </p>
        </div>
      </div>
    </section>
  );
}
