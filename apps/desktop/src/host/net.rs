//! How this app reaches anything outside it: directly, or, with a proxy set in Settings,
//! through that SOCKS5 proxy and no other way (docs/SOCKS5.md). Every HTTP client starts
//! from `client`, and every other connection comes from `tcp`, so one made anywhere else
//! stands out. While the proxy can't be reached nothing connects: there's no going around it.
//!
//! A change of proxy reaches what's open through `generation`: the core's thread makes its
//! clients again and drops its connections (`Core::network_changed`), and `fetch`'s client is
//! made again on its next request.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tokio::net::TcpStream;

pub use super::socks::{Failure, Proxy};

static PROXY: LazyLock<RwLock<Option<Arc<Proxy>>>> = LazyLock::new(Default::default);
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// What last went wrong at the proxy itself, until a connection through it works.
static TROUBLE: LazyLock<Mutex<Option<Failure>>> = LazyLock::new(Default::default);

/// Sets the proxy everything goes through, or none, and says whether that changed anything.
pub fn set(proxy: Option<Proxy>) -> bool {
    let mut current = PROXY.write();
    if current.as_deref() == proxy.as_ref() {
        return false;
    }
    log::info!("connecting {}", proxy.as_ref().map(|proxy| format!("through the proxy at {proxy:?}")).unwrap_or_else(|| "directly".into()));
    *current = proxy.map(Arc::new);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *TROUBLE.lock() = None;
    true
}

/// The proxy everything goes through, if there is one.
pub fn proxy() -> Option<Arc<Proxy>> {
    PROXY.read().clone()
}

/// Counts changes of proxy, so what holds a client knows to make it again.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// Why the proxy can't be had, if the last connection through it found it so.
pub fn trouble() -> Option<Failure> {
    PROXY.read().as_ref()?;
    TROUBLE.lock().clone()
}

fn note<T>(result: &Result<T, Failure>) {
    match result {
        Ok(_) => *TROUBLE.lock() = None,
        Err(failure) if failure.at_proxy() => *TROUBLE.lock() = Some(failure.clone()),
        Err(_) => *TROUBLE.lock() = None,
    }
}

/// The start of every HTTP client: through the proxy, with reqwest's reading of proxies from
/// the environment off, where there is one, and as reqwest connects where there isn't.
pub fn client() -> reqwest::ClientBuilder {
    client_through(proxy().as_deref())
}

/// The same, through the proxy given rather than the one that's set.
pub fn client_through(proxy: Option<&Proxy>) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    let Some(proxy) = proxy else { return builder };
    // One reqwest can't read goes nowhere, rather than around it.
    let through = reqwest::Proxy::all(proxy.url()).or_else(|_| reqwest::Proxy::all("socks5h://127.0.0.1:0")).expect("a proxy's address reqwest reads");
    builder.no_proxy().proxy(through)
}

/// A connection to `host`, through the proxy where there is one, which then resolves its name.
pub async fn tcp(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let bare = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host);
    match proxy() {
        Some(proxy) => {
            let result = super::socks::connect(&proxy, bare, port).await;
            note(&result);
            result.map_err(|failure| std::io::Error::other(failure.to_string()))
        }
        None => {
            let stream = TcpStream::connect((bare, port)).await?;
            stream.set_nodelay(true).ok();
            Ok(stream)
        }
    }
}

/// What Check found of a proxy.
#[derive(Clone, Debug)]
pub struct Report {
    /// Signing in, and how long that took.
    pub signed_in: Result<Duration, Failure>,
    /// Whether it grants a UDP association, which a call needs to go over UDP.
    pub udp: bool,
    /// Each server joined, by name, and how long reaching it through the proxy took.
    pub servers: Vec<(String, Result<Duration, String>)>,
}

/// Signs in to `proxy`, asks it for a UDP association, and reaches each of `servers`, a name
/// and an address each, through it, as Settings' Check does before the proxy is saved.
pub async fn check(proxy: Proxy, servers: Vec<(String, String)>) -> Report {
    let started = Instant::now();
    let (signed_in, udp) = match super::socks::associate(&proxy).await {
        Ok(_) => (Ok(started.elapsed()), true),
        Err(Failure::Declined(_)) => (Ok(started.elapsed()), false),
        Err(failure) => (Err(failure), false),
    };
    if signed_in.is_err() {
        return Report { signed_in, udp, servers: Vec::new() };
    }
    let client = client_through(Some(&proxy)).use_preconfigured_tls(super::tls_config()).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(20)).build();
    let mut reached = Vec::new();
    for (name, url) in servers {
        let started = Instant::now();
        let result = match &client {
            Ok(client) => match client.get(format!("{}/healthz", url.trim_end_matches('/'))).send().await {
                Ok(response) if response.status().is_success() => Ok(started.elapsed()),
                Ok(response) => Err(format!("It responded with status {}.", response.status().as_u16())),
                Err(error) => {
                    log::info!("checking the proxy with {url}: {}", super::runtime::describe_request_error(&error));
                    Err(if error.is_timeout() { "It didn't answer in time.".into() } else { "The proxy couldn't reach it.".into() })
                }
            },
            Err(error) => Err(error.to_string()),
        };
        reached.push((name, result));
    }
    Report { signed_in, udp, servers: reached }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn requests_go_through_the_proxy_by_name() {
        crate::host::tokio().block_on(async {
            let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = server.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut socket, _) = server.accept().await.unwrap();
                let mut request = [0u8; 1024];
                let _ = socket.read(&mut request).await;
                socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok").await.unwrap();
            });
            // A password with what a URL encodes, which reaches the proxy as it was.
            let (proxy_port, mut asked) = crate::host::socks::tests::fake_proxy_with(false, "a proxy's p@ss:word/+").await;
            let proxy = Proxy { host: "127.0.0.1".into(), port: proxy_port, username: "zuna".into(), password: "a proxy's p@ss:word/+".into() };
            let client = client_through(Some(&proxy)).build().unwrap();
            let response = client.get(format!("http://localhost:{port}/")).send().await.map_err(|error| super::super::runtime::describe_request_error(&error)).unwrap();
            assert_eq!(response.text().await.unwrap(), "ok");
            assert_eq!(asked.recv().await.unwrap(), [&[3u8, 9][..], b"localhost", &port.to_be_bytes()].concat());
        });
    }

    #[test]
    fn a_client_goes_through_the_proxy_set_and_only_then() {
        // reqwest takes the proxy's address as `client` writes it, with any password in it.
        let proxy = Proxy { host: "127.0.0.1".into(), port: 1, username: "a b".into(), password: "c:d@e".into() };
        assert!(client_through(Some(&proxy)).build().is_ok());
        assert!(client_through(None).build().is_ok());
        // Nothing listens on port 1, so a request through it fails, rather than going around it
        // to a server that would have answered.
        crate::host::tokio().block_on(async {
            let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://127.0.0.1:{}/", server.local_addr().unwrap().port());
            assert!(client_through(Some(&proxy)).build().unwrap().get(&url).send().await.is_err());
            let accepted = tokio::time::timeout(Duration::from_millis(200), server.accept()).await;
            assert!(accepted.is_err(), "the server was reached without the proxy");
        });
    }
}
