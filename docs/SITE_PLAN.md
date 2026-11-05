# zuna.chat: plan

The project's landing page, at `https://zuna.chat`, in English. It lives in `apps/site` (`@zuna/site`) beside the apps, because what it claims has to change in the same commit as the code it describes.

## Who it's for

Two people arrive, and every call to action serves both:

- **Whoever hosts:** usually the one technical person in a group of friends. "Host a server" leads to the terminal, Docker and the self-hosting guide.
- **Whoever was invited:** everyone else. "Download" leads to the installer, then pasting the invite link.

Zuna needs a server, and the page says so plainly without making it sound like a chore.

## Look

The page looks like the app: dark, monochrome, white as the one accent, Inter for text and JetBrains Mono for anything technical. Colors come from `packages/ui/src/styles/tokens.css`, imported rather than copied, so they never drift.

- Thin 1px lines, a bento grid, large headings with tight tracking.
- Two effects only: a soft light and grain behind the app window in the hero, and the demo's heading resolving from noise into text as it scrolls in.
- Restrained motion: the hero's window straightens as the page scrolls, messages arrive one by one with a typing indicator, sections fade up. All of it off under `prefers-reduced-motion`.

## Sections

| # | Section | Heading | What's there |
|---|---|---|---|
| 1 | Hero | The chat app nobody owns. | Download for the visitor's system, Host a server, the platforms in a sentence, and a live app window built from the app's tokens, with floating chips for MLS and what the server sees |
| 2 | Demo | Your server only ever sees noise. | Type a message: the left shows what a friend sees, the right what the server stores, really encrypted with WebCrypto and padded to 256-byte blocks as Zuna pads, labelled as an illustration |
| 3 | Features | All the chat. None of the snooping. | Bento: servers and channels, voice channels and calls, 7TV emotes, search on the device, link previews made by the sender; smaller features as chips |
| 4 | Devices | Pick up on any device where you left off. | What follows someone between devices: the whole history with no other device on, read positions, the synced preferences and verifications, notifications that wait while another device is in use, calls ringing everywhere and moving, and the recovery key; Zuna and Signal side by side on a line down the middle, topic by topic: devices, sharing a screen, where it runs and channels; then "Encryption you never have to think about", that comfort comes first and no security fix may add a step, prompt or setting |
| 5 | Streaming | Your screen, sharp and smooth. | Up to 240 fps, up to 4K and about 80 ms of latency, side by side and none made the headline, said to be each setting's most rather than one share; a bar moving at the visitor's own refresh rate with the measured Hz, a 1440p60 share costing about 5% of a core, one app's sound |
| 6 | Security | Private by math, not by promise. | MLS in every chat, the 16-emoji check, the password staying on the device, a short "can see / never sees" from `SECURITY.md`, and the missing independent audit said up front |
| 7 | Notifications | Your phone buzzes. Nobody else learns why. | Server → zuna-push → Apple → phone, with what each sees, and that the relay sees which server woke which phone, and when |
| 8 | Self-hosting | One command. One folder to back up. | A terminal with tabs for Docker and for systemd, which is `deploy/update.sh` with LiveKit (`--voice on`), each with its commands, a copy button, its own three steps and a link to its whole guide on GitHub; LiveKit for voice, the web app and backups |
| 9 | Platforms | Got an invite? You're three steps away. | Windows, macOS (Apple silicon), Linux, the web (if a server hosts it), iPhone and iPad (soon), Android (planned) |
| 10 | FAQ | | Can the server's owner read my messages, what can it see, do I need a server, is it free, is it audited, phone number, how many people, Android, skipping the relay |
| 11 | Final call | Stop renting your group chat. | Download and Host a server |
| 12 | Footer | | Links, the license, and that the page has no cookies, analytics or third-party requests |

Pages beside it: `/privacy`, the app's and the relay's privacy policy, and `/support`. App Store Connect needs both.

## Copy

- Headings are plain sentences that say one thing. No "military-grade", "zero metadata", "unhackable", "seamless".
- Every claim is one the code and the docs back. The page says what the server and the relay can see, and that Zuna hasn't had an independent audit.
- Comparisons with other apps stay accurate: Discord's voice and video are end-to-end encrypted, its text isn't. The comparison with Signal is Signal as of November 2026, from its blog, its support pages, reports of its betas and its issue tracker. The page doesn't date it, so it's checked again when Signal ships something, such as a desktop app that needs no phone, or channels.
- What has only run in part says so. Screen sharing at 240 fps has been measured natively on Windows; AMD's and Intel's encoders haven't run, so the page says "encoded on your GPU" rather than naming them. The latency of about 80 ms is the maintainers' own measurement, not at 4K and 240 fps at once, and `docs/SCREEN_SHARE.md` doesn't record it yet.

## Build

- React 19, Vite 7 and `@vitejs/plugin-react` 5, the versions the rest of the repository uses.
- Prerendered at build time: Vite builds a server bundle, `react-dom/static` renders each page into its HTML, and the browser hydrates it. No framework.
- Plain CSS with custom properties, as `packages/ui` does. Fonts from `@fontsource-variable`, icons from `lucide-react`.
- Download links are fetched from the latest GitHub release at build time, since file names carry the version. Without a release, they lead to the releases page. The visitor's browser never contacts GitHub.
- No cookies, analytics or requests to any other origin, under a strict content security policy. `apps/site/test/site-check.mjs` checks that, with screenshots at 375, 768 and 1440 pixels wide and no sideways scrolling.
- A sitemap and `robots.txt` are made at build time. The picture a shared link shows, `public/og.png`, is drawn by `og.mjs` in the page's fonts, and kept in the repository.
- The maintainers host it on their own server, not on GitHub. "Hosting" below says how.

## Hosting

Publishing the site is building it and copying `apps/site/dist` to the server's folder for zuna.chat. The token only lets the build see the latest release while the repository is private:

```bash
GITHUB_TOKEN=$(gh auth token) npm run build -w @zuna/site
```

Download links are fixed when it's built, so it's built and copied again after each release. Run the site check before copying.

The server has to:

- Serve a folder's `index.html` (`/privacy/` is `privacy/index.html`), and `404.html` with a 404 for anything else.
- Let browsers keep `/assets/` for a year, since those names change with their content.
- Send the headers in `HEADERS` in `policy.mjs`, which the site check serves the pages with too: the pages' content security policy with `frame-ancestors 'none'` added, which a meta tag can't carry, `X-Content-Type-Options` and `Referrer-Policy`. And HSTS, which the check can't try over plain HTTP.

With Caddy, which already serves Zuna's own Docker setup:

```
zuna.chat {
	root * /srv/zuna.chat
	encode zstd gzip
	file_server
	handle_errors {
		rewrite * /{err.status_code}.html
		file_server
	}
	header {
		Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=31536000"
	}
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
}
```

## Left to decide

- The push relay is at `https://relay.mgalazka.pl`. Moving it to `push.zuna.chat` before the iPhone app is released means only one address to keep.
- The repository is private and has no release yet, so download and GitHub links only work for visitors once it's public.
- A contact address for `/support` and `/privacy`, which Apple asks for.
