# Watching YouTube together

People in a voice channel or a call put a YouTube video on, and it plays for each of them at the same moment: one pauses, and it pauses for everyone. This page is the design and what was decided. "Watching together" in [SECURITY_DETAILS.md](SECURITY_DETAILS.md) says in short what Google and the server learn.

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
- **The native app plays it in the system's web view:** WebView2 on Windows and WKWebView on macOS, inside the stage, and on Linux WebKitGTK in a window of its own (`zuna-watch`), since nothing can be put inside another program's window under Wayland.
- **The press is for the session,** which lasts until someone stops it or the room empties, so a new video in it needs no other press of Watch. This was assumed while building, not asked.
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
- YouTube's developer policies also ask an app that embeds its player to say so in its privacy policy and to link to Google's.

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

- The server's `pong` carries its time (`pongFrame` in `server/internal/api/hub.go`).
- While a room has a video on, the core pings a few times at once and then once a minute, and keeps the offset from the round trip that was quickest.
- `at` in a state is on the server's clock. The core turns it to the device's own before the app sees it, so no interface deals with offsets.

A server that lies about the time can only put people out of step. It learns nothing by it.

### What the core gives the apps

In the `// --- Watching together ---` part of `packages/core/src/session/channels.ts`, after Calls:

| Method or event | What it does |
|---|---|
| `getWatch(channelId)` | The room's state, or null |
| `watchStart(channelId, url)` | Reads the link, fetches the title and picture, sends a new state |
| `watchControl(channelId, { playing?, position?, rate? })` | A change by this person |
| `watchStop(channelId)` | Stops it for everyone |
| `{ type: "watch", serverId, channelId, watch }` | The state changed |

Leaving the room forgets the state. `WatchView` in `types.ts` is mirrored in `Models.swift` and `models.rs`.

## The server

It hands signals on and keeps nothing, as for sounds (`server/internal/api/sounds.go`).

- `POST /api/channels/{id}/voice/watch` and `POST /api/groups/{id}/call/watch`, both `member`. The body is `{ data, to? }`. The sender's device must be in the room. Being muted or deafened doesn't matter here.
- It goes to the room's other devices as a `watch` frame, or only to `to`.
- At most 64 KB, and a limit of its own for each person, loose enough for someone dragging the seek bar. The apps send at most four seeks a second.
- `channels.watch`, on by default, at the end of `migrations` and `postgresMigrations`. A voice channel with it off refuses with `watch_off`. `ChannelView` has `watch`.
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

### The player's messages

The frame is driven by the messages YouTube's own script sends, which the privacy-enhanced address takes as `www.youtube.com/embed` does. Read on 2026-11-11 in Chromium, WebKit and Firefox, with no script from YouTube in the page:

- The page sends `{"event":"listening","id":1,"channel":"widget"}` every 250 ms once the frame has loaded, until `initialDelivery` and `onReady` come, then `{"event":"command","func":"addEventListener","args":["onStateChange"],…}` for each event it wants. Commands are `{"event":"command","func":…,"args":[…],"id":1,"channel":"widget"}`: `playVideo`, `pauseVideo`, `seekTo` with seconds and `true`, `setPlaybackRate`, `setVolume`, `mute`, `unMute`, `loadVideoById` with `{ videoId, startSeconds }`.
- What comes back: `initialDelivery` with everything (`duration`, `availablePlaybackRates`, `videoData` with the title and `isLive`), then `infoDelivery` with what changed, `currentTime` every 250 to 270 ms while it plays, `playerState`, `playbackRate`, `volume` and `muted` as they change; `onStateChange` (−1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued); and `onVideoProgress` with the time every 250 ms once listened for. A seek reports the new time within one reading, and buffering after it as state 3 in WebKit and Firefox.

### Telling what the person did from what we did

This is where tools like this go wrong: a player that's catching up looks like someone seeking, and sends everyone back.

