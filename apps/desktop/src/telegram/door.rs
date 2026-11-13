//! The app's end of the door (`telegram/src/door.rs` is the engine's): each connection TDLib asks
//! for is opened here, if it's to one of Telegram's own addresses on a port Telegram uses, and
//! refused otherwise. A name is always refused: Telegram's servers are reached by address, and
//! what TDLib does when it can't reach them, asking other companies' servers where they went,
//! isn't Telegram's and doesn't go.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use super::Outgoing;
use super::frame::MAX_DATA;

/// The ranges Telegram publishes (https://core.telegram.org/resources/cidr.txt, read on
/// 2026-11-13): nine for IPv4, five for IPv6. When it changes, this changes with it.
const RANGES_V4: &[(Ipv4Addr, u8)] = &[
    (Ipv4Addr::new(91, 108, 56, 0), 22),
    (Ipv4Addr::new(91, 108, 4, 0), 22),
    (Ipv4Addr::new(91, 108, 8, 0), 22),
    (Ipv4Addr::new(91, 108, 16, 0), 22),
    (Ipv4Addr::new(91, 108, 12, 0), 22),
    (Ipv4Addr::new(149, 154, 160, 0), 20),
    (Ipv4Addr::new(91, 105, 192, 0), 23),
    (Ipv4Addr::new(91, 108, 20, 0), 22),
    (Ipv4Addr::new(185, 76, 151, 0), 24),
];
const RANGES_V6: &[(Ipv6Addr, u8)] = &[
    (Ipv6Addr::new(0x2001, 0xb28, 0xf23d, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x2001, 0xb28, 0xf23f, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x2001, 0x67c, 0x4e8, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x2001, 0xb28, 0xf23c, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x2a0a, 0xf280, 0, 0, 0, 0, 0, 0), 32),
];

/// The ports Telegram's data centers answer on: 443 first, and 80 and 5222 where it's blocked.
const PORTS: &[u16] = &[443, 80, 5222];

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Whether the door lets a connection to this address and port through.
pub fn allowed(address: SocketAddr) -> bool {
    if !PORTS.contains(&address.port()) {
        return false;
    }
    match address.ip() {
        IpAddr::V4(ip) => RANGES_V4.iter().any(|&(network, bits)| {
            let mask = u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(network) & mask
        }),
        IpAddr::V6(ip) => {
            // An IPv4 address written as IPv6 is judged as itself.
            if let Some(v4) = ip.to_ipv4_mapped() {
                return allowed(SocketAddr::new(IpAddr::V4(v4), address.port()));
            }
            RANGES_V6.iter().any(|&(network, bits)| {
                let mask = u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0);
                u128::from(ip) & mask == u128::from(network) & mask
            })
        }
    }
}

/// A connection open through the door: what the engine sends goes to Telegram through
/// `writes`, and `reader` carries what Telegram sends back until it's ended.
struct Open {
    writes: UnboundedSender<Vec<u8>>,
    reader: Option<tokio::task::AbortHandle>,
}

/// The connections open through the door, by the engine's number for each.
#[derive(Clone)]
pub struct Door {
    streams: Arc<Mutex<HashMap<u32, Open>>>,
    out: std::sync::mpsc::Sender<Outgoing>,
}

impl Door {
    pub fn new(out: std::sync::mpsc::Sender<Outgoing>) -> Door {
        Door { streams: Arc::new(Mutex::new(HashMap::new())), out }
    }

