import { LockKeyhole } from "lucide-react";
import { AppWindow } from "../components/AppWindow";
import { DownloadButton, HostButton } from "../components/Download";

export function Hero() {
  return (
    <section className="hero">
      <div className="hero-light" aria-hidden="true" />
      <div className="wrap hero-inner">
        <h1 className="display hero-in">The chat app nobody owns.</h1>
        <p className="lead hero-lead hero-in">
          Messages, groups, voice channels, calls and screen sharing, on a server you and your friends run. Even whoever hosts it can't read a word.
        </p>
        <div className="actions hero-in">
          <DownloadButton />
          <HostButton />
        </div>
        <p className="hero-platforms hero-in">For Windows, Linux and the web, and soon macOS, iPhone and iPad.</p>
      </div>
      <div className="wrap hero-stage hero-in">
        <div className="hero-tilt">
          <AppWindow />
        </div>
        <span className="chip-float chip-float-left" aria-hidden="true">
          <LockKeyhole size={14} /> Encrypted with MLS <span className="chip-label">RFC 9420</span>
        </span>
        <span className="chip-float chip-float-right" aria-hidden="true">
          <span className="chip-label">server sees</span> 9f3c 81d0 e4a7 …
        </span>
      </div>
    </section>
  );
}

