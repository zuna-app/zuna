//! Updates, the part that's the same on every system: finding a release, what its manifest has
//! to pass before it's trusted, the channels, and the state the interface reads
//! (docs/RELEASES.md). Downloading, the installer and Authenticode are Windows's own, in
//! `windows/updates.rs`. Linux and macOS don't update themselves yet.
//!
//! A release carries `update.json`, its manifest, `update.json.sig`, an Ed25519 signature of
//! the manifest's bytes, and `update.json.sig2`, an ML-DSA-65 one (FIPS 204), which a quantum
//! computer doesn't forge as it would Ed25519 (docs/POST_QUANTUM.md). Builds from before the
//! second check the first alone, as they always did, so every installed build still updates.
//! The app carries the public keys, two pairs for each channel. It checks, in order: both
//! signatures, by keys of the same channel; that the manifest's channel is the one its key may sign,
//! and one this app follows; that its build is higher than the app's own, so an old release
//! can't be replayed as a downgrade; then the downloaded file's size and SHA-256. Only then is
//! the update ready. No environment variable or file can swap the keys or the address in a
//! build anyone uses: only one made with the `update-check` feature reads them, for
//! `test/windows-update-check.mjs`.

#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
use super::linux::updates as system;
#[cfg(target_os = "macos")]
use super::macos::updates as system;
#[cfg(windows)]
use super::windows::updates as system;

pub use system::installed;

/// The keys a stable release's manifest is signed with, as an Ed25519 public key's 32 bytes in
/// base64. The first is the `release` environment's `UPDATE_SIGNING_KEY`. The second is a
/// spare, whose private half was never on GitHub, to move to if the first leaks: an app must
/// carry a key before anything is signed with it. scripts/release.mjs reads these, and
/// refuses to sign with a key that isn't here.
pub const STABLE_KEYS: &[&str] = &["GUNhiJO8B8ejuIUnMRQB0Tuw+aNcpndXUKl9nsJvGp0=", "4Sc1YfROnpXo35khRj8S45yO/13R3xiV9rFfpFnViUU="];

/// The keys a nightly's manifest is signed with: the `nightly` environment's, and its spare.
/// An app on stable takes nothing these signed.
pub const NIGHTLY_KEYS: &[&str] = &["C7wqzUsCH0J4j7FNPsvmPSsAvQNUsJ5GpIR4QESqYCA=", "dyNEr4EXnQ3UBcaYsGU4BUFvgQhR9awXphizE5nVNDQ="];

/// The ML-DSA-65 keys a stable release's `update.json.sig2` is signed with, each FIPS 204's
/// 1,952 bytes in base64: the `release` environment's `UPDATE_SIGNING_KEY_PQ`, and a spare whose
/// private half was never on GitHub.
pub const STABLE_PQ_KEYS: &[&str] = &[
    "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",
];