- A player is **loading**, **catching up** or **in step**. Only one that's in step can speak for its person.
- A pause or a play that the shared state didn't ask for, on a player in step, is the person's.
- A jump of more than about 1.5 s between two readings a quarter of a second apart, on a player in step, is a seek. Standing still isn't: that's buffering or an advert.
- For half a second after the controller itself seeks, plays or pauses, what the player reports is taken as the result of that.
- A change of speed is the person's unless the controller just set it.
- A paused player's jump counts however long ago it last said anything, as YouTube's player says nothing while it's paused. A seek past what's loaded reports buffering at the new place first, so such a jump waits until the player plays or pauses there, for up to 15 s (`seekSettleMs` in `packages/watch/src/sync.ts`).
- A change of speed is heard in any phase, as catching up never changes the speed. Only a play, a pause or a seek needs the player in step.

### Keeping in step

- Playing, under 0.3 s off: left alone. A paused player is sent to the room's place if it's 0.1 s off, as nobody sees that seek, so a video played again after a pause starts within a frame or two on every device.
- Over that: one seek to where it should be, plus how far the last seek left the player behind the room, measured once it settled. No more than one every five seconds.
- Nobody waits for someone who's buffering. They catch up.
- At the end, a player in step says so as a pause at the end. The others say the same, which changes nothing.

- **Nothing is sent to the player while it first loads.** Where to start and whether to play go in its address, and the volume once it's started: a `seekTo` or a volume sent while YouTube's player starts a video by itself can stop it for good, and it says error 5 about twenty seconds later. That happens now and then by itself too, with two players starting on one machine at once, so the controller loads a video again once after error 5.
- A player that won't play is asked again every two seconds, not with each reading.

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

This sits beside the decision against GIF search, which was refused because a service would learn each person's address and what they look for. Here the person asks for it each time, knowing. It's the one exception in `CLAUDE.md`'s "Decisions to keep".

## Each platform

### Web

- `contentSecurityPolicy` in `server/internal/webhost/webhost.go` allows `frame-src https://www.youtube-nocookie.com`. Nothing else opens: the picture is a data URL, and no script is added.
- The frame carries `allow="autoplay; fullscreen; encrypted-media; picture-in-picture"` and its own referrer policy, which the page's header doesn't override for it.
- `packages/ui/src/features/voice/Watch.tsx`: the tile, the bar under the player (title, who, volume, another video, stop, stop watching), the dialog for a link, the consent. It's a tile on the stage that takes its middle as a shared screen does (`ScreenTile` in `VoiceStage.tsx`).
- `voice/store.ts`: the state from `watch` events, whether this device is watching, and the calls.
- `features/voice/ChannelDialog.tsx`: the channel's switch. `features/overlays/Settings.tsx`: the Privacy switch.
- Safari may refuse to start a video nobody on that device pressed play on. Then the bar says to press play once.

### iPhone and iPad

- `apps/ios/Zuna/Voice/Watch.swift`: a `WKWebView` with `watch.html` loaded with `baseURL` `https://chat.zuna.mobile`, which sets the Referer. No stored data, inline playback, playing without a tap, picture in picture off.
- A message handler for the controller, and a navigation delegate that lets only the player through.
- `VoiceModel.swift` for the state, `CallScreen.swift` for the tile, `CoreAPI.swift` and `Models.swift` for the core's methods and types, `ChannelEditor.swift` and `Settings/AccountSettings.swift` for the two switches.
- With the app in the background, or the call down to its bar, the player pauses, and catches up on return.
- Consent and the video's mute are kept apart from the app's other settings, which are decoded as one, where a new field would set the rest, App lock among them, back to their defaults.
- A check's fake player is plain HTTP, which WebKit won't frame in an HTTPS page, so a development build pointed at one loads the page under `http://chat.zuna.mobile`. A release build can't be pointed anywhere but YouTube.

### The native app

