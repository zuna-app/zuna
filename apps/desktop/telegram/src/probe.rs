//! `zuna-telegram --probe`, in builds with the `probe` feature alone: tries what the box around
//! the engine must refuse, and the one thing it must allow, and says how each went as one line of
//! JSON on standard output. The app's test of the box starts it boxed and reads that
//! (`src/platform/sandbox.rs`). It runs where the engine would, after its door's port is bound
//! and, on Linux, its own half of the box closed (`main.rs`).
//!
//!   zuna-telegram --probe <its own folder> <a file it mustn't read> <a folder it mustn't list> [<a local socket it mustn't reach>]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::json;

fn outcome(result: std::io::Result<String>) -> String {
    match result {
        Ok(what) => format!("allowed: {what}"),
        Err(error) => format!("denied: {error}"),
    }
}

pub fn run(args: &[String], door: TcpListener) {
    let own = args.first().cloned().unwrap_or_default();
    let secret = args.get(1).cloned().unwrap_or_default();
    let elsewhere = args.get(2).cloned().unwrap_or_default();

    // Its own folder, which it keeps TDLib's database in: allowed.
    let own_folder = outcome((|| {
        let path = std::path::Path::new(&own).join("probe.txt");
        std::fs::write(&path, b"probe")?;
        let back = std::fs::read(&path)?;
        std::fs::remove_file(&path)?;
        Ok(format!("{} bytes", back.len()))
    })());
    // A file moved from one of its folders to another, as TDLib moves what it downloads from its
    // `temp` into place: allowed.
    let move_file = outcome((|| {
        let base = std::path::Path::new(&own);
        std::fs::create_dir_all(base.join("probe-from"))?;
        std::fs::create_dir_all(base.join("probe-to"))?;
        std::fs::write(base.join("probe-from").join("file"), b"probe")?;
        let moved = std::fs::rename(base.join("probe-from").join("file"), base.join("probe-to").join("file"));
        std::fs::remove_dir_all(base.join("probe-from")).ok();
        std::fs::remove_dir_all(base.join("probe-to")).ok();
        moved.map(|_| "moved".to_string())
    })());
    // A file of the app's, such as its sealed device key: denied.
    let read_secret = outcome(std::fs::read(&secret).map(|bytes| format!("{} bytes", bytes.len())));
    // Any other folder of the person's: denied.
    let list_elsewhere = outcome(std::fs::read_dir(&elsewhere).map(|entries| format!("{} entries", entries.count())));
    // The internet, by address and by name: denied.
    let connect_out = outcome(
        TcpStream::connect_timeout(&SocketAddr::from(([1, 1, 1, 1], 443)), Duration::from_secs(5)).map(|_| "1.1.1.1:443".to_string()),
    );
    let telegram_direct = outcome(
        TcpStream::connect_timeout(&SocketAddr::from(([149, 154, 167, 50], 443)), Duration::from_secs(5)).map(|_| "149.154.167.50:443".to_string()),
    );
    let resolve = outcome(("example.com", 443).to_socket_addrs().map(|found| format!("{} addresses", found.count())));
    // Its own loopback, where the door is: allowed, or the door can't work.
    let loopback = outcome((|| {
        let address = door.local_addr()?;
        let accepting = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
            let (mut socket, _) = door.accept()?;
            let mut buffer = [0u8; 5];
            socket.read_exact(&mut buffer)?;
            Ok(buffer.to_vec())
        });
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        client.write_all(b"hello")?;
        let heard = accepting.join().map_err(|_| std::io::Error::other("the listener panicked"))??;
        Ok(format!("{} bytes back", heard.len()))
    })());
    // The system's random numbers, which the door's secret is made of: allowed.
    let random = outcome((|| {
        let mut bytes = [0u8; 16];
        crate::door::random(&mut bytes)?;
        Ok(format!("{} bytes", bytes.len()))
    })());
    // Another program: denied.
    let start_program = outcome(
        std::process::Command::new(if cfg!(windows) { "C:\\Windows\\System32\\cmd.exe" } else { "/bin/sh" })
            .args(if cfg!(windows) { ["/c", "exit"] } else { ["-c", "exit"] })
            .status()
            .map(|status| format!("exited {status}")),
    );
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut found = json!({
        "ownFolder": own_folder,
        "moveFile": move_file,
        "readSecret": read_secret,
        "listElsewhere": list_elsewhere,
        "connectOut": connect_out,
        "telegramDirect": telegram_direct,
        "resolve": resolve,
        "loopback": loopback,
        "random": random,
        "startProgram": start_program,
    });
    #[cfg(target_os = "linux")]
    linux(&mut found, args.get(3).cloned());
    println!("{found}");
}

/// What only Linux's box has to refuse, as Windows' holds these by other means.
#[cfg(target_os = "linux")]
fn linux(found: &mut serde_json::Value, socket: Option<String>) {
    use serde_json::Value;
    use std::net::{Ipv4Addr, UdpSocket};
    let errno = |result: libc::c_long, what: &str| -> std::io::Result<String> { if result < 0 { Err(std::io::Error::last_os_error()) } else { Ok(what.to_string()) } };
    let parent = unsafe { libc::getppid() };
    let more = json!({
        // A port of its own besides the door, which nothing else could reach in its own network,
        // and which on a shared one would be a way in.
        "bindOther": outcome(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map(|listener| format!("{:?}", listener.local_addr()))),
        "udp": outcome(UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).map(|_| "bound".to_string())),
        // Another program's local socket, as the session's bus is: denied.
        "localSocket": outcome(match &socket {
            Some(path) => std::os::unix::net::UnixStream::connect(path).map(|_| format!("{path} connected")),
            None => Err(std::io::Error::other("no socket was named")),
        }),
        // The app that started it, by a signal and by ptrace: denied.
        "signal": outcome(errno(unsafe { libc::kill(parent, 0) } as libc::c_long, "signalled the app")),
        "ptrace": outcome(errno(unsafe { libc::ptrace(libc::PTRACE_ATTACH, parent, 0, 0) }, "attached to the app")),
        // A namespace of its own, a process of its own: denied.
        "namespace": outcome(errno(unsafe { libc::unshare(libc::CLONE_NEWUSER) } as libc::c_long, "made a user namespace")),
        "fork": outcome({
            let forked = unsafe { libc::syscall(libc::SYS_clone, libc::SIGCHLD as libc::c_ulong, 0, 0, 0, 0) };
            if forked == 0 {
                unsafe { libc::_exit(0) };
            }
            errno(forked, "forked")
        }),
        "dumpable": unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) },
    });
    if let (Value::Object(found), Value::Object(more)) = (found, more) {
        found.extend(more);
    }
}
