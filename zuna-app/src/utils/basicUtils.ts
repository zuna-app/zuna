import { BrowserWindow } from "electron";

export const convertTimeToRelative = (timestamp: number) => {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}m ago`;
  if (diff < 24 * 60 * 60 * 1000)
    return `${Math.floor(diff / (60 * 60 * 1000))}h ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const getFirstLetters = (str: string) => {
  const words = str.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return words[0][0].toUpperCase() + words[1][0].toUpperCase();
};

export const getZunaWindow = (): BrowserWindow | null => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length === 1) {
    return allWindows[0] || null;
  }
  for (const win of allWindows) {
    if (win.getTitle() === "Zuna") {
      return win;
    }
  }
  return null;
};
