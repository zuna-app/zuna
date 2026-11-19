import { AudioLines, Bot, Hash, Headphones, Link as LinkIcon, MicOff, Phone, Play, Search, Smile, Square, Volume2 } from "lucide-react";

const MORE = [
  "Replies, reactions and pins",
  "Editing, and deleting for everyone",
  "Forwarding to any chat, on any server",
  "Voice messages with a waveform",
  "Video messages in a circle",
  "A soundboard in voice",
  "Sharing your location",
  "Markdown, spoilers and code",
  "Photos, video and any file",
  "Disappearing messages",
  "Read receipts and typing",
  "Online status you can hide",
  "Saved messages",
  "History on every new device",
];

/** The video in the Watch tile: a sun setting over a lake behind hills, drawn here, as the page loads nothing from elsewhere. */
function WatchScene() {
  return (
    <svg className="mini-watch-scene" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="watch-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#131a35" />
          <stop offset="0.45" stopColor="#47325f" />
          <stop offset="0.8" stopColor="#c4625c" />
          <stop offset="1" stopColor="#f6aa62" />
        </linearGradient>
        <radialGradient id="watch-glow">
          <stop offset="0" stopColor="#ffd49a" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ffd49a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="watch-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd59a" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffd59a" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="watch-lake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a4058" />
          <stop offset="0.5" stopColor="#2a2034" />
          <stop offset="1" stopColor="#0c0d15" />
        </linearGradient>
      </defs>
      <rect width="320" height="112" fill="url(#watch-sky)" />
      <g fill="#fff" opacity="0.55">
        <circle cx="38" cy="18" r="0.8" />
        <circle cx="94" cy="32" r="0.6" />
        <circle cx="146" cy="12" r="0.7" />
        <circle cx="258" cy="22" r="0.8" />
        <circle cx="300" cy="9" r="0.6" />
      </g>
      <circle cx="240" cy="100" r="70" fill="url(#watch-glow)" />
      <circle cx="240" cy="100" r="16" fill="#ffe3b4" />
      <path d="M0 112V94l30-12 28 10 34-22 32 18 28-10 32 14 30-6 26 15 22-9 28-20 30 12v28z" fill="#3a2949" />
      <path d="M0 112v-8l46-7 38 9 40-7 36 9h90l32-7 38 5v6z" fill="#201828" />
      <rect y="112" width="320" height="68" fill="url(#watch-lake)" />
      <rect x="226" y="112" width="28" height="52" fill="url(#watch-shine)" />
      <g fill="#ffd59a">
        <rect x="222" y="115" width="36" height="1.6" rx="0.8" opacity="0.7" />
        <rect x="230" y="119" width="24" height="1.4" rx="0.7" opacity="0.55" />
        <rect x="219" y="124" width="18" height="1.2" rx="0.6" opacity="0.35" />
        <rect x="238" y="126" width="16" height="1.2" rx="0.6" opacity="0.45" />
        <rect x="228" y="132" width="13" height="1.2" rx="0.6" opacity="0.35" />
        <rect x="241" y="139" width="9" height="1" rx="0.5" opacity="0.28" />
        <rect x="231" y="147" width="7" height="1" rx="0.5" opacity="0.2" />
      </g>
    </svg>
  );
}

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
                  <span className="emote">
                    <img src={`/emotes/${name}.webp`} alt="" />
                  </span>
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

          {/* Fifth of the tiles that take one column, so it takes the row once the bento has two (tile-alone in sections.css). */}
          <article className="tile tile-alone reveal">
            <div className="tile-copy">
              <h3>Bots that speak Telegram's API.</h3>
              <p>
                Run a bot with zuna-bot on a machine you choose, and write it as you would for Telegram, commands and buttons included. It has keys of its
                own, reads only the chats it's added to, and wears a badge wherever its name shows.
              </p>
            </div>
            <div className="mini-bot" aria-hidden="true">
              <span className="mini-bot-name">
                <i className="mini-av aw-c5">
                  <Bot size={12} />
                </i>
                Reminders <b>Bot</b>
              </span>
              <span className="mini-bot-bubble">Movie night starts in 30 minutes. Are you in?</span>
              <span className="mini-bot-buttons">
                <span>I'm in</span>
                <span>Not tonight</span>
              </span>
            </div>
          </article>

          {/*
            docs/WATCH_TOGETHER.md: one video at a time, everyone controls it, and YouTube is contacted only after Watch, asked about the first time.
            The bar under the video is the apps' own (watch-bar in Watch.tsx), with who paused it, as voice.watch.pausedBy says.
          */}
          <article className="tile tile-wide tile-watch reveal">
            <div className="tile-copy">
              <h3>Watch YouTube together.</h3>
              <p>
                Put a video on in a voice channel or a call, and it plays at the same moment for everyone who presses Watch. Anyone can pause it, skip ahead
                or change its speed. Your device contacts YouTube only once you press Watch, and asks you the first time.
              </p>
            </div>
            <div className="mini-watch" aria-hidden="true">
              <div className="mini-watch-video">
                <WatchScene />
                <span className="mini-watch-play">
                  <Play size={20} fill="currentColor" />
                </span>
                <span className="mini-watch-controls">
                  <span className="mini-watch-track">
                    <span className="mini-watch-fill" />
                  </span>
                  <span className="mini-watch-row">
                    2:14 / 6:40 <b>1.25×</b>
                  </span>
                </span>
              </div>
              <div className="mini-watch-bar">
                <span className="mini-watch-text">
                  <b>Lakeside sunset, a timelapse</b>
                  Paused by Jordan
                </span>
                <span className="mini-watch-people">
                  <i className="mini-av aw-c2">PN</i>
                  <i className="mini-av aw-c3">JB</i>
                  <i className="mini-av aw-c4">MK</i>
                </span>
                <span className="mini-watch-stop">
                  <Square size={10} fill="currentColor" /> Stop
                </span>
              </div>
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
