# Releasing the native app: plan

How the native app gets from a push to `main` to an update button in someone's title bar, with nobody deciding a version number or clicking through a release by hand. Only the native app is released. The server, `zuna-web`, the bot and the images aren't on GitHub Releases yet.

This is a plan: nothing below is built. Once it is, a `docs/RELEASES.md` that says how it works takes this file's place.

## What's wanted

- **Claude picks the version.** Every change is read and counted as minor, patch or build.
- **A nightly after every session that pushed.** Built and published to GitHub Releases with a changelog of its commits. Tested on the machine the session ran on, not on CI.
- **A stable release on "release a new stable version".** Published only after CI has run everything.
- **Updates on Windows as Telegram's.** A channel switch in Settings, stable or nightly. When a newer build is out, an Update button shows beside the window's buttons. Pressing it closes the app, installs the update and starts the app again.

## What's there today

| Piece | State |
|---|---|
| `apps/desktop/src/platform/windows/updates.rs` | Asks `api.github.com` for the newest release every six hours, downloads `Zuna-Native-Setup-<version>.exe`, keeps it only if Authenticode says the app's own publisher signed it, and runs it quietly as the app quits. No button, no channel, no relaunch. An unsigned build never updates, and no certificate exists yet, so no build ever has |
| `apps/desktop/installer/zuna.nsi`, `scripts/windows-app.mjs` | A one-click installer for one person, which needs no administrator, so an update never shows a UAC prompt. `/S` installs quietly. It force-closes a running copy and doesn't start the app after a quiet install |
| `.github/workflows/release.yml` | Runs on `v*` tags: all of `ci.yml`, then server binaries, `zuna-web` and both Docker images. No desktop job since Electron went. No tag has ever been pushed, so it has never run |
| `.github/workflows/ci.yml` | Its `desktop` job only runs `cargo check` on Windows, is `continue-on-error`, and has never been seen passing |
| The version | `0.10.0`, in eight `package.json` files and two `Cargo.toml`s. The app takes the root `package.json`'s through `ZUNA_VERSION` |
| The repository | **Private.** `api.github.com/repos/SocketByte/zuna-chat` answers 404 without a sign-in, so no installed app could read its releases today. `SECURITY.md` and `apps/site` already point people at its releases page |
| This machine | Has no `gh`. Git pushes over SSH, so Claude can push a tag, but can't watch a workflow run or read its logs |

## Decisions to make first

These four are yours. Each has a recommendation, and the rest of the plan assumes it.

1. **Where the releases are public.** An app can't download from a private repository. Either `SocketByte/zuna-chat` goes public before the first nightly (recommended, as the site and `SECURITY.md` already assume it, and Actions minutes are free there), or releases go to a public repository that holds nothing else. On a private repository, Windows runners also cost double minutes and build attestations aren't offered.
2. **Whether a stable release keeps the second person's approval.** `release.yml` says its `release` environment has the other maintainer as a required reviewer, so that one stolen account can't ship to everyone. I couldn't check that it's set up so. Keeping it means a stable release waits for one click from them (recommended). Dropping it makes stable as hands-off as nightly.
3. **What "no backward compatibility until the first release" means from here.** Recommended: "the first release" is the first stable one, and nightlies don't count. One thing has to keep working from the first nightly on, though: an installed build must always be able to update to the newest one.
4. **Whether iOS's tests hold back a desktop release.** Today a release waits for every job in `ci.yml`, the iPhone's simulator run included, which takes up to an hour and isn't what's being shipped. Recommended: keep it, since "fully tested" was the ask, and take it out only if it turns out flaky.

## Versions

A version is `MAJOR.MINOR.PATCH` and a build number.

- **The build number is how many commits `main` has at the commit released** (`git rev-list --count`, 1108 today). `main` is never force-pushed, so it only goes up, needs no file to keep it, and is the same on every machine. The updater compares build numbers and nothing else.
- **The three-part number is what the next stable release will be called.** It lives in the root `package.json`, with the other nine files kept the same by the release script. iOS's `MARKETING_VERSION` and build number stay the iPhone app's own.
- **A nightly is `0.11.0-nightly.1108`,** tagged `v0.11.0-nightly.1108`. **A stable is `0.11.0`,** tagged `v0.11.0`, with its build number in its manifest and as the fourth part of the exe's Windows version.

What each change counts as:

| Level | What it is | Examples |
|---|---|---|
| minor | Something new a person can see or do in the app | A feature, a new setting, a platform gaining what another had |
| patch | A change to what's already there that someone could notice | A fix, a security or privacy fix, a speed-up, new wording, a dependency update that reaches the app |
| build | Nothing anyone using the app would notice | Refactors, tests, docs, CI, scripts, and anything that isn't in the native app: server, web, iOS, site, bot |
| major | Only on your word | 1.0.0 |

The next version is the last stable's, raised once by the highest level among the commits since it, and at least a patch. After `0.11.0`: a refactor gives `0.11.1-nightly.1110`, a fix after it `0.11.1-nightly.1112` (only the build moves), a feature `0.12.0-nightly.1115`, another feature `0.12.0-nightly.1120`. Until the first stable release the number stays `0.10.0`, which becomes that release.

Claude reads each commit's diff to decide, not just its subject, and the decision is written down as the changelog: every commit since the last release under **New**, **Fixed and changed** or **Under the hood**. The script works the level out from those headings, so the changelog and the version can't disagree.

## `scripts/release.mjs`

One script, with no dependency beyond git and Node.

| Command | What it does |
|---|---|
| `npm run release:pending` | Lists the commits since the last release of each channel, with the files each touched, and says whether any reach the native app |
| `npm run release:nightly -- <notes file>` | Cuts a nightly from `origin/main` |
| `npm run release:stable -- <notes file>` | Cuts a stable release |
| `node scripts/release.mjs keygen` | Makes an update signing key, once for each channel |
| `node scripts/release.mjs owed` | For the hook below: fails when pushed app commits have no nightly |

Cutting a release:

1. Refuses unless this is `main`, with nothing unpushed and `HEAD` at `origin/main`.
2. Refuses unless the notes name every commit since the last release exactly once, by its short hash, under one of the three headings.
3. Stops, saying so, when no commit touches what the app is built from: `apps/desktop`, `packages/core`, `crypto`, `package-lock.json`, the app's build scripts and `release.yml`. A session that only changed the server or the site cuts no nightly, as its build would be the last one again.
4. Works out the version. If the files don't say it yet, sets it in all ten, commits "Number the next release 0.12.0" and pushes.
5. Makes an annotated tag whose message is the changelog, and pushes it. CI takes it from there. A tag is never moved or deleted by hand.

The version arithmetic has tests of its own (`node --test`), as it's the part nobody will be watching.

## The release workflow

`release.yml` is rewritten around the app. Its server, web and image jobs go, as none of them is released yet. They're in git history, and `docs/ROADMAP.md` gets a line for bringing them back.

| Job | Runs for | What it does |
|---|---|---|
| `plan` | every `v*` tag | Reads the channel, version and build from the tag. Fails unless the tag is annotated, its commit is on `main`, `package.json` agrees with it, and a nightly's number is the commit count |
| `checks` | stable only | All of `ci.yml` |
| `windows` | every tag | `npm run dist:windows` on `windows-latest`, with the version, build and channel stamped in. Holds no secret |
| `publish` | every tag | Runs in the channel's environment. Writes and signs the manifest, then publishes the release: the installer, `update.json`, `update.json.sig`, `SHA256SUMS`, and the tag's message as the notes. A nightly is marked a prerelease, and only a stable becomes "latest". Builds nothing |

- **Environments.** `release` for stable, as now. A new `nightly`, with no reviewer, holding only the nightly key.
- **A nightly that's overtaken is cancelled.** Two sessions ending close together leave one build, the newer.
- **A failed build publishes nothing.** The next nightly carries its commits. A failed stable is fixed and released under the next patch number, so its tag is never reused.
- **The 30 newest nightlies are kept.** `publish` deletes older nightly releases and their tags. Stable releases stay for good.
- **`ci.yml`'s `desktop` job becomes a real one:** the release build and `cargo test`, on Windows, without `continue-on-error`.

How long the Windows build takes on a runner isn't known. It fetches Zed's repository and builds GPUI, LiveKit and QuickJS. Caching Cargo's registry, git checkouts and target folder comes with the first working run, and the timing is measured before nightlies are switched on.

## What an update is trusted by

The updater stops relying on a certificate nobody has, and does what Telegram does: the app carries the public keys its updates must be signed with.

