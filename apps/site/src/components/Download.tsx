import { ArrowRight, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { APP_STORE, detectSystem, downloadsFor, SYSTEM_NAMES, type System } from "../downloads";

/** The visitor's system, once the page can ask. The prerendered page shows the plain button. */
export function useSystem(): System | null {
  const [system, setSystem] = useState<System | null>(null);
  useEffect(() => setSystem(detectSystem()), []);
  return system;
}

/** The bar's button, which leads to the downloads for every system rather than starting one. */
export function NavDownloadButton() {
  return (
    <a className="button button-primary button-small" href="/#download">
      <Download size={15} aria-hidden="true" />
      Download
    </a>
  );
}

/** The hero's and the FAQ's button, which starts the download for the visitor's own system once the page knows it. */
export function DownloadButton() {
  const system = useSystem();
  if (system === "windows" || system === "linux" || system === "mac") {
    const [first] = downloadsFor(system);
    return (
      <a className="button button-primary" href={first!.url}>
        <Download size={18} aria-hidden="true" />
        Download for {SYSTEM_NAMES[system]}
      </a>
    );
  }
  if (system === "ios") {
    return (
      <a className="button button-primary" href={APP_STORE}>
        <Download size={18} aria-hidden="true" />
        Download on the App Store
      </a>
    );
  }
  return (
    <a className="button button-primary" href="/#download">
      <Download size={18} aria-hidden="true" />
      {system === null ? "Download" : "Get the app"}
    </a>
  );
}

export function HostButton() {
  return (
    <a className="button button-ghost" href="/#host">
      Host a server
      <ArrowRight size={18} aria-hidden="true" />
    </a>
  );
}
