//! The app's end of a plugin's host process: starting the app's own executable as
//! `--plugin-host`, writing to it on a thread of its own, and handing what it writes back to the
//! broker. The process ends when it's stopped, when its pipe closes, or when the app goes, as its
//! standard input closes then.

use std::io::BufReader;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

use super::protocol::{MAX_FROM_HOST, read_frame, write_frame};

pub struct Process {
    child: Child,
    writer: Sender<String>,
}

impl Process {
    /// Starts a host and sends it `boot`. Each message it sends comes to `heard` on a thread of
    /// the pipe's own, and None once it has gone.
    pub fn start(boot: String, heard: impl Fn(Option<String>) + Send + 'static) -> std::io::Result<Process> {
        let exe = std::env::current_exe()?;
        let mut command = Command::new(exe);
        command.arg("--plugin-host").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        // Nothing of the app's logging or of where its data is goes with it.
        command.env_remove("ZUNA_DATA_DIR").env("RUST_LOG", "off");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window for it.
            command.creation_flags(0x0800_0000);
        }
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
                loop {
                    match read_frame(&mut input, MAX_FROM_HOST) {
                        Ok(Some(message)) => heard(Some(message)),
                        Ok(None) => break,
                        Err(error) => {
                            log::warn!(target: "plugins", "a plugin's host sent what it shouldn't: {error}");
                            break;
                        }
                    }
                }
                heard(None);
            })?;
        Ok(Process { child, writer })
    }

    pub fn send(&self, message: String) {
        self.writer.send(message).ok();
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.writer.send("{\"t\":\"stop\"}".into()).ok();
        self.child.kill().ok();
        self.child.wait().ok();
    }
}
