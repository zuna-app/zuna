import { StrictMode } from "react";
import { prerender } from "react-dom/static";
import { App } from "./App";
import { PAGES, SITE, type Page } from "./pages";

export { PAGES, SITE };

/** The page's markup, for build.mjs to put in index.html. */
export async function render(page: Page): Promise<string> {
  const { prelude } = await prerender(
    <StrictMode>
      <App page={page.id} />
    </StrictMode>,
  );
  return new Response(prelude).text();
}

export function head(page: Page): string {
  const url = `${SITE}${page.path}`;
  const tags = [
    `<title>${escape(page.title)}</title>`,
    `<meta name="description" content="${escape(page.description)}" />`,
    page.id === "missing" ? `<meta name="robots" content="noindex" />` : `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Zuna" />`,
    `<meta property="og:title" content="${escape(page.title)}" />`,
    `<meta property="og:description" content="${escape(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  if (page.id === "home") tags.push(`<script type="application/ld+json">${JSON.stringify(software).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n    ");
}

const software = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Zuna",
  url: SITE,
  applicationCategory: "CommunicationApplication",
  operatingSystem: "Windows, macOS, Linux",
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
