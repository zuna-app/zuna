# Watching YouTube together: plan

People in a voice channel or a call put a YouTube video on, and it plays for each of them at the same moment: one pauses, and it pauses for everyone. This page is the design, what was decided, and the order to build it in. "Where it stands" at the end says what's built.

```
someone presses pause in their player
        │
  the player's page (packages/watch) ── says what the person did ──▶ the app
        │                                                             │
        │                                                  the core: a new state, sealed
        │                                                  under the room's key and signed
        │                                                             │
        │                                    chat server: hands it to the others in the room,
        │                                    reads nothing, keeps nothing
        │                                                             │
  every other device's core opens it, checks who signed it ──▶ its app ──▶ its player seeks and pauses

  each player ◀────── video and sound ────── YouTube   (straight from Google, to each device)
```

The video never passes through Zuna. Only "which video, playing or not, where, how fast" does, encrypted as a soundboard's sound is. Each device fetches the video from YouTube itself, which is what makes this the first thing in Zuna that contacts a third party, and why it only happens after a click.

## Decisions

Made on 2026-11-11:

- **YouTube only, through its own embedded player.** YouTube allows nothing else. Reading its streams as yt-dlp does breaks its terms and breaks whenever YouTube changes, so it isn't an option.
- **Everyone in the room controls it:** play, pause, seek, speed, another video, stop. There is no host.
- **Speed is shared. Volume and captions are each person's own.**
- **In voice channels and in calls,** as everything else a voice channel has.
- **A device contacts YouTube only after its person presses Watch,** each time a video is put on in a room. The first time, it also asks, says what Google learns, and remembers the answer in a switch under Privacy.
- **One video at a time in a room.** No queue in the first version.
- **A voice channel has a switch for it,** for admins, as it has for the soundboard. A call always allows it.
- **The native app plays it in the system's web view:** WebView2 on Windows and WKWebView on macOS, inside the stage, and on Linux in a window of its own through WebKitGTK, since nothing can be put inside another program's window under Wayland.

Still to decide while building, with what this plan assumes:

- Whether a new video in a session someone is already watching needs another press of Watch. Assumed: no. The press is for the session, which lasts until someone stops it or the room empties.
- Whether a server needs one switch for all of it, calls included. Assumed: not in the first version.

Decided while building phase 1, on 2026-11-11:

- **The three devices longest in the room answer someone coming in,** 400 ms apart in that order, by when the server says each came in. An answer goes only to the one who asked, so nobody hears another's, and without a limit every device would answer.
- **An ask says what the asker holds,** as after a moment offline, and only a newer state is sent back.
- **A device that's sent a state behind its own is sent its own,** to that device alone and at most once a second, so a device that missed a change catches up the next time it changes something.
- **A state says which device made the change,** which breaks a tie of `rev` and `at`, as the answerer's device can't, and **its video says who put it on,** for the tile.

## What YouTube asks

Checked against YouTube's pages on 2026-11-11: [required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), [player parameters](https://developers.google.com/youtube/player_parameters) and the [IFrame API](https://developers.google.com/youtube/iframe_api_reference).

- **A Referer that says who is embedding.** A browser sends it, unless the page forbids it, which `zuna-web` does today with `Referrer-Policy: no-referrer`. A web view sends none, so an app sets it: `https://` and the app's own ID, in lower case. Without it the player may refuse to play (error 153).
- **The player is at least 200 by 200 pixels,** and nothing is drawn over any part of it.
- **A video starts by itself only while more than half of its player shows.**
- **Nothing about the player changes except through documented parameters.**
- **Errors to show in words:** 100 (gone or private), 101 and 150 (its owner doesn't allow embedding), 5 (can't be played here), 153 (no Referer: a bug of ours).
- YouTube's developer policies also ask an app that embeds its player to say so in its privacy policy and to link to Google's. Read them again when writing the consent's text and the site's page.

What follows from these:

- **YouTube's own controls stay on.** They're how each person picks captions, quality and, on a computer, volume. Zuna reads what the person did with them and tells the room. Hiding them (`controls=0`) would make captions need calls YouTube doesn't document.
- **Zuna's own controls sit under the player,** never on it.
- **A video plays only where its player is on screen.** A device whose stage is hidden pauses its own player and catches up when the stage is back. This is also why there's no mini player in the first version.
- **Not every video plays.** Ones that forbid embedding, age-restricted ones and some music don't, and the tile says which.
- **There are adverts,** as nobody is signed in to YouTube in the player. Someone watching one is behind for a while and catches up after it.

## The shared state

One state per room, held only by the devices in it. The last change wins.

```ts
// packages/core/src/watch.ts
interface WatchState {
  session: string;   // new each time a video is put on where nothing was
  rev: number;       // one more with each change; the higher wins, then the later `at`, then the device ID
  video: { id: string; by: string; title?: string; author?: string; image?: PreviewImage } | null;  // null: stopped; `by` put it on
  playing: boolean;
  position: number;  // ms into the video at `at`
  at: number;        // when that was, in ms, by the server's clock as the sender knew it
  rate: number;      // one of YouTube's: 0.25 to 2 in quarters
  user: string;      // who made the change
  device: string;    // and on which device
}
```

