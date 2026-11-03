import { doc, REPO } from "../pages";
import { Logo } from "./brand";

const COLUMNS = [
  {
    title: "Zuna",
    links: [
      { href: "/#download", label: "Download" },
      { href: `${REPO}/releases`, label: "Releases" },
      { href: doc("docs/ROADMAP.md"), label: "Roadmap" },
      { href: REPO, label: "Source code" },
    ],
  },
  {
    title: "Run a server",
    links: [
      { href: doc("docs/SELF_HOSTING.md"), label: "Self-hosting guide" },
      { href: doc("docs/WEB.md"), label: "The web app" },
      { href: doc("docs/PUSH_RELAY.md"), label: "The push relay" },
      { href: doc("docs/LINUX.md"), label: "Without Docker" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: doc("SECURITY.md"), label: "Security model" },
      { href: doc("docs/ARCHITECTURE.md"), label: "Architecture" },
      { href: "/privacy/", label: "Privacy" },
      { href: "/support/", label: "Support" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="nav-brand" href="/">
              <Logo size={26} />
              <span>Zuna</span>
            </a>
            <p>Private chat on servers you and your friends run. Free and open source under the AGPL-3.0.</p>
          </div>
          {COLUMNS.map((column) => (
            <div key={column.title} className="footer-column">
              <h2>{column.title}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="footer-bottom">
          <span>This page has no cookies, no analytics and no trackers. Obviously.</span>
          <a href={doc("LICENSE")}>AGPL-3.0</a>
        </div>
      </div>
    </footer>
  );
}