- **The state and the calls** are in `apps/desktop/src/voice/watch.rs`, the same on every system: `watch`, `watching`, `watch_start`, `watch_control` (seeks held to four a second), `watch_stop`, `set_watching`, and the `watch` event. `plays_here()` says whether this device can play at all.
- **The tile, the bar and the player's life** are in `src/ui/voice_stage/watch.rs`: `keep_player` makes the player for the room's session and lets go of it, `on_player_message` takes what the page says (`ready`, `intent`, `status`, `volume`, `blocked`), `sync_player` tells it what changed, and a task asks the page where its player is each second (`probe`), which the log says as `watch: player <phase> at <ms> ms, <now>`, so that a check can compare it with where the room is by the same clock.
- **The page** is `packages/watch`'s `watch.html`, which `core-bundle/build.mjs` writes into `assets/core`. It posts to `window.ipc`, `window.webkit.messageHandlers.zuna` or `window.chrome.webview`, whichever is there, and is loaded under `https://chat.zuna.desktop`, the Referer YouTube needs, or `http://chat.zuna.desktop` when `ZUNA_WATCH_PLAYER` names a fake over plain HTTP (`player_host`, `page_origin`). It keeps no data, lets only itself load in the main frame and anything in subframes, opens what YouTube opens in a new window in the browser, and is refused the camera, the microphone and downloads.
- **Each system's player** is `platform::watch_view`, with the same interface: `WatchView::new(window, page, origin, sender)`, with what the page says coming to `sender` as text, `set_frame(x, y, width, height)` in the window's logical points from its top left, `set_hidden(bool)`, `send(json)`, and `Drop`, which takes it away.
- **The web view draws over everything GPUI draws inside its rectangle,** and can't be clipped or rounded. So its bounds follow the tile's each frame, and it's hidden whenever something of GPUI's has to be on top (`crate::ui::something_on_top()`): a menu, a dialog, the stream stats, and above all the question about a new device.

**macOS:** a WKWebView through `objc2-web-kit` (`platform/macos/watch_view.rs`), loaded with `loadHTMLString:baseURL:`, as on iOS. GPUI's view on macOS isn't flipped and never takes the keyboard back by itself, so the player's frame is set from the bottom, and a local monitor of mouse clicks gives the keyboard back to GPUI's view when a click lands outside the player. YouTube's full screen button is off there (`fs=0`), and nothing takes the video to full screen yet.

**Windows:** WebView2 through `webview2-com`, as a child of GPUI's window (`platform/windows/watch_view.rs`), InPrivate, its user data in the app's cache, with the page answered from memory (`AddWebResourceRequestedFilter`). Without the WebView2 Runtime, `plays_here()` is false, and the tile says where to get it.

- GPUI's window doesn't take the keyboard back from WebView2 either, so a subclass on it gives the keyboard back on any button press while something else has it (`watch_clicks`), and hiding or dropping the player does too. Zuna's fork of GPUI draws a window's frames behind its child windows, or the stage's tile would cover the player.
- YouTube's own full screen button works: WebView2 says when the player wants all of the view (`ContainsFullScreenElementChanged`), and the stage makes the window full screen with the view over all of it, until the player leaves it by its button, a double click or Escape (`follow_player_full_screen` in `ui/voice_stage/watch.rs`, `full_screen` in `watch_view.rs`).
- RivaTuner Statistics Server crashes WebView2's browser process now and then as the player seeks. A player whose browser or renderer process dies, or that doesn't start, is made again at once and catches up (`failed`, `note_player_failed`). After three in a minute the device stops watching, and a toast says so, with how to keep RTSS out where it's running (`rtss_running`).
- Chromium paints nothing in a window off every screen, where the checks keep the app, so a development build takes `ZUNA_WEBVIEW2_ARGUMENTS` for WebView2 (`--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` paints it there) and `ZUNA_WATCH_SNAPSHOT`, a PNG path the player is written to each second through WebView2's `CapturePreview`. That's WebView2's own picture, not the window as it's composed, which `PrintWindow` with `PW_RENDERFULLCONTENT` shows.

**Linux:** `zuna-watch` (`apps/desktop/watch`), a GTK 4 window holding WebKitGTK 6.0 through the `webkit6` crate, which the app starts when its person presses Watch (`platform/linux/watch_view.rs`) and talks to in lines of JSON over its pipes.

