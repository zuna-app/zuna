//! The descriptions a Telegram call passes between this WebRTC and the core: the offers this
//! WebRTC makes, kept as files the core's tests read (packages/core/test/telegram-calls.test.ts),
//! and the answers the core writes from them, which a real peer connection must take. A new
//! LiveKit may write its offers differently, which these catch: write the offers again with
//! `UPDATE_TELEGRAM_CALL_FIXTURES=1`, then the answers with the core's test, and read the change.

use super::*;
use livekit::webrtc::stats::{IceRole, RtcStats};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core/test/fixtures/telegram-calls");

/// The calls' shapes the fixtures are of: the caller's and the one called's first offers, by
/// voice, and the caller's once its camera is on.
const SHAPES: &[(&str, bool, bool)] = &[("caller", true, false), ("callee", false, false), ("caller-camera", true, true)];

/// A peer connection as a call makes one in a shape, with its offer.
async fn offer_of(caller: bool, camera: bool) -> (PeerConnection, SessionDescription) {
    let runtime = LkRuntime::instance();
    let (pc, _channel) = connection(&runtime, Vec::new(), caller, crate::voice::room::VoiceRoom::microphone_source()).expect("a peer connection");
    if camera {
        let source = NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false);
        let track = runtime.pc_factory().create_video_track("camera", source);
        pc.add_transceiver(MediaStreamTrack::Video(track), RtpTransceiverInit { direction: RtpTransceiverDirection::SendOnly, stream_ids: vec!["zuna".into()], send_encodings: Vec::new() }).expect("a camera's transceiver");
    }
    receive(&pc, 1, 1).expect("transceivers taking the other side's");
    if !caller {
        answer_first(&pc).await.expect("the first offer answered");
    }
    let offer = pc.create_offer(offering()).await.expect("an offer");
    (pc, offer)
}

/// What makes an offer the same shape as another: its sections, their codecs and header extensions, not its keys or SSRCs.
fn shape(sdp: &str) -> Vec<String> {
    sdp.lines().filter(|line| line.starts_with("m=") || line.starts_with("a=mid:") || line.starts_with("a=rtpmap:") || line.starts_with("a=extmap:") || line.starts_with("a=sendonly") || line.starts_with("a=recvonly") || line.starts_with("a=fmtp:")).map(str::to_string).collect()
}

#[test]
fn offers_are_of_the_shape_the_core_was_tested_with() {
    let update = std::env::var("UPDATE_TELEGRAM_CALL_FIXTURES").is_ok_and(|value| value == "1");
    crate::host::tokio().block_on(async {
        for (name, caller, camera) in SHAPES {
            let (_pc, offer) = offer_of(*caller, *camera).await;
            let sdp = offer.to_string();
            // Relaying only: an offer made before gathering names no candidate and no address.
            assert!(!sdp.contains("a=candidate"), "{name}'s offer names a candidate");
            assert!(sdp.contains("m=application") && sdp.contains("a=sctp-port:5000"), "{name}'s offer has no data channel on port 5000");
            let path = format!("{FIXTURES}/offer-{name}.sdp");
            if update {
                std::fs::write(&path, &sdp).expect("the fixture written");
                continue;
            }
            let kept = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path} is missing: write it with UPDATE_TELEGRAM_CALL_FIXTURES=1"));
            assert_eq!(shape(&sdp), shape(&kept), "{name}'s offer isn't what the core was tested with: write the fixtures again and run the core's test");
        }
    });
}

/// What of an offer is this peer connection's own, in order: its ICE name and password, its
/// certificate's fingerprint, its SSRCs and its CNAME.
fn own(sdp: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for prefix in ["a=ice-ufrag:", "a=ice-pwd:", "a=fingerprint:sha-256 "] {
        if let Some(line) = sdp.lines().find(|line| line.starts_with(prefix)) {
            found.push(line[prefix.len()..].to_string());
        }
    }
    if let Some(cname) = sdp.lines().find_map(|line| line.strip_prefix("a=ssrc:").and_then(|rest| rest.split_once(" cname:")).map(|(_, cname)| cname.to_string())) {
        found.push(cname);
    }
    for line in sdp.lines().filter_map(|line| line.strip_prefix("a=ssrc:")) {
        let ssrc = line.split(' ').next().unwrap_or_default().to_string();
        if !found.contains(&ssrc) {
            found.push(ssrc);
        }
    }
    found
}

