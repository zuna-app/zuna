import { useEffect, useState } from "react";
import { REPO } from "../pages";
import { GitHubMark, Logo } from "./brand";
import { DownloadButton } from "./Download";

/** The app's accents, from Appearance in its settings (packages/ui/src/styles/tokens.css). */
const ACCENTS = [
  { id: "", name: "Neutral" },
  { id: "blue", name: "Blue" },
  { id: "green", name: "Green" },
  { id: "red", name: "Red" },
  { id: "amber", name: "Amber" },
] as const;

const LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#streaming", label: "Streaming" },
  { href: "/#security", label: "Security" },
  { href: "/#host", label: "Self-host" },
];

export function Nav({ home }: { home: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header className={`nav ${scrolled ? "is-scrolled" : ""}`}>
      <div className="wrap nav-inner">
        <a className="nav-brand" href="/" aria-label="Zuna, home">
          <Logo size={26} />
          <span>Zuna</span>
        </a>
        <nav className="nav-links" aria-label="Sections">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="nav-end">
          {home && <AccentSwitcher />}
          <a className="nav-icon" href={REPO} aria-label="Zuna on GitHub">
            <GitHubMark />
          </a>
          <DownloadButton size="small" />
        </div>
      </div>
    </header>
  );
}

/** Recolors the page as Appearance recolors the app. It's remembered nowhere. */
function AccentSwitcher() {
  const [accent, setAccent] = useState("");
  useEffect(() => {
    if (accent) document.documentElement.dataset.accent = accent;
    else delete document.documentElement.dataset.accent;
  }, [accent]);

  return (
    <div className="accents" role="radiogroup" aria-label="Accent color">
      {ACCENTS.map((option) => (
        <button
          key={option.name}
          type="button"
          role="radio"
          aria-checked={accent === option.id}
          aria-label={option.name}
          title={option.name}
          className={`accent-dot accent-${option.name.toLowerCase()}`}
          onClick={() => setAccent(option.id)}
        />
      ))}
    </div>
  );
}
