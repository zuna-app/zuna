// What zuna.chat allows itself, for build.mjs to put in each page and site-check.mjs to serve them with.

/** In a meta tag, so it goes wherever the pages are served. A meta tag can't hold frame-ancestors. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** What the server sends with every page, as the Caddy example under "Hosting" in docs/SITE_PLAN.md does. */
export const HEADERS = {
  "content-security-policy": `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};