Where the video is now is `position + (now − at) × rate` while it plays, and `position` while it doesn't. Nobody sends the time as it passes: a state is only sent when someone changes something.

A signal is sealed and signed exactly as a played sound is (`playSound` and `onSoundFrame` in `packages/core/src/session/server.ts`): `sealEnvelope` under the room's key for its current epoch, kind `"watch"`, framed with `frameSigned`. It's opened with `checkEnvelope`, only counts from a device the log of keys names, whose user is who the server says sent it, and goes through `parseWatch` in `validate.ts` before anything sees it. A `sent` time and a `nonce` keep one from being played back later, as `PLAY_FRESH_MS` and `playsSeen` do for sounds.

There are two signals:

- `state`: the whole state. Sent on every change. The video's title and picture ride along only when the video changes or someone asks.
- `ask`: sent by a device as it comes into the room, and again when its socket reconnects. Devices that hold a state answer with it, sealed under the current key, each after a wait set by how long it's been in the room, and not at all once it hears someone else's answer. The answer goes only to the one who asked.

An answer is signed by whoever answers, so `user` is their word for who made the last change. It only shows a name ("paused by…"), and everyone in the room can already do everything, so nothing rests on it.

A stopped video stays as a state with no video, so that a late answer can't bring the old one back.

### The video's title and picture

Whoever puts a video on has their device fetch them, as it would for a link's preview (`makeLinkPreview` in `packages/core/src/links.ts`, with a smaller picture), and they travel inside the state. So the tile can say what's on before a device has touched YouTube. On the web that fetch is `zuna-web`'s, as previews are.

The link is read by the core: `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `music.youtube.com`, with `t=` as where to start. Anything else is refused with words.

### The clock

Devices' clocks can be seconds apart, and the people watching hear each other, so they'd notice. Each device measures how far its clock is from the server's:

- The server's `pong` carries its time (`pongFrame` in `server/internal/api/hub.go`, which stops being a constant).
- While a room has a video on, the core pings a few times at once and then once a minute, and keeps the offset from the round trip that was quickest.
- `at` in a state is on the server's clock. The core turns it to the device's own before the app sees it, so no interface deals with offsets.

A server that lies about the time can only put people out of step. It learns nothing by it.

### What the core gives the apps

In a new `// --- Watching together ---` part of `packages/core/src/session/channels.ts`, after Calls:

| Method or event | What it does |
|---|---|
| `getWatch(channelId)` | The room's state, or null |
| `watchStart(channelId, url)` | Reads the link, fetches the title and picture, sends a new state |
| `watchControl(channelId, { playing?, position?, rate? })` | A change by this person |
| `watchStop(channelId)` | Stops it for everyone |
| `{ type: "watch", serverId, channelId, watch }` | The state changed |

Leaving the room forgets the state. `types.ts` gains `WatchView`, and with it `Models.swift` and `models.rs`.

## The server

It hands signals on and keeps nothing, as for sounds (`server/internal/api/sounds.go`).

- `POST /api/channels/{id}/voice/watch` and `POST /api/groups/{id}/call/watch`, both `member`. The body is `{ data, to? }`. The sender's device must be in the room. Being muted or deafened doesn't matter here.
- It goes to the room's other devices as a `watch` frame, or only to `to`.
- At most 64 KB, and a limit of its own for each person, loose enough for someone dragging the seek bar. The apps send at most four seeks a second.
- `channels.watch`, on by default, at the end of `migrations` and `postgresMigrations`. A voice channel with it off refuses with `watch_off`. `ChannelView` gains `watch`.
- A bot is refused (`refuseBot`).

What the server learns: that a device in a room sent a signal, when, and how big. Not which video, nor whether it was a pause or a seek.

## The player

One small package, `packages/watch`, used by every app, so that the fiddly part exists once:

- `watch.html`: a page with nothing but the player's frame. The native apps load it in their web view.
- A controller in TypeScript. The web app imports it. The native apps get it built into `watch.html`.

It makes a frame of `https://www.youtube-nocookie.com/embed/<id>` with `enablejsapi=1`, `origin`, `playsinline=1`, and `referrerpolicy="strict-origin-when-cross-origin"`. It talks to the frame with `postMessage`, the messages YouTube's own script sends. **No script from YouTube ever runs in Zuna's page.** The frame is another origin, and can reach nothing of the app's.

| To the controller | From it |
|---|---|
| `apply({ video, playing, position, age, rate })` | `intent({ playing?, position?, rate? })`: the person did this |
| `setVolume`, `setMuted` | `status({ phase, position, duration, live, error? })` |
| | `volume({ level, muted })`: changed in YouTube's own control |
| | `blocked()`: the browser refused to start it, so the person has to press play once |