/// The ML-DSA-65 keys a nightly's `update.json.sig2` is signed with: the `nightly` environment's, and its spare.
pub const NIGHTLY_PQ_KEYS: &[&str] = &[
    "m/qiyN2KwjrpgGXvHxJaXqfg48Df4kHjwYW68Wy62FaCgPhceD/PfVJa+Xv5s0TZS4jlLdDTxO9OL6qQbPGFhjrCEY7pSxeoQBnH9hqvlln+CIB5tr4X6TnQlyWLMCSlfEEbq9mgUX/E+kRlYrhZMNGA+P75J6D/dvGrMcudP/9MIjRhHrb8NLsIUH0OO9XfTmSXT6+WZLFfhWkMW0lhH9wIRtHmbtn6hZdzHpQP4g7baCqlJBk36k+Da50dhwbR8lQ1mX3O9ECXXJNgWF64EEAWWqDwQYTSM9k3Bd84w9eYN0BajMnRv7D7gYgfdMtStav0yrzOpa8XZBDD7As5x/NPD8ST7K02wLHrjvclXF1fs/6YBUHjhcEZ8m8SDq07iu0oWWgGXVl/VJTTsBXp9ELHwAWZwcbMJFGjjKl8hRrev6erWUf153wQmsx4JWBXMksx+fARPrFcUYdO7NcIO4T4ovVcLfYKHr40pV5r/G4VwHH+rPM+jkPd3ovJGYLFC4+lo8bWXaJSTPL1J+b3+65W2rxFy7f0bK4k3OHQOQW1qYIX+mqu3c1qEItRwmeNaNgY/D36Q3/PYW3I7WcmcUgIvp7AwIGljM33VxPwp+ksU+LJoQv5bLGrblv5bQFLEocNMVFcAxxd9gcCuts+9Pa15Su8N+kTHgIDerr5H2AV7vKhNxaQb6pr+7OooTPmD4AKPgunN2EYEYRraLUjgoDguGH+LxMtM+FVCujJ7ba+oy0PEStZqKm0MOFJXdOOn5+6xYqXCgMG4T11pgT3dc7CWhICCu8JlvYLFPZCjGpyHCctWN3xndQ5iMB2VLb1zSiWqeqBW3PCLp9q8gSOYCIVqUAOna681xBcLVpTRDZOTxcEgXKnMm8tGcsrGqS6gKHurk4O7/V6gr/3i9LTR6GaIYm1jiUs3pMOL4E1K5M6rw5XoKOyqthAG8HqvCJz6p1Sc8IjeAKLta/tpSDEYzZpYLlKdtBVWO9ru56t2m0HtIoNXcovPdYDfiEUsY6PkxFbZcVSQWM2PD5SR2rvrcAAk9alKQZxwB+Gn+GNxEIRT6aE1YLItbaYya/ZbOQ7iWORvUx1S+WjowsJbAHxtWsETB3+RrevJZyrxo4rQkz0jAHJt82KiX4Q6aWiMLlVgVF/l1wckcU1Ouc5e4wk3yxPSwWyV3wW5KjOROm0P3w3GnvTlxj5QBe/TqrbN1Gl36iqmvL5YX1oc6o6Z89ZulsmGy5waCIaEfJ+Pp28XRyy/Kemo9auHkssT0vWSWkhoxGVJPBI9vXSTVt/Lpd0NZcVDqldHkSDdazURYRHPXH9DfRhBf6FgipNL0CeG/cqr1pzqQcYqjZpPinq+D+0YYyXvP0O/rcTrG7xrhazbiK+2aonSPhwODyetcifTAMEOQsc8Oe1gqiBFlLfF5/687F6CH4GxHX10CefFencgZtGnKd1i2xwR7zgEeeT0AJbnoKtH1Nt7HSoBNDbFNPsZ5RcnOeekOLjwjiapVxUHSKtSCSL/+zeTrqN4+TEydGywBttHfThqD/OHqGn3uugkuuFWNMTMwA5P1zDgVIGDCwVsZhFw9PqRTWq5Hv9BnYvhX8QkQB/JRdMatMVRsPOJbHZ/i/xO493xgk9apuQJsFxh1iCtFtKKApzLu6I5O7Kme5O8oxhF8hBTVa9+HZmMs4XIugUwt7TEZN3rF6L2A7wDyuiXJo/Gq3rKKbMXPK9oe/b7lkBb+BYhXGv75vNcXWFkMxk/V7jwwioU/PYstKrr/7ZksBcg84SK7lgFDTmsIXRkDb5H+f7w0tbyaNTwQ3pMVJuz0g5KLkiZhv5/8HDoFi3xYUqItAsaXOwdRaV6TyNULNCO/FrB/zEkjnz7NikMWvgTms8mhXCvtRf6xV305gOlczUGKhzi1siPZ2uvLJo0sD4OSlgDfJPk63JxrVybaKFw+Xf8JftmD1zqDVxgddSZqd+E8N3b/yxz9pFPPA1JyDw0HKxYJhXIgTeV38ubEtYpfRHJYUsdi9lF5j7TFJKzF0/1S6A19S1RIhcHMlh4yUaiJMUSQY5h/e6Op8WQI4JUXuvkDIhU7c5c9qNgOHMpATgqtYXykBVpTalYUE4grhGKJJeGco3LmOd7gYNLPO3b4wjE6E4AswWr1cPnrEfZn67CmbmDryigZZkP7DczJPG+YqLbSJo+tzHBsq+pRS0OvYQ7YB40Geiybe/WXHR8vNegnkzFYASZXNiXo4dacAoc7AtCjjmBPAH5DZHDWc5ZgaZj9VmiUoZXLiJ6XvmyZ2Aw1IdAUHsST/3hn2ydXorjjdi2A63jB2ELDm1uMOUVCDzYEib/ums42KBRm6HLAVwnP56qNJ//nnsJbOnEg+Z1lx9h49046uRkiJEr6irbp8AC9bQnhBUXs0mB+BVaMKT7sTfY9tlP1gQ8oWL7DoOd1Edab9UjayRO6ZSHwg4RvRJbenFC4nokjtgpWs4fnwh6jWYDTG0NA8fTJhmr5JHpTBdgjjl1dIlKmTgTnl/PD0PsKD2yiQ4rpXCC4zmh+Vtri+IJofcuKg/sj5/+JbjnXjT7PJE6QJnrPXEL4DHoskple+CJ8MDOgw=",
    "AQtKXkfgDiCPirO5slgJqfJNpjVyuI9N/Y4uKQTkUyhwtzhDO91gO+81SY18vtqko9gJsv3WOxW2n8PcRzN9qa5xyLr6qtSoHvt55c85Pb0bmqxhtaGf+rf5mlXekMLSleLOYHPk9HfDrp0zkgAusIX5ilAht0Gpt7/0Ur9JWZ9f4K4NV/APPND7Lh/JnIhjYHPUIv+RzzWIkbNjzPQEfPNkl2EGUff/RZ7bgOdVr1jx2cJjj+brp6hnejgb8neiMN4ky3uuxUNomrXLj8KOjaXov4dl16YiGZh/RnSAp9DMBvnE6sIK0+bOfziljiLRU300Ux3ZUHZSxUzEl8uSMNY+77Djh3ixiBenJcyl+mtCo7BjXCeoTiivtvfD6qRkmjSrjCyzo5ObVvPJO/jMLTTptIp+Fip5RzM9TCbl/2fwNWLRcKNrmnP5qQ2RfHcpMiJ1J0yo24E9QbLO98qXI26GboUwocLBWg5W5hNtc38j4p8Pgx6DAOq0RxFgZeKoSFzOape8eLQPcyRQIHN8C+0nsI6F2Q6jcyIabCelD9F6EtwLTxMn0ban2kipGq7A5b0aPy2wMbd5gTKQqx5wySwXZcV21ZH/V8NorwBNJJU914bWk88EWMSXN4EGyXUIXLgxm6hSuvC0I1SkmCOe+3v4xVeVp5tkCHLOYjdgG5/jpXOeNF2ANPPgLJr0bVFMPFbKZNEc5GJjfa1ChH2IzIvobHe6mzcDd7pxEpAppi5b5yCCK9Nc83t/hxbqKXHpLF54DwNOuccBbhq5L+IO8ers0gjoE4wuHsbkx92zl6S5YZ8zmFnfCW8UeVCm4FPbJMNtEQxe9JZrgJYOkof+CZH+O2vVe3LvPyQo3aOJL6CCoMD6rl9Lb+tpCPw/8hEplJwF6T9JCHUjCZGPsANT9MJh5tfY1EI/3iLEgGvQaTQQScGyJqYDJ3izsFUiAx5+wKOvj4QDloPZFF/qzjyATRPD9Yq+5EGfAfN9Zscqgm93CqbPDC0vZvQDMaZ3EnzJ8Q+C5VbyQITOuYTMmh/WUJXJMH75Tg3VHFnalwKQktZmSqkKJLIMGPT3NC4Cjt0gHDMX7tKW7XmtmZeK2/sZAmQYIda4PAmVO+oXzbLIOu3a6bdjGPK09i3mI3tXSliFu6botzVk2/1+PD3l3ntKj2Nixva9q91fpiNQv/bOJ9GU91DUFGHSREn8t2zlmMU3NjVvs9cEjYvDX53z6QOgzVbJfE1ol0K3tmgPbGImeJYu6YRXssKOedFMIYCRIxukMGqQoqBDLGgjssTunAIUpt2VeAOu+bpGEOZhYRj1UDeYX7I4SsW+DM7XTCHL7yKXIwz94foAZv6WDD7yW0/UjmD0vTM36xP50tirmWDv5sv9MJGGEANJqMgxSQV9TyyDS+L9CW70Ap8cdMGGC8VJWnkad49O7MdUEClKTVLsCB/pNKm4SSvqDcdpohbZ1gjNioaNpMPd731cfDP0KmHh98BtNuB44ZAYHoA+sKhstUqrpo/FTSTOUz5BWFS0/KYNsJZy1inWpjYl12tnFdqiXFSt3tHh5u2wZU/frpxxQfmydPHCEySPHZ6MwCcmykbBP+XLXv89xky+dsa6ulJOABIUrislr4ipLyojeA9gZhvvLHoRl6fb7ubuGIoAgkdH4sBTObK5t2+ikQYzXhGwR+e7VUb8+2a6DkSwqxvayVafcFoAVJ5nheD2SBjwYE2V/wtTux+ju+cRkjBjLhlN9K6tX9bRzsj70k/JuwywUN5P/HGN6+ywQ9QafnYLf568+xv/JPJEJBurRwUbGc1xxf8TF1GgMJ2EzrtWLFYqtxs0kaNvjDABURvn36x0lA/Nuz3LChX/5vNSEc421CBh5cAU38l7kpAjV0/k1ep2YCevybHt9PPInRqkncX7s5vYFeV+vDgdCO3tz7tFrIbVnDFhxSx/yc+IRh862TT+NH+0nQazbo/UOJ1ICWi8X4+HEleBSyIaqQtt01Ub7BuqbCSq1bs5OxkLV8gYWG0YSPYzuYu2kOgSi8TqrBVIZmZM0kooGcBA3fA/IrwaEyzclckFWwVjOwF/MI/T8psFGczlgJP1gPlQJz8n7yBP4AN5AwMSxz+KxQgj0iXWiViSjcdzWeMnYP/WiFE72yVZQynyrT4gb5HxPSQKO+g2Fm8rQDw0akTdF1Y9mOtShLlqaG737LvyTKko0hveKdlOjCbUfC5c1hUrc5SInwBjgSKV+N8kr4TO7zkuOWO6HfRzgIOGEmEFhsT7frQP/mnAF4ScAUNRmnxr1PmzFK9TpYg7oiz2PBZOMpkBLfKuml7UE9VSSMfFeDDrWH5Fp1onau7PIMB6UYTUrHV5GXy5ezGdbBJteE0Q1N7NZTU8xy5Khw7V38LmbfMLBPaH3nz3h/PQa4BJsCp5sF980YZa17F58NHtMZEx2VoxS0RImmJ5LzWQEg3Cdvyh5/WjZ5pIjtNr0yjWbd8hFzEYmwXO3y0j4SfHbAOL/ElQPWmtqpQejhAlFg18p7ImQZMOPdT35Go6DZHw3n/j5HRoVwegc/hDt3J0iUzolcDoimfSewZ150N9KKd4psJ45UbwukgEFvo=",
];

