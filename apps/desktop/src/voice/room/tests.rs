//! What the app tells the media server about itself as it joins: nothing of the system it runs
//! on or the device's model, which LiveKit's SDK sends unless patches/livekit-signaling.patch
//! takes them out, and LiveKit writes to its log. And pictures sent turned, put upright.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use livekit_protocol as proto;
use parking_lot::Mutex;
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::VoiceRoom;
use crate::voice::audio::Mixer;

/// A token shaped as LiveKit's are, which nothing here checks.
fn token() -> String {
    let part = |json: &str| URL_SAFE_NO_PAD.encode(json);
    let claims = r#"{"iss":"key","sub":"someone.device","exp":4102444800,"video":{"room":"room","roomJoin":true}}"#;
    format!("{}.{}.{}", part(r#"{"alg":"HS256","typ":"JWT"}"#), part(claims), URL_SAFE_NO_PAD.encode([7u8; 32]))
}

/// Joins a room on a server on this machine that answers every request with a 404, which takes
/// the SDK from its v1 path to its v0 one, and says what each request asked for.
fn requests_of_a_join() -> Vec<String> {
    let runtime = crate::host::tokio();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = runtime.spawn({
        let asked = asked.clone();
        async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut chunk = [0u8; 8192];
                while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let line = String::from_utf8_lossy(&request).lines().next().unwrap_or_default().to_string();
                asked.lock().push(line);
                let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        }
    });
    let joined = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(30),
            VoiceRoom::join(url, token(), "someone.device".into(), 1, vec![9; 32], Mixer::new(Arc::default()), Arc::new(|_: &str, _: bool| 1.0)),
        )
        .await
    });
    assert!(matches!(joined, Ok(Err(_))), "the join should have been refused");
    server.abort();
    asked.lock().clone()
}

/// The query's pairs of a request line, `GET /rtc/v1?… HTTP/1.1`.
fn query(line: &str) -> Vec<(String, String)> {
    let target = line.split(' ').nth(1).unwrap_or_default();
    url::Url::parse(&format!("http://here{target}")).unwrap().query_pairs().into_owned().collect()
}

fn client_info(join_request: &str) -> proto::ClientInfo {
    let wrapped = proto::WrappedJoinRequest::decode(URL_SAFE.decode(join_request).unwrap().as_slice()).unwrap();
    let bytes = if wrapped.compression == proto::wrapped_join_request::Compression::Gzip as i32 {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(wrapped.join_request.as_slice()).read_to_end(&mut bytes).unwrap();
        bytes
    } else {
        wrapped.join_request
    };
    proto::JoinRequest::decode(bytes.as_slice()).unwrap().client_info.expect("a join request says who's joining")
}

#[test]
fn the_media_server_is_told_neither_the_system_nor_the_model() {
    let asked = requests_of_a_join();
    let v1 = asked.iter().find(|line| line.contains("/rtc/v1?")).unwrap_or_else(|| panic!("no v1 join was asked for: {asked:?}"));
    let v0 = asked.iter().find(|line| line.contains("/rtc?")).unwrap_or_else(|| panic!("no v0 join was asked for: {asked:?}"));

    let pairs = query(v1);
    let join_request = &pairs.iter().find(|(name, _)| name == "join_request").expect("the v1 join has its request").1;
    let info = client_info(join_request);
    assert_eq!((info.os.as_str(), info.os_version.as_str(), info.device_model.as_str()), ("", "", ""), "v1 sent {info:?}");
    // What the protocol needs is still there, so the check looked at the right thing.
    assert!(!info.version.is_empty() && info.protocol > 0, "v1 sent {info:?}");

    let pairs = query(v0);
    for name in ["os", "os_version", "device_model"] {
        let value = pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert!(matches!(value, None | Some("")), "v0 sent {name}={value:?}");
    }
    assert!(pairs.iter().any(|(key, value)| key == "sdk" && !value.is_empty()), "v0 sent {pairs:?}");
}

/// Pixels 0, 1, 2 over 3, 4, 5, each of the four bytes its number, and what's in each place once turned.
#[test]
fn a_picture_sent_turned_is_turned_upright() {
    use livekit::webrtc::prelude::VideoRotation;
    let picture: Vec<u8> = (0..6u8).flat_map(|pixel| [pixel; 4]).collect();
    let numbers = |(width, height, bgra): (u32, u32, Vec<u8>)| (width, height, bgra.chunks_exact(4).map(|pixel| pixel[0]).collect::<Vec<_>>());
    assert_eq!(numbers(super::upright(3, 2, picture.clone(), VideoRotation::VideoRotation0)), (3, 2, vec![0, 1, 2, 3, 4, 5]));
    // Clockwise, as libwebrtc's renderers turn it: the left column becomes the top row.
    assert_eq!(numbers(super::upright(3, 2, picture.clone(), VideoRotation::VideoRotation90)), (2, 3, vec![3, 0, 4, 1, 5, 2]));
    assert_eq!(numbers(super::upright(3, 2, picture.clone(), VideoRotation::VideoRotation180)), (3, 2, vec![5, 4, 3, 2, 1, 0]));
    assert_eq!(numbers(super::upright(3, 2, picture.clone(), VideoRotation::VideoRotation270)), (2, 3, vec![2, 5, 1, 4, 0, 3]));
    // Larger than a block each way, and turned all the way round, it's as it was.
    let (width, height) = (70u32, 45u32);
    let large: Vec<u8> = (0..width * height).flat_map(|pixel| pixel.to_le_bytes()).collect();
    let mut turned = (width, height, large.clone());
    for _ in 0..4 {
        turned = super::upright(turned.0, turned.1, turned.2, VideoRotation::VideoRotation90);
    }
    assert_eq!(turned, (width, height, large.clone()));
    let back = super::upright(width, height, large.clone(), VideoRotation::VideoRotation90);
    assert_eq!(super::upright(back.0, back.1, back.2, VideoRotation::VideoRotation270), (width, height, large));
}
