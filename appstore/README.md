# App Store art

The iPhone app's screenshots and product page art for App Store Connect. The pictures in `captures/` are the source. The scripts in `art/` draw every image here from them, and `showcase/` sets up the made-up people and servers the captures show.

| Folder | App Store Connect slot | Size |
|---|---|---|
| `iphone-6.9` | iPhone 6.9" | 1320 × 2868 |
| `iphone-6.3` | iPhone 6.1" or 6.3", scaled from the 6.9" ones | 1206 × 2622 |
| `iphone-pl-6.9`, `iphone-pl-6.3` | The same, in Polish | |
| `ipad-13` | iPad 12.9" or 13", landscape | 2752 × 2064 |
| `product-page/header.png`, `header-basic.png` | Product Page Header (iOS 27 or later), two to choose from | 3840 × 1646 |
| `product-page/search-result.png` | Search Results (iOS 27 or later) | 3840 × 2560 |

Every image is a PNG without an alpha channel, which App Store Connect refuses.

## Drawing them again

```bash
appstore/art/render.sh [iphone | iphone-pl | ipad | product-page] [name]
```

It needs Google Chrome, Python 3 and `sips`, which comes with macOS, and the repository's `node_modules` for Inter. The headlines are in `render.sh`. The pages are:

- `frame.html` for the screenshots.
- `header.html`, `header-basic.html` and `search.html` for the product page.
- `art.js` and `art.css`, which draw the devices.

`capture.py` drives headless Chrome over the DevTools protocol and waits until each device's tiles are drawn. Chrome's own `--screenshot` leaves them out.

### How App Store Connect shows the product page art

Checked in App Store Connect's preview on 2026-11-18:

- **Header on an iPhone.** About 3240 px of its 3840 px width fills the phone's width. The top sits under the status bar, and the back and share buttons cover the top corners. Everything in it is drawn large, and nothing sits in those corners. `art/header-sim.py` shows a header the way the preview did.
- **Search results on an iPhone.** The whole width shows, but only the top 2017 px. `art/search-sim.py` shows that crop.

Apple's safe areas are the middle 1646 × 661 of the header (at x 1097, y 493) and the middle 2168 × 1030 of the search artwork (at x 836, y 765). Both pieces of art reach past them, so the iPhone can show them larger. Nobody has checked yet how an iPad shows them.

## The captures

- **iPhone:** a Debug build on an iPhone simulator, at 1206 × 2622.
- **iPad:** an iPad Pro 13" simulator lying on its side.
- **Language:** the system language was set to English, or Polish for `iphone-pl`, with `defaults write -g AppleLanguages`.
- **Status bar:** `xcrun simctl status_bar … override` with every field given, as giving only some resets the rest. The time is 12:41, and 17:52 on the iPad's servers shot, written in 24-hour form. The battery is set to discharging, so it shows no bolt.

Two scripts cleaned up the captures before framing:

- `art/cleanbar.py` takes the bar along the bottom of a capture from a second capture with nothing scrolled under it. Without that, iOS's glass tab bar shows whatever is under it, as a grey blur.
- `art/ipadcorner.py` paints out the resize handle iPadOS draws in a window's corner.

## The showcase

Everything on screen is made up:

- **The servers** ran on this Mac.
- **The people** are the core's test clients (`TestApp` in `packages/core/test/helpers.ts`). Their faces are DiceBear's notionists, which are CC0. `showcase/images.mjs` and `images2.mjs` drew them, the servers' icons and the photos people share.
- **The person on the simulator** is driven through the app's control channel: `-ZunaControlPort <port>`, in "The control channel" in `docs/IOS_TESTING.md`. `showcase/ctl.mjs` reaches it from the shell.
- **The Telegram chats** come from `showcase/tg-inject*.mjs`. Each one prints a script for `ctl.mjs eval` that feeds the app's core made-up updates. No Telegram account is used, nothing reaches TDLib, and the chats are gone when the app restarts. `tg-history-ipad.mjs` answers for the history of the chat that is open on the iPad.

To make the people and servers again:

1. **Start the servers.** Build the server with `npm run build:server`. Run one `zuna-server` per showcase server, each with its own `--data` and `--public-url`. Basecamp and Szlakiem also need `--livekit-url`, `--livekit-key` and `--livekit-secret` for voice. Write each server's first-run setup link to `$ZUNA_SHOWCASE`, which defaults to `.dev-data/showcase`:
   - `setup-link.txt` for Basecamp.
   - `setup-pixel.txt` and `setup-family.txt` for the other two.
   - `pl/setup-szlak.txt`, `pl/setup-gildia.txt` and `pl/setup-rodzina.txt` for the Polish world.
2. **Run the world scripts from `packages/core`.** For example, `PHONE_PORT=<the simulator's control port> node ../../node_modules/vite-node/dist/cli.mjs ../../appstore/showcase/world.ts`. Each one keeps running, so its people show as online.
   - **English:** `world.ts` builds Basecamp and signs the simulator up as Alex Morgan. `world2.ts` brings Basecamp's people back after a restart and says yes to their new devices, the simulators that join voice as them. `world3.ts` adds Pixel Guild and Family. `world4.ts` brings those two back.
   - **Polish:** `world-pl.ts` and then `world-pl2.ts` do the same for Kuba Lewandowski.
   - **Invite shots:** the Family and Rodzina invites are shown on screen first. The scripts wait for an empty `family-go` or `pl/rodzina-go` file before joining.
