//! A SOCKS5 client (RFC 1928), signing in with a username and password where the proxy has
//! them (RFC 1929): what the core's socket connects through, the relays of a call ask for UDP
//! associations with, and Settings checks a proxy with. A destination goes to the proxy as
//! the name it is, for the proxy to resolve, so this device never looks it up.
//! reqwest makes its own SOCKS5 connections for every request (net.rs).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long a proxy gets to answer each step.
const TIMEOUT: Duration = Duration::from_secs(15);

/// A SOCKS5 proxy, as Settings has it: no username means none is sent.
#[derive(Clone, PartialEq, Eq)]
pub struct Proxy {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for Proxy {
    /// Without the password, which goes in no log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.address())
    }
}

impl Proxy {
    /// `host:port`, with an IPv6 address in brackets.
    pub fn address(&self) -> String {
        if self.host.contains(':') { format!("[{}]:{}", self.host, self.port) } else { format!("{}:{}", self.host, self.port) }
    }

    /// As reqwest takes it, which leaves names to the proxy (`socks5h`), with the username and
    /// password percent-encoded as a URL's are, which reqwest decodes.
    pub fn url(&self) -> String {
        let address = format!("socks5h://{}", self.address());
        let Ok(mut url) = url::Url::parse(&address) else { return address };
        if !self.username.is_empty() && url.set_username(&self.username).is_ok() {
            url.set_password(Some(&self.password)).ok();
        }
        url.as_str().trim_end_matches('/').to_string()
    }
}

/// What went wrong, and whose doing it was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The proxy wasn't there, didn't answer, or doesn't speak SOCKS5.
    Unreachable(String),
    /// It took no username and password, or not these.
    Refused,
    /// It was reached and signed in to, but wouldn't, or couldn't, do what was asked: the
    /// reply's code (RFC 1928, 6).
    Declined(u8),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Unreachable(why) => write!(f, "Can't reach the proxy: {why}"),
            Failure::Refused => f.write_str("The proxy refused the username or password."),
            Failure::Declined(code) => f.write_str(match code {
                2 => "The proxy doesn't allow that connection.",
                3 => "The proxy can't reach that network.",
                4 => "The proxy can't reach that server.",
                5 => "That server refused the proxy's connection.",
                6 => "The proxy's connection timed out.",
                7 => "The proxy doesn't support that.",
                8 => "The proxy doesn't support that type of address.",
                _ => "The proxy couldn't make the connection.",
            }),
        }
    }
}

impl Failure {
    /// Whether it's the proxy that can't be had, rather than what was asked of it.
    pub fn at_proxy(&self) -> bool {
        !matches!(self, Failure::Declined(_))
    }
}

fn unreachable(error: impl std::fmt::Display) -> Failure {
    Failure::Unreachable(error.to_string())
}

/// Where a connection or a datagram is going, as SOCKS5 writes it: an address, or a name for the proxy to resolve.
pub fn encode_address(host: &str, port: u16) -> Result<Vec<u8>, Failure> {
    let bare = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host);
    let mut out = match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => [&[1u8][..], &ip.octets()].concat(),
        Ok(IpAddr::V6(ip)) => [&[4u8][..], &ip.octets()].concat(),
        Err(_) => {
            if bare.is_empty() || bare.len() > 255 {
                return Err(Failure::Declined(8));
            }
            [&[3u8, bare.len() as u8][..], bare.as_bytes()].concat()
        }
    };
    out.extend_from_slice(&port.to_be_bytes());
    Ok(out)
}

/// An address SOCKS5 wrote, from the start of `bytes`: what it names, and how long it was.
pub fn decode_address(bytes: &[u8]) -> Option<(Target, usize)> {
    let port = |at: usize| bytes.get(at..at + 2).map(|pair| u16::from_be_bytes([pair[0], pair[1]]));
    match *bytes.first()? {
        1 => {
            let octets: [u8; 4] = bytes.get(1..5)?.try_into().ok()?;
            Some((Target::Address(SocketAddr::new(IpAddr::from(octets), port(5)?)), 7))
        }
        4 => {
            let octets: [u8; 16] = bytes.get(1..17)?.try_into().ok()?;
            Some((Target::Address(SocketAddr::new(IpAddr::from(octets), port(17)?)), 19))
        }
        3 => {
            let length = *bytes.get(1)? as usize;
            let name = std::str::from_utf8(bytes.get(2..2 + length)?).ok()?.to_string();
            Some((Target::Name(name, port(2 + length)?), 4 + length))
        }
        _ => None,
    }
}