### Telling what the person did from what we did

This is where tools like this go wrong: a player that's catching up looks like someone seeking, and sends everyone back.

- A player is **loading**, **catching up** or **in step**. Only one that's in step can speak for its person.
- A pause or a play that the shared state didn't ask for, on a player in step, is the person's.
- A jump of more than about 1.5 s between two readings a quarter of a second apart, on a player in step, is a seek. Standing still isn't: that's buffering or an advert.
- For half a second after the controller itself seeks, plays or pauses, what the player reports is taken as the result of that.
- A change of speed is the person's unless the controller just set it.

### Keeping in step

- Under 0.3 s off: left alone.
- Over that: one seek to where it should be, plus however long this device's last seek took to start playing. No more than one every five seconds.
- Nobody waits for someone who's buffering. They catch up.
- At the end, a player in step says so as a pause at the end. The others say the same, which changes nothing.

The numbers are a start, to be set by what phase 0 measures.

### Volume, captions, speed

- **Captions and quality:** YouTube's own buttons, each person's own, told to nobody.
- **Volume:** a slider and a mute button under the player, kept on the device and set again on each video, since the player remembers nothing between sessions. YouTube's own volume control moves it too. On the iPhone a page can't set a video's volume, so there it's only mute, and the phone's buttons.
- **Deafened:** the video is silent too.
- **Speed:** from YouTube's menu, told to the room.

## Consent and privacy

What Google learns from a device that watches: its IP address, which video, and when. On the web also the address of the web app, from the Referer. In the native apps the Referer is the app's ID, the same for everyone.

- **Until Watch is pressed, a device contacts nobody.** The tile shows the title and picture that came inside the state, who put it on, and a Watch button.
- **The first press asks:** what Google will learn, with links to YouTube's terms and Google's privacy policy, and Watch or Cancel. Watch turns on **Privacy, Play YouTube videos**, which is off until then. Turning it off makes the next press ask again.
- **Putting a video on goes through the same question first,** as the device fetches the title before anyone else sees it.
- **The player keeps nothing:** the privacy-enhanced address, and in the native apps a web view with no stored data, so no cookie outlives a session.
- **In the native apps the web view may open the player and nothing else.** A link pressed inside it opens in the browser. It's refused the camera, the microphone, the location, downloads and new windows. It talks to the app only in the controller's few messages, which are checked as anything from outside is.

This sits beside the decision against GIF search, which was refused because a service would learn each person's address and what they look for. Here the person asks for it each time, knowing. It goes into "Decisions to keep" as the one exception when it's built.

## Each platform

### Web

- `contentSecurityPolicy` in `server/internal/webhost/webhost.go`: `frame-src https://www.youtube-nocookie.com` in place of `'none'`, and its test. Nothing else opens: the picture is a data URL, and no script is added.
- The frame carries `allow="autoplay; fullscreen; encrypted-media; picture-in-picture"` and its own referrer policy, which the page's header doesn't override for it.
- `packages/ui/src/features/voice/Watch.tsx`: the tile, the bar under the player (title, who, volume, another video, stop, stop watching), the dialog for a link, the consent. It's a tile on the stage that takes its middle as a shared screen does (`ScreenTile` in `VoiceStage.tsx`).
- `voice/store.ts`: the state from `watch` events, whether this device is watching, and the calls.
- `features/voice/ChannelDialog.tsx`: the channel's switch. `features/overlays/Settings.tsx`: the Privacy switch.
- Safari may refuse to start a video nobody on that device pressed play on. Then the bar says to press play once.

### iPhone and iPad

- `apps/ios/Zuna/Voice/Watch.swift`: a `WKWebView` with `watch.html` loaded with `baseURL` `https://chat.zuna.mobile`, which sets the Referer. No stored data, inline playback, playing without a tap, picture in picture off.
- A message handler for the controller, and a navigation delegate that lets only the player through.
- `VoiceModel.swift` for the state, `CallScreen.swift` for the tile, `CoreAPI.swift` and `Models.swift` for the core's new methods and types, `ChannelEditor.swift` and `Settings/AccountSettings.swift` for the two switches.
- With the app in the background, or the call down to its bar, the player pauses, and catches up on return.

### The native app on Windows and macOS

- `wry` gives WebView2 and WKWebView behind one interface, made as a child of the app's window from the handle GPUI already gives (`platform/windows/mod.rs`, `platform/macos/mod.rs`). If it fights GPUI's event loop, the fallback is `webview2-com` and `objc2-web-kit` directly.
- `apps/desktop/src/voice/watch/`: the state, the web view and its messages. `ui/voice_stage/watch.rs`: the tile and the bar, drawn by GPUI.
- **The web view draws over everything GPUI draws inside its rectangle,** and can't be clipped or rounded. So its bounds follow the tile's each frame, and it's hidden whenever something of GPUI's has to be on top: a menu, a dialog, and above all the question about a new device, which must be over everything. If GPUI can't say when that is, it's a change to the fork.
- The Referer is `https://chat.zuna.desktop`.
- Windows needs the WebView2 runtime, which Windows 11 has. Where it's missing, the tile says so with a link.
- YouTube's full screen button is off (`fs=0`). The stage's own full screen does it, and the web view follows.
- `ui/settings/preferences.rs` for the Privacy switch, `ui/server_settings` for the channel's, `test_control.rs` for the checks.

