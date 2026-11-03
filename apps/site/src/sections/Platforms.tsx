import { Download, Globe, Laptop, Monitor, Smartphone, Tablet, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { RELEASE, downloadsFor } from "../downloads";
import { doc } from "../pages";

const STEPS = ["Install Zuna", "Paste the invite link a friend sent you", "Pick a name and password, and save your recovery key"];

export function Platforms() {
  return (
    <section className="section" id="download">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">Get the app{RELEASE ? ` · ${RELEASE.version}` : ""}</p>
          <h2 className="heading">Got an invite? You're three steps away.</h2>
          <ol className="join-steps">
            {STEPS.map((step, index) => (
              <li key={step}>
                <span className="step-number">{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="platforms">
          <Platform icon={<Monitor size={22} />} name="Windows" detail="Windows 10 and 11, x64" system="windows" />
          <Platform icon={<Laptop size={22} />} name="macOS" detail="Apple silicon" system="mac" />
          <Platform icon={<Terminal size={22} />} name="Linux" detail="x64, built for Wayland" system="linux" />
          <article className="platform reveal">
            <span className="platform-icon">
              <Globe size={22} aria-hidden="true" />
            </span>
            <h3>Web</h3>
            <p>The desktop's interface in a browser, when your server's admins host it.</p>
            <a className="platform-link" href={doc("docs/WEB.md")}>
              How to host the web app
            </a>
          </article>
          <article className="platform is-soon reveal">
            <span className="platform-icon">
              <Smartphone size={22} aria-hidden="true" />
              <Tablet size={22} aria-hidden="true" />
            </span>
            <h3>
              iPhone and iPad <span className="badge">Soon</span>
            </h3>
            <p>A native app with everything the desktop has, coming through TestFlight, then the App Store.</p>
          </article>
          <article className="platform is-soon reveal">
            <span className="platform-icon">
              <Smartphone size={22} aria-hidden="true" />
            </span>
            <h3>
              Android <span className="badge">Planned</span>
            </h3>
            <p>The same core and crypto as the iPhone app, with native screens. It's on the roadmap.</p>
            <a className="platform-link" href={doc("docs/ROADMAP.md")}>
              Read the roadmap
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function Platform(props: { icon: ReactNode; name: string; detail: string; system: "windows" | "mac" | "linux" }) {
  const [main, ...others] = downloadsFor(props.system);
  return (
    <article className="platform reveal">
      <span className="platform-icon" aria-hidden="true">
        {props.icon}
      </span>
      <h3>{props.name}</h3>
      <p>{props.detail}</p>
      <a className="button button-primary button-small platform-button" href={main!.url}>
        <Download size={15} aria-hidden="true" />
        {main!.label}
        {main!.size ? <span className="platform-size">{main!.size} MB</span> : null}
      </a>
      {others.length > 0 && (
        <ul className="platform-others">
          {others.map((download) => (
            <li key={download.label}>
              <a href={download.url}>{download.label}</a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
