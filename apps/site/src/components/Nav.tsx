import { useEffect, useState } from "react";
import { REPO } from "../pages";
import { GitHubMark, Logo } from "./brand";
import { DownloadButton } from "./Download";

const LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#streaming", label: "Streaming" },
  { href: "/#security", label: "Security" },
  { href: "/#host", label: "Self-host" },
];

export function Nav() {
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
          <a className="nav-icon" href={REPO} aria-label="Zuna on GitHub">
            <GitHubMark />
          </a>
          <DownloadButton size="small" />
        </div>
      </div>
    </header>
  );
}