### The native app on Linux

- A helper, `zuna-watch`, a crate of the app's workspace as `zuna-screenshare` is: a GTK window holding WebKitGTK through `wry`'s `build_gtk`, which the app starts and talks to in lines of JSON over its pipes.
- The video is in that window. The tile on the stage shows the title and the bar, and says the video is in its own window. Closing the window stops watching on this device.
- WebKitGTK and GStreamer's decoders are the system's. The .deb, .rpm and pacman packages recommend them without requiring them. The AppImage and the .tar.gz use what's there. Where the helper can't start, or the player can't decode, the tile says what to install.
- `scripts/linux-build-deps.sh` gains WebKitGTK's development package, and `scripts/linux-app.mjs` puts the helper in the packages.

### Echo in the native app

The native app cancels echo by comparing the microphone with what the app itself played (`apps/desktop/src/voice/audio.rs`). A web view's sound comes from another process, so with speakers, the room is likely to hear the video again through that person's microphone. The fix is to give the canceller the web view's sound as well: Windows' loopback of one process and macOS's audio taps, both of which the screen share's sound already uses, and on Linux the helper's PipeWire node. It's a phase of its own, and a Known gap until then.

Browsers and the iPhone cancel what the whole device plays, so they shouldn't need it. Phase 0 checks.

## Phases

Each ends pushed, with its checks run, its rows in `.agents/FEATURE_PARITY.md`, and a Known gap for every platform not there yet.

| | What | Done when |
|---|---|---|
| 0 | **Proof of the risky parts,** thrown away after: the frame driven by `postMessage` alone in Chromium, Firefox and WebKit; a `WKWebView` playing during a CallKit call on a real iPhone; a `wry` child view in the GPUI window on macOS and Windows; the helper's window on Linux; echo with speakers on each | Each of "Risks" has an answer, written into this page |
| 1 | **Core and server:** the state, the signals, the clock, the routes, the channel's switch | `packages/core/test/watch.test.ts` passes, in SQLite and PostgreSQL, with the server's tests |
| 2 | **`packages/watch` and the web app** | The web check's new step passes in three browsers, and two people have watched a real video |
| 3 | **iPhone and iPad** | `VoiceTests` has it against a desktop peer, and it's been watched on a phone during a call |
| 4 | **Native app on macOS and Windows** | `mac-voice-check.mjs` has it, and it's been watched on both |
| 5 | **Native app on Linux** | `linux-voice-check.mjs` has it, and `linux-package-check.mjs` finds the helper |
| 6 | **Echo in the native app** | Someone on speakers sends none of the video back, measured |

Phases 3, 4 and 5 don't depend on each other. Phases 1 to 3 and 5 on their own change nothing in the native app that anyone would notice, so the first nightly with something new is phase 4's.

## Checks

- **Core** (`packages/core/test/watch.test.ts`, against a real server): a state reaches only the others in the room; one from outside the room, from an unknown device, signed by the wrong person, or played back, changes nothing; two changes at once end the same on every device; someone coming in gets the state, sealed under a key they hold, after an epoch change too; a stop stays stopped; a channel with the switch off refuses; two devices with clocks set apart agree on where the video is.
- **Server** (Go): the routes' access rules, the limit, the size, `to`, the migration in both databases.
- **Controller** (`packages/watch/test`): against a fake player, a page that speaks the same messages, with buffering, adverts and seeks played out in it. The cases are the ones under "Telling what the person did from what we did".
- **Web, iPhone, native:** each platform's own check, with the fake player in place of YouTube (the web check routes the player's address to it, the native apps take `ZUNA_WATCH_PLAYER`, as they take `ZUNA_FAKE_SCREEN`), so no check depends on YouTube or the network.
- **By hand, once for each platform, against YouTube itself,** written into the parity file: a video that plays, one that forbids embedding, an advert, captions, and two devices side by side to hear how far apart they are.

## What changes with it

| Change | Also change |
|---|---|
| The web's content security policy | `docs/WEB_PLAN.md`, which says nothing third-party loads, and `docs/WEB.md` |
| A device contacting YouTube | `SECURITY.md` and `docs/SECURITY_DETAILS.md`: a section on what Google and the server each learn, and when |
| The same | `apps/site`: the privacy policy, and Features once it's on a platform people can get |
| `packages/watch` | `APP_PATHS` and `IOS_PATHS` in `scripts/release.mjs`, its `versionFiles`, `npm run typecheck`, and the two native apps' copies of `watch.html` |
| `types.ts` | `Models.swift`, `models.rs` |
| The core's new methods | `CoreAPI.swift`, and the native app's `call("…")` strings |
| When it's built | `CLAUDE.md`: the part's marker, a Quick reference row, "Decisions to keep", and `packages/watch` in "What has to change together" |