#[test]
fn the_cores_answers_are_taken() {
    crate::host::tokio().block_on(async {
        for (name, caller, camera) in SHAPES {
            let read = |what: &str| std::fs::read_to_string(format!("{FIXTURES}/{what}-{name}.sdp")).unwrap_or_else(|_| panic!("{what}-{name}.sdp is missing: the core's test writes it"));
            let (answer, prepared) = (read("answer"), read("prepared"));
            let (pc, offer) = offer_of(*caller, *camera).await;
            // The offer as the core gave it back, made this peer connection's own: its keys and
            // SSRCs in place of those of the one the fixture came from.
            let (theirs, mine) = (own(&prepared), own(&offer.to_string()));
            assert_eq!(theirs.len(), mine.len(), "{name}: the offer has changed shape");
            let mut sdp = prepared.clone();
            for (from, to) in theirs.iter().zip(&mine) {
                sdp = sdp.replace(from.as_str(), &format!("\u{0}{to}\u{0}"));
            }
            let sdp = sdp.replace('\u{0}', "");
            let local = SessionDescription::parse(&sdp, SdpType::Offer).unwrap_or_else(|error| panic!("{name}: {error}"));
            pc.set_local_description(local).await.unwrap_or_else(|error| panic!("{name}'s prepared offer wasn't set: {error:?}"));
            let remote = SessionDescription::parse(&answer, SdpType::Answer).unwrap_or_else(|error| panic!("{name}'s answer doesn't parse: {error}"));
            pc.set_remote_description(remote).await.unwrap_or_else(|error| panic!("{name}'s answer wasn't taken: {error:?}"));
            // What the other side said it sends now comes to this side, where the answer said so.
            let receiving = pc.transceivers().iter().filter(|transceiver| transceiver.current_direction() == Some(RtpTransceiverDirection::RecvOnly)).count();
            assert!(receiving >= 1, "{name}: nothing of the other side's is taken");
            let sending = pc.transceivers().iter().filter(|transceiver| transceiver.current_direction() == Some(RtpTransceiverDirection::SendOnly)).count();
            assert_eq!(sending, if *camera { 2 } else { 1 }, "{name}: this side's streams aren't all taken");
            // The caller controls ICE, as Telegram's apps take it to, and the one called never
            // claims to, which they'd answer with nothing but role conflicts.
            let roles: Vec<IceRole> = pc.get_stats().await.expect("its stats").into_iter().filter_map(|stats| if let RtcStats::Transport(transport) = stats { Some(transport.transport.ice_role) } else { None }).collect();
            let role = if *caller { IceRole::Controlling } else { IceRole::Controlled };
            assert!(!roles.is_empty() && roles.iter().all(|each| *each == role), "{name}: ICE's roles are {roles:?}, not {role:?}");
            pc.close();
        }
    });
}

#[test]
fn relays_are_telegrams_alone() {
    let servers = json!([
        { "urls": ["turn:149.154.167.51:3478?transport=udp", "turn:[2001:67c:4e8:f002::a]:3478?transport=udp"], "username": "u", "password": "p" },
        { "urls": ["turn:8.8.8.8:3478?transport=udp"], "username": "u", "password": "p" },
        { "urls": ["turn:turn.cloudflare.com:3478?transport=udp"], "username": "u", "password": "p" },
        { "urls": ["turn:149.154.167.51:3478?transport=tcp", "stun:149.154.167.51:3478"], "username": "u", "password": "p" },
        { "urls": ["turn:149.154.167.52:3478?transport=udp"], "username": "", "password": "p" },
    ]);
    let relays = relays(&servers);
    assert_eq!(relays.len(), 1);
    assert_eq!(relays[0].urls, vec!["turn:149.154.167.51:3478?transport=udp", "turn:[2001:67c:4e8:f002::a]:3478?transport=udp"]);
    assert!(!allowed_relay("127.0.0.1".parse().unwrap()) || cfg!(feature = "test-control"));
}

