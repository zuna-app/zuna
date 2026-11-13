//! Calls through the SOCKS5 proxy (host/net.rs, docs/SOCKS5.md, "Calls"). LiveKit's SDK
//! and libwebrtc make connections of their own, and neither can be told to use a proxy, so
//! the SDK is only ever told addresses on this device:
//!
//! - Its signalling goes through the app's own WebSocket and HTTP clients, which livekit-net
//!   takes (`install`): through the proxy, with each message rewritten by the core's code
//!   (host/relay.rs), so that LiveKit's candidates become relays here, no STUN or TURN server
//!   is left, and none of this device's candidates reach LiveKit.
//! - Each relay is a port on loopback (`Relays`) that carries what libwebrtc sends it through
//!   the proxy to the candidate it stands for: TCP over a connection the proxy opens, UDP in a
//!   UDP association of its own for each of libwebrtc's sockets. A proxy that grants no
//!   association gets no UDP candidates, and the call goes over TCP.
//!
//! Without a proxy, the same clients connect directly, and nothing is rewritten.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use livekit_net::{Header, HttpClient, HttpMethod, HttpResponse, TransportError, WsClient, WsConnectResult, WsConnection};
use parking_lot::Mutex;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::host::net::{self, Proxy};

/// The relays of the call this device is in, which there's one of at most.
static CURRENT: LazyLock<Mutex<Option<Arc<Relays>>>> = LazyLock::new(Default::default);

/// Has livekit-net take the app's WebSocket and HTTP clients, before any room connects.
pub fn install() {
    livekit_net::set_ws_client(Arc::new(Transport));
    livekit_net::set_http_client(Arc::new(Transport));
}

/// Sets up the relays for a call about to start, through `proxy`: whether it grants UDP is
/// asked first, as LiveKit's UDP candidates are left out where it doesn't. Fails as the
/// proxy can't be had.
pub async fn prepare(proxy: Proxy) -> Result<Arc<Relays>, String> {
    let udp = match crate::host::socks::associate(&proxy).await {
        Ok(_) => true,
        Err(crate::host::socks::Failure::Declined(_)) => false,
        Err(failure) => return Err(failure.to_string()),
    };
    log::info!("a call through the proxy, {}", if udp { "which carries UDP" } else { "over TCP, as it carries no UDP" });
    let relays = Arc::new(Relays { proxy, udp, open: Mutex::new(HashMap::new()), tasks: Mutex::new(Vec::new()), udp_seen: AtomicU64::new(0), tcp_seen: AtomicU64::new(0), started: Instant::now() });
    *CURRENT.lock() = Some(relays.clone());
    Ok(relays)
}

/// The call's relays go, and with them every connection and association they hold.
pub fn finish(relays: &Arc<Relays>) {
    let mut current = CURRENT.lock();
    if current.as_ref().is_some_and(|held| Arc::ptr_eq(held, relays)) {
        *current = None;
    }
    relays.close();
}

/// Which way a call through the proxy carries its media, for the stream stats: None outside
/// one, or before anything went.
pub fn way() -> Option<&'static str> {
    let relays = CURRENT.lock().clone()?;
    let (udp, tcp) = (relays.udp_seen.load(Ordering::Relaxed), relays.tcp_seen.load(Ordering::Relaxed));
    match (udp, tcp) {
        (0, 0) => None,
        _ if udp >= tcp => Some("Through the proxy, over UDP"),
        _ => Some("Through the proxy, over TCP"),
    }
}

/// The ports on loopback that stand for LiveKit's candidates in a call, each carrying what
/// reaches it through the proxy.
pub struct Relays {
    proxy: Proxy,
    udp: bool,
    open: Mutex<HashMap<(String, String, u16), SocketAddr>>,
    tasks: Mutex<Vec<AbortHandle>>,
    /// When media last went each way, in milliseconds since `started`.
    udp_seen: AtomicU64,
    tcp_seen: AtomicU64,
    started: Instant,
}

impl Relays {
    /// The relay for one of LiveKit's candidates, opened the first time it's asked for. None
    /// for UDP through a proxy that carries none.
    pub fn relay_for(self: &Arc<Self>, protocol: &str, address: &str, port: u16) -> Option<SocketAddr> {
        if protocol == "udp" && !self.udp {
            return None;
        }
        let key = (protocol.to_string(), address.to_string(), port);
        if let Some(open) = self.open.lock().get(&key) {
            return Some(*open);
        }
        let _inside = crate::host::tokio().enter();
        let (local, task) = match protocol {
            "udp" => {
                let socket = std::net::UdpSocket::bind("127.0.0.1:0").and_then(|socket| socket.set_nonblocking(true).map(|_| socket)).ok()?;
                let local = socket.local_addr().ok()?;
                let socket = Arc::new(UdpSocket::from_std(socket).ok()?);
                (local, crate::host::tokio().spawn(udp_relay(socket, self.clone(), address.to_string(), port)).abort_handle())
            }
            "tcp" => {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.set_nonblocking(true).map(|_| listener)).ok()?;
                let local = listener.local_addr().ok()?;
                let listener = TcpListener::from_std(listener).ok()?;
                (local, crate::host::tokio().spawn(tcp_relay(listener, self.clone(), address.to_string(), port)).abort_handle())
            }
            _ => return None,
        };
        self.tasks.lock().push(task);
        self.open.lock().insert(key, local);
        Some(local)
    }

    fn saw(&self, udp: bool) {
        let now = self.started.elapsed().as_millis() as u64;
        if udp { &self.udp_seen } else { &self.tcp_seen }.store(now.max(1), Ordering::Relaxed);
    }

    fn close(&self) {
        for task in self.tasks.lock().drain(..) {
            task.abort();
        }
        self.open.lock().clear();
    }
}