/// Where releases are listed, and where their files are.
const API: &str = "https://api.github.com/repos/zuna-app/zuna";
const DOWNLOADS: &str = "https://github.com/zuna-app/zuna/releases/download";
const PAGES: &str = "https://github.com/zuna-app/zuna/releases/tag";

/// The installer this system takes, as the manifest names systems.
#[cfg(windows)]
const SYSTEM: &str = "windows-x86_64";
#[cfg(target_os = "linux")]
const SYSTEM: &str = "linux-x86_64";
#[cfg(target_os = "macos")]
const SYSTEM: &str = "macos-aarch64";

/// Which releases an app takes: stable ones only, or every nightly too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Nightly,
}

impl Channel {
    pub fn parse(name: &str) -> Option<Channel> {
        match name {
            "stable" => Some(Channel::Stable),
            "nightly" => Some(Channel::Nightly),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Nightly => "nightly",
        }
    }

    /// The channel this build was made for, which it follows until the person picks one.
    pub fn of_build() -> Channel {
        Channel::parse(super::CHANNEL).unwrap_or(Channel::Nightly)
    }

    /// The one the person picked (`updateChannel` in settings.json), or the build's own.
    pub fn followed(setting: Option<&str>) -> Channel {
        setting.and_then(Channel::parse).unwrap_or_else(Channel::of_build)
    }
}

/// An update that passed its manifest's checks.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Update {
    pub version: String,
    pub build: u32,
    pub channel: Channel,
    pub tag: String,
    /// The installer's name, size and SHA-256, in hex.
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

impl Update {
    /// As a person reads it: `0.12.0`, or `0.12.0 nightly 1120`.
    pub fn label(&self) -> String {
        super::version_name(&self.version, self.channel.name(), self.build)
    }

    /// The release's page, with what's new in it.
    pub fn page(&self) -> String {
        format!("{PAGES}/{}", self.tag)
    }
}

/// The page of the release this build is, if it's one.
pub fn own_page() -> Option<String> {
    let tag = match Channel::of_build() {
        Channel::Stable => format!("v{}", super::VERSION),
        Channel::Nightly => format!("v{}-nightly.{}", super::VERSION, super::BUILD),
    };
    (super::BUILD > 0).then(|| format!("{PAGES}/{tag}"))
}

/// Why a release wasn't taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// None of the app's keys signed the manifest.
    Signature,
    /// The key that signed it is the other channel's.
    WrongKey,
    /// It's a nightly, and this app follows stable releases.
    Channel,
    /// Its build isn't higher than this app's.
    Old,
    /// The manifest can't be read, or names something it shouldn't.
    Malformed,
    /// It has no installer for this system.
    NoFile,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Refused::Signature => "its manifest isn't signed with one of Zuna's keys",
            Refused::WrongKey => "its manifest is signed with the other channel's key",
            Refused::Channel => "it's a nightly, and this app follows stable releases",
            Refused::Old => "it isn't newer than this app",
            Refused::Malformed => "its manifest can't be read",
            Refused::NoFile => "it has no installer for this system",
        })
    }
}

/// One channel's public keys: Ed25519's, which sign `update.json.sig`, and ML-DSA-65's,
/// which sign `update.json.sig2`.
struct ChannelKeys {
    ed25519: Vec<Vec<u8>>,
    ml_dsa: Vec<Vec<u8>>,
}

impl ChannelKeys {
    fn new(ed25519: &[&str], ml_dsa: &[&str]) -> ChannelKeys {
        let decode = |keys: &[&str], len: usize| keys.iter().filter_map(|key| base64::engine::general_purpose::STANDARD.decode(key.trim()).ok()).filter(|key| key.len() == len).collect();
        ChannelKeys { ed25519: decode(ed25519, 32), ml_dsa: decode(ml_dsa, 1952) }
    }

    /// Whether a key of each kind of this channel signed these bytes: both have to have.
    fn signed(&self, bytes: &[u8], ed25519: &[u8], ml_dsa: &[u8]) -> bool {
        self.ed25519.iter().any(|key| zuna_crypto::primitives::ed25519_verify(key, bytes, ed25519))
            && self.ml_dsa.iter().any(|key| zuna_crypto::hybrid::ml_dsa65_verify(key, bytes, ml_dsa))
    }
}

/// The public keys manifests are checked against.
pub struct Keys {
    stable: ChannelKeys,
    nightly: ChannelKeys,
}

impl Keys {
    pub fn new(stable: &[&str], nightly: &[&str], stable_pq: &[&str], nightly_pq: &[&str]) -> Keys {
        Keys { stable: ChannelKeys::new(stable, stable_pq), nightly: ChannelKeys::new(nightly, nightly_pq) }
    }

    /// The keys this build trusts: the ones compiled into it, always, in a build anyone uses.
    fn trusted() -> Keys {
        #[cfg(feature = "update-check")]
        if let (Ok(stable), Ok(nightly), Ok(stable_pq), Ok(nightly_pq)) = (
            std::env::var("ZUNA_UPDATE_STABLE_KEYS"),
            std::env::var("ZUNA_UPDATE_NIGHTLY_KEYS"),
            std::env::var("ZUNA_UPDATE_STABLE_PQ_KEYS"),
            std::env::var("ZUNA_UPDATE_NIGHTLY_PQ_KEYS"),
        ) {
            let list = |keys: &str| keys.split(',').map(str::to_string).collect::<Vec<_>>();
            let (stable, nightly, stable_pq, nightly_pq) = (list(&stable), list(&nightly), list(&stable_pq), list(&nightly_pq));
            fn borrow(keys: &[String]) -> Vec<&str> {
                keys.iter().map(String::as_str).collect()
            }
            return Keys::new(&borrow(&stable), &borrow(&nightly), &borrow(&stable_pq), &borrow(&nightly_pq));
        }
        Keys::new(STABLE_KEYS, NIGHTLY_KEYS, STABLE_PQ_KEYS, NIGHTLY_PQ_KEYS)
    }

