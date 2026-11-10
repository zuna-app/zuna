import { ArrowRight, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { detectSystem, downloadsFor, SYSTEM_NAMES, type System } from "../downloads";

/** The visitor's system, once the page can ask. The prerendered page shows the plain button. */
export function useSystem(): System | null {
  const [system, setSystem] = useState<System | null>(null);
  useEffect(() => setSystem(detectSystem()), []);
  return system;
}

export function DownloadButton({ size = "large" }: { size?: "large" | "small" }) {
  const system = useSystem();
  const className = `button button-primary ${size === "small" ? "button-small" : ""}`;
  if (system === "windows" || system === "linux") {
    const [first] = downloadsFor(system);
    return (
      <a className={className} href={first!.url}>
        <Download size={size === "small" ? 15 : 18} aria-hidden="true" />
        {size === "small" ? "Download" : `Download for ${SYSTEM_NAMES[system]}`}
      </a>
    );
  }
  return (
    <a className={className} href="/#download">
      <Download size={size === "small" ? 15 : 18} aria-hidden="true" />
      {size === "small" || system === null ? "Download" : "Get the app"}
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