impl Drop for Relays {
    fn drop(&mut self) {
        self.close();
    }
}

/// Carries what libwebrtc sends to a UDP candidate's relay: each socket it sends from gets an
/// association of its own, so answers find their way back to it.
async fn udp_relay(local: Arc<UdpSocket>, relays: Arc<Relays>, host: String, port: u16) {
    let mut sources: HashMap<SocketAddr, tokio::sync::mpsc::UnboundedSender<Vec<u8>>> = HashMap::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let Ok((length, from)) = local.recv_from(&mut buffer).await else { return };
        sources.retain(|_, sender| !sender.is_closed());
        let sender = sources.entry(from).or_insert_with(|| {
            let (sender, packets) = tokio::sync::mpsc::unbounded_channel();
            let task = tokio::spawn(association(local.clone(), relays.clone(), from, host.clone(), port, packets));
            relays.tasks.lock().push(task.abort_handle());
            sender
        });
        sender.send(buffer[..length].to_vec()).ok();
    }
}

/// One of libwebrtc's sockets' association: packets out wrapped for the proxy, and what comes
/// back unwrapped and sent on to that socket, for as long as the proxy keeps it.
async fn association(local: Arc<UdpSocket>, relays: Arc<Relays>, from: SocketAddr, host: String, port: u16, mut packets: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
    use tokio::io::AsyncReadExt;
    let (mut control, relay) = match crate::host::socks::associate(&relays.proxy).await {
        Ok(association) => association,
        Err(failure) => return log::info!("a call's UDP association: {failure}"),
    };
    let Ok(outside) = UdpSocket::bind(if relay.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).await else { return };
    log::debug!("a UDP association for {from}, to {host}:{port}");
    let mut buffer = vec![0u8; 65536];
    let mut closed = [0u8; 1];
    let (mut out, mut back) = (0u64, 0u64);
    loop {
        tokio::select! {
            packet = packets.recv() => {
                let Some(packet) = packet else { return };
                let Ok(wrapped) = crate::host::socks::wrap(&host, port, &packet) else { return };
                if outside.send_to(&wrapped, relay).await.is_err() { return }
                relays.saw(true);
                out += 1;
                if out.is_power_of_two() { log::debug!("UDP for {from}: {out} out, {back} back"); }
            }
            received = outside.recv_from(&mut buffer) => {
                let Ok((length, sender)) = received else { return };
                if sender != relay { continue }
                if let Some((_, payload)) = crate::host::socks::unwrap(&buffer[..length]) {
                    back += 1;
                    if let Err(error) = local.send_to(payload, from).await {
                        log::info!("a call's UDP back to {from} didn't go: {error}");
                    }
                }
            }
            // The association lasts as long as its connection: once the proxy ends it, so does this.
            ended = control.read(&mut closed) => if !matches!(ended, Ok(n) if n > 0) { return },
        }
    }
}

/// Carries each connection libwebrtc makes to a TCP candidate's relay over one the proxy opens.
async fn tcp_relay(listener: TcpListener, relays: Arc<Relays>, host: String, port: u16) {
    loop {
        let Ok((mut incoming, from)) = listener.accept().await else { return };
        log::debug!("a TCP connection from {from}, to {host}:{port}");
        let carrying = relays.clone();
        let host = host.clone();
        let task = tokio::spawn(async move {
            match crate::host::socks::connect(&carrying.proxy, &host, port).await {
                Ok(mut outgoing) => {
                    carrying.saw(false);
                    let carried = tokio::io::copy_bidirectional(&mut incoming, &mut outgoing).await;
                    log::debug!("a call's TCP connection ended: {carried:?}");
                }
                Err(failure) => log::info!("a call's TCP connection: {failure}"),
            }
        });
        relays.tasks.lock().push(task.abort_handle());
    }
}

/// livekit-net's WebSocket and HTTP clients, as the app makes them (host/net.rs).
struct Transport;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Connection {
    writer: AsyncMutex<SplitSink<Socket, Message>>,
    reader: AsyncMutex<SplitStream<Socket>>,
    /// The call's relays, while it goes through the proxy, which every message is rewritten for.
    relays: Option<Arc<Relays>>,
}

fn closed_by(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    use tokio_tungstenite::tungstenite::Error;
    use tokio_tungstenite::tungstenite::error::ProtocolError;
    matches!(error, Error::ConnectionClosed | Error::AlreadyClosed | Error::Protocol(ProtocolError::ResetWithoutClosingHandshake))
        || matches!(error, Error::Io(io) if io.kind() == std::io::ErrorKind::UnexpectedEof)
}

