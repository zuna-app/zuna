//! What the app and the engine say to each other over the engine's standard input and output.
//! Each frame is a 4-byte little-endian length, then that many bytes: a kind, and its body.
//!
//! - `j`: JSON, as UTF-8. One with an `@type` is TDLib's own, a request one way and a response or
//!   an update the other. One with a `zuna` field is the app's and the engine's: `start` from
//!   the app first, and the door's `open` from the engine, answered with `opened` or `refused`,
//!   and `closed` from either side.
//! - `d`: what a connection through the door carries: its number, 4 bytes little-endian, then
//!   the bytes, as they came.
//!
//! The app includes this file as it is (`#[path]` in `src/telegram/mod.rs`), so both ends read
//! and write the same frames.

use std::io::{Read, Write};

/// The largest frame either end takes. TDLib's largest answers, such as a long chat's history,
/// are a few megabytes.
pub const MAX_FRAME: usize = 32 << 20;
/// How much of a connection one data frame carries at most.
pub const MAX_DATA: usize = 64 << 10;

pub enum Frame {
    Json(String),
    Data(u32, Vec<u8>),
}

/// Writes a JSON frame without flushing, for callers that batch flushes.
pub fn write_json_buffered(out: &mut impl Write, json: &str) -> std::io::Result<()> {
    let length = u32::try_from(json.len() + 1).map_err(|_| std::io::Error::other("too large a frame"))?;
    let mut header = [0u8; 5];
    header[..4].copy_from_slice(&length.to_le_bytes());
    header[4] = b'j';
    out.write_all(&header)?;
    out.write_all(json.as_bytes())
}

/// Writes a JSON frame.
#[allow(dead_code)]
pub fn write_json(out: &mut impl Write, json: &str) -> std::io::Result<()> {
    write_json_buffered(out, json)?;
    out.flush()
}

/// Writes what a connection carried without flushing, for callers that batch flushes.
pub fn write_data_buffered(out: &mut impl Write, stream: u32, bytes: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(bytes.len() + 5).map_err(|_| std::io::Error::other("too large a frame"))?;
    let mut header = [0u8; 9];
    header[..4].copy_from_slice(&length.to_le_bytes());
    header[4] = b'd';
    header[5..9].copy_from_slice(&stream.to_le_bytes());
    out.write_all(&header)?;
    out.write_all(bytes)
}

/// Writes what a connection carried.
#[allow(dead_code)]
pub fn write_data(out: &mut impl Write, stream: u32, bytes: &[u8]) -> std::io::Result<()> {
    write_data_buffered(out, stream, bytes)?;
    out.flush()
}

/// Reads one frame, or None at the end of the stream. One over `MAX_FRAME`, of a kind neither end
/// writes, or JSON that isn't UTF-8 ends it with an error.
pub fn read_frame(input: &mut impl Read) -> std::io::Result<Option<Frame>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(std::io::Error::other(format!("a frame of {length} bytes")));
    }
    let mut kind = [0u8; 1];
    input.read_exact(&mut kind)?;
    match kind[0] {
        b'j' => {
            let mut body = vec![0u8; length - 1];
            input.read_exact(&mut body)?;
            String::from_utf8(body).map(|json| Some(Frame::Json(json))).map_err(|_| std::io::Error::other("JSON that isn't UTF-8"))
        }
        b'd' if length >= 5 => {
            let mut stream = [0u8; 4];
            input.read_exact(&mut stream)?;
            let mut body = vec![0u8; length - 5];
            input.read_exact(&mut body)?;
            Ok(Some(Frame::Data(u32::from_le_bytes(stream), body)))
        }
        kind => Err(std::io::Error::other(format!("a frame of kind {kind}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_go_both_ways() {
        let mut pipe = Vec::new();
        write_json(&mut pipe, r#"{"@type":"getMe"}"#).unwrap();
        write_data(&mut pipe, 7, b"\x00\xffhello").unwrap();
        let mut input = pipe.as_slice();
        assert!(matches!(read_frame(&mut input).unwrap(), Some(Frame::Json(json)) if json == r#"{"@type":"getMe"}"#));
        assert!(matches!(read_frame(&mut input).unwrap(), Some(Frame::Data(7, bytes)) if bytes == b"\x00\xffhello"));
        assert!(read_frame(&mut input).unwrap().is_none());
    }

    #[test]
    fn a_strange_frame_ends_the_stream() {
        let mut too_large = Vec::new();
        too_large.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert!(read_frame(&mut too_large.as_slice()).is_err());
        let unknown = [1u8, 0, 0, 0, b'x'];
        assert!(read_frame(&mut unknown.as_slice()).is_err());
        let empty = [0u8, 0, 0, 0];
        assert!(read_frame(&mut empty.as_slice()).is_err());
    }
}
