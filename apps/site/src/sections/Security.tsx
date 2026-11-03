import { Check, KeyRound, Layers, ShieldCheck } from "lucide-react";
import { doc } from "../pages";

// Sixteen of the identity check's 64, from packages/core/src/safety-emoji.ts.
const EMOJI = ["🐶", "🦁", "🦄", "🐼", "🐧", "🐙", "🦋", "🌵", "🍄", "🌙", "🔥", "🍌", "🌳", "🐢", "☁️", "🍎"];

/** Condensed from the table in SECURITY.md. */
const SEES = ["Your username and when you signed up", "Who is in each conversation", "Who sent a message, when, and roughly how big", "Your IP address and online status"];
const NEVER = ["What you write, reply or react with", "Photos, files and their names", "Group names, pictures and descriptions", "Links, their previews, and what you search for"];

export function Security() {
  return (
    <section className="section" id="security">
      <div className="wrap">
        <div className="section-head reveal">
          <p className="eyebrow">Security</p>
          <h2 className="heading">Private by math, not by promise.</h2>
          <p className="lead">The server is a delivery service for ciphertext. Nothing about how it's run, or who runs it, changes what it can read.</p>
        </div>
        <div className="sec-grid">
          <article className="card reveal">
            <Layers className="card-icon" size={22} aria-hidden="true" />
            <h3>Every chat is an MLS group</h3>
            <p>
              Direct messages too, on MLS (RFC 9420) through the independently audited OpenMLS. Keys change whenever someone joins or leaves, and at least weekly in active chats.
            </p>
          </article>
          <article className="card card-emoji reveal">
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
            <p>
              It's stretched with Argon2id where you type it, and never sent. A key made from it signs you in, and it's tied to that server, so one server can't use
              it on another.
            </p>
          </article>
        </div>
        <div className="sees reveal">
          <div className="sees-column">
            <h3>Your server can see</h3>
            <ul>
              {SEES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="sees-column sees-never">
            <h3>It can't read</h3>
            <ul>
              {NEVER.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="note reveal">
          Zuna hides what you say, not who you talk to. And while OpenMLS has been audited, Zuna's own code hasn't had an independent review yet. We'd rather you
          knew. <a href={doc("SECURITY.md")}>Read the full security model</a>
        </p>
      </div>
    </section>
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