    /// Which channel's keys signed these bytes, both kinds of them, if any did.
    fn signer(&self, bytes: &[u8], ed25519: &[u8], ml_dsa: &[u8]) -> Option<Channel> {
        if self.stable.signed(bytes, ed25519, ml_dsa) {
            Some(Channel::Stable)
        } else if self.nightly.signed(bytes, ed25519, ml_dsa) {
            Some(Channel::Nightly)
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    build: u32,
    channel: String,
    tag: String,
    #[serde(default)]
    files: HashMap<String, ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    name: String,
    size: u64,
    sha256: String,
}

/// A version's three numbers, and a nightly's build number: `v0.11.0`, `v0.11.1-nightly.1112`.
fn parse_tag(tag: &str) -> Option<([u32; 3], Option<u32>)> {
    let rest = tag.strip_prefix('v')?;
    let (version, nightly) = match rest.split_once("-nightly.") {
        Some((version, build)) => (version, Some(build)),
        None => (rest, None),
    };
    let number = |text: &str| (!text.is_empty() && text.len() <= 9 && text.bytes().all(|byte| byte.is_ascii_digit())).then(|| text.parse::<u32>().ok()).flatten();
    let mut parts = version.split('.');
    let numbers = [number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?];
    if parts.next().is_some() {
        return None;
    }
    match nightly {
        Some(build) => Some((numbers, Some(number(build)?))),
        None => Some((numbers, None)),
    }
}

/// The manifest's checks, in the order the module's comment gives them. Nothing in the
/// manifest is read before its signatures hold. `signature` is `update.json.sig`'s, Ed25519's,
/// and `signature2` is `update.json.sig2`'s, ML-DSA-65's, each in base64.
pub fn accept(manifest: &[u8], signature: &str, signature2: &str, following: Channel, own_build: u32, keys: &Keys) -> Result<Update, Refused> {
    let decode = |text: &str| base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|_| Refused::Signature);
    let (ed25519, ml_dsa) = (decode(signature)?, decode(signature2)?);
    let signer = keys.signer(manifest, &ed25519, &ml_dsa).ok_or(Refused::Signature)?;
    let manifest: Manifest = serde_json::from_slice(manifest).map_err(|_| Refused::Malformed)?;
    let channel = Channel::parse(&manifest.channel).ok_or(Refused::Malformed)?;
    if channel != signer {
        return Err(Refused::WrongKey);
    }
    if following == Channel::Stable && channel == Channel::Nightly {
        return Err(Refused::Channel);
    }
    if manifest.build <= own_build {
        return Err(Refused::Old);
    }
    // The tag and the file's name become part of an address and a path, so they're held to
    // what a release's are.
    let tagged = parse_tag(&manifest.tag).ok_or(Refused::Malformed)?;
    if tagged.1.is_some() != (channel == Channel::Nightly) || tagged.1.is_some_and(|build| build != manifest.build) {
        return Err(Refused::Malformed);
    }
    let file = manifest.files.get(SYSTEM).ok_or(Refused::NoFile)?;
    let plain = |name: &str| !name.is_empty() && name.len() <= 120 && !name.starts_with('.') && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    let hex = file.sha256.len() == 64 && file.sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !plain(&file.name) || !hex || file.size == 0 || file.size > MAX_INSTALLER || parse_tag(&format!("v{}", manifest.version)).is_none() {
        return Err(Refused::Malformed);
    }
    Ok(Update { version: manifest.version, build: manifest.build, channel, tag: manifest.tag, name: file.name.clone(), size: file.size, sha256: file.sha256.clone() })
}

/// No installer is anywhere near this large.
const MAX_INSTALLER: u64 = 1 << 30;

/// The newest nightly and the newest stable release among a page of GitHub's releases, by
/// their tags. Nothing here is trusted: it only says which manifests to fetch.
fn newest_tags(releases: &[u8]) -> (Option<String>, Option<String>) {
    let Ok(serde_json::Value::Array(releases)) = serde_json::from_slice(releases) else { return (None, None) };
    let tags: Vec<(String, [u32; 3], Option<u32>)> = releases
        .iter()
        .filter(|release| release.get("draft").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|release| release.get("tag_name")?.as_str())
        .filter_map(|tag| parse_tag(tag).map(|(version, build)| (tag.to_string(), version, build)))
        .collect();
    let nightly = tags.iter().filter(|tag| tag.2.is_some()).max_by_key(|tag| tag.2).map(|tag| tag.0.clone());
    let stable = tags.iter().filter(|tag| tag.2.is_none()).max_by_key(|tag| tag.1).map(|tag| tag.0.clone());
    (nightly, stable)
}

/// Whether a file is the one a manifest names, by its size and SHA-256.
pub fn file_matches(path: &Path, size: u64, sha256: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    if file.metadata().map(|data| data.len()).ok() != Some(size) {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hash.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    let found: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    found == sha256
}

// --- What the interface reads ---

/// What the updater is doing right now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Idle,
    Checking,
    /// With what's being downloaded, as a person reads it.
    Downloading(String),
}

/// Everything Settings and the title bar show about updates.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Updates {
    /// Whether this copy updates itself: only an installed release build does.
    pub enabled: bool,
    pub following: Channel,
    pub activity: Activity,
    /// When releases were last looked at and nothing went wrong.
    pub checked: Option<SystemTime>,
    /// What went wrong with the last look, in words that follow "Couldn't check for updates: ".
    pub problem: Option<String>,
    /// Why the newest release found wasn't taken, for the logs and the update check.
    pub refused: Option<String>,
    /// Downloaded, checked and ready to install: what the Update button installs.
    pub ready: Option<Update>,
    /// An update that was started and didn't take, as a person reads its version.
    pub not_installed: Option<String>,
}

static STATE: Mutex<Updates> = Mutex::new(Updates { enabled: false, following: Channel::Nightly, activity: Activity::Idle, checked: None, problem: None, refused: None, ready: None, not_installed: None });
static WATCHERS: Mutex<Vec<futures::channel::mpsc::UnboundedSender<()>>> = Mutex::new(Vec::new());

