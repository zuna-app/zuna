export const SITE = "https://zuna.chat";
export const REPO = "https://github.com/zuna-app/zuna";

export type PageId = "home" | "privacy" | "terms" | "support" | "missing";

export interface Page {
  id: PageId;
  /** Where it's served, and what goes in the sitemap. */
  path: string;
  /** The file build.mjs writes, under dist. */
  file: string;
  title: string;
  description: string;
}

export const PAGES: Page[] = [
  {
    id: "home",
    path: "/",
    file: "index.html",
    title: "Zuna: end-to-end encrypted chat on servers you run",
    description:
      "Messages, groups, voice channels, calls and screen sharing, on a server you and your friends run. Even whoever hosts it can't read a word. Free and open source.",
  },
  {
    id: "privacy",
    path: "/privacy/",
    file: "privacy/index.html",
    title: "Zuna's privacy policy",
    description: "What Zuna's apps, its push relay and this website learn about you, and what they never can.",
  },
  {
    id: "terms",
    path: "/terms/",
    file: "terms/index.html",
    title: "Zuna's terms of use",
    description: "The rules for using Zuna: what nobody may post, what happens to those who do, and what running a server asks of you.",
  },
  {
    id: "support",
    path: "/support/",
    file: "support/index.html",
    title: "Help with Zuna",
    description: "Help with the Zuna apps, with running a server, and with reporting a security problem.",
  },
  {
    id: "missing",
    path: "/404",
    file: "404.html",
    title: "Page not found",
    description: "There's nothing at this address.",
  },
];

export function pageFor(pathname: string): PageId {
  const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return PAGES.find((page) => page.path === path)?.id ?? "missing";
}

export function doc(path: string): string {
  return `${REPO}/blob/main/${path}`;
}