## Risks

Phase 0 is there to settle these before anything is built on them.

- **`postMessage` without YouTube's script.** The messages are what its script sends, and have been stable for years, but they aren't documented. If they prove flaky, the native apps can load YouTube's script inside their web view's page, where there's nothing of Zuna's to reach. The web app can't, and would be left with a plainer player.
- **Whether the privacy-enhanced address takes the same messages.** If not, `www.youtube.com/embed`, with what that costs in cookies said in the consent.
- **A `WKWebView` playing during a call on an iPhone.** WebKit has changed an app's audio session under it before. If it takes the call's sound or the microphone, the iPhone waits for a fix or only shows what's on.
- **The web view over GPUI:** hiding it in time, keyboard focus going in and not coming back, and WebView2 needing the right kind of thread.
- **Linux's decoders.** YouTube sends VP9 or AV1 with Opus, or H.264 with AAC, and a system may have none of what WebKitGTK needs for them.
- **Adverts and seeks told apart.** The rules above are a design, not a measurement.
- **Live streams.** Where one is has no meaning to share. The first version plays one at its live edge and only shares playing or not.
- **YouTube changing or blocking embedded playback.** Outside anyone's hands here. The tile's errors are in words so people know it isn't Zuna.

## Phase 0: what was found

On 2026-11-11, on macOS 27, with a page of nothing but the frame (`https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1&playsinline=1&origin=…`) served from `localhost` and driven by `postMessage` alone, in Playwright's Chromium and WebKit and in Firefox 159 from Mozilla through WebDriver BiDi:

- **The privacy-enhanced address takes the same messages as `www.youtube.com/embed`,** with no script from YouTube in the page. So the first two of "Risks" are settled for the web, and so for every app.
- The page sends `{"event":"listening","id":1,"channel":"widget"}` every 250 ms once the frame has loaded, until `initialDelivery` and `onReady` come, then `{"event":"command","func":"addEventListener","args":["onStateChange"],…}` for each event it wants. Commands are `{"event":"command","func":…,"args":[…],"id":1,"channel":"widget"}`: `playVideo`, `pauseVideo`, `seekTo` with seconds and `true`, `setPlaybackRate`, `setVolume`, `mute`, `unMute`, `loadVideoById` with `{ videoId, startSeconds }`.
- What comes back: `initialDelivery` with everything (`duration`, `availablePlaybackRates`, `videoData` with the title and `isLive`), then `infoDelivery` with what changed, `currentTime` every 250 to 270 ms while it plays, `playerState`, `playbackRate`, `volume` and `muted` as they change; `onStateChange` (−1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued); and `onVideoProgress` with the time every 250 ms once listened for. A seek reports the new time within one reading, and buffering after it as state 3 in WebKit and Firefox.
- Headless browsers started a video without a press. Whether Safari itself does is for phase 2.

Not yet run: a `WKWebView` during a CallKit call (phase 3), `wry` in GPUI's window (phase 4), the Linux helper (phase 5), and echo with speakers (phase 6).

## Where it stands

- **Phase 1, core and server: built** on 2026-11-11. `packages/core/test/watch.test.ts` and `server/internal/api/watch_test.go` pass in SQLite and PostgreSQL.
- **Phase 2, `packages/watch` and the web app: built** on 2026-11-11. The web check's step passes in Chromium and WebKit with the fake player; Firefox doesn't reach it on this Mac, where the voice step before it waits on a silent microphone. Two accounts watched Big Buck Bunny from YouTube itself, by hand, in headless Chromium and WebKit.

What building phase 2 changed in the design:

- **Nothing is sent to the player while it first loads.** Where to start and whether to play go in its address, and the volume once it's started: a `seekTo` or a volume sent while YouTube's player starts a video by itself can stop it for good, and it says error 5 about twenty seconds later. That happens now and then by itself too, with two players starting on one machine at once, so the controller loads a video again once after error 5.
- **A player that won't play is asked again every two seconds,** not with each reading.
- **A seek adds how far the last one left the player behind the room,** measured once it's settled, rather than how long it took to play: a seek within what's buffered plays at once, and the time the first one took to load overshot by half a second.
- **A player that isn't playing is sent to the room's place first if it's 0.1 s off,** as nobody sees that seek, so a video played again after a pause starts within a frame or two on every device. Playing, the 0.3 s stands.
- **A change of speed is heard in any phase,** as catching up never changes the speed; only a play, a pause or a seek needs the player in step.
- **Phase 3, iPhone and iPad: built** on 2026-11-11. `VoiceTests/testWatchesAVideoTogetherWithEveryoneInTheChannel` passes in the simulator against a peer, with the fake player. The same `watch.html` in a macOS WKWebView under `https://chat.zuna.mobile` played YouTube itself. Not yet watched on an iPhone during a call, which needs someone with one: the risk about WebKit and the call's audio session stands until then.

