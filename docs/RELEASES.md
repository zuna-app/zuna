# Releasing the native app

How the native app gets from a push to `main` to an Update button in someone's title bar, with nobody deciding a version number or clicking through a release by hand.

Only the native app is released: its Windows installer and its Linux packages, on [GitHub Releases](https://github.com/zuna-app/zuna/releases). macOS isn't built there yet, as that needs a Developer ID and notarizing in CI's secrets. The server, `zuna-web`, the bot and the images aren't on releases yet either (`docs/ROADMAP.md`).

## What happens

- **Claude picks the version.** Every change is read and counted as minor, patch or build.
- **A nightly after every session that pushed.** Built and published as a prerelease, with a changelog of its commits. It's tested on the machine the session ran on, not on CI.
- **A stable release on "release a new stable version".** Published only after CI has run its tests.
- **The app updates itself on Windows.** A channel switch in Settings, stable or nightly. When a newer build is out, an Update button shows beside the window's buttons. Pressing it closes the app, installs the update and starts the app again.

## Versions

A version is `MAJOR.MINOR.PATCH` and a build number.

- **The build number is how many commits `main` has at the commit released** (`git rev-list --count`). `main` is never force-pushed, so it only goes up, needs no file to keep it, and is the same on every machine. The updater compares build numbers and nothing else.
- **The three-part number is what the next stable release will be called.** It lives in the root `package.json`, with every other file that says it kept the same by the release script: each workspace's `package.json`, `package-lock.json`, and the crates' `Cargo.toml` and `Cargo.lock`. iOS's `MARKETING_VERSION` and build number stay the iPhone app's own.
- **A nightly is `0.1.1-nightly.1150`,** tagged `v0.1.1-nightly.1150`. **A stable release is `0.1.0`,** tagged `v0.1.0`, with its build number in its manifest. Both carry it as the fourth part of the exe's Windows version.

What each change counts as:

| Level | What it is | Examples |
|---|---|---|
| minor | Something new a person can see or do in the app | A feature, a new setting, a platform gaining what another had |
| patch | A change to what's already there that someone could notice | A fix, a security or privacy fix, a speed-up, new wording, a dependency update that reaches the app |
| build | Nothing anyone using the app would notice | Refactors, tests, docs, CI, scripts, and anything that isn't in the native app: server, web, iOS, site, bot |
| major | Only on a person's word | 1.0.0 |

The next version is the last stable's, raised once by the highest level among the commits since it, and at least a patch. After `0.11.0`: a refactor gives `0.11.1-nightly.1110`, a fix after it `0.11.1-nightly.1112` (only the build moves), a feature `0.12.0-nightly.1115`, another feature `0.12.0-nightly.1120`. The files remember the highest level so far, so a later nightly of fixes alone doesn't take the number back down. Until the first stable release the number stays `0.1.0`, which becomes that release.

The level comes from reading each commit's diff, not just its subject, and the decision is written down as the changelog: every commit since the last release under **New**, **Fixed and changed** or **Under the hood**. The script works the level out from those headings, so the changelog and the version can't disagree.

A commit's tag says where a change is, not how big it is: a `desktop:` commit can be any of the three levels, and a `core:` one can reach the app or not. What reaches the app is decided by the paths a commit touched: `APP_PATHS` in `scripts/release.mjs` lists what the app is built from. A commit that touches none of it can only go under the hood.

## `scripts/release.mjs`

One script, with no dependency beyond git, Node and, for the keys and the cleanup, `gh`.

| Command | What it does |
|---|---|
| `npm run release:pending` | Lists the commits since the last release of each channel, with the files each touched, and says whether any reach the native app. For a stable release it also says which heading each commit was under in a nightly |
| `npm run release:nightly -- <notes file>` | Cuts a nightly from `origin/main` |
| `npm run release:stable -- <notes file>` | Cuts a stable release. `--major` makes it the next major one |
| `node scripts/release.mjs owed` | For the hook below: fails when pushed app commits have no nightly |
| `node scripts/release.mjs keygen <stable\|nightly> --out <folder> [--spare]` | Makes an update signing key. The private half goes straight into its environment's secret and into a file in the folder, and is never shown. A spare only goes into the file |
| `node scripts/release.mjs plan`, `manifest`, `prune` | What the workflow calls, below |

`--dry-run` after either of the two says what would be released and pushes nothing. `npm run test:release` runs the script's own tests, which `npm test` does too.

The notes file:

```markdown
## New
- 1a2b3c4 desktop: added an update button

## Fixed and changed
- 5d6e7f8 desktop: fixed a crash on quitting

## Under the hood
- 9a8b7c6 docs: said how releases work
```

Cutting a release:

1. Refuses unless this is `main`, with nothing uncommitted or unpushed and `HEAD` at `origin/main`.
2. Refuses unless the notes name every commit since the last release exactly once, by its short hash, under one of the three headings, and nothing that doesn't reach the app is above Under the hood. The last release is the newest stable one for a stable release, and the newest of either kind for a nightly. Only what follows the hash on a line is ignored: the published changelog takes each commit's subject as it stands.
3. Stops, saying so, when no commit touches what the app is built from. A session that only changed the server or the site cuts no nightly, as its build would be the last one again.
4. Works out the version. If the files don't say it yet, sets it in all of them, commits `release: numbered the next release 0.12.0` and pushes. That commit needs no line in any notes.
5. Makes an annotated tag whose message is the changelog, and pushes it. CI takes it from there. A tag is never moved or deleted by hand.

If `main` moved while it ran, it undoes its numbering and says to pull and run it again, as the new commits aren't in the notes.

## The release workflow

`.github/workflows/release.yml` runs for every `v*` tag.

| Job | Runs for | What it does |
|---|---|---|
| `plan` | every tag | Reads the channel, version and build from the tag. Fails unless the tag is annotated, its commit is on `main`, `package.json` agrees with it, and a nightly's number is the commit count |
| `checks` | stable only | `ci.yml`'s `test`, `advisories` and `desktop` jobs. The iPhone's and PostgreSQL's don't hold a desktop release back |
| `windows` | every tag | `npm run dist:windows` on `windows-latest`, with the version, build and channel stamped in. Holds no secret |
| `linux` | every tag | `npm run dist:linux` in a Debian 12 container, so the program runs wherever glibc is that old or newer: a .deb, an .rpm, a pacman package, an AppImage and a .tar.gz. `scripts/linux-build-deps.sh` installs what it needs, with clang 21 from LLVM's own packages, as LiveKit's libwebrtc ships a libc++ that Debian's clang 14 can't read. Holds no secret |
| `publish` | every tag | Runs in the channel's environment. Writes and signs the manifest, then publishes the release: the installer, the Linux packages, `update.json`, `update.json.sig`, `SHA256SUMS`, and the tag's message as the notes. A nightly is marked a prerelease, and only a stable release becomes "latest". Builds nothing |

- **Environments.** `release` for stable and `nightly` for nightlies, each holding only its own key, as `UPDATE_SIGNING_KEY`. Neither has a reviewer, so a stable release waits for nobody's click. `nightly` only runs for `v*-nightly.*` tags and `release` for `v*` tags.
- **Tags.** Three rulesets: only the repository's admins create `v*` tags, nobody moves one, and nobody deletes a stable one. Nightly tags can be deleted, which is how the workflow's cleanup removes them.
- **A nightly that's overtaken is cancelled.** Two sessions ending close together leave one build, the newer.
- **A failed build publishes nothing.** The next nightly carries its commits. A failed stable release is fixed and released under the next patch number, so its tag is never reused.
- **The 30 newest nightlies are kept.** `publish` deletes older nightly releases and their tags. Stable releases stay for good.
- **`ci.yml`'s `desktop` job** is the release build with its installer, then the app's tests and the screen share's in the same profile, and `windows-update-check.mjs`. `gh workflow run ci.yml -f jobs=desktop` runs it by hand, as nothing runs on a push to `main`, and `-f jobs=linux` builds the Linux packages the same way.

On a runner with nothing cached the Windows build takes about 11 minutes and the installer one more, and the Linux build about 10 with its packages. Each Linux package is about 110 MB. Only Cargo's registry and git checkouts are cached, which `ci.yml` saves on `main` and a release only reads: the build's own folder is 3.6 GB, and fetching it would take as long as building. Windows Server has no Opus decoder, so the tests don't decode the fixtures' sound there (`ZUNA_TEST_NO_OPUS`).

## What an update is trusted by

The app carries the public keys its updates must be signed with, as Telegram's does. No certificate is involved.

- **Each release has a manifest,** `update.json`: version, build, channel, tag, commit, and for each system that updates itself the installer's name, size and SHA-256. `update.json.sig` is an Ed25519 signature of its bytes, in base64, made in `publish` with Node's own `crypto`.
- **Two keys, one for each channel.** The stable key is a secret of the `release` environment and the nightly key of `nightly`. Both public halves are compiled into the app (`STABLE_KEYS` and `NIGHTLY_KEYS` in `apps/desktop/src/platform/updates.rs`). `publish` refuses to sign with a key the app at that commit doesn't carry.
- **An app on stable only takes a manifest the stable key signed.** One on nightly takes either. A manifest that says stable and was signed with the nightly key reaches nobody.
- **The app checks, in order:** the signature, with the Ed25519 the crypto core already has, before anything in the manifest is read; that the manifest's channel is the one its key may sign, and one this app follows; that its build is higher than the app's own, so an old release can't be replayed as a downgrade; that the tag and the file's name are what a release's are, as they become part of an address and a path; then the downloaded file's size and SHA-256, and again right before the installer is started. Only then is the update ready.
- **Authenticode stays as a second lock.** If the running app is signed, the update must be signed by the same publisher too. No build is signed yet: a certificate remains on the roadmap, for the SmartScreen warning on a first download. Updates the app downloads itself don't meet SmartScreen.
- **A lost key strands every installed app,** so each private key also has a copy kept offline, and the app carries a spare public key for each channel, whose private half was never on GitHub, to move to if one leaks.

No test or environment variable can swap the keys or the releases' address in a build anyone uses. Only a build made with the `update-check` feature reads them from the environment, which is what the check below installs.

What this doesn't protect against: both maintainers can push a `v*` tag, and the workflow file is read from the tagged commit, so either account alone can sign and ship a release on either channel. A required reviewer on the `release` environment would take a second person for a stable release, and was decided against, to keep releases hands-off.

## The app on Windows

**Finding an update.** At start, every hour, and on Check now, the app asks GitHub for the repository's releases: the latest one on stable, or the newest nightly and the newest stable release on nightly, whichever has the higher build. It fetches that release's manifest and checks it. Without a sign-in GitHub allows 60 such requests an hour for an address, which an hourly check stays far inside. A newer build is downloaded in the background to `updates` in the app's own data, so the button only shows once pressing it is instant.

**The button.** In the title bar, left of minimize: a small filled pill reading "Update", with the version in its tooltip. Pressing it starts the installer with `/S /relaunch` and quits as Quit in the tray does. In a call it first says the call will end. An update that's ready and never pressed is still installed as the app quits, so nobody stays behind.

**The installer.** `apps/desktop/installer/zuna.nsi` installs for one person and needs no administrator, so an update never shows a UAC prompt. `/S` installs quietly, and then waits up to 15 seconds for the app to leave by itself before force-closing it. `/relaunch` starts the app once it's installed. If it couldn't replace the program it starts the old one again, which sees its build didn't change and says so in Settings rather than leaving someone with no app.

**Settings, in About.** The version line reads "Version 0.1.1 nightly 1150 for Windows", or "Version 0.1.0 for Windows" for a stable release. Under it:

- **Updates:** Stable or Nightly. "Nightly gets every change as it's made, and is tested less."
- A status line, "Up to date, checked 12 minutes ago" or "Downloading 0.2.0", with Check now, or Update and restart once one is ready, and What's new, which opens the release's page.

**Channels.** A build starts on the channel it was made for, until the person picks one, kept as `updateChannel` in `settings.json`. Going to nightly checks at once. Going back to stable never installs an older build, as the app's data has already moved on: the app stays where it is until a stable release passes it, and the switch says so.

**Which copies update.** Only an installed release build. A development build or a copy run from elsewhere never does, and About says so. `npm run install:windows` makes a nightly of the checkout, so the copy it installs updates itself from releases once one has a higher build.

**Code.** What's the same on every system, the releases, the manifest's checks, channels and the state the interface reads, is in `apps/desktop/src/platform/updates.rs`. Downloading, the installer and Authenticode are in `platform/windows/updates.rs`. The button is in `title_bar` (`ui/rail.rs`), the settings in `ui/settings/mod.rs`, and the question in a call in `ui/overlays/mod.rs`. `build.rs` and `platform/mod.rs` take `ZUNA_BUILD` and `ZUNA_CHANNEL`, which `appStamp` in `scripts/lib.mjs` gives every release build.

**Linux and macOS** show the same version line and have no updater: on Linux updates come with the system's packages or a new AppImage, and macOS has no release yet.

**Its check.** `node apps/desktop/test/windows-update-check.mjs` builds the app twice with the `update-check` feature, as two builds, installs the older into a folder of its own, and serves releases from this machine signed with keys made for the run. It expects the newer build to be found, downloaded and ready, then pressing Update to quit the app, install the new build and start it. Then that a manifest nobody signed, one the other channel's key signed, a nightly for an app on stable, an older build and a changed file are each refused, that an update nobody pressed is installed as the app quits, and that one that didn't take is said so. Its installers make no shortcuts and write nothing to the registry, and its app keeps its window hidden, so it runs beside an installed Zuna.

## An installed build must always be able to update

That's the one exception to "no backward compatibility until the first stable release". From the first nightly on, these only change in ways the oldest build still installed can follow:

- The manifest: `update.json` and `update.json.sig`, their names, and the fields read from them. An app ignores fields it doesn't know.
- The keys. A new key is compiled into the app first, and only signs once every build that should follow it carries it.
- The installer's flags, `/S` and `/relaunch`, and the installer's name, which the app takes from the manifest.
- Where releases are: the repository's releases on GitHub, and the `releases/latest` and `releases` API calls.

## The rules Claude follows, and the hook

CLAUDE.md has the rules: cut a nightly when a session's work is pushed, what "release a new stable version" means, that Claude picks version numbers, and the levels, under "Releases".

A rule can be forgotten at the end of a long session, so `.claude/settings.json`, checked in, has a Stop hook that runs `node scripts/release.mjs owed --hook`. It keeps Claude from ending its turn while this checkout has pushed app commits with no nightly, once: a turn that's already going on because of the hook ends. It fires at the end of a turn, not of a session, so a long session can cut more than one nightly. The workflow cancels the one overtaken.

## What was set up once

- The `nightly` and `release` environments, with their tag rules, and the three tag rulesets.
- Four keys from `keygen`: the stable and the nightly one, each in its environment's secret and in a file kept offline, and a spare of each, which is only in a file kept offline.
- `gh`, signed in, on each machine Claude releases from, so it can watch a run and read why one failed.

To replace a key: make the new one with `keygen --spare`, add its public half to the app, release, and only once the builds that matter carry it, set it as the environment's secret.

## What hasn't been checked

- **A real update between two published releases,** on an installed copy: the check serves its releases from the machine it runs on. The first build that can update itself is `0.1.0-nightly.1135`.
- **The Linux packages a release carries:** they're built on CI and were never installed or run from there. `linux-check.mjs` and `linux-package-check.mjs` run on a developer's machine, on packages built there.
- **Whether Windows Defender or SmartScreen leaves the unsigned installer alone** when it's downloaded in a browser.
- **The Authenticode lock,** as no build is signed.
- **Two maintainers' sessions cutting a release at the same moment.** The script refuses when `main` moved, and the workflow cancels a nightly that's overtaken, but neither has been seen happening.

## Later, each its own piece of work

- **macOS,** once a Developer ID and notarization are in CI's secrets, with the updater `docs/MACOS_APP_PLAN.md` describes, checked against the same manifest.
- **An update button on Linux** isn't planned: updates there come with the system's packages or a new AppImage. A package repository would be the way.
- **An Authenticode certificate,** for the first download's warning.
- **The server and `zuna-web` back on releases,** when they're ready to be.
