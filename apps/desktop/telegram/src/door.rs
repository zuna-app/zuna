//! The engine's end of the door: a SOCKS5 proxy on this process's own loopback, which TDLib is
//! told to use, and which opens nothing itself. Each connection TDLib makes through it is asked
//! of the app over the pipe (`open`), which decides whether it may go anywhere and opens the real
//! connection if so (`opened` or `refused`). From then on what either side sends goes over the
//! pipe as data frames, until one of them closes it (`closed`).
//!
//! It takes only a username and password made for this run, so that nothing else on the computer
//! uses it as a way to Telegram, and only addresses, never names: Telegram's servers are reached
//! by address, and the app connects to Telegram's own ranges alone.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::frame::MAX_DATA;

/// What goes out on the pipe to the app.
pub enum Outgoing {
    Json(String),
    Data(u32, Vec<u8>),
    /// Everything before it is written, and nothing after: the process is ending.
    End,
}

/// How long the handshake and the app's answer may take.
const HANDSHAKE: Duration = Duration::from_secs(30);

enum Stream {
    /// Asked of the app, waiting for its answer.
    Waiting(SyncSender<bool>),
    /// Open: what the app sends goes to TDLib through this.
    Open(Sender<Vec<u8>>, TcpStream),
}

#[derive(Clone)]
pub struct Door {
    pub port: u16,
    pub username: String,
    pub password: String,
    streams: Arc<Mutex<HashMap<u32, Stream>>>,
    next: Arc<AtomicU32>,
    out: Sender<Outgoing>,
}

fn random_text() -> String {
    let mut bytes = [0u8; 16];
    random(&mut bytes).expect("the system's random numbers");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The system's random numbers. On Linux the call itself: the crate looks for glibc's function by
/// name, which a program linked whole can't find, and then reads /dev/urandom, which the box
/// keeps it from.
#[cfg(target_os = "linux")]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    let mut filled = 0;
    while filled < bytes.len() {
        let got = unsafe { libc::getrandom(bytes[filled..].as_mut_ptr().cast(), bytes.len() - filled, 0) };
        if got < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
            continue;
        }
        filled += got as usize;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    getrandom::fill(bytes).map_err(|error| std::io::Error::other(error.to_string()))
}

impl Door {
    /// The door's port, of the system's choosing, on this process's own loopback: bound before the
    /// engine closes its box, which leaves it no other (`lockdown.rs`).
    pub fn bind() -> std::io::Result<TcpListener> {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
    }

    /// Starts taking TDLib's connections on the door's port.
    pub fn open(listener: TcpListener, out: Sender<Outgoing>) -> std::io::Result<Door> {
        let door = Door {
            port: listener.local_addr()?.port(),
            username: random_text(),
            password: random_text(),
            streams: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU32::new(1)),
            out,
        };
        let accepting = door.clone();
        std::thread::Builder::new().name("door".into()).spawn(move || {
            for connection in listener.incoming() {
                let Ok(connection) = connection else { continue };
                let door = accepting.clone();
                std::thread::Builder::new().name("door-stream".into()).spawn(move || door.serve(connection)).ok();
            }
        })?;
        Ok(door)
    }

    /// The app's answer to `open`.
    pub fn answered(&self, stream: u32, opened: bool) {
        if let Some(Stream::Waiting(answer)) = self.streams.lock().unwrap().get(&stream) {
            answer.try_send(opened).ok();
        }
    }

    /// What the app's end of a connection sent.
    pub fn data(&self, stream: u32, bytes: Vec<u8>) {
        if let Some(Stream::Open(writer, _)) = self.streams.lock().unwrap().get(&stream) {
            writer.send(bytes).ok();
        }
    }

    /// The app's end closed.
    pub fn closed(&self, stream: u32) {
        if let Some(Stream::Open(_, socket)) = self.streams.lock().unwrap().remove(&stream) {
            socket.shutdown(Shutdown::Both).ok();
        }
    }

    fn serve(&self, mut socket: TcpStream) {
        socket.set_nodelay(true).ok();
        socket.set_read_timeout(Some(HANDSHAKE)).ok();
        let target = match handshake(&mut socket, &self.username, &self.password) {
            Ok(Some(target)) => target,
            Ok(None) | Err(_) => return,
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, wait) = sync_channel(1);
        self.streams.lock().unwrap().insert(id, Stream::Waiting(answer));
        let open = json!({ "zuna": "open", "id": id, "host": target.ip().to_string(), "port": target.port() });
        self.out.send(Outgoing::Json(open.to_string())).ok();
        let answer = wait.recv_timeout(HANDSHAKE);
        if answer != Ok(true) {
            self.streams.lock().unwrap().remove(&id);
            // "Connection not allowed by ruleset".
            socket.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).ok();
            if answer.is_err() {
                // Not answered in time: whatever the app opens late is closed.
                self.out.send(Outgoing::Json(json!({ "zuna": "closed", "id": id }).to_string())).ok();
            }
            return;
        }
        if socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).is_err() {
            self.finish(id);
            return;
        }
        socket.set_read_timeout(None).ok();
        let (writer, writes) = channel::<Vec<u8>>();
        let (Ok(reading), Ok(writing)) = (socket.try_clone(), socket.try_clone()) else {
            self.finish(id);
            return;
        };
        self.streams.lock().unwrap().insert(id, Stream::Open(writer, socket));
        std::thread::Builder::new().name("door-write".into()).spawn(move || write_all(writing, writes)).ok();
        self.pump(id, reading);
    }

    /// Carries what TDLib sends on a connection to the app, until either end closes.
    fn pump(&self, id: u32, mut socket: TcpStream) {
        let mut buffer = vec![0u8; MAX_DATA];
        loop {
            match socket.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if self.out.send(Outgoing::Data(id, buffer[..count].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        self.finish(id);
    }

    /// TDLib's end closed, or failed: the app's end is told, if it's still open.
    fn finish(&self, id: u32) {
        if let Some(Stream::Open(_, socket)) = self.streams.lock().unwrap().remove(&id) {
            socket.shutdown(Shutdown::Both).ok();
            self.out.send(Outgoing::Json(json!({ "zuna": "closed", "id": id }).to_string())).ok();
        }
    }
}

fn write_all(mut socket: TcpStream, writes: Receiver<Vec<u8>>) {
    while let Ok(bytes) = writes.recv() {
        if socket.write_all(&bytes).is_err() {
            socket.shutdown(Shutdown::Both).ok();
            return;
        }
    }
}

/// SOCKS5's handshake (RFC 1928, with RFC 1929's username and password), for a CONNECT to an
/// address. Anything else is answered with the failure SOCKS5 has for it, and None.
fn handshake(socket: &mut (impl Read + Write), username: &str, password: &str) -> std::io::Result<Option<SocketAddr>> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head)?;
    if head[0] != 5 {
        return Ok(None);
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods)?;
    if !methods.contains(&2) {
        socket.write_all(&[5, 0xff])?;
        return Ok(None);
    }
    socket.write_all(&[5, 2])?;

    let mut version = [0u8; 2];
    socket.read_exact(&mut version)?;
    let mut given_user = vec![0u8; version[1] as usize];
    socket.read_exact(&mut given_user)?;
    let mut length = [0u8; 1];
    socket.read_exact(&mut length)?;
    let mut given_password = vec![0u8; length[0] as usize];
    socket.read_exact(&mut given_password)?;
    if version[0] != 1 || !same(&given_user, username.as_bytes()) || !same(&given_password, password.as_bytes()) {
        socket.write_all(&[1, 1])?;
        return Ok(None);
    }
    socket.write_all(&[1, 0])?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request)?;
    if request[0] != 5 || request[1] != 1 {
        // "Command not supported".
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])?;
        return Ok(None);
    }
    let ip = match request[3] {
        1 => {
            let mut octets = [0u8; 4];
            socket.read_exact(&mut octets)?;
            IpAddr::V4(Ipv4Addr::from(octets))
        }
        4 => {
            let mut octets = [0u8; 16];
            socket.read_exact(&mut octets)?;
            IpAddr::V6(Ipv6Addr::from(octets))
        }
        _ => {
            // "Address type not supported": a name, which the door never resolves.
            socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0])?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port)?;
    Ok(Some(SocketAddr::new(ip, u16::from_be_bytes(port))))
}

