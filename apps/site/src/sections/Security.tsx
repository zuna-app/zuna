import { ArrowRight, BadgeCheck, Check, Eye, Fingerprint, Info, KeyRound, Laptop, Layers, Lock, PenLine, Server, ShieldCheck, Smartphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prefersLessMotion, useOnScreen } from "../components/reveal";
import { doc } from "../pages";

// Sixteen of the identity check's 64, from packages/core/src/safety-emoji.ts.
const EMOJI = ["🐶", "🦁", "🦄", "🐼", "🐧", "🐙", "🦋", "🌵", "🍄", "🌙", "🔥", "🍌", "🌳", "🐢", "☁️", "🍎"];

/** Condensed from the table in SECURITY.md. */
const SEES = ["Your username and when you signed up", "Who is in each conversation", "When a message was sent there, and roughly how big", "Your IP address and online status"];
const NEVER = ["What you write, reply or react with", "Who in a chat sent each message", "Photos, files and their names", "Group names, pictures and descriptions", "Links, their previews, and what you search for"];

/** Each from SECURITY.md: MLS through the audited OpenMLS, the password stretched with Argon2id, and every message signed by its device. */
const CREDENTIALS = ["MLS · RFC 9420", "OpenMLS, independently audited", "Argon2id", "Every message signed"];

// A noise of ciphertext behind what the server can't read, made once so the page renders the same on the server and in the browser.
const NOISE = "9f2c a71e 04bd e83a 5c19 f6d0 2b8e 71a4 c03f 8e5d 1a97 d24c 6b0e 3f81 a5c7 0d62 e94b 27f3 b81c 4e06 9a3d f15b 08c2 7de9 c4a0 3b7f e612 58d4 0f9e a2b6 ".repeat(6);