/// Where something is, as SOCKS5 can say it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Address(SocketAddr),
    Name(String, u16),
}

async fn timed<T>(work: impl std::future::Future<Output = std::io::Result<T>>) -> Result<T, Failure> {
    match tokio::time::timeout(TIMEOUT, work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(unreachable(error)),
        Err(_) => Err(Failure::Unreachable("it didn't answer".into())),
    }
}

/// Connects to the proxy and signs in.
async fn greet(proxy: &Proxy) -> Result<TcpStream, Failure> {
    let mut stream = timed(TcpStream::connect((proxy.host.trim_start_matches('[').trim_end_matches(']'), proxy.port))).await?;
    stream.set_nodelay(true).ok();
    let methods: &[u8] = if proxy.username.is_empty() { &[5, 1, 0] } else { &[5, 2, 0, 2] };
    timed(stream.write_all(methods)).await?;
    let mut chosen = [0u8; 2];
    timed(stream.read_exact(&mut chosen)).await?;
    if chosen[0] != 5 {
        return Err(Failure::Unreachable("it doesn't speak SOCKS5".into()));
    }
    match chosen[1] {
        0 => Ok(stream),
        2 if !proxy.username.is_empty() => {
            let (name, password) = (proxy.username.as_bytes(), proxy.password.as_bytes());
            if name.len() > 255 || password.len() > 255 {
                return Err(Failure::Refused);
            }
            let mut request = vec![1, name.len() as u8];
            request.extend_from_slice(name);
            request.push(password.len() as u8);
            request.extend_from_slice(password);
            timed(stream.write_all(&request)).await?;
            let mut status = [0u8; 2];
            timed(stream.read_exact(&mut status)).await?;
            if status[1] == 0 { Ok(stream) } else { Err(Failure::Refused) }
        }
        _ => Err(Failure::Refused),
    }
}

/// Sends a request, and reads the address in its reply.
async fn request(stream: &mut TcpStream, command: u8, host: &str, port: u16) -> Result<Target, Failure> {
    let mut message = vec![5, command, 0];
    message.extend(encode_address(host, port)?);
    timed(stream.write_all(&message)).await?;
    let mut head = [0u8; 4];
    timed(stream.read_exact(&mut head)).await?;
    if head[0] != 5 {
        return Err(Failure::Unreachable("it doesn't speak SOCKS5".into()));
    }
    if head[1] != 0 {
        return Err(Failure::Declined(head[1]));
    }
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut length = [0u8; 1];
            timed(stream.read_exact(&mut length)).await?;
            let mut name = vec![0u8; length[0] as usize + 2];
            timed(stream.read_exact(&mut name)).await?;
            let mut whole = vec![3, length[0]];
            whole.extend(name);
            return decode_address(&whole).map(|(target, _)| target).ok_or_else(|| Failure::Unreachable("it answered with an address it can't have".into()));
        }
        _ => return Err(Failure::Unreachable("it answered with an address it can't have".into())),
    };
    let mut address = vec![0u8; rest];
    timed(stream.read_exact(&mut address)).await?;
    let mut whole = vec![head[3]];
    whole.extend(address);
    decode_address(&whole).map(|(target, _)| target).ok_or_else(|| Failure::Unreachable("it answered with an address it can't have".into()))
}

/// A connection to `host`, through the proxy, which resolves it where it's a name.
pub async fn connect(proxy: &Proxy, host: &str, port: u16) -> Result<TcpStream, Failure> {
    let mut stream = greet(proxy).await?;
    request(&mut stream, 1, host, port).await?;
    Ok(stream)
}

/// A UDP association: the connection that keeps it, which ends it when it closes, and where
/// to send datagrams for the proxy to pass on.
pub async fn associate(proxy: &Proxy) -> Result<(TcpStream, SocketAddr), Failure> {
    let mut stream = greet(proxy).await?;
    let relay = request(&mut stream, 3, "0.0.0.0", 0).await?;
    let relay = match relay {
        Target::Address(address) if !address.ip().is_unspecified() => address,
        // A proxy that doesn't say where takes them where it was reached.
        Target::Address(address) => SocketAddr::new(stream.peer_addr().map(|peer| peer.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)), address.port()),
        Target::Name(..) => return Err(Failure::Unreachable("it named its relay rather than giving its address".into())),
    };
    Ok((stream, relay))
}

