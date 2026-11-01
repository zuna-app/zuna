// What the host, zuna-web, was set up with. Without a host (a plain static server),
// there are no link previews and nothing is filled in.

export interface HostConfig {
  /** Whether zuna-web fetches pages for link previews. */
  previews: boolean;
  /** A server address to start the sign-in form with. */
  server: string | null;
}

export async function loadConfig(): Promise<HostConfig> {
  try {
    const response = await fetch("/_zuna/config", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const config = (await response.json()) as Partial<HostConfig>;
    return {
      previews: config.previews === true,
      server: typeof config.server === "string" && config.server ? config.server : null,
    };
  } catch {
    return { previews: false, server: null };
  }
}
