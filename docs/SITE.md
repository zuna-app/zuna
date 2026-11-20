# zuna.chat

The project's landing page, at `https://zuna.chat`, in English. It lives in `apps/site` (`@zuna/site`) beside the apps, because what it claims has to change in the same commit as the code it describes.

## Who it's for

Two people arrive, and every call to action serves both:

- **Whoever hosts:** usually the one technical person in a group of friends. "Host a server" leads to the one command and the self-hosting guide.
- **Whoever was invited:** everyone else. "Download" leads to the installer, then pasting the invite link.

Zuna needs a server, and the page says so plainly without making it sound like a chore.

## Look

The page looks like the app: dark, monochrome, white as the one accent, Inter for text and JetBrains Mono for anything technical. Colors come from `packages/ui/src/styles/tokens.css`, imported rather than copied, so they never drift.

- Thin 1px lines, a bento grid, large headings with tight tracking.
- Effects stay few: a soft light and grain behind the app window in the hero, and figures that count up or bars that grow as they come into view.
- Restrained motion: the hero's window straightens as the page scrolls, messages arrive one by one with a typing indicator, sections fade up. All of it off under `prefers-reduced-motion`.

## Sections

| # | Section | Heading | What's there |
|---|---|---|---|
| 1 | Hero | The chat app nobody owns. | Download for the visitor's system, Host a server, the platforms in a sentence, and a live app window built from the app's tokens, with floating chips for MLS and what the server sees |
| 2 | Features | All the chat. None of the snooping. | Bento: servers and channels, voice channels and calls, 7TV emotes, search on the device, link previews made by the sender, bots on an API shaped like Telegram's, and watching YouTube together; smaller features as chips, the soundboard, video messages, sharing a location, and editing and deleting among them |
| 3 | Streaming | Your screen, exactly as you see it. | Up to 240 fps, up to 4K and about 80 ms of latency as three huge figures of one size that count up as they come in, so none is the headline, said to be each setting's most rather than one share; two lanes on one path, one moving every frame at the visitor's own measured refresh rate and one at 30 fps for comparison; then encoding on the GPU, a 1440p60 share costing about 5% of a core, one app's sound and end-to-end encryption |
| 4 | Telegram | Your Telegram, one icon down. | Linking one's own Telegram account: the rail with its icon under the servers and its chats, beside what's there (`docs/TELEGRAM.md`, "What's there"); four facts as screen sharing's, boxed in on a computer, Telegram's addresses alone, calls through its relays, unknown to Zuna's servers; and a note that its chats aren't end-to-end encrypted, that the iPhone and iPad run its code unboxed, what stays in Telegram's app, and that Zuna isn't Telegram's |
| 5 | Native apps | Native, not a website in a box. | 4.5× less memory than the same app built on Electron as the headline, beside both apps' memory, then three quieter figures in a row, 1.8× faster to open, 9.2× less processor while scrolling and 2.6× smaller installed, each with its two numbers; all from the maintainers' benchmark of 6 November 2026 on Windows, which `NativeApps.tsx` describes, leaving out playing a video message, where Electron used less of a core |
| 6 | Security | Private by math, not by promise. | MLS, audited OpenMLS, Argon2id and signed messages as a row of chips; a bento from `SECURITY.md`: MLS in every chat with a group key that changes as someone joins and leaves, the 16-emoji check, the password stretched on the device and never sent, every message signed by its device, every device checked before anything is encrypted, the log of keys the server can't rewrite (`docs/KEY_TRANSPARENCY.md`), the question each earlier device asks when another signs in, the SOCKS5 proxy that carries everything or nothing, and Settings' Your data with its rows' tags; a short "can see / can't read" with ciphertext behind what it can't; and the missing independent audit said up front, in a box of its own |
| 7 | Compared | Zuna next to Matrix and Fluxer. | A table, feature by feature, with a check, a dash or a cross and a few words in each cell, Zuna's column lit: privacy (encrypted messages, the group encryption, encrypted calls, link previews, search), files (encrypted, the largest, metadata taken out), every day (channels, screen sharing, history on a new device, signing up), performance (native desktop and phone apps, the browser) and hosting (running a server, every feature free, open source); on a phone, each feature's three answers under it |
| 8 | Platforms | Got an invite? You're three steps away. | Windows, macOS (Apple silicon), Linux, the web (if a server hosts it), iPhone and iPad (the App Store), Android (planned) |
| 9 | FAQ | Fair questions. | Can the server's owner read my messages, what can it see, do I need a server, is it free, is it audited, phone number, a forgotten password, how many people, skipping the relay, Android |
| 10 | Self-hosting | One command. One folder to back up. | A terminal with the one command, `public/install.sh`, which starts `deploy/install.sh`, with LiveKit and a proxy it sets up or checks, a copy button, its three steps, a link to its whole guide on GitHub, and Docker coming soon; LiveKit for voice, the web app and backups |
| 11 | Final call | Stop renting your group chat. | Download and Host a server |
| 12 | Footer | | Links, the license, and that the page has no cookies, analytics or third-party requests |