- **Each release has a manifest,** `update.json`: version, build, channel, commit, and for each system the installer's name, size and SHA-256. `update.json.sig` is an Ed25519 signature of its bytes, made in `publish` with Node's own `crypto`.
- **Two keys, one for each channel.** The stable key is a secret of the `release` environment and the nightly key of `nightly`. Both public halves are compiled into the app.
- **An app on stable only takes a manifest the stable key signed.** One on nightly takes either. So whatever cuts nightlies automatically, a session, a token or one account, can't reach anyone who didn't choose nightly.
- **The app checks, in order:** the signature, with the Ed25519 the crypto core already has (`crypto/src/primitives.rs`); that the manifest's channel is the one its key may sign; that its build is higher than the app's own, so an old release can't be replayed as a downgrade; then the downloaded file's size and SHA-256. Only then is the update ready.
- **Authenticode stays as a second lock.** If the running app is signed, the update must be signed by the same publisher too, as today. A certificate remains on the roadmap for the SmartScreen warning on a first download. Updates the app downloads itself don't meet SmartScreen.
- **A lost key strands every installed app,** so each private key also has a copy kept offline, and the app carries a spare public key for each channel, whose private half was never on GitHub, to move to if one leaks.

No test or environment variable can swap the keys in a release build. The update check below uses a build made with the `test-control` feature, which no build anyone uses has.

## The app on Windows

**Finding an update.** At start, every hour, and on Check now, the app asks GitHub for the repository's newest releases, takes the newest one its channel allows, and fetches its manifest. Without a sign-in GitHub allows 60 such requests an hour for an address, which an hourly check stays far inside. A newer build is downloaded in the background to the app's own folder, so the button only shows once pressing it is instant.

**The button.** In `title_bar` (`apps/desktop/src/ui/rail.rs`), left of minimize: a small filled pill reading "Update", with the version in its tooltip. Pressing it starts the installer with `/S /relaunch` and quits as Quit in the tray does. In a call it first says the call will end. An update that's ready and never pressed is still installed as the app quits, as today, so nobody stays behind.

**The installer.** `zuna.nsi` learns `/relaunch`: it waits up to 15 seconds for the app to leave by itself before force-closing it, installs, and starts the app. If it couldn't replace the program it starts the old one again, which sees its build didn't change and says so in Settings rather than leaving someone with no app.

**Settings, in About.** The version line becomes "Version 0.11.1 nightly 1112 for Windows". Under it:

- **Updates:** Stable or Nightly. "Nightly gets every change as it's made, and is tested less."
- A status line, "Up to date, checked 12 minutes ago" or "Downloading 0.12.0", with Check now and a link to what's new, which opens the release's page.

**Channels.** A build starts on the channel it was made for, until the person picks one, kept as `updateChannel` in `settings.json`. Going to nightly checks at once. Going back to stable never installs an older build, as the app's data has already moved on: the app stays where it is until a stable release passes it, and the switch says so.

**Which copies update.** Only an installed release build, as today. A development build or a copy run from elsewhere never does. `npm run install:windows` builds get the keys too, so the copy installed on this machine starts updating itself from releases.

**Code.** What's the same on every system, the feed, the manifest's checks, channels and the state the interface reads, goes in `apps/desktop/src/platform/updates.rs`. Downloading, the installer and Authenticode stay in `platform/windows/updates.rs`. `build.rs` takes `ZUNA_BUILD` and `ZUNA_CHANNEL`.

**Its check.** `apps/desktop/test/windows-update-check.mjs`: installs a build, serves a release with a higher build from this machine signed with a test key, and expects the button, the quit, the new build running, then that a bad signature, a wrong channel's key, a lower build and a changed file are each refused. It installs into the real install folder, so it only runs where no Zuna is installed, which means CI. It joins `ci.yml`'s `desktop` job.

## CLAUDE.md

The rules Claude follows go where it reads them. These are the additions, written as they'd be committed.

In **Working rules**:

> - **Cut a nightly when a session's work is pushed.** Once what was asked for is pushed and its checks have passed here, run `npm run release:pending`, read each commit it lists, write the changelog and run `npm run release:nightly`. It says so itself when nothing in the app changed. Nobody asks for this each time.
> - **"Release a new stable version" means `npm run release:stable`,** after the same reading, the type checks, `npm test` and the app's `cargo test`. Then watch the run with `gh run watch` until the release is published, or say what failed. Fix a failure on `main` and release the next patch. Never move or delete a tag.
> - **Claude picks version numbers, and never asks.** The levels are in "Releases". Only 1.0.0 waits for a person's word.
> - **An installed build must always be able to update to the newest one.** That's the one exception to no backward compatibility: the manifest, the keys, the installer's flags and the release's file names only change in ways the oldest build still installed can follow.

