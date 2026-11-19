import { Box, Info, PhoneCall, Send, ServerOff, Users, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { doc } from "../pages";

/** docs/TELEGRAM.md, "What's there". Channels, video chats in groups and secret chats stay in Telegram's app, which the note says. */
const THERE = [
  "People and groups, with their pins, mutes and archive",
  "Replies, edits, reactions, forwarding and a bot's buttons",
  "Photos, videos, files, voice and video messages, stickers",
  "Drafts that follow you to your phone and back",
  "Calls with one person, by voice or video",
  "Linked by scanning a QR code with Telegram on your phone",
];

/**
 * docs/TELEGRAM.md, "How it's kept apart", and SECURITY.md's limits: boxed in on Windows, Linux and macOS and not on the iPhone, which the note
 * says; connections only to Telegram's published addresses, through the proxy when one is set; calls only through Telegram's relays.
 */
const FACTS: { icon: ReactNode; value: string; label: string }[] = [
  { icon: <Box size={18} />, value: "Boxed in", label: "On a computer, Telegram's code runs in a sandbox, away from your files and Zuna's keys" },
  { icon: <Waypoints size={18} />, value: "Telegram's addresses only", label: "It reaches nothing else, and goes through your proxy if you set one" },
  { icon: <PhoneCall size={18} />, value: "Calls through relays", label: "Never device to device, so the other person never learns your address" },
  { icon: <ServerOff size={18} />, value: "Unknown to your servers", label: "No Zuna server hears that it's linked, and nothing passes between the two" },
];

export function Telegram() {
  return (
    <section className="section" id="telegram">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Telegram</p>
          <h2 className="heading">Your Telegram, one icon down.</h2>
          <p className="lead">
            Link your own Telegram account and its chats sit under an icon of their own, beside your servers. Message, send files and call from the same app,
            kept apart from everything else in it.
          </p>
        </div>

        <div className="tg-panel reveal">
          <div className="tg-app" aria-hidden="true">
            <div className="mini-rail">
              <span>F</span>
              <span>LN</span>
              <span className="is-active">
                <Send size={15} />
              </span>
            </div>
            <div className="tg-list">
              <span className="mini-heading">Telegram</span>
              <span className="tg-chat is-active">
                <i className="mini-av aw-c3">AK</i>
                <span>
                  <b>Anna Kowalska</b>
                  Sending the photos tonight
                </span>
              </span>
              <span className="tg-chat">
                <i className="mini-av aw-c1">
                  <Users size={11} />
                </i>
                <span>
                  <b>Climbing club</b>
                  Tomek: Saturday at 10?
                </span>
              </span>
              <span className="tg-chat">
                <i className="mini-av aw-c4">M</i>
                <span>
                  <b>Mum</b>
                  Voice message, 0:42
                </span>
              </span>
              <span className="tg-label">
                <Info size={12} /> Not end-to-end encrypted
              </span>
            </div>
          </div>
          <ul className="tg-there">
            {THERE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <ul className="facts">
          {FACTS.map((fact) => (
            <li key={fact.value} className="reveal">
              <span className="fact-icon" aria-hidden="true">
                {fact.icon}
              </span>
              <b>{fact.value}</b>
              <span>{fact.label}</span>
            </li>
          ))}
        </ul>

        <p className="note center reveal">
          On Windows, Linux, macOS, iPhone and iPad. Telegram's chats aren't end-to-end encrypted: Telegram keeps them, as it does for its own apps, and each
          says so in its header. On iPhone and iPad its code runs inside the app, as iOS gives it too little memory for a box of its own. Channels, group video
          chats and secret chats stay in Telegram's app. Zuna isn't made by Telegram. <a href={doc("docs/TELEGRAM.md")}>What linking an account means</a>
        </p>
      </div>
    </section>
  );
}