/// A datagram for the proxy to send on to `host`.
pub fn wrap(host: &str, port: u16, payload: &[u8]) -> Result<Vec<u8>, Failure> {
    let mut out = vec![0, 0, 0];
    out.extend(encode_address(host, port)?);
    out.extend_from_slice(payload);
    Ok(out)
}

/// A datagram the proxy passed back: where it came from, and what it carried. None for one
/// that's a fragment, which nothing here asks for, or isn't SOCKS5's.
pub fn unwrap(packet: &[u8]) -> Option<(Target, &[u8])> {
    if packet.len() < 4 || packet[0] != 0 || packet[1] != 0 || packet[2] != 0 {
        return None;
    }
    let (from, length) = decode_address(&packet[3..])?;
    Some((from, &packet[3 + length..]))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::net::{TcpListener, UdpSocket};

    /// A proxy for these tests: it signs in with `zuna` and `secret`, connects anywhere, and
    /// grants a UDP association unless told not to, writing down every destination it was given.
    pub(crate) async fn fake_proxy(udp: bool) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        fake_proxy_with(udp, "secret").await
    }

    /// The same, with another password.
    pub(crate) async fn fake_proxy_with(udp: bool, secret: &'static str) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (asked, told) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut client, _)) = listener.accept().await else { return };
                let asked = asked.clone();
                tokio::spawn(async move {
                    let mut head = [0u8; 2];
                    client.read_exact(&mut head).await.ok()?;
                    let mut methods = vec![0u8; head[1] as usize];
                    client.read_exact(&mut methods).await.ok()?;
                    if !methods.contains(&2) {
                        client.write_all(&[5, 0xff]).await.ok()?;
                        return None;
                    }
                    client.write_all(&[5, 2]).await.ok()?;
                    let mut version = [0u8; 2];
                    client.read_exact(&mut version).await.ok()?;
                    let mut name = vec![0u8; version[1] as usize];
                    client.read_exact(&mut name).await.ok()?;
                    let mut length = [0u8; 1];
                    client.read_exact(&mut length).await.ok()?;
                    let mut password = vec![0u8; length[0] as usize];
                    client.read_exact(&mut password).await.ok()?;
                    let right = name == b"zuna" && password == secret.as_bytes();
                    client.write_all(&[1, if right { 0 } else { 1 }]).await.ok()?;
                    if !right {
                        return None;
                    }
                    let mut request = [0u8; 4];
                    client.read_exact(&mut request).await.ok()?;
                    let mut address = vec![request[3]];
                    let more = match request[3] {
                        1 => 6,
                        4 => 18,
                        _ => {
                            let mut length = [0u8; 1];
                            client.read_exact(&mut length).await.ok()?;
                            address.push(length[0]);
                            length[0] as usize + 2
                        }
                    };
                    let mut rest = vec![0u8; more];
                    client.read_exact(&mut rest).await.ok()?;
                    address.extend(rest);
                    asked.send(address.clone()).ok();
                    if request[1] == 3 {
                        if !udp {
                            client.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok()?;
                            return None;
                        }
                        // An echo, as a relay that answers for everywhere.
                        let socket = UdpSocket::bind("127.0.0.1:0").await.ok()?;
                        let port = socket.local_addr().ok()?.port().to_be_bytes();
                        client.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, port[0], port[1]]).await.ok()?;
                        let mut buffer = [0u8; 2048];
                        let (length, from) = socket.recv_from(&mut buffer).await.ok()?;
                        socket.send_to(&buffer[..length], from).await.ok()?;
                        client.read(&mut [0u8; 1]).await.ok()?;
                        return None;
                    }
                    // Every name here is this machine.
                    let to = match decode_address(&address)?.0 {
                        Target::Name(_, port) => SocketAddr::from(([127, 0, 0, 1], port)),
                        Target::Address(address) => address,
                    };
                    let mut upstream = TcpStream::connect(to).await.ok()?;
                    client.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.ok()?;
                    tokio::io::copy_bidirectional(&mut client, &mut upstream).await.ok()?;
                    Some(())
                });
            }
        });
        (port, told)
    }

    fn proxy(port: u16, password: &str) -> Proxy {
        Proxy { host: "127.0.0.1".into(), port, username: "zuna".into(), password: password.into() }
    }

    #[test]
    fn addresses_are_written_as_socks5_does() {
        assert_eq!(encode_address("192.0.2.7", 7881).unwrap(), vec![1, 192, 0, 2, 7, 0x1e, 0xc9]);
        assert_eq!(encode_address("example.com", 443).unwrap(), [&[3u8, 11][..], b"example.com", &[1, 187]].concat());
        assert_eq!(encode_address("[2001:db8::1]", 1).unwrap()[0], 4);
        for host in ["192.0.2.7", "2001:db8::1", "example.com"] {
            let encoded = encode_address(host, 7882).unwrap();
            let (target, length) = decode_address(&encoded).unwrap();
            assert_eq!(length, encoded.len());
            match target {
                Target::Name(name, port) => assert_eq!((name.as_str(), port), (host, 7882)),
                Target::Address(address) => assert_eq!(address, SocketAddr::new(host.parse().unwrap(), 7882)),
            }
        }
        assert!(encode_address(&"a".repeat(256), 1).is_err());
        let packet = wrap("voice.example", 7882, b"media").unwrap();
        let (from, payload) = unwrap(&packet).unwrap();
        assert_eq!((from, payload), (Target::Name("voice.example".into(), 7882), &b"media"[..]));
        assert!(unwrap(&[0, 0, 1, 1, 127, 0, 0, 1, 0, 1]).is_none(), "a fragment");
    }

    #[test]
    fn the_password_stays_out_of_logs_but_reaches_reqwest_encoded() {
        let proxy = Proxy { host: "proxy.example".into(), port: 1080, username: "me@home".into(), password: "p@ss:word/ it's".into() };
        assert_eq!(format!("{proxy:?}"), "proxy.example:1080");
        // A space is %20, never +, which reqwest would give the proxy as it is.
        assert_eq!(proxy.url(), "socks5h://me%40home:p%40ss%3Aword%2F%20it's@proxy.example:1080");
        let bare = Proxy { username: String::new(), ..proxy };
        assert_eq!(bare.url(), "socks5h://proxy.example:1080");
        let six = Proxy { host: "2001:db8::1".into(), port: 9050, username: String::new(), password: String::new() };
        assert_eq!(six.url(), "socks5h://[2001:db8::1]:9050");
    }

    #[test]
    fn connects_by_name_signed_in_and_refuses_the_wrong_password() {
        crate::host::tokio().block_on(async {
            let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let target_port = target.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut socket, _) = target.accept().await.unwrap();
                socket.write_all(b"hello").await.unwrap();
            });
            let (port, mut asked) = fake_proxy(true).await;
            let mut stream = connect(&proxy(port, "secret"), "localhost", target_port).await.unwrap();
            let mut hello = [0u8; 5];
            stream.read_exact(&mut hello).await.unwrap();
            assert_eq!(&hello, b"hello");
            // The name, for the proxy to resolve.
            assert_eq!(asked.recv().await.unwrap(), [&[3u8, 9][..], b"localhost", &target_port.to_be_bytes()].concat());
            assert_eq!(connect(&proxy(port, "wrong"), "localhost", target_port).await.unwrap_err(), Failure::Refused);
            let nobody = Proxy { username: String::new(), ..proxy(port, "") };
            assert_eq!(connect(&nobody, "localhost", target_port).await.unwrap_err(), Failure::Refused);
        });
    }

    #[test]
    fn says_when_the_proxy_is_gone_or_carries_no_udp() {
        crate::host::tokio().block_on(async {
            let gone = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = gone.local_addr().unwrap().port();
            drop(gone);
            let failure = connect(&proxy(port, "secret"), "localhost", 1).await.unwrap_err();
            assert!(matches!(failure, Failure::Unreachable(_)) && failure.at_proxy());

            let (port, _) = fake_proxy(false).await;
            assert_eq!(associate(&proxy(port, "secret")).await.unwrap_err(), Failure::Declined(7));
            assert!(!Failure::Declined(7).at_proxy());

            let (port, _) = fake_proxy(true).await;
            let (_control, relay) = associate(&proxy(port, "secret")).await.unwrap();
            let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            socket.send_to(&wrap("voice.example", 7882, b"ping").unwrap(), relay).await.unwrap();
            let mut buffer = [0u8; 512];
            let (length, _) = socket.recv_from(&mut buffer).await.unwrap();
            assert_eq!(unwrap(&buffer[..length]).unwrap().1, b"ping");
        });
    }
}