A new section, **Releases**, with the levels table above, the three changelog headings, what counts as reaching the app, and a pointer to `docs/RELEASES.md`.

In **Commands**, the three `release:*` scripts and `windows-update-check.mjs`.

In **What has to change together**:

| When you change | Also change |
|---|---|
| The update manifest, or what's in a release (`publish` in `release.yml`) | `apps/desktop/src/platform/updates.rs`, which reads them, `windows-update-check.mjs`, and "Updates" in `docs/SECURITY_DETAILS.md` |
| An update signing key | The public key in `platform/updates.rs`, the environment's secret and the offline copy, in that order: an app must carry the new key before anything is signed with it |
| What the native app is built from | The list of paths in `scripts/release.mjs`, or a session that only touched the new place cuts no nightly |
| The version's files | `scripts/release.mjs`, which keeps them the same |

"CI only runs on `v*` tags and pull requests" stays true, with "and a nightly's run only builds" added.

**A hook as a backstop.** A rule can be forgotten at the end of a long session, so `.claude/settings.json`, checked in, gets a Stop hook that runs `node scripts/release.mjs owed` and keeps Claude from ending its turn while this checkout has pushed app commits with no nightly. It fires at the end of a turn, not of a session, so a long session can cut more than one nightly. The workflow cancels the one overtaken.

## What you set up once

Claude can't do these, as they're GitHub settings and secrets.

1. Decide 1 to 4 above.
2. Make the repository public, or make the releases one.
3. Run `node scripts/release.mjs keygen` twice. Each run prints a public key, which Claude commits, and a private key, which goes into its environment's secret as `UPDATE_SIGNING_KEY` and onto something offline. Run it twice more for the spares, which only go offline.
4. Make the `nightly` environment, limited to tags, with no reviewer. Check `release` has the reviewer and the tag rule its comment claims.
5. Add a tag ruleset: only maintainers create `v*` tags, and nobody moves or deletes one except the workflow's cleanup.
6. Install `gh` and sign in, on each machine Claude releases from, so it can watch a run and read why one failed.

## Order of work

Each step is pushed and usable before the next.

1. **Versions and the script.** `scripts/release.mjs` with its tests, the build number and channel stamped into the app and shown in About, and CLAUDE.md's rules. Nothing publishes yet: `release:nightly` gets a dry run.
2. **CI builds the app.** `ci.yml`'s `desktop` job building and testing on Windows until it passes, then the new `release.yml`, the keys, and the first nightly published. Build time measured, caching added.
3. **The updater.** The manifest's checks, channels, the download, the button, `/relaunch`, Settings, and `windows-update-check.mjs`. The copy installed here moves from one nightly to the next by its own button.
4. **The first stable release,** end to end, then the hook, and the docs that claim things: `SECURITY.md`, `docs/SECURITY_DETAILS.md`, `docs/WINDOWS_APP.md`, `docs/WEB.md`, `docs/ROADMAP.md`, `README.md`, `docs/SELF_HOSTING.md`, which sends people to a server download that won't be there, `.agents/FEATURE_PARITY.md`, and `apps/site`, whose download button can point at the installer itself. This file becomes `docs/RELEASES.md`.

Later, each its own piece of work:

- **Linux packages on each release,** built in a container old enough for glibc. No update button: updates there come with the system's packages or a new AppImage.
- **macOS,** once a Developer ID and notarization are in CI's secrets, with the updater `docs/MACOS_APP_PLAN.md` describes, checked against the same manifest.
- **An Authenticode certificate,** for the first download's warning.
- **The server and `zuna-web` back on releases,** when they're ready to be.

## What isn't known yet

- Whether the app builds on `windows-latest` at all, and how long it takes. Nothing has built it there.
- Whether Windows Defender leaves an unsigned installer from GitHub alone. It has quarantined this repository's Go test binaries before.
- How the `release` environment is really set up, and what the `xcode-27` runner `ci.yml` names costs.
- Whether two maintainers' sessions ending together ever race on the version commit. The script pulls and retries, as any push here does, but it hasn't been tried.
