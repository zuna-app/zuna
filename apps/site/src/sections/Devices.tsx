import { BellRing, CheckCheck, History, LifeBuoy, PhoneCall, Pin } from "lucide-react";
import type { ReactNode } from "react";

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
        {/* "Security fixes may not add a step, prompt or setting" is one of the decisions to keep in CLAUDE.md. */}
        <div className="comfort reveal">
          <p className="comfort-claim">Encryption you never have to think about.</p>
          <p>
            Zuna puts comfort first. There's no phone to keep close, no backup to turn on and no code to compare before you can talk, and no security fix may add a
            step, a prompt or a setting. You just chat, and everything stays end-to-end encrypted underneath.
          </p>
        </div>
      </div>
    </section>
  );
}
