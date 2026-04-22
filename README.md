<p align="center">
  <img src=".github/resources/banner_v2.png" alt="Zuna — Privacy. For Everyone." width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License: AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-lightgrey?style=flat-square" alt="Platform" />
  <a href="https://github.com/zuna-app/zuna/actions/workflows/release.yml"><img src="https://github.com/zuna-app/zuna/actions/workflows/release.yml/badge.svg?branch=main"/></a>
</p>

<br/>

**Zuna** is a fully self-hosted, end-to-end encrypted chat and voice service. Run your own server, own your data, and communicate safely with others using a modern and powerful desktop and mobile client apps.

> [!WARNING]
> Zuna is currently in **early alpha**. Core functionality is constantly improving and breaking changes (including full database wipes!) are all but guaranteed. We expect we'll be able to move to a little bit more stable beta releases in a few months. Thank you for your patience and in the meantime - we're happy to accept any contributions that would help speed things up!

---

## Table of Contents

- [Features](#packages)
- [Motivation](#motivation)
- [Core Philosophy](#core-philosophy)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- Fully end-to-end encrypted message, voice and screensharing transport
- Beautiful and modern desktop application
- Mature LiveKit voice/screensharing platform integration
- 7tv integration for animated emotes
- Code mode
- Push notifications
- Encrypted file and photo sharing
- Completely self-hosted

---

## Motivation

Zuna was not conceived as just another platform, but as a response to a growing and tangible need. Across both the European Union and the United States, there has been a noticeable shift toward increased regulation of online speech, often justified through broadly appealing but frequently insincere narratives about protecting children online.

While safeguarding minors is a legitimate concern, many of the proposed measures - such as mandatory age verification systems and sweeping initiatives like so-called “chat control” - introduce serious risks to privacy, security, and the fundamental right to communicate freely. These policies, if implemented as currently envisioned, could undermine encryption, expose sensitive user data, and create precedents for broader surveillance. Zuna emerges in this context as an attempt to preserve a space where individuals can communicate safely, privately, and without undue interference, resisting a trajectory that increasingly conflates safety with control.

Why not rely on existing, mature open-source end-to-end encrypted chat platforms? In many cases, you absolutely can - and for some users, they are an excellent choice. However, for us (and, we suspect, for many others), these solutions fell short in key areas such as simplicity, user experience, and feature design. Too often, they either prioritize technical robustness at the expense of usability or replicate familiar patterns without rethinking them.

---

## Core Philosophy

Zuna is not intended - at least at this stage - to compete directly with established platforms such as Signal or Matrix in terms of protocol maturity, formal verification, or encryption rigor. This is, in part, a deliberate choice rather than a shortcoming. From the outset, our guiding principle has been to strike a careful balance between security and usability.

Many secure communication tools achieve strong guarantees but at the cost of added complexity, friction, or user burden. Zuna takes a different approach: we aim to provide a high baseline of meaningful, practical security while minimizing the need for constant user intervention or technical understanding. Instead of expecting users to actively manage intricate settings or workflows, we focus on delivering essential protections by default, in a way that feels seamless and unobtrusive.

Self-hosting fundamentally changes the threat model, and Zuna is designed to take advantage of that. By allowing users to operate their own infrastructure - or rely on instances they trust - we can reduce the need for certain defensive measures that are essential in large, centralized platforms. In those environments, providers must assume adversarial conditions at scale, often leading to complex safeguards that introduce friction or limit usability.

_Our objective is not to compromise on security, but to make it more accessible - ensuring that users benefit from robust protections without being overwhelmed or discouraged from using them altogether._

---

## Architecture

By default, running a Zuna server is intentionally straightforward: a single Linux instance and a supported database - such as SQLite, MariaDB, or PostgreSQL - are sufficient to get started. This simplicity, however, assumes the use of our cloud gateway relay (gateway.zuna.chat). That component handles certain external integrations, most notably enabling push notifications for iOS devices.

Due to Apple’s platform restrictions, delivering push notifications on iOS requires integration with their proprietary infrastructure. As a result, using Zuna’s iOS application in its standard form depends on our gateway relay. While this introduces a limited external dependency, it allows most users to deploy and operate Zuna with minimal setup complexity.

For those who prefer a fully independent setup, it is possible to replace our gateway relay with your own. This involves configuring a custom relay service, linking it to your own Apple Developer account, and distributing a properly signed version of the iOS application. This approach offers greater control and removes reliance on our infrastructure, but it is significantly more complex and requires enrollment in Apple’s paid developer program.

> [!TIP]
> Zuna is currently in **early alpha**. This means the iOS app or the iOS push notifications are not complete just yet. In the meantime, for just desktop notifications you can easily run your own gateway relay without an Apple developer account.

## Contributing

Contributions are very welcome since Zuna is currently maintained by just two devs. We're doing what we can to provide the best possible open messaging platform that is easy to understand, extend and use, but we can't do it all alone. Please open an issue before submitting a pull request for non-trivial changes so the approach can be discussed first.

---

## License

Zuna is released under the **GNU Affero General Public License v3.0** (AGPL-3.0).

This means you are free to use, modify, and distribute Zuna, but any modified version that is made available over a network must also be distributed under the same license with its source code made available. See the [LICENSE](LICENSE) file for the full text.

> TL;DR — run it, fork it, improve it. Just keep it open.

<br/>

<a href="https://www.buymeacoffee.com/socketbyte" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" style="height: 60px !important;width: 217px !important;" ></a>
