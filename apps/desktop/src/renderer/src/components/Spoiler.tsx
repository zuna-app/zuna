import { useState, type ReactNode } from "react";

export function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={`spoiler${revealed ? " is-revealed" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => setRevealed(true)}
      onKeyDown={(event) => event.key === "Enter" && setRevealed(true)}
    >
      <span className="spoiler-content">{children}</span>
    </span>
  );
}
