import { AudioLines, Hash, Headphones, Link as LinkIcon, MicOff, Phone, Search, Smile, Volume2 } from "lucide-react";

const MORE = [
  "Replies, reactions and pins",
  "Forwarding to any chat, on any server",
  "Voice messages with a waveform",
  "Markdown, spoilers and code",
  "Photos, video and any file",
  "Disappearing messages",
  "Read receipts and typing",
  "Online status you can hide",
  "Saved messages",
  "History on every new device",
];

export function Features() {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <div className="section-head reveal">
          <p className="eyebrow">Features</p>
          <h2 className="heading">All the chat. None of the snooping.</h2>
          <p className="lead">Everything you'd expect from a modern chat app, with every message encrypted on your device before it leaves.</p>
        </div>
        <div className="bento">
          <article className="tile tile-wide reveal">
            <div className="tile-copy">
              <h3>One sidebar. Every community.</h3>
              <p>
                Each server you're on is an icon on the rail. Inside, channels anyone can join, direct messages with everyone on the server, and groups that are
                invite-only.
              </p>
            </div>
            <div className="mini-sidebar" aria-hidden="true">
              <div className="mini-rail">
                <span className="is-active">F</span>
                <span>LN</span>
                <span>DV</span>
              </div>
              <div className="mini-list">
                <span className="mini-heading">Channels</span>
                <span className="mini-channel is-unread">
                  <Hash size={14} /> general <i className="mini-mention">2</i>
                </span>
                <span className="mini-channel">
                  <Hash size={14} /> screenshots
                </span>
                <span className="mini-channel">
                  <Volume2 size={14} /> Lounge
                </span>
                <span className="mini-heading">Chats</span>
                <span className="mini-channel">
                  <i className="mini-av aw-c1">WT</i> Weekend trip
                </span>
                <span className="mini-channel">
                  <i className="mini-av aw-c2">PN</i> Priya Nair
                </span>
              </div>
            </div>
          </article>

          <article className="tile reveal">
            <div className="tile-copy">
              <h3>Drop into voice. Or just call.</h3>
              <p>Voice channels to drop into, and calls in any chat that ring like a phone call. Voice, cameras and screens, all end-to-end encrypted.</p>
            </div>
            <div className="voice-grid" aria-hidden="true">
              <span className="voice-person is-speaking">
                <i className="aw-c2">PN</i>
              </span>
              <span className="voice-person">
                <i className="aw-c4">MK</i>
                <MicOff size={11} className="voice-muted" />
              </span>
              <span className="voice-person is-speaking is-late">
                <i className="aw-c3">JB</i>
              </span>
              <span className="voice-bar">
                <Headphones size={14} /> Lounge
                <Phone size={14} className="voice-leave" />
              </span>
            </div>
          </article>

          <article className="tile reveal">
            <div className="tile-copy">
              <h3>7TV emotes, built in.</h3>
              <p>Your admins pick one 7TV set for everyone, animated and zero-width included. Your server caches the images, so 7TV never sees who's looking.</p>
            </div>
            <div className="emote-picker" aria-hidden="true">
              <span className="emote-query">
                <Smile size={14} /> :pee
              </span>
              {["peepoHappy", "peepoClap", "peepoSad"].map((name, index) => (
                <span key={name} className={`emote-row ${index === 0 ? "is-active" : ""}`}>
                  <i className={`emote emote-${index}`} />
                  {name}
                </span>
              ))}
            </div>
          </article>

          <article className="tile reveal">
            <div className="tile-copy">
              <h3>Search that never leaves your device.</h3>
              <p>Your whole history, searchable, with the index kept on your device. The server never sees what you look for.</p>
            </div>
            <div className="mini-search" aria-hidden="true">
              <span className="mini-search-box">
                <Search size={14} /> campsite
              </span>
              <span className="mini-result">
                Booking the <mark>campsite</mark> by the lake now
              </span>
              <span className="mini-result">
                Is the <mark>campsite</mark> dog-friendly?
              </span>
            </div>
          </article>

          <article className="tile reveal">
            <div className="tile-copy">
              <h3>Link previews that don't snitch.</h3>
              <p>The sender's device makes the preview and sends it encrypted, so neither the people you send it to nor the server ever contact the site.</p>
            </div>
            <div className="mini-preview" aria-hidden="true">
              <span className="mini-preview-url">
                <LinkIcon size={13} /> lakeside-camping.example
              </span>
              <span className="mini-preview-card">
                <b>Lakeside Camping</b>
                Pitches by the water, open all year.
              </span>
            </div>
          </article>

          <article className="tile tile-full reveal">
            <div className="tile-copy">
              <h3>And the rest you'd miss.</h3>
            </div>
            <ul className="chips">
              {MORE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <AudioLines className="tile-mark" size={120} aria-hidden="true" />
          </article>
        </div>
      </div>
    </section>
  );
}
