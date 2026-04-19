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

export const base64ToImageUrl = (base64: string) => {
  return `data:image/png;base64,${base64}`;
};