    /// The engine asks for a connection.
    pub fn open(&self, id: u32, host: &str, port: u16) {
        let asked = format!("{host}:{port}");
        let refuse = move |door: &Door, why: &str| {
            log::info!(target: "telegram", "the door refused {asked}: {why}");
            door.out.send(Outgoing::Json(json!({ "zuna": "refused", "id": id }).to_string())).ok();
        };
        let Ok(ip) = host.parse::<IpAddr>() else { return refuse(self, "not an address") };
        let address = SocketAddr::new(ip, port);
        if !allowed(address) {
            return refuse(self, "not one of Telegram's");
        }
        // Tests reach no network.
        if cfg!(test) {
            return refuse(self, "a test");
        }
        let door = self.clone();
        crate::host::tokio().spawn(async move {
            // Through the proxy set in Privacy where there is one, as everything else goes, and
            // nowhere while it can't be reached (host/net.rs).
            let socket = match tokio::time::timeout(CONNECT_TIMEOUT, crate::host::net::tcp(&address.ip().to_string(), address.port())).await {
                Ok(Ok(socket)) => socket,
                Ok(Err(error)) => return refuse(&door, &error.to_string()),
                Err(_) => return refuse(&door, "it took too long"),
            };
            socket.set_nodelay(true).ok();
            let (writes, mut pending) = unbounded_channel::<Vec<u8>>();
            door.streams.lock().insert(id, Open { writes, reader: None });
            if door.out.send(Outgoing::Json(json!({ "zuna": "opened", "id": id }).to_string())).is_err() {
                door.streams.lock().remove(&id);
                return;
            }
            let (mut reading, mut writing) = socket.into_split();
            // Ends once its sender is dropped with the connection's entry, and shuts the socket.
            tokio::spawn(async move {
                while let Some(bytes) = pending.recv().await {
                    if writing.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                writing.shutdown().await.ok();
            });
            let carrying = door.clone();
            let reader = tokio::spawn(async move {
                let mut buffer = vec![0u8; MAX_DATA];
                loop {
                    match reading.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if carrying.out.send(Outgoing::Data(id, buffer[..count].to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                }
                // Telegram's end closed: the engine's end is told, unless it closed first.
                if carrying.streams.lock().remove(&id).is_some() {
                    carrying.out.send(Outgoing::Json(json!({ "zuna": "closed", "id": id }).to_string())).ok();
                }
            });
            if let Some(open) = door.streams.lock().get_mut(&id) {
                open.reader = Some(reader.abort_handle());
            }
        });
    }

    /// What the engine sent on a connection.
    pub fn data(&self, id: u32, bytes: Vec<u8>) {
        if let Some(open) = self.streams.lock().get(&id) {
            open.writes.send(bytes).ok();
        }
    }

    /// The engine's end closed, so this one does too: its reader ends, and dropping its sender
    /// ends its writer, which shuts the socket.
    pub fn closed(&self, id: u32) {
        if let Some(Open { reader: Some(reader), .. }) = self.streams.lock().remove(&id) {
            reader.abort();
        }
    }

    /// Closes every connection: as the engine stops, or, telling the engine, as the proxy changes.
    pub fn close_all(&self, tell_engine: bool) {
        for (id, open) in self.streams.lock().drain() {
            if let Some(reader) = open.reader {
                reader.abort();
            }
            if tell_engine {
                self.out.send(Outgoing::Json(json!({ "zuna": "closed", "id": id }).to_string())).ok();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(address: &str) -> bool {
        allowed(address.parse().unwrap())
    }

    #[test]
    fn only_telegram_s_ranges_and_ports_go_through() {
        // The test servers and the production servers.
        assert!(at("149.154.167.40:443"));
        assert!(at("149.154.167.50:443"));
        assert!(at("149.154.175.53:80"));
        assert!(at("91.108.56.130:5222"));
        assert!(at("[2001:67c:4e8:f002::a]:443"));
        assert!(at("[2a0a:f280:203::5]:443"));
        // Just past a range's edges.
        assert!(!at("149.154.176.1:443"));
        assert!(!at("149.154.159.255:443"));
        assert!(!at("91.105.194.1:443"));
        assert!(!at("[2001:67c:4e9::1]:443"));
        // Another company's, and this computer.
        assert!(!at("8.8.8.8:443"));
        assert!(!at("[2001:4860:4860::8888]:443"));
        assert!(!at("127.0.0.1:443"));
        assert!(!at("[::1]:443"));
        // A port Telegram doesn't use.
        assert!(!at("149.154.167.50:22"));
        assert!(!at("149.154.167.50:8080"));
    }

    #[test]
    fn an_ipv4_address_inside_ipv6_is_judged_as_itself() {
        assert!(at("[::ffff:149.154.167.50]:443"));
        assert!(!at("[::ffff:8.8.8.8]:443"));
    }

    #[test]
    fn a_name_is_refused() {
        let (out, heard) = std::sync::mpsc::channel();
        let door = Door::new(out);
        door.open(4, "dns.google", 443);
        door.open(5, "8.8.8.8", 443);
        for id in [4, 5] {
            let Ok(Outgoing::Json(json)) = heard.try_recv() else { panic!("no answer") };
            assert_eq!(json, json!({ "zuna": "refused", "id": id }).to_string());
        }
    }
}