What building phase 3 changed in the design:

- **Consent and the video's mute are kept apart from the app's other settings** on iOS, which are decoded as one, where a new field would set the rest, App lock among them, back to their defaults.
- **A check's fake player is plain HTTP, which WebKit won't frame in an HTTPS page,** so a development build pointed at one loads the page under `http://chat.zuna.mobile`. A release build can't be pointed anywhere but YouTube.
- **Phase 4, the native app: built on macOS** on 2026-11-11, through `objc2-web-kit` rather than `wry`, as the app already speaks to AppKit through `objc2` and the page wants the same `loadHTMLString:baseURL:` as iOS. `mac-voice-check.mjs` passes with it. Built on Windows the same day, through `webview2-com` (below). Linux isn't built yet.

What building phase 4 changed in the design:

- **GPUI's view on macOS isn't flipped and never takes the keyboard back by itself,** so the player's frame is set from the bottom, and a local monitor of mouse clicks gives the keyboard back to GPUI's view when a click lands outside the player.
- **The app asks the page where its player is each second** (`probe`), which its log says, so that a check can compare it with where the room is by the same clock. The page has no other use for it.
- **The video's title and picture are still fetched from YouTube in that check,** by the owner's core, which nothing in it depends on.
- **Phase 6 on macOS: built** on 2026-11-11. WebKit plays from processes of its own, which macOS holds the app responsible for, so the screen share's Core Audio tap takes them without the app itself (`Wanted::Helpers`), once the video plays and where echo cancelling is on, and the mixer hands what it hears to the echo canceller beside its own mix (`hear_far_end`). The first time, macOS asks whether Zuna may record the computer's sound, whose words now say why. `cargo test` measures it with a simulated room: the video's echo is left at −39 dB with it and −3 dB without. `mac-voice-check.mjs` sees the fake player's tone reach both apps' cancellers. Not yet measured with real speakers and a microphone.
- **Phase 4 on Windows: built** on 2026-11-11, in `platform/windows/watch_view.rs`: WebView2 as a child of GPUI's window, InPrivate, its user data in the app's cache, with the page answered from memory (`AddWebResourceRequestedFilter`) under the same origins as macOS (`page_origin`; whether Chromium would frame the fake's `http://127.0.0.1` in the HTTPS page wasn't tried). Without the WebView2 Runtime, `plays_here()` in `voice/watch.rs` is false, and the tile says where to get it.
- **GPUI's window on Windows doesn't take the keyboard back from WebView2 either,** so a subclass on it gives the keyboard back on any button press while something else has it (`watch_clicks`), and hiding or dropping the player does too.
- **Chromium paints nothing in a window off every screen, and GDI can't capture what it paints,** where the checks keep the app out of the person's way. A development build takes `ZUNA_WEBVIEW2_ARGUMENTS` for WebView2 (`--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` paints it there), and `ZUNA_WATCH_SNAPSHOT`, a PNG path, which the player is written to each second through WebView2's own `CapturePreview`.
- **The stage dropped the video whenever the room's videos changed,** as when someone joined, on every system: `sync_videos` only kept a focus that was a camera or a share. It keeps the video now, as the web's store does.
- **Checked on Windows by hand** with two copies of the app, each its own account, as the web app in Claude's in-app browser couldn't connect to LiveKit: with the fake, putting it on, Watch on the other, both players within 260 ms of each other by the same clock, a pause in either player stopping the other's, with "Paused by" the right name, a seek each way while playing, the channel dialog over the player hiding it and Cancel showing it again, the keyboard going to the player on a click there and back on a click elsewhere, and Stop closing WebView2 and its processes; and YouTube itself playing in step with sound. Not checked: a menu over it, typing into the message box with real keys, a second monitor's scale, and a machine without WebView2.
- **Phase 6 on Windows: not built.** Process loopback hears nothing of WebView2's, though Windows meters its audio service's session playing the fake's tone, and loopback hears Brave from the same code: not with `Wanted::Tree` of the browser process (`BrowserProcessId`), of its audio service, or of the app; not with the audio service in the browser process (`--disable-features=AudioServiceOutOfProcess`) or unsandboxed (`AudioServiceSandbox`); and not without InPrivate. The tap isn't started on Windows, so someone on speakers may send the video back to the room. What's left to try: system loopback of the output device the app plays to, as the far end in place of the mixer's own mix.