export function Security() {
  return (
    <section className="section" id="security">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Security</p>
          <h2 className="heading">Private by math, not by promise.</h2>
          <p className="lead">The server is a delivery service for ciphertext. Nothing about how it's run, or who runs it, changes what it can read.</p>
          <ul className="sec-credentials">
            {CREDENTIALS.map((item) => (
              <li key={item}>
                <Check size={13} strokeWidth={3} aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="sec-bento">
          <article className="card sec-wide reveal">
            <div>
              <Layers className="card-icon" size={22} aria-hidden="true" />
              <h3>Every chat is an MLS group</h3>
              <p>
                Direct messages too, on MLS (RFC 9420), the IETF's standard for group encryption, through the independently audited OpenMLS. Keys change whenever
                someone joins or leaves, and at least weekly in active chats.
              </p>
            </div>
            <EpochDemo />
          </article>

          <article className="card reveal">
            <ShieldCheck className="card-icon" size={22} aria-hidden="true" />
            <h3>Sixteen emoji to prove it's really them</h3>
            <p>Compare them on a call. If they match, nobody is sitting in the middle of your conversation, the server included.</p>
            <div className="emoji-pair" aria-hidden="true">
              <EmojiGrid />
              <span className="emoji-match">
                <Check size={16} />
              </span>
              <EmojiGrid />
            </div>
          </article>

          <article className="card reveal">
            <KeyRound className="card-icon" size={22} aria-hidden="true" />
            <h3>Your password stays on your device</h3>
            <p>It's stretched with Argon2id where you type it, and never sent. What signs you in is tied to that server, so it's no use on another.</p>
            <div className="sec-steps" aria-hidden="true">
              <span className="sec-pill sec-mono">••••••</span>
              <ArrowRight size={14} />
              <span className="sec-pill">Argon2id</span>
              <ArrowRight size={14} />
              <span className="sec-pill is-good">
                <KeyRound size={13} /> Your key
              </span>
            </div>
            <span className="sec-never" aria-hidden="true">
              <Server size={13} /> To the server <X size={13} strokeWidth={3} />
            </span>
          </article>

          <article className="card reveal">
            <PenLine className="card-icon" size={22} aria-hidden="true" />
            <h3>No words put in your mouth</h3>
            <p>Every message, reaction and read position is signed by the device that sent it, so a server can't pass off one person's words as another's.</p>
            <div className="sec-signed" aria-hidden="true">
              <span className="sec-bubble">See you at eight?</span>
              <span className="sec-signature">
                <BadgeCheck size={13} /> Signed by Priya's laptop
              </span>
            </div>
          </article>

          <article className="card reveal">
            <Fingerprint className="card-icon" size={22} aria-hidden="true" />
            <h3>No device slips in</h3>
            <p>Your app checks every device in a chat before it encrypts. One the server added on its own is removed, and everyone is warned.</p>
            <ul className="sec-devices" aria-hidden="true">
              <li>
                <Smartphone size={14} /> Priya's phone <Check size={14} strokeWidth={3} className="is-good" />
              </li>
              <li>
                <Laptop size={14} /> Priya's laptop <Check size={14} strokeWidth={3} className="is-good" />
              </li>
              <li className="is-removed">
                <Server size={14} /> Unknown device <span>Removed</span>
              </li>
            </ul>
          </article>
        </div>

        <div className="sees reveal">
          <div className="sees-column">
            <h3>
              <Eye size={15} aria-hidden="true" /> Your server can see
            </h3>
            <ul>
              {SEES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="sees-column sees-never">
            <span className="sees-noise" aria-hidden="true">
              {NOISE}
            </span>
            <h3>
              <Lock size={15} aria-hidden="true" /> It can't read
            </h3>
            <ul>
              {NEVER.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* SITE_PLAN asks for the missing audit up front, not in small print. */}
        <aside className="sec-audit reveal">
          <Info size={18} aria-hidden="true" />
          <p>
            <b>Zuna hides what you say, and the server isn't told who in a chat said it, but it does see who you talk to.</b> One set on finding out who sent a message can often still tell, from addresses and timing. And while OpenMLS has been audited, Zuna's own code hasn't had an independent review yet. We'd
            rather you knew. <a href={doc("SECURITY.md")}>Read the full security model</a>
          </p>
        </aside>
      </div>
    </section>
  );
}

const MEMBERS = [
  { initials: "PN", tone: "aw-c2" },
  { initials: "JB", tone: "aw-c3" },
  { initials: "MK", tone: "aw-c4" },
];
const NEWCOMER = { initials: "SC", tone: "aw-c5" };
// Shortened group secrets for the illustration, one per epoch.
const KEYS = ["7c1e 94a0 3f2d", "e05b 1d83 a6c9", "42fa c70e 9b15", "b9d3 06e1 5ac4"];

/** A group whose key changes as someone joins and leaves, every three seconds while it's on screen. Still, it shows one epoch. */
function EpochDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!onScreen || prefersLessMotion()) return;
    const timer = setInterval(() => setStep((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, [onScreen]);

  const joined = step % 2 === 1;
  const members = joined ? [...MEMBERS, NEWCOMER] : MEMBERS;
  return (
    <div className="epoch" ref={ref} aria-hidden="true">
      <div className="epoch-members">
        {members.map((member) => (
          <span key={member.initials} className={`epoch-avatar ${member.tone} ${member === NEWCOMER ? "is-new" : ""}`}>
            {member.initials}
          </span>
        ))}
      </div>
      <span className="epoch-event" key={step}>
        {step === 0 ? "Group created" : joined ? "Sam joined, so the key changed" : "Sam left, so the key changed"}
      </span>
      <div className="epoch-key" key={`key-${step}`}>
        <KeyRound size={14} />
        <span className="epoch-label">Epoch {41 + step}</span>
        <span className="epoch-secret">{KEYS[step % KEYS.length]}</span>
      </div>
    </div>
  );
}

function EmojiGrid() {
  return (
    <span className="emoji-grid">
      {EMOJI.map((emoji) => (
        <i key={emoji}>{emoji}</i>
      ))}
    </span>
  );
}