/// Compares two secrets in time that doesn't depend on where they differ.
fn same(given: &[u8], expected: &[u8]) -> bool {
    given.len() == expected.len() && given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A socket that reads from a script and keeps what's written to it.
    struct Script {
        input: std::io::Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl Read for Script {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl Write for Script {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn talk(input: Vec<u8>) -> (std::io::Result<Option<SocketAddr>>, Vec<u8>) {
        let mut script = Script { input: std::io::Cursor::new(input), written: Vec::new() };
        let result = handshake(&mut script, "user", "pass");
        (result, script.written)
    }

    fn greeting(user: &str, password: &str) -> Vec<u8> {
        let mut bytes = vec![5, 1, 2, 1, user.len() as u8];
        bytes.extend_from_slice(user.as_bytes());
        bytes.push(password.len() as u8);
        bytes.extend_from_slice(password.as_bytes());
        bytes
    }

    #[test]
    fn a_connect_to_an_address_is_asked_for() {
        let mut input = greeting("user", "pass");
        input.extend_from_slice(&[5, 1, 0, 1, 149, 154, 167, 40, 1, 187]);
        let (result, written) = talk(input);
        assert_eq!(result.unwrap(), Some("149.154.167.40:443".parse().unwrap()));
        assert_eq!(written, [5, 2, 1, 0]);

        let mut input = greeting("user", "pass");
        input.extend_from_slice(&[5, 1, 0, 4]);
        input.extend_from_slice(&"2001:67c:4e8:f002::a".parse::<Ipv6Addr>().unwrap().octets());
        input.extend_from_slice(&[0, 80]);
        assert_eq!(talk(input).0.unwrap(), Some("[2001:67c:4e8:f002::a]:80".parse().unwrap()));
    }

    #[test]
    fn a_name_is_never_resolved() {
        let mut input = greeting("user", "pass");
        input.extend_from_slice(&[5, 1, 0, 3, 10]);
        input.extend_from_slice(b"dns.google");
        input.extend_from_slice(&[1, 187]);
        let (result, written) = talk(input);
        assert_eq!(result.unwrap(), None);
        assert_eq!(&written[4..6], &[5, 8]);
    }

    #[test]
    fn only_this_run_s_secret_gets_in() {
        let (result, written) = talk(greeting("user", "wrong"));
        assert_eq!(result.unwrap(), None);
        assert_eq!(written, [5, 2, 1, 1]);
        // Without asking for a password at all.
        let (result, written) = talk(vec![5, 1, 0]);
        assert_eq!(result.unwrap(), None);
        assert_eq!(written, [5, 0xff]);
    }

    #[test]
    fn only_connect_is_done() {
        let mut input = greeting("user", "pass");
        // BIND.
        input.extend_from_slice(&[5, 2, 0, 1, 1, 2, 3, 4, 0, 80]);
        let (result, written) = talk(input);
        assert_eq!(result.unwrap(), None);
        assert_eq!(&written[4..6], &[5, 7]);
    }
}