- **Phase 5, the native app on Linux: built** on 2026-11-11, in `zuna-watch` (`apps/desktop/watch`), a GTK window holding WebKitGTK 4.1, which the app starts when its person presses Watch (`platform/linux/watch_view.rs`). `linux-voice-check.mjs` passes with it against the web app in Chromium, with the fake player: the window opens titled with what's on and plays within 500 ms of the web app's player, a pause there stops it where it stopped, a play and a seek in the window reach the web app, closing the window stops watching on this device alone, Watch opens it again without asking, and Stop in the web app closes it. `linux-package-check.mjs` finds `zuna-watch` beside the app in the AppImage and the .tar.gz, and it opens its window; the .deb, .rpm and pacman package carry it in `/usr/lib/zuna`. Not yet watched from YouTube itself, as the machine it was built on has no GStreamer demuxers, which `gst-plugins-good` has; the tile said so.

What building phase 5 changed in the design:

- **WebKitGTK's own crate, not `wry`.** `wry` can't load HTML under a base address of our choosing on Linux, which the Referer needs, and `webkit2gtk` gives the rest directly: an ephemeral context, `decide-policy`, `create`, `permission-request`, a script message handler named `zuna`. WebKitGTK 4.1 on GTK 3, rather than 6.0 on GTK 4, as more systems have it: Tauri's apps and GNOME's help need it. Its Rust bindings, gtk-rs 0.18, are GTK 3's last: `cargo audit` passes, warning of `glib::VariantStrIter`'s unsoundness, which the helper never uses, and of `proc-macro-error`, which their macros are built with. The helper is a thin shell around the system's own WebKit, and nothing but the app and the page talks to it.
- **The window is held by `Voice`, not by the stage** (`voice/watch_window.rs`), so it stays open while its person looks at a chat, as a window of its own can. It goes when they stop watching, the room stops the video, or they leave, and its person closing it stops watching on this device. The stage shows the picture, says it's playing in a window of its own, and has the bar, with volume and mute.
- **The helper's lines are wrapped**: what the page posts goes to the app as `{"type":"page","message":…}`, beside the helper's own `decoders`, `closed` and `failed`, so the page can't say it closed the window. Its standard output is kept for the app alone: fd 1 is pointed at standard error before GTK starts, so nothing WebKit or a GPU's overlay prints there reaches the app's reader.
- **YouTube's own full screen button works on Linux**, as the window is the player's own.
- **The helper asks GStreamer whether it can decode what YouTube sends** (`watch/src/decoders.rs`): VP9 or AV1 with Opus in WebM, or H.264 or AV1 with AAC in MP4, and `autoaudiosink`, by the caps WebKit looks for. Without, WebKit tells YouTube it plays nothing, and the player only says the video can't be played, so the tile says instead what to install, by the system's own package names. A missing WebKitGTK is heard from the dynamic loader on the helper's standard error.
- **WebKit's web processes run in bubblewrap** where bubblewrap and `xdg-dbus-proxy` are installed and user namespaces work, which the helper tries first, as WebKitGTK 4.1 doesn't by default.
- **"Show its window" only asks the desktop for it.** Under Wayland a window comes forward only with an activation token from the app in front, and GPUI asks for tokens only for itself and what it opens. So KWin marks the window as wanting attention, and GNOME says it's ready. Giving zuna-watch a token needs a change to GPUI's fork (`gpui_linux`'s `wayland/client.rs`). A Known gap.
- **`zuna-watch` isn't a default member of the app's workspace**, so that `cargo run` stays the app's on every system: `scripts/linux-app.mjs` and the Linux checks build it with `-p zuna-watch`, and the packages carry it beside the app.

Left to build, as of 2026-11-11: phase 6 on Windows (above) and Linux, which "Handing on" below lays out; the native app's stage taking the video to full screen; and on Linux, bringing the window forward with an activation token. Phases 4 and 6 on macOS, phase 4 on Windows and phase 5 on Linux are built: see above. Left to check by hand: an iPhone during a call, YouTube itself in the native app on macOS and Linux, and captions, an advert, a video that forbids embedding and a live stream anywhere.

## Handing on: Windows and Linux

For an agent on that system, which can build and run what this Mac couldn't. Read this page through first, then `CLAUDE.md`. Each ends as the rest did: pushed to `main` with `desktop:` commits, its checks run, `.agents/FEATURE_PARITY.md` (the native app's row and its Known gaps), "Where it stands" above, "Watching together" in `docs/SECURITY_DETAILS.md` and the privacy page in `apps/site` saying which apps contact YouTube, and a nightly.

What's there for both:

- **The state and the calls** are cross-platform, in `apps/desktop/src/voice/watch.rs`: `watch`, `watching`, `watch_start`, `watch_control` (seeks held to four a second), `watch_stop`, `set_watching`, and the `watch` event.
- **The tile, the bar and the player's lifecycle** are in `src/ui/voice_stage/watch.rs`: `keep_player` makes the player for the room's session and lets go of it, `on_player_message` takes what the page says (`ready`, `intent`, `status`, `volume`, `blocked`), `sync_player` tells it what changed, and a task probes it each second, which logs `watch: player <phase> at <ms> ms, <now>`. What only a system with a player has is behind `#[cfg(any(target_os = "macos", windows))]`: the page (`PAGE`, from `assets/core/watch.html`, which `core-bundle/build.mjs` builds on every system), `WatchPlayer.view`, and making it; the echo canceller's tap is macOS's alone. Elsewhere the tile shows the picture and says it plays on macOS and Windows for now, and this device never starts watching (`plays_here()` in `voice/watch.rs`).
- **The players** are `src/platform/macos/watch_view.rs` and `src/platform/windows/watch_view.rs`, each re-exported as `crate::platform::watch_view`. Each system's gives the same: `WatchView::new(window, page, origin, sender) -> Option<WatchView>` with what the page says coming to `sender` as text, `set_frame(x, y, width, height)` in the window's logical points from its top left, `set_hidden(bool)`, `send(json)`, which runs `window.zunaWatch && window.zunaWatch.receive(<json>)`, and `Drop`, which takes it away.
- **The page** (`packages/watch/src/page.ts`) posts to `window.ipc`, `window.webkit.messageHandlers.zuna` or `window.chrome.webview`, whichever is there. Load it under `https://chat.zuna.desktop` (the Referer YouTube needs), or `http://chat.zuna.desktop` when `ZUNA_WATCH_PLAYER` names a fake over plain HTTP (`player_host`, `page_origin`), with `{{player}}` already replaced. Keep no data, let only the page itself load in the main frame and anything in subframes, open what YouTube opens in a new window in the browser, refuse camera, microphone and downloads.
- **Hide it** whenever `crate::ui::something_on_top()` or stream stats say so, as the canvas in `watch_stage` does with `set_hidden(covered)`.
- **The checks' fake player** is `packages/watch/fake/player.html`, served as `text/html` at `/embed/<id>` by any small server, named by `ZUNA_WATCH_PLAYER`. `apps/desktop/test/mac-voice-check.mjs` shows how a check drives it (`watchStart` through the core, `{"watchHere": true}` through the test control, the log's `watch: player` lines compared with `getWatch`).

### Windows

Built on 2026-11-11 but for phase 6, as "Where it stands" says, with what was tried for it. The player is `src/platform/windows/watch_view.rs`; a check drives two copies of the app by their windows' messages, each with `ZUNA_WATCH_PLAYER`, `ZUNA_WEBVIEW2_ARGUMENTS` and `ZUNA_WATCH_SNAPSHOT` set, and reads where each player is from its log, as `mac-voice-check.mjs` does.

### Linux

Built on 2026-11-11, but phase 6: "Where it stands" says what changed. The steps were:

1. **A helper, `zuna-watch`**, a crate in `apps/desktop/watch` and a member of the workspace beside `screenshare`, added to `CRATES` in `scripts/release.mjs`: a GTK window holding WebKitGTK, which can load HTML under a base address (`load_html(page, Some("https://chat.zuna.desktop/"))`), with an ephemeral network session or data manager, `decide-policy` for navigation, `create` opening the link in the browser, `permission-request` denied, and a script message handler named `zuna`, which the page already posts to. `wry`'s `build_gtk` is the plan's choice; WebKitGTK's own crate is the fallback if `wry` can't set the base address.
2. **The app talks to it in lines of JSON over its pipes**: what the app would `send` goes to it and on to the page; what the page posts comes back as it is; and `{"type":"closed"}` when its window is closed, which stops watching on this device (`set_watching(false)`).
3. **`src/platform/linux/watch_view.rs`** starts it, with the API above, where `set_frame` and `set_hidden` do nothing, as it's a window of its own: nothing can be put inside another program's window under Wayland. On Linux the tile shows the picture and the bar, says the video is in its own window, and offers to bring it forward.
4. **Packaging**: `scripts/linux-build-deps.sh` gains WebKitGTK's development package; `scripts/linux-app.mjs` puts the helper beside the app in every package; the .deb, .rpm and pacman package recommend WebKitGTK and GStreamer's decoders (VP9, AV1, Opus, H.264, AAC) without requiring them; the AppImage and the .tar.gz use the system's. Where the helper can't start or the player can't decode, the tile says what to install.
5. **Checks**: a watch step in `apps/desktop/test/linux-voice-check.mjs` with the fake player, against the web app in Chromium as it is now; `linux-package-check.mjs` finds the helper in the AppImage and the .tar.gz; `linux-check.mjs` still passes.
6. **Phase 6 on Linux**: the helper's sound is its own PipeWire stream, which can be fed to the canceller's far end beside the app's own output (`voice/pipewire.rs`, `voice/audio.rs`). Measure with speakers.

## Left out of the first version

- A queue, and searching YouTube from the app, which would need a key and tell Google what people look for.
- Other sites, and a video file of someone's own.
- A mini player while looking at another chat.
- An icon beside someone in the channel list while they watch, which would tell the server who's watching.
- One switch for a whole server.
