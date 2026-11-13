//! `zuna-telegram --probe`, in builds with the `probe` feature alone: tries what the box around
//! the engine must refuse, and the one thing it must allow, and says how each went as one line of
//! JSON on standard output. The app's test of the box starts it boxed and reads that
//! (`src/platform/sandbox.rs`).
//!
//!   zuna-telegram --probe <its own folder> <a file it mustn't read> <a folder it mustn't list>

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::json;

fn outcome(result: std::io::Result<String>) -> String {
    match result {
        Ok(what) => format!("allowed: {what}"),
        Err(error) => format!("denied: {error}"),
    }
}

pub fn run(args: &[String]) {
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
    // Its own loopback, which the door is: allowed, or the door can't work.
    let loopback = outcome((|| {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let address = listener.local_addr()?;
        let accepting = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
            let (mut socket, _) = listener.accept()?;
            let mut buffer = [0u8; 5];
            socket.read_exact(&mut buffer)?;
            Ok(buffer.to_vec())
        });
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        client.write_all(b"hello")?;
        let heard = accepting.join().map_err(|_| std::io::Error::other("the listener panicked"))??;
        Ok(format!("{} bytes back", heard.len()))
    })());
    // Another program: denied.
    let start_program = outcome(
        std::process::Command::new(if cfg!(windows) { "C:\\Windows\\System32\\cmd.exe" } else { "/bin/sh" })
            .args(if cfg!(windows) { ["/c", "exit"] } else { ["-c", "exit"] })
            .status()
            .map(|status| format!("exited {status}")),
    );
    println!(
        "{}",
        json!({
            "ownFolder": own_folder,
            "readSecret": read_secret,
            "listElsewhere": list_elsewhere,
            "connectOut": connect_out,
            "telegramDirect": telegram_direct,
            "resolve": resolve,
            "loopback": loopback,
            "startProgram": start_program,
        })
    );
}