Pages beside it: `/privacy`, the app's and the relay's privacy policy, and `/terms`, the terms of use everyone agrees to when they create an account. App Store Connect needs the privacy policy and a support link, which goes to the repository, and App Review terms with no tolerance for objectionable content.

## Copy

- Headings are plain sentences that say one thing. No "military-grade", "zero metadata", "unhackable", "seamless".
- Every claim is one the code and the docs back. The page says what the server and the relay can see, and that Zuna hasn't had an independent audit.
- Comparisons with other apps stay accurate: Discord's voice and video are end-to-end encrypted, its text isn't. The comparison is Matrix as Element and Synapse ship it, and Fluxer as fluxer.com and its self-hosted server do, as of November 2026, from each project's own pages, which `Compare.tsx` lists line by line. The page doesn't date it, so it's checked again when either ships something, such as MLS in Matrix, or Fluxer's encrypted calls and direct messages. Zuna's native apps are claimed for the first release, on the maintainers' word, ahead of what ships: the desktop app's Windows installer, Linux packages and macOS DMG are on every release, so far nightlies alone, and the iPhone and iPad app is on the App Store (`APP_STORE` in `downloads.ts`). The download buttons give the files of the latest stable release (`downloads.ts`), and each falls back to the releases page while there's none; on an iPhone or iPad the hero's goes to the App Store. The bar's leads to the downloads, for every system. The table's "No limits" on file size is also the maintainers' word, though a server takes files up to 100 MB unless its admins raise it, to at most 100,000 MB.
- What has only run in part says so. Screen sharing at 240 fps has been measured natively on Windows; AMD's and Intel's encoders haven't run, so the page says "encoded on your GPU" rather than naming them. The latency of about 80 ms is the maintainers' own measurement, not at 4K and 240 fps at once, and `docs/SCREEN_SHARE.md` doesn't record it yet.

## Build

- React 19, Vite 8 and `@vitejs/plugin-react` 6, the versions the rest of the repository uses.
- Prerendered at build time: Vite builds a server bundle, `react-dom/static` renders each page into its HTML, and the browser hydrates it. No framework.
- Plain CSS with custom properties, as `packages/ui` does. Fonts from `@fontsource-variable`, icons from `lucide-react`.
- Download links are fetched from the latest GitHub release at build time, since file names carry the version. GitHub's latest release leaves nightlies out, so until the first stable release they lead to the releases page. The visitor's browser never contacts GitHub.
- No cookies, analytics or requests to any other origin, under a strict content security policy. `apps/site/test/site-check.mjs` checks that, with screenshots at 375, 768 and 1440 pixels wide and no sideways scrolling.
- A sitemap and `robots.txt` are made at build time. The picture a shared link shows, `public/og.png`, is drawn by `og.mjs` in the page's fonts, and kept in the repository.
- The maintainers host it on their own server, not on GitHub. "Hosting" below says what that takes.

## Hosting

Publishing the site is building it, checking it and copying `apps/site/dist` to the maintainers' server. How that server is set up is kept out of the repository. The build asks GitHub for the latest release, which needs no token now that the repository is public. One only raises GitHub's rate limit:

```bash
GITHUB_TOKEN=$(gh auth token) npm run build -w @zuna/site
```

```bash
node apps/site/test/site-check.mjs
```

Download links are fixed when it's built, so it's built and copied again after each release.

Whatever serves it has to:

- Serve a folder's `index.html` (`/privacy/` is `privacy/index.html`), and `404.html` with a 404 for anything else.
- Let browsers keep `/assets/` for a year, since those names change with their content.
- Send the headers in `HEADERS` in `policy.mjs` with every response, which the site check serves the pages with too: the pages' content security policy with `frame-ancestors 'none'` added, which a meta tag can't carry, `X-Content-Type-Options` and `Referrer-Policy`. And HSTS, which the check can't try over plain HTTP.

## Left to decide

- A contact address for `/privacy`, which sends questions to the repository's issues for now.