#[async_trait::async_trait]
impl WsClient for Transport {
    async fn connect(&self, url: String, headers: Vec<Header>, timeout_ms: u64) -> Result<WsConnectResult, TransportError> {
        let relays = match net::proxy() {
            Some(_) => Some(CURRENT.lock().clone().ok_or_else(|| TransportError::Other("a call through the proxy has no relays".into()))?),
            None => None,
        };
        let url = match &relays {
            Some(_) => crate::host::relay::join_address(url).await.map_err(TransportError::Other)?,
            None => url,
        };
        let mut request = url.as_str().into_client_request().map_err(|error| TransportError::Connection(error.to_string()))?;
        for header in headers {
            use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
            let name: HeaderName = header.name.parse().map_err(|_| TransportError::Other("bad header name".into()))?;
            let value = HeaderValue::from_str(&header.value).map_err(|_| TransportError::Other("bad header value".into()))?;
            request.headers_mut().insert(name, value);
        }
        let secure = request.uri().scheme_str() == Some("wss");
        let host = request.uri().host().unwrap_or_default().to_string();
        let port = request.uri().port_u16().unwrap_or(if secure { 443 } else { 80 });
        let connector = if secure { tokio_tungstenite::Connector::Rustls(Arc::new(crate::host::tls::client_config(&[b"http/1.1"]))) } else { tokio_tungstenite::Connector::Plain };
        let connecting = async {
            let stream = net::tcp(&host, port).await.map_err(|error| TransportError::Connection(error.to_string()))?;
            tokio_tungstenite::client_async_tls_with_config(request, stream, None, Some(connector)).await.map_err(|error| match error {
                tokio_tungstenite::tungstenite::Error::Http(response) => TransportError::Http { status: response.status().as_u16() },
                other => TransportError::Connection(other.to_string()),
            })
        };
        let (socket, _) = tokio::time::timeout(Duration::from_millis(timeout_ms), connecting).await.map_err(|_| TransportError::Timeout)??;
        let (writer, reader) = socket.split();
        Ok(WsConnectResult { connection: Arc::new(Connection { writer: AsyncMutex::new(writer), reader: AsyncMutex::new(reader), relays }) })
    }
}

#[async_trait::async_trait]
impl WsConnection for Connection {
    async fn send(&self, frame: Vec<u8>) -> Result<(), TransportError> {
        let frame = match &self.relays {
            Some(_) => match crate::host::relay::to_livekit(frame).await {
                Ok(frame) => frame,
                Err(why) => {
                    log::debug!("not sent to LiveKit: {why}");
                    return Ok(());
                }
            },
            None => frame,
        };
        self.writer.lock().await.send(Message::Binary(frame.into())).await.map_err(|error| TransportError::Connection(error.to_string()))
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, TransportError> {
        let mut reader = self.reader.lock().await;
        loop {
            match reader.next().await {
                Some(Ok(Message::Binary(data))) => {
                    let Some(relays) = &self.relays else { return Ok(Some(data.to_vec())) };
                    let relays = relays.clone();
                    let relay_for: crate::host::relay::RelayFor = Arc::new(move |protocol, address, port| relays.relay_for(protocol, address, port).map(|local| (local.ip().to_string(), local.port())));
                    match crate::host::relay::from_livekit(data.to_vec(), relay_for).await {
                        Ok(message) => return Ok(Some(message)),
                        Err(why) => log::info!("not given to LiveKit's SDK: {why}"),
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    self.writer.lock().await.send(Message::Pong(payload)).await.ok();
                }
                Some(Ok(Message::Close(_))) | None => return Ok(None),
                Some(Ok(_)) => continue,
                Some(Err(error)) if closed_by(&error) => return Ok(None),
                Some(Err(error)) => return Err(TransportError::Connection(error.to_string())),
            }
        }
    }

    async fn close(&self) {
        self.writer.lock().await.close().await.ok();
    }
}

#[async_trait::async_trait]
impl HttpClient for Transport {
    async fn request(&self, method: HttpMethod, url: String, headers: Vec<Header>, body: Option<Vec<u8>>) -> Result<HttpResponse, TransportError> {
        let client = net::client().use_preconfigured_tls(crate::host::tls_config()).connect_timeout(Duration::from_secs(15)).build().map_err(|error| TransportError::Other(error.to_string()))?;
        let mut request = match method {
            HttpMethod::Get => client.get(&url),
            HttpMethod::Post => client.post(&url),
        };
        for header in headers {
            request = request.header(header.name, header.value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| TransportError::Connection(crate::host::describe_request_error(&error.without_url())))?;
        let status = response.status().as_u16();
        let headers = response.headers().iter().filter_map(|(name, value)| value.to_str().ok().map(|value| Header { name: name.as_str().to_string(), value: value.to_string() })).collect();
        let body = response.bytes().await.map_err(|error| TransportError::Other(error.to_string()))?.to_vec();
        Ok(HttpResponse { status, headers, body })
    }
}