- The window is held by `Voice` (`voice/watch_window.rs`), so it stays open while its person looks at a chat. It goes when they stop watching, the room stops the video, or they leave, and closing it stops watching on this device. The stage shows the picture, says it plays in a window of its own, and has the bar. YouTube's own full screen button works there.
- What the page posts reaches the app wrapped as `{"type":"page","message":…}`, beside the helper's own `decoders`, `closed` and `failed`, so the page can't say it closed the window. Its standard output is the app's alone: fd 1 points at standard error before GTK starts.
- It asks GStreamer whether it can decode what YouTube sends (`watch/src/decoders.rs`). Without, the tile says what to install, by the system's own package names. The .deb, .rpm and pacman package require WebKitGTK 6.0 and GStreamer's good plugins; the AppImage and the .tar.gz use what's there.
- WebKit's web processes run in bubblewrap where it, `xdg-dbus-proxy` and user namespaces are there, and without it elsewhere (`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`), where nothing would play otherwise.
- What its web processes play is neither remembered nor given a volume by WirePlumber (`state.restore-props = false`), or a video watched quietly would set everything the app plays to that volume.
- Not `wry`, which can't load HTML under a base address of our choosing on Linux, which the Referer needs. Not WebKitGTK 4.1 on GTK 3, whose bindings pulled in an unsound `glib`. `webkit6` 0.5, not 0.6, which needs GTK 4.10, where Debian 12, which the packages are built in, has 4.8.
- "Show its window" only asks the desktop for it: under Wayland a window comes forward only with an activation token, and GPUI asks for tokens only for itself.

### Echo in the native app

The native app cancels echo by comparing the microphone with what the app itself played (`apps/desktop/src/voice/audio.rs`). A web view's sound comes from other processes, so with speakers the room would hear the video again through that person's microphone. So the screen share's capture of the computer's sound takes what plays under the app but the app itself (`Wanted::Helpers`), from once the video plays and where echo cancelling is on, and the mixer hands it to the echo canceller beside its own mix (`hear_far_end`):

- **macOS:** WebKit's processes, which macOS holds the app responsible for, through a Core Audio tap. The first time, macOS asks whether Zuna may record the computer's sound. `cargo test` measures it with a simulated room: the video's echo is left at −39 dB with it and −3 dB without.
- **Linux:** what `zuna-watch`'s web processes play through PipeWire, found by the sandbox's instance, which names the process that started it (`sandboxed_by` in `screenshare/src/sound/linux.rs`). With the window's sound played straight into the microphone, the other side heard it about 66 dB quieter.
- **Windows: not built.** Process loopback hears nothing of WebView2's, however it's asked, so someone on speakers may send the video back to the room. What's left to try: the system's loopback of the output device the app plays to.

Neither has been measured with real speakers and a microphone. Browsers and the iPhone cancel what the whole device plays.

## Checks

- **Core** (`packages/core/test/watch.test.ts`, against a real server): a state reaches only the others in the room; one from outside the room, from an unknown device, signed by the wrong person, or played back, changes nothing; two changes at once end the same on every device; someone coming in gets the state, sealed under a key they hold, after an epoch change too; a stop stays stopped; a channel with the switch off refuses; two devices with clocks set apart agree on where the video is.
- **Server** (Go): the routes' access rules, the limit, the size, `to`, the migration in both databases.
- **Controller** (`packages/watch/test`): against a fake player, a page that speaks the same messages, with buffering, adverts and seeks played out in it. The cases are the ones under "Telling what the person did from what we did".
- **Web, iPhone, native:** each platform's own check, with the fake player in place of YouTube (the web check routes the player's address to it, the native apps take `ZUNA_WATCH_PLAYER`, as they take `ZUNA_FAKE_SCREEN`), so no check depends on YouTube or the network.
- **By hand, once for each platform, against YouTube itself,** written into the parity file: a video that plays, one that forbids embedding, an advert, captions, and two devices side by side to hear how far apart they are.

## Not checked

- A WKWebView playing during a CallKit call on a real iPhone, which might take the call's audio session.
- YouTube itself in the native app on macOS, and anywhere: captions, an advert, a video that forbids embedding, and a live stream.

## Risks

- **The player's messages aren't documented,** though they've been stable for years. If they change, the native apps can load YouTube's script inside their web view's page, where there's nothing of Zuna's to reach. The web app can't.
- **Live streams.** Where one is has no meaning to share, so one plays at its live edge, and only playing or not is shared.
- **YouTube changing or blocking embedded playback** is outside anyone's hands here. The tile's errors are in words, so people know it isn't Zuna.

## Left out of the first version

- A queue, and searching YouTube from the app, which would need a key and tell Google what people look for.
- Other sites, and a video file of someone's own.
- A mini player while looking at another chat.
- An icon beside someone in the channel list while they watch, which would tell the server who's watching.
- One switch for a whole server.
