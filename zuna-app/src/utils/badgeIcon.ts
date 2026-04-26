import { nativeImage } from "electron";

export function createBadgeSVG(count: number) {
  const text = count > 99 ? "99+" : String(count);

  let fontSize = 25;
  if (text.length === 2) fontSize = 19;
  if (text.length >= 3) fontSize = 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <circle cx="16" cy="16" r="15" fill="#E81123"/>
      <text x="16" y="24"
            font-size="${fontSize}"
            font-weight="bold"
            text-anchor="middle"
            fill="white"
            font-family="Segoe UI, Arial, sans-serif">
        ${text}
      </text>
  </svg>`;
}

export async function createWindowsBadgeIcon(count: number) {
  const svg = createBadgeSVG(count);
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

  return nativeImage
    .createFromDataURL(dataUrl)
    .resize({ width: 16, height: 16 });
}
