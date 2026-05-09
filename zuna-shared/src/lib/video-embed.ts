export type VideoProvider = "youtube" | "vimeo" | "streamable";

export interface VideoEmbed {
  embedUrl: string;
  provider: VideoProvider;
}

export function getVideoEmbed(url: string): VideoEmbed | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    // YouTube: youtube.com/watch?v=ID | youtu.be/ID | youtube.com/shorts/ID
    if (host === "youtube.com" || host === "youtu.be") {
      let videoId: string | null = null;
      if (host === "youtu.be") {
        videoId = u.pathname.slice(1).split("/")[0] || null;
      } else if (u.pathname === "/watch") {
        videoId = u.searchParams.get("v");
      } else {
        const shorts = u.pathname.match(/^\/shorts\/([^/?]+)/);
        if (shorts) videoId = shorts[1];
        const embed = u.pathname.match(/^\/embed\/([^/?]+)/);
        if (embed) videoId = embed[1];
      }
      if (videoId) {
        return {
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          provider: "youtube",
        };
      }
    }

    // Vimeo: vimeo.com/ID
    if (host === "vimeo.com") {
      const match = u.pathname.match(/^\/(\d+)/);
      if (match) {
        return {
          embedUrl: `https://player.vimeo.com/video/${match[1]}`,
          provider: "vimeo",
        };
      }
    }

    // Streamable: streamable.com/ID
    if (host === "streamable.com") {
      const match = u.pathname.match(/^\/(?:e\/)?([a-zA-Z0-9]+)$/);
      if (match) {
        return {
          embedUrl: `https://streamable.com/e/${match[1]}`,
          provider: "streamable",
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
