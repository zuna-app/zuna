import { UserIcon } from "lucide-react";

export function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s_.\-]+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.toUpperCase();
}

export function getAvatarHue(name: string): number {
  if (!name) return 220;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return ((Math.abs(hash) % 360) + 360) % 360;
}

interface PseudoAvatarProps {
  name: string;
  size?: number;
  rounded?: "full" | "xl";
}

export function PseudoAvatar({
  name,
  size = 40,
  rounded = "full",
}: PseudoAvatarProps) {
  const hue = getAvatarHue(name);
  const bg = `hsl(${hue}, 60%, 50%)`;
  const border = `hsl(${hue}, 60%, 38%)`;
  const initials = name ? (
    getInitials(name)
  ) : (
    <UserIcon style={{ width: size * 0.4, height: size * 0.4 }} />
  );
  const borderRadius = rounded === "full" ? "50%" : `${size * 0.25}px`;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius,
        background: name
          ? `radial-gradient(circle at 35% 35%, hsl(${hue}, 70%, 62%), ${bg})`
          : undefined,
        backgroundColor: name ? undefined : "hsl(var(--muted))",
        boxShadow: `0 0 0 2px ${name ? border : "hsl(var(--border))"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: name ? "white" : "hsl(var(--muted-foreground))",
        fontSize: size * 0.32,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        flexShrink: 0,
        userSelect: "none",
        transition: "border-radius 0.15s ease",
      }}
    >
      {initials}
    </div>
  );
}
