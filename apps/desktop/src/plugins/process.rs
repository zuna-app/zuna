//! The app's end of a plugin's host process: starting the app's own executable as
//! `--plugin-host`, writing to it on a thread of its own, and handing what it writes back to the
//! broker. The process ends when it's stopped, when its pipe closes, or when the app goes, as its
//! standard input closes then.

use std::io::BufReader;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

use super::protocol::{MAX_FROM_HOST, read_frame, write_frame};

/// The most messages a plugin's host may send in a second.
const MAX_PER_SECOND: u32 = 2000;

pub struct Process {
    /// None for the tests' host, which is no process (`fake`).
    child: Option<Child>,
    writer: Sender<String>,
    #[cfg(test)]
    fake: Option<Fake>,
}

impl Process {
    /// Starts a host and sends it `boot`. Each message it sends comes to `heard` on a thread of
    /// the pipe's own, and None once it has gone.
    #[cfg_attr(test, allow(dead_code))]
    pub fn start(boot: String, heard: impl Fn(Option<String>) + Send + 'static) -> std::io::Result<Process> {
        let exe = std::env::current_exe()?;
        let mut command = Command::new(exe);
        command.arg("--plugin-host");
        // Nothing of the app's logging or of where its data is goes with it.
        command.env_remove("ZUNA_DATA_DIR").env("RUST_LOG", "off");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window for it.
            command.creation_flags(0x0800_0000);
        }
        Process::run(command, boot, heard)
    }

    /// Starts a host by its command, with its pipes.
    fn run(mut command: Command, boot: String, heard: impl Fn(Option<String>) + Send + 'static) -> std::io::Result<Process> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no pipe to the host"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no pipe from the host"))?;
        let (writer, outbox) = std::sync::mpsc::channel::<String>();
        writer.send(boot).ok();
        std::thread::Builder::new()
            .name("plugin-writer".into())
            .spawn(move || {
                while let Ok(message) = outbox.recv() {
                    if write_frame(&mut stdin, &message).is_err() {
                        break;
                    }
                }
            })?;
        std::thread::Builder::new()
            .name("plugin-reader".into())
            .spawn(move || {
                let mut input = BufReader::new(stdout);
                // A plugin that floods the app, whose main thread answers each message, is ended
                // rather than kept up with.
                let mut window = std::time::Instant::now();
                let mut count = 0u32;
                loop {
                    match read_frame(&mut input, MAX_FROM_HOST) {
                        Ok(Some(message)) => {
                            if window.elapsed() > std::time::Duration::from_secs(1) {
                                window = std::time::Instant::now();
                                count = 0;
                            }
                            count += 1;
                            if count > MAX_PER_SECOND {
                                heard(Some("{\"t\":\"fault\",\"reason\":\"flood\"}".into()));
                                break;
                            }
                            heard(Some(message))
                        }
                        Ok(None) => break,
                        Err(error) => {
                            log::warn!(target: "plugins", "a plugin's host sent what it shouldn't: {error}");
                            break;
                        }
                    }
                }
                heard(None);
            })?;
        Ok(Process {
            child: Some(child),
            writer,
            #[cfg(test)]
            fake: None,
        })
    }

    pub fn send(&self, message: String) {
        self.writer.send(message).ok();
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.writer.send("{\"t\":\"stop\"}".into()).ok();
        if let Some(child) = &mut self.child {
            child.kill().ok();
            child.wait().ok();
        }
    }
}

/// The tests' host, which runs nothing: what the app sends it waits to be read, and the test says
/// what a host would.
#[cfg(test)]
struct Fake {
    outbox: std::sync::mpsc::Receiver<String>,
    heard: Box<dyn Fn(Option<String>) + Send>,
}

#[cfg(test)]
impl Process {
    /// A host for the tests, which the broker can't tell from one that runs: `sent` reads what the
    /// app sent it, `boot` first, and `say` speaks for it.
    pub fn fake(boot: String, heard: impl Fn(Option<String>) + Send + 'static) -> Process {
        let (writer, outbox) = std::sync::mpsc::channel();
        writer.send(boot).ok();
        Process { child: None, writer, fake: Some(Fake { outbox, heard: Box::new(heard) }) }
    }

