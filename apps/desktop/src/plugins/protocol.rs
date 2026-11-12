//! What the app and a plugin's host process say to each other: JSON messages, each a 4-byte
//! little-endian length and then that many bytes of UTF-8, over the host's standard input and
//! output. One host process runs one plugin, so the pipe a message comes on is the only thing
//! that says which plugin sent it.
//!
//! The app sends `boot` first, with the script and everything the plugin starts with, then
//! `call` (asking the plugin to run something, answered with `done`), `event` (telling it
//! something, unanswered), `reply` (answering an `ask`) and `stop`. The host sends `ready` or
//! `failed` once, then `ask` (a request for the broker, answered with `reply`), `done`, `log`
//! and `fault`, when the plugin went over a limit.

use std::io::{Read, Write};

/// The largest message the app takes from a host: a view, a decoration, a fetch's body.
pub const MAX_FROM_HOST: usize = 4 << 20;
/// The largest a host takes from the app: `boot` carries a script of up to 8 MB.
pub const MAX_TO_HOST: usize = 24 << 20;

/// Writes one message.
pub fn write_frame(out: &mut impl Write, json: &str) -> std::io::Result<()> {
    let length = u32::try_from(json.len()).map_err(|_| std::io::Error::other("too large a message"))?;
    out.write_all(&length.to_le_bytes())?;
    out.write_all(json.as_bytes())?;
    out.flush()
}

/// Reads one message, or None at the end of the stream. A message over `max` ends it with an error.
pub fn read_frame(input: &mut impl Read, max: usize) -> std::io::Result<Option<String>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > max {
        return Err(std::io::Error::other(format!("a message of {length} bytes, over the limit of {max}")));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    String::from_utf8(body).map(Some).map_err(|_| std::io::Error::other("a message that isn't UTF-8"))
}