/// What's known about updates right now.
pub fn current() -> Updates {
    STATE.lock().map(|state| state.clone()).unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

/// Told each time `current` changes.
pub fn changes() -> futures::channel::mpsc::UnboundedReceiver<()> {
    let (sender, receiver) = futures::channel::mpsc::unbounded();
    if let Ok(mut watchers) = WATCHERS.lock() {
        watchers.push(sender);
    }
    receiver
}

fn change(update: impl FnOnce(&mut Updates)) {
    let after = {
        let Ok(mut state) = STATE.lock() else { return };
        let before = state.clone();
        update(&mut state);
        if *state == before {
            return;
        }
        state.clone()
    };
    #[cfg(feature = "update-check")]
    if let Ok(json) = serde_json::to_vec_pretty(&after) {
        let folder = folder();
        std::fs::create_dir_all(&folder).ok();
        crate::host::write_whole(&folder.join("status.json"), &json).ok();
    }
    let _ = &after;
    if let Ok(mut watchers) = WATCHERS.lock() {
        watchers.retain(|watcher| watcher.unbounded_send(()).is_ok());
    }
}

/// How long ago something was, as Settings says it: "just now", "12 minutes ago", "3 hours ago".
pub fn ago(then: SystemTime, now: SystemTime) -> String {
    let minutes = now.duration_since(then).map(|passed| passed.as_secs() / 60).unwrap_or(0);
    match minutes {
        0 => "just now".into(),
        1 => "a minute ago".into(),
        2..=59 => format!("{minutes} minutes ago"),
        60..=119 => "an hour ago".into(),
        _ => format!("{} hours ago", minutes / 60),
    }
}

/// The line under the channel in Settings.
pub fn status_line(updates: &Updates, now: SystemTime) -> String {
    if let Some(update) = &updates.ready {
        return format!("{} is ready to install", update.label());
    }
    match &updates.activity {
        Activity::Downloading(label) => return format!("Downloading {label}"),
        Activity::Checking => return "Checking for updates".into(),
        Activity::Idle => {}
    }
    if let Some(version) = &updates.not_installed {
        return format!("The update to {version} couldn't be installed. Zuna will try again.");
    }
    match (&updates.problem, updates.checked) {
        (Some(problem), _) => format!("Couldn't check for updates: {problem}"),
        // A release is out that this app won't take, which is worth a person's knowing.
        (None, Some(_)) if updates.refused.is_some() => format!("The newest release wasn't taken: {}", updates.refused.as_deref().unwrap_or_default()),
        (None, Some(checked)) => format!("Up to date, checked {}", ago(checked, now)),
        (None, None) => "Not checked yet".into(),
    }
}

/// Where a downloaded update waits, in the app's own data.
fn folder() -> std::path::PathBuf {
    crate::host::data_dir().join("updates")
}

// --- Finding, downloading and installing, where the app updates itself ---

#[cfg(not(windows))]
pub fn start(_setting: Option<&str>) {}

#[cfg(not(windows))]
pub fn install_on_quit() {}

#[cfg(not(windows))]
pub fn install(_relaunch: bool) -> bool {
    false
}

#[cfg(not(windows))]
pub fn check_now() {}

#[cfg(not(windows))]
pub fn follow(_channel: Channel) {}

#[cfg(windows)]
pub(in crate::platform) use self::running::problem;
#[cfg(windows)]
pub use self::running::{check_now, follow, install, install_on_quit, start};

#[cfg(windows)]
mod running {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, mpsc};
    use std::time::{Duration, SystemTime};

    use super::*;

    const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

    enum Command {
        Check,
        Follow(Channel),
    }

    static COMMANDS: Mutex<Option<mpsc::Sender<Command>>> = Mutex::new(None);
    /// Where the update that's ready is.
    static READY_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
    /// Whether the installer was started, which happens once.
    static STARTED: AtomicBool = AtomicBool::new(false);

    /// Whether this copy updates itself: an installed release build, as today. A development
    /// build, or a copy run from elsewhere, never does.
    fn self_updating() -> bool {
        if cfg!(feature = "update-check") {
            return true;
        }
        !cfg!(debug_assertions) && crate::platform::BUILD > 0 && std::env::current_exe().is_ok_and(|exe| system::installed(&exe))
    }

    /// Starts looking for updates, where this copy may update itself: now, every hour, and
    /// when asked. `setting` is the channel the person picked, if they did.
    pub fn start(setting: Option<&str>) {
        let following = Channel::followed(setting);
        let enabled = self_updating();
        change(|state| {
            state.enabled = enabled;
            state.following = following;
        });
        if !enabled {
            return;
        }
        let (sender, commands) = mpsc::channel();
        if let Ok(mut slot) = COMMANDS.lock() {
            *slot = Some(sender);
        }
        std::thread::Builder::new().name("zuna-updates".into()).spawn(move || worker(following, commands)).ok();
    }

    /// Looks for an update now, as Check now in Settings does.
    pub fn check_now() {
        send(Command::Check);
    }

    /// Follows another channel from now on, and looks at once.
    pub fn follow(channel: Channel) {
        change(|state| state.following = channel);
        send(Command::Follow(channel));
    }

    fn send(command: Command) {
        if let Ok(commands) = COMMANDS.lock() {
            if let Some(commands) = commands.as_ref() {
                commands.send(command).ok();
            }
        }
    }

    fn worker(mut following: Channel, commands: mpsc::Receiver<Command>) {
        note_last_install();
        // Checking this program's own signature hashes all of it, which is why it's done here
        // and not as the window opens.
        let publisher = std::env::current_exe().ok().and_then(|exe| system::publisher(&exe));
        loop {
            look(following, publisher.as_ref());
            match commands.recv_timeout(CHECK_EVERY) {
                Ok(Command::Check) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Ok(Command::Follow(channel)) => {
                    following = channel;
                    // What was ready for the other channel isn't for this one.
                    if channel == Channel::Stable && current().ready.is_some_and(|update| update.channel == Channel::Nightly) {
                        forget_ready();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn forget_ready() {
        if let Ok(mut file) = READY_FILE.lock() {
            *file = None;
        }
        change(|state| state.ready = None);
    }

    /// One look at the releases, through to an update that's ready.
    fn look(following: Channel, publisher: Option<&system::Signer>) {
        if STARTED.load(Ordering::SeqCst) {
            return;
        }
        change(|state| state.activity = Activity::Checking);
        let outcome = find(following).and_then(|found| match found {
            Found::Update(update) => fetch(&update, publisher).map(|path| Some((update, path))),
            Found::Nothing(refused) => {
                change(|state| state.refused = refused.map(|refused| refused.to_string()));
                Ok(None)
            }
        });
        match outcome {
            Ok(ready) => {
                if let Some((update, path)) = ready {
                    log::info!("update {} is ready", update.label());
                    if let Ok(mut file) = READY_FILE.lock() {
                        *file = Some(path);
                    }
                    change(|state| {
                        state.ready = Some(update);
                        state.refused = None;
                    });
                }
                change(|state| {
                    state.activity = Activity::Idle;
                    state.checked = Some(SystemTime::now());
                    state.problem = None;
                });
            }
            Err(problem) => {
                log::warn!("checking for updates: {problem}");
                change(|state| {
                    state.activity = Activity::Idle;
                    state.problem = Some(problem);
                });
            }
        }
    }

    enum Found {
        Update(Update),
        /// Nothing to take, and why the newest release wasn't, unless it's only that it isn't newer.
        Nothing(Option<Refused>),
    }

    /// Where releases are listed and where their files are: GitHub, always, in a build anyone uses.
    fn addresses() -> (String, String) {
        #[cfg(feature = "update-check")]
        if let Ok(feed) = std::env::var("ZUNA_UPDATE_FEED") {
            return (format!("{feed}/api"), format!("{feed}/download"));
        }
        (API.to_string(), DOWNLOADS.to_string())
    }

    pub(in crate::platform) fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .use_preconfigured_tls(crate::host::tls_config())
            .user_agent("Zuna")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|error| error.to_string())
    }

    /// What went wrong with a request, in words for Settings. The whole of it goes to the log.
    pub(in crate::platform) fn problem(error: reqwest::Error) -> String {
        log::warn!("updates: {error:?}");
        match error.status() {
            Some(status) => format!("GitHub answered {}", status.as_u16()),
            None if error.is_timeout() => "the connection timed out".into(),
            None => "no connection to GitHub".into(),
        }
    }

    /// Something small from the releases, or nothing where there's none (404).
    fn get(client: &reqwest::Client, url: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        let bytes = crate::host::tokio().block_on(async {
            let response = client.get(url).header("Accept", "application/vnd.github+json").send().await.map_err(problem)?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            let response = response.error_for_status().map_err(problem)?;
            response.bytes().await.map(Some).map_err(problem)
        })?;
        match bytes {
            Some(bytes) if bytes.len() > limit => Err(format!("{url} answered with more than expected")),
            Some(bytes) => Ok(Some(bytes.to_vec())),
            None => Ok(None),
        }
    }

    /// The newest release this app's channel allows, with its manifest checked. On stable
    /// that's GitHub's latest release. On nightly it's the newest nightly or the newest
    /// stable release, whichever has the higher build.
    fn find(following: Channel) -> Result<Found, String> {
        let client = client()?;
        let (api, downloads) = addresses();
        let tags: Vec<String> = match following {
            Channel::Stable => {
                let latest = get(&client, &format!("{api}/releases/latest"), 1 << 20)?;
                let tag = latest.and_then(|latest| serde_json::from_slice::<serde_json::Value>(&latest).ok()).and_then(|latest| latest.get("tag_name")?.as_str().map(str::to_string));
                tag.into_iter().collect()
            }
            Channel::Nightly => {
                let page = get(&client, &format!("{api}/releases?per_page=10"), 4 << 20)?.unwrap_or_default();
                let (nightly, stable) = newest_tags(&page);
                nightly.into_iter().chain(stable).collect()
            }
        };
        let keys = Keys::trusted();
        let mut best: Option<Update> = None;
        let mut refused = None;
        for tag in tags {
            if parse_tag(&tag).is_none() {
                continue;
            }
            let Some(manifest) = get(&client, &format!("{downloads}/{tag}/update.json"), 1 << 16)? else { continue };
            let Some(signature) = get(&client, &format!("{downloads}/{tag}/update.json.sig"), 1 << 10)? else { continue };
            // A release from before the second signature has none, and isn't taken.
            let Some(signature2) = get(&client, &format!("{downloads}/{tag}/update.json.sig2"), 8 << 10)? else { continue };
            match accept(&manifest, &String::from_utf8_lossy(&signature), &String::from_utf8_lossy(&signature2), following, crate::platform::BUILD, &keys) {
                Ok(update) if best.as_ref().is_none_or(|best| update.build > best.build) => best = Some(update),
                Ok(_) => {}
                Err(Refused::Old) => {}
                Err(why) => {
                    log::warn!("release {tag} wasn't taken: {why}");
                    refused = Some(why);
                }
            }
        }
        Ok(match best {
            Some(update) => Found::Update(update),
            None => Found::Nothing(refused),
        })
    }

    /// Downloads an update's installer to the app's own folder, unless it's there already,
    /// and checks it's the file the manifest names, and signed as the app is where the app
    /// is signed.
    fn fetch(update: &Update, publisher: Option<&system::Signer>) -> Result<PathBuf, String> {
        let folder = folder();
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        let path = folder.join(&update.name);
        // Older downloads go, and a file left half written.
        if let Ok(entries) = std::fs::read_dir(&folder) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name != *update.name.as_str() && name != "installing.json" && name != "status.json" {
                    std::fs::remove_file(entry.path()).ok();
                }
            }
        }
        if !file_matches(&path, update.size, &update.sha256) {
            change(|state| state.activity = Activity::Downloading(update.label()));
            let (_, downloads) = addresses();
            let partial = path.with_extension("partial");
            system::download(&client()?, &format!("{downloads}/{}/{}", update.tag, update.name), &partial, update.size)?;
            if !file_matches(&partial, update.size, &update.sha256) {
                std::fs::remove_file(&partial).ok();
                change(|state| state.refused = Some("the file isn't the one its manifest names".into()));
                return Err(format!("{} isn't the file its manifest names", update.name));
            }
            std::fs::rename(&partial, &path).map_err(|error| error.to_string())?;
        }
        // The second lock: a signed app only takes an installer its own publisher signed.
        if let Some(publisher) = publisher {
            if system::signed_by(&path).as_ref() != Some(publisher) {
                std::fs::remove_file(&path).ok();
                change(|state| state.refused = Some("the installer isn't signed as this app is".into()));
                return Err(format!("{} isn't signed by {}", update.name, publisher.name));
            }
        }
        Ok(path)
    }

    #[derive(Serialize, Deserialize)]
    struct Installing {
        build: u32,
        version: String,
    }

    /// Whether the update that was last started took. The installer starts the old app again
    /// when it couldn't replace it, and this is how that copy knows.
    fn note_last_install() {
        let marker = folder().join("installing.json");
        let Ok(bytes) = std::fs::read(&marker) else { return };
        std::fs::remove_file(&marker).ok();
        if let Ok(installing) = serde_json::from_slice::<Installing>(&bytes) {
            if installing.build > crate::platform::BUILD {
                log::warn!("the update to {} didn't install", installing.version);
                change(|state| state.not_installed = Some(installing.version));
            }
        }
    }

    /// Starts the installer of the update that's ready, quietly, and says whether it did. The
    /// app quits next: the installer waits for it, and with `relaunch` starts it again.
    pub fn install(relaunch: bool) -> bool {
        let Some(update) = current().ready else { return false };
        let Some(path) = READY_FILE.lock().ok().and_then(|file| file.clone()) else { return false };
        if STARTED.swap(true, Ordering::SeqCst) {
            return true;
        }
        // Checked again, as it has been lying in a folder since it was downloaded.
        if !file_matches(&path, update.size, &update.sha256) {
            STARTED.store(false, Ordering::SeqCst);
            forget_ready();
            check_now();
            return false;
        }
        let marker = Installing { build: update.build, version: update.label() };
        if let Ok(json) = serde_json::to_vec(&marker) {
            crate::host::write_whole(&folder().join("installing.json"), &json).ok();
        }
        if !system::run_installer(&path, relaunch) {
            STARTED.store(false, Ordering::SeqCst);
            std::fs::remove_file(folder().join("installing.json")).ok();
            return false;
        }
        true
    }

    /// Installs an update that's ready and was never pressed, as the app quits, so nobody
    /// stays behind.
    pub fn install_on_quit() {
        install(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A channel's two signing keys, as a test holds them: Ed25519's and ML-DSA-65's, each a seed.
    struct Signing {
        public: String,
        public_pq: String,
        secret: Vec<u8>,
        secret_pq: Vec<u8>,
    }

    fn key() -> Signing {
        let base64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let secret = zuna_crypto::primitives::random_bytes(32).unwrap();
        let secret_pq = zuna_crypto::primitives::random_bytes(32).unwrap();
        Signing {
            public: base64(&zuna_crypto::primitives::signing_public(&secret).unwrap()),
            public_pq: base64(&zuna_crypto::hybrid::ml_dsa65_public(&secret_pq).unwrap()),
            secret,
            secret_pq,
        }
    }

    /// A release's two signatures, as `update.json.sig` and `update.json.sig2` hold them.
    struct Signed(String, String);

    fn sign(key: &Signing, bytes: &[u8]) -> Signed {
        let base64 = |bytes: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(bytes);
        Signed(
            base64(zuna_crypto::primitives::sign(&key.secret, bytes).unwrap()),
            base64(zuna_crypto::hybrid::ml_dsa65_sign(&key.secret_pq, bytes).unwrap()),
        )
    }

    fn keys_of(stable: &[&Signing], nightly: &[&Signing]) -> Keys {
        fn list<'a>(keys: &[&'a Signing], pq: bool) -> Vec<&'a str> {
            keys.iter().map(|key| if pq { key.public_pq.as_str() } else { key.public.as_str() }).collect()
        }
        Keys::new(&list(stable, false), &list(nightly, false), &list(stable, true), &list(nightly, true))
    }

    fn accept_signed(manifest: &[u8], signed: &Signed, following: Channel, own_build: u32, keys: &Keys) -> Result<Update, Refused> {
        accept(manifest, &signed.0, &signed.1, following, own_build, keys)
    }

    fn manifest(channel: &str, build: u32) -> Vec<u8> {
        let tag = if channel == "nightly" { format!("v0.12.0-nightly.{build}") } else { "v0.12.0".to_string() };
        let name = format!("Zuna-Native-Setup-{}.exe", tag.trim_start_matches('v'));
        let files = serde_json::json!({ SYSTEM: { "name": name, "size": 3, "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" } });
        serde_json::to_vec_pretty(&serde_json::json!({ "version": "0.12.0", "build": build, "channel": channel, "tag": tag, "commit": "c0ffee", "files": files, "later": "a field a newer release added" })).unwrap()
    }

    #[test]
    fn every_key_is_a_public_key_of_its_kind_and_no_two_are_the_same() {
        let all: Vec<&str> = STABLE_KEYS.iter().chain(NIGHTLY_KEYS).copied().collect();
        for key in &all {
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(key).expect("base64").len(), 32);
        }
        let all_pq: Vec<&str> = STABLE_PQ_KEYS.iter().chain(NIGHTLY_PQ_KEYS).copied().collect();
        for key in &all_pq {
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(key).expect("base64").len(), 1952);
        }
        let distinct: std::collections::HashSet<&str> = all.iter().chain(&all_pq).copied().collect();
        assert_eq!(distinct.len(), all.len() + all_pq.len());
        let keys = Keys::trusted();
        assert_eq!((keys.stable.ed25519.len(), keys.nightly.ed25519.len()), (STABLE_KEYS.len(), NIGHTLY_KEYS.len()));
        assert_eq!((keys.stable.ml_dsa.len(), keys.nightly.ml_dsa.len()), (STABLE_PQ_KEYS.len(), NIGHTLY_PQ_KEYS.len()));
        // Each channel has one in use and a spare, of each kind.
        assert!(STABLE_PQ_KEYS.len() == 2 && NIGHTLY_PQ_KEYS.len() == 2);
    }

    #[test]
    fn a_manifest_signed_with_one_of_the_two_is_refused() {
        let (stable, nightly) = (key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        let bytes = manifest("nightly", 1120);
        let Signed(ed25519, ml_dsa) = sign(&nightly, &bytes);
        assert!(accept(&bytes, &ed25519, &ml_dsa, Channel::Nightly, 1112, &keys).is_ok());
        // Either signature alone, as a release from before the second would be, or a broken one.
        assert_eq!(accept(&bytes, &ed25519, "", Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        assert_eq!(accept(&bytes, "", &ml_dsa, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        let mut broken = base64::engine::general_purpose::STANDARD.decode(&ml_dsa).unwrap();
        broken[100] ^= 1;
        let broken = base64::engine::general_purpose::STANDARD.encode(broken);
        assert_eq!(accept(&bytes, &ed25519, &broken, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        // The two from different channels, or with the files swapped, sign for neither.
        let Signed(stable_ed25519, stable_ml_dsa) = sign(&stable, &bytes);
        assert_eq!(accept(&bytes, &ed25519, &stable_ml_dsa, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        assert_eq!(accept(&bytes, &stable_ed25519, &ml_dsa, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        assert_eq!(accept(&bytes, &ml_dsa, &ed25519, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
    }

    #[test]
    fn an_update_its_channel_s_key_signed_is_taken() {
        let (stable, nightly) = (key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        let bytes = manifest("nightly", 1120);
        let update = accept_signed(&bytes, &sign(&nightly, &bytes), Channel::Nightly, 1112, &keys).unwrap();
        assert_eq!((update.build, update.channel, update.tag.as_str()), (1120, Channel::Nightly, "v0.12.0-nightly.1120"));
        assert_eq!(update.name, "Zuna-Native-Setup-0.12.0-nightly.1120.exe");
        assert_eq!(update.label(), "0.12.0 nightly 1120");
        // An app on nightly takes a stable release too, and one on stable takes it.
        let bytes = manifest("stable", 1130);
        for following in [Channel::Nightly, Channel::Stable] {
            let update = accept_signed(&bytes, &sign(&stable, &bytes), following, 1112, &keys).unwrap();
            assert_eq!((update.label().as_str(), update.page().as_str()), ("0.12.0", "https://github.com/zuna-app/zuna/releases/tag/v0.12.0"));
        }
        // The spare key of a channel signs for it as the first does.
        let spare = key();
        let keys = keys_of(&[&stable, &spare], &[&nightly]);
        assert!(accept_signed(&bytes, &sign(&spare, &bytes), Channel::Stable, 1112, &keys).is_ok());
    }

    #[test]
    fn a_manifest_nobody_signed_or_that_was_changed_is_refused() {
        let (stable, nightly, stranger) = (key(), key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        let bytes = manifest("nightly", 1120);
        assert_eq!(accept_signed(&bytes, &sign(&stranger, &bytes), Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        assert_eq!(accept(&bytes, "", "", Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        assert_eq!(accept(&bytes, "not base64", "not base64", Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        let signature = sign(&nightly, &bytes);
        let mut changed = bytes.clone();
        let at = changed.iter().position(|byte| *byte == b'3').unwrap();
        changed[at] = b'4';
        assert_eq!(accept_signed(&changed, &signature, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
        // It isn't read before its signature holds, so even nonsense says no more than that.
        assert_eq!(accept_signed(b"{", &signature, Channel::Nightly, 1112, &keys), Err(Refused::Signature));
    }

    #[test]
    fn the_nightly_key_can_t_reach_an_app_on_stable() {
        let (stable, nightly) = (key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        // A nightly, signed as one.
        let bytes = manifest("nightly", 1120);
        assert_eq!(accept_signed(&bytes, &sign(&nightly, &bytes), Channel::Stable, 1112, &keys), Err(Refused::Channel));
        // A manifest that says stable, signed with the nightly key, reaches nobody.
        let bytes = manifest("stable", 1120);
        for following in [Channel::Stable, Channel::Nightly] {
            assert_eq!(accept_signed(&bytes, &sign(&nightly, &bytes), following, 1112, &keys), Err(Refused::WrongKey));
        }
        // Nor does the stable key sign nightlies.
        let bytes = manifest("nightly", 1120);
        assert_eq!(accept_signed(&bytes, &sign(&stable, &bytes), Channel::Nightly, 1112, &keys), Err(Refused::WrongKey));
    }

    #[test]
    fn an_older_release_is_never_installed_over_a_newer_one() {
        let (stable, nightly) = (key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        let bytes = manifest("nightly", 1120);
        let signature = sign(&nightly, &bytes);
        assert_eq!(accept_signed(&bytes, &signature, Channel::Nightly, 1120, &keys), Err(Refused::Old));
        assert_eq!(accept_signed(&bytes, &signature, Channel::Nightly, 1121, &keys), Err(Refused::Old));
        assert!(accept_signed(&bytes, &signature, Channel::Nightly, 1119, &keys).is_ok());
        // Going back to stable from a nightly waits for a stable release that passes it.
        let bytes = manifest("stable", 1118);
        assert_eq!(accept_signed(&bytes, &sign(&stable, &bytes), Channel::Stable, 1120, &keys), Err(Refused::Old));
    }

    #[test]
    fn a_signed_manifest_still_has_to_name_a_plain_file() {
        let (stable, nightly) = (key(), key());
        let keys = keys_of(&[&stable], &[&nightly]);
        let with = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut value: serde_json::Value = serde_json::from_slice(&manifest("nightly", 1120)).unwrap();
            change(&mut value);
            let bytes = serde_json::to_vec(&value).unwrap();
            accept_signed(&bytes, &sign(&nightly, &bytes), Channel::Nightly, 1112, &keys)
        };
        assert!(with(&|_| {}).is_ok());
        assert_eq!(with(&|value| value["files"][SYSTEM]["name"] = "..\\..\\Startup\\run.exe".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["files"][SYSTEM]["name"] = "a/b.exe".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["files"][SYSTEM]["sha256"] = "abc".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["files"][SYSTEM]["size"] = 0.into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["tag"] = "v0.12.0/../../x".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["tag"] = "v0.12.0".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["tag"] = "v0.12.0-nightly.1119".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["channel"] = "beta".into()), Err(Refused::Malformed));
        assert_eq!(with(&|value| value["files"] = serde_json::json!({ "another-system": { "name": "x", "size": 1, "sha256": "" } })), Err(Refused::NoFile));
    }

    #[test]
    fn tags_are_read_as_the_release_script_writes_them() {
        assert_eq!(parse_tag("v0.11.0"), Some(([0, 11, 0], None)));
        assert_eq!(parse_tag("v0.11.1-nightly.1112"), Some(([0, 11, 1], Some(1112))));
        for other in ["0.11.0", "v0.11", "v0.11.0.1", "v0.11.0-beta.1", "v0.11.0-nightly.", "v0.11.0-nightly.x", "v0.11.0 ", "v0.11.0/..", "v-1.0.0", "v+1.0.0", ""] {
            assert_eq!(parse_tag(other), None, "{other}");
        }
    }

    #[test]
    fn the_newest_of_each_kind_is_found_among_the_releases() {
        let page = serde_json::json!([
            { "tag_name": "v0.11.1-nightly.1125", "prerelease": true },
            { "tag_name": "v0.11.1-nightly.1131", "prerelease": true },
            { "tag_name": "v0.11.0", "prerelease": false },
            { "tag_name": "v0.11.1-nightly.9999", "draft": true },
            { "tag_name": "v0.9.0" },
            { "tag_name": "v0.10.0" },
            { "tag_name": "something else" },
            { "name": "no tag" },
        ]);
        assert_eq!(newest_tags(&serde_json::to_vec(&page).unwrap()), (Some("v0.11.1-nightly.1131".into()), Some("v0.11.0".into())));
        assert_eq!(newest_tags(b"[]"), (None, None));
        assert_eq!(newest_tags(b"{\"message\": \"rate limited\"}"), (None, None));
    }

    #[test]
    fn a_file_is_known_by_its_size_and_hash() {
        let path = std::env::temp_dir().join(format!("zuna-update-test-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(file_matches(&path, 3, abc));
        assert!(!file_matches(&path, 4, abc));
        assert!(!file_matches(&path, 3, &abc.replace('b', "c")));
        std::fs::write(&path, b"abd").unwrap();
        assert!(!file_matches(&path, 3, abc));
        std::fs::remove_file(&path).unwrap();
        assert!(!file_matches(&path, 3, abc));
    }

    #[test]
    fn settings_say_where_updates_stand() {
        let now = SystemTime::now();
        let ago_minutes = |minutes: u64| now - Duration::from_secs(minutes * 60);
        let mut updates = Updates { enabled: true, following: Channel::Nightly, activity: Activity::Idle, checked: None, problem: None, refused: None, ready: None, not_installed: None };
        assert_eq!(status_line(&updates, now), "Not checked yet");
        updates.checked = Some(ago_minutes(12));
        assert_eq!(status_line(&updates, now), "Up to date, checked 12 minutes ago");
        updates.checked = Some(now);
        assert_eq!(status_line(&updates, now), "Up to date, checked just now");
        updates.checked = Some(ago_minutes(200));
        assert_eq!(status_line(&updates, now), "Up to date, checked 3 hours ago");
        updates.refused = Some("its manifest isn't signed with one of Zuna's keys".into());
        assert_eq!(status_line(&updates, now), "The newest release wasn't taken: its manifest isn't signed with one of Zuna's keys");
        updates.refused = None;
        updates.problem = Some("no connection".into());
        assert_eq!(status_line(&updates, now), "Couldn't check for updates: no connection");
        updates.not_installed = Some("0.12.0".into());
        assert_eq!(status_line(&updates, now), "The update to 0.12.0 couldn't be installed. Zuna will try again.");
        updates.activity = Activity::Downloading("0.12.0 nightly 1120".into());
        assert_eq!(status_line(&updates, now), "Downloading 0.12.0 nightly 1120");
        updates.ready = Some(Update { version: "0.12.0".into(), build: 1120, channel: Channel::Nightly, tag: "v0.12.0-nightly.1120".into(), name: "x.exe".into(), size: 1, sha256: String::new() });
        assert_eq!(status_line(&updates, now), "0.12.0 nightly 1120 is ready to install");
    }

    #[test]
    fn a_build_follows_its_own_channel_until_another_is_picked() {
        assert_eq!(Channel::followed(Some("stable")), Channel::Stable);
        assert_eq!(Channel::followed(Some("nightly")), Channel::Nightly);
        assert_eq!(Channel::followed(None), Channel::of_build());
        assert_eq!(Channel::followed(Some("beta")), Channel::of_build());
    }
}