    /// What the app sent the host since this was last asked.
    pub fn sent(&self) -> Vec<serde_json::Value> {
        let Some(fake) = &self.fake else { return Vec::new() };
        fake.outbox.try_iter().map(|message| serde_json::from_str(&message).unwrap_or(serde_json::Value::Null)).collect()
    }

    /// Says something as the host would, as it came on the pipe, or with None, closes it.
    pub fn say(&self, message: Option<String>) {
        if let Some(fake) = &self.fake {
            (fake.heard)(message);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::{MAX_PER_SECOND, Process};
    use crate::plugins::protocol::{MAX_FROM_HOST, read_frame, write_frame};

    /// A host that says back whatever it's told, as `cat` does with the frames.
    fn echo() -> (Process, mpsc::Receiver<Option<String>>) {
        let (heard, hearing) = mpsc::channel();
        let process = Process::run(Command::new("cat"), r#"{"t":"boot"}"#.into(), move |message| {
            heard.send(message).ok();
        })
        .expect("cat starts");
        (process, hearing)
    }

    #[test]
    fn a_host_is_sent_boot_first_and_heard_frame_by_frame() {
        let (process, hearing) = echo();
        let next = || hearing.recv_timeout(Duration::from_secs(10)).expect("the host answers");
        assert_eq!(next().as_deref(), Some(r#"{"t":"boot"}"#));
        process.send(r#"{"t":"call","n":1}"#.into());
        process.send("ünïcode".into());
        assert_eq!(next().as_deref(), Some(r#"{"t":"call","n":1}"#));
        assert_eq!(next().as_deref(), Some("ünïcode"));
        // Dropped, it's told to stop and ended, and its pipe closing is heard.
        drop(process);
        let mut last = next();
        while last.is_some() {
            last = next();
        }
    }

    #[test]
    fn a_host_that_floods_the_app_is_cut_off() {
        let (process, hearing) = echo();
        for n in 0..MAX_PER_SECOND + 50 {
            process.send(format!(r#"{{"n":{n}}}"#));
        }
        let mut heard = 0;
        loop {
            match hearing.recv_timeout(Duration::from_secs(10)).expect("the host answers") {
                Some(message) if message.contains("flood") => break,
                Some(_) => heard += 1,
                None => panic!("the pipe closed before the flood was noticed"),
            }
        }
        assert!(heard <= MAX_PER_SECOND as usize, "no more than its limit reaches the app: {heard}");
        assert_eq!(hearing.recv_timeout(Duration::from_secs(10)).unwrap(), None, "and nothing after it");
    }

    #[test]
    fn frames_are_held_to_their_limit_and_to_utf8() {
        let mut out = Vec::new();
        write_frame(&mut out, "hello").unwrap();
        assert_eq!(&out[..4], &5u32.to_le_bytes());
        let mut input = std::io::Cursor::new(out.clone());
        assert_eq!(read_frame(&mut input, MAX_FROM_HOST).unwrap().as_deref(), Some("hello"));
        assert_eq!(read_frame(&mut input, MAX_FROM_HOST).unwrap(), None, "the end of the stream");
        assert!(read_frame(&mut std::io::Cursor::new(out), 4).is_err(), "over the limit");
        let mut bad = 2u32.to_le_bytes().to_vec();
        bad.extend_from_slice(&[0xff, 0xfe]);
        assert!(read_frame(&mut std::io::Cursor::new(bad), MAX_FROM_HOST).is_err(), "not UTF-8");
        let mut short = 10u32.to_le_bytes().to_vec();
        short.extend_from_slice(b"abc");
        assert!(read_frame(&mut std::io::Cursor::new(short), MAX_FROM_HOST).is_err(), "cut short");
    }
}
