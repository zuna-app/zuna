//! Fetching pages and pictures for link previews (the core's `webFetch`), under the
//! address rules of `packages/core/src/links.ts` and zuna-web's `server/internal/webhost/address.go`.
//!
//! A public name can lead to this machine or a private network, and what a preview
//! found there would go into the message. So names are resolved here, refused if any
//! address they lead to is private, and the connection goes to the addresses that were
//! checked, with no moment between the check and the connection for the name to change.
//! Redirects are followed one at a time, each checked the same way.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use url::Url;

const MAX_REDIRECTS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Zuna link preview)";

/// Whether an IPv4 address is on this machine, a private network, or anywhere a public
/// page can't be (`privateIpv4` in links.ts).
fn private_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

/// Besides this machine and private networks: documentation, and the ways of carrying
/// IPv4 inside IPv6, which can lead anywhere in IPv4 with none of the checks on it.
const PRIVATE_IPV6: &[(u128, u32)] = &[
    (0, 96),                                        // ::/96
    (0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96), // 64:ff9b::/96
    (0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48), // 64:ff9b:1::/48
    (0x0100_0000_0000_0000_0000_0000_0000_0000, 64), // 100::/64
    (0x2001_0000_0000_0000_0000_0000_0000_0000, 32), // 2001::/32
    (0x2001_0db8_0000_0000_0000_0000_0000_0000, 32), // 2001:db8::/32
    (0x2002_0000_0000_0000_0000_0000_0000_0000, 16), // 2002::/16
    (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),  // fc00::/7
    (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10), // fe80::/10
    (0xfec0_0000_0000_0000_0000_0000_0000_0000, 10), // fec0::/10
    (0xff00_0000_0000_0000_0000_0000_0000_0000, 8),  // ff00::/8
];

fn private_ipv6(ip: Ipv6Addr) -> bool {
    let bits = u128::from(ip);
    // ::ffff:0:0/96, IPv4 written as IPv6, is judged as the IPv4 address it is.
    if bits >> 32 == 0xffff {
        return private_ipv4(Ipv4Addr::from(bits as u32));
    }
    PRIVATE_IPV6.iter().any(|&(network, prefix)| {
        let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
        bits & mask == network & mask
    })
}

/// Whether an address, as a resolver gives it, is on this machine or a private network.
pub fn private_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => private_ipv4(ip),
        IpAddr::V6(ip) => private_ipv6(ip),
    }
}

/// Names that only mean something on this machine or its network.
fn local_name(host: &str) -> bool {
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    !name.contains('.')
        || [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"].iter().any(|suffix| name.ends_with(suffix))
}

/// Whether a link may be fetched for a preview: HTTPS to somewhere public, on the usual
/// port, with nobody's name or password in it (`previewable` in links.ts).
pub fn previewable(url: &Url) -> bool {
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => !private_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => !private_ipv6(ip),
        Some(url::Host::Domain(name)) => !local_name(name),
        None => false,
    }
}

/// Resolves names for previews, refusing any that leads anywhere private. The client
/// connects to the addresses given here, so what was checked is what's reached.
struct CheckedResolver;

impl reqwest::dns::Resolve for CheckedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            if local_name(&host) {
                return Err("That address is on this computer's network.".into());
            }
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 443)).await?.collect();
            if addresses.is_empty() || addresses.iter().any(|address| private_address(address.ip())) {
                return Err("That address is on this computer's network.".into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A client for previews alone: no cookies, the checked resolver, and each redirect checked.
pub fn client(tls: rustls::ClientConfig) -> reqwest::Client {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .dns_resolver(Arc::new(CheckedResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("Too many redirects.")
            } else if previewable(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("The page went somewhere previews don't go.")
            }
        }))
        .connect_timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .expect("a client for link previews")
}

/// Fetches a page or picture, keeping at most `max_bytes`: its address in the end, its
/// type, and its start.
pub async fn fetch(client: &reqwest::Client, url: &str, max_bytes: usize) -> Result<(String, String, Vec<u8>), String> {
    let unavailable = || "The page isn't available.".to_string();
    let parsed = Url::parse(url).map_err(|_| unavailable())?;
    if !previewable(&parsed) {
        return Err(unavailable());
    }
    let work = async {
        let mut response = client
            .get(parsed)
            .header("accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5")
            .send()
            .await
            .map_err(|error| {
                log::debug!("link preview: {}", super::runtime::describe_request_error(&error));
                unavailable()
            })?;
        if !response.status().is_success() {
            log::debug!("link preview: {}", response.status());
            return Err(unavailable());
        }
        let final_url = response.url().to_string();
        let mime = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("").to_string();
        let mut body = Vec::new();
        // Only as much as a preview needs, however large the page is.
        while body.len() < max_bytes {
            match response.chunk().await {
                Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                Ok(None) => break,
                Err(_) if !body.is_empty() => break,
                Err(_) => return Err(unavailable()),
            }
        }
        body.truncate(max_bytes);
        Ok((final_url, mime, body))
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses_are_refused() {
        for address in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::"] {
            assert!(private_address(address.parse().unwrap()), "{address} should be private");
        }
        for address in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:1.1.1.1"] {
            assert!(!private_address(address.parse().unwrap()), "{address} should be public");
        }
    }

    #[test]
    fn only_public_https_on_the_usual_port_is_previewable() {
        let ok = |text: &str| previewable(&Url::parse(text).unwrap());
        assert!(ok("https://example.com/page"));
        assert!(!ok("http://example.com/"));
        assert!(!ok("https://example.com:8443/"));
        assert!(!ok("https://user:pass@example.com/"));
        assert!(!ok("https://localhost/"));
        assert!(!ok("https://printer.local/"));
        assert!(!ok("https://intranet/"));
        assert!(!ok("https://127.0.0.1/"));
        assert!(!ok("https://[::1]/"));
        assert!(ok("https://1.1.1.1/"));
    }
}
