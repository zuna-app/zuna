//! What's going out and coming in, read from each track's WebRTC statistics through
//! LiveKit, in the sections the web's stream stats show (packages/ui/src/voice/stats.ts).

use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use livekit::prelude::*;
use livekit::webrtc::stats::RtcStats;

use super::ShareInfo;
use super::room::{VoiceRoom, parse_identity};

/// Losing more than this shows as worth a look.
const NOTICEABLE_LOSS: f64 = 0.02;
const HISTORY: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Microphone,
    Camera,
    Screen,
    ScreenSound,
}

/// One track's numbers at one moment.
#[derive(Clone, Debug)]
pub struct Sample {
    pub key: String,
    pub user_id: String,
    pub local: bool,
    pub video: bool,
    pub source: Source,
    /// A share sent from the desktop app, whose track is named `screen`, where a browser's and the
    /// iPhone's are `screen_share`.
    pub native: bool,
    pub encrypted: bool,
    pub muted: bool,
    pub numbers: HashMap<&'static str, f64>,
    pub texts: HashMap<&'static str, String>,
}

/// The connection's own numbers: its round trip, and what the network allows.
#[derive(Clone, Debug, Default)]
pub struct Connection {
    pub round_trip: Option<f64>,
    pub allows: Option<f64>,
}

fn source_of(source: TrackSource) -> Source {
    match source {
        TrackSource::Camera => Source::Camera,
        TrackSource::Screenshare => Source::Screen,
        TrackSource::ScreenshareAudio => Source::ScreenSound,
        _ => Source::Microphone,
    }
}

/// What a track's report says, in the few numbers and names the panel shows.
fn read(stats: &[RtcStats], local: bool) -> (HashMap<&'static str, f64>, HashMap<&'static str, String>, Connection) {
    let mut numbers = HashMap::new();
    let mut texts = HashMap::new();
    let mut connection = Connection::default();
    let mut codec_id = String::new();
    for stat in stats {
        match stat {
            RtcStats::OutboundRtp(rtp) if local => {
                codec_id = rtp.stream.codec_id.clone();
                let out = &rtp.outbound;
                for (name, value) in [
                    ("bytes", rtp.sent.bytes_sent as f64),
                    ("packets", rtp.sent.packets_sent as f64),
                    ("frames_encoded", out.frames_encoded as f64),
                    ("frames_sent", out.frames_sent as f64),
                    ("width", out.frame_width as f64),
                    ("height", out.frame_height as f64),
                    ("target_bitrate", out.target_bitrate),
                    ("key_frames", out.key_frames_encoded as f64),
                    ("pli", out.pli_count as f64),
                    ("nack", out.nack_count as f64),
                    ("resent", out.retransmitted_packets_sent as f64),
                    ("encode_time", out.total_encode_time),
                    ("huge_frames", out.huge_frames_sent as f64),
                ] {
                    *numbers.entry(name).or_insert(0.) += value;
                }
                if !out.encoder_implementation.is_empty() {
                    texts.insert("encoder", out.encoder_implementation.clone());
                }
                texts.insert("limited", format!("{:?}", out.quality_limitation_reason).to_lowercase());
            }
            RtcStats::InboundRtp(rtp) if !local => {
                codec_id = rtp.stream.codec_id.clone();
                let inbound = &rtp.inbound;
                for (name, value) in [
                    ("bytes", inbound.bytes_received as f64),
                    ("packets", rtp.received.packets_received as f64),
                    ("lost", rtp.received.packets_lost as f64),
                    ("frames_received", inbound.frames_received as f64),
                    ("frames_decoded", inbound.frames_decoded as f64),
                    ("frames_dropped", inbound.frames_dropped as f64),
                    ("width", inbound.frame_width as f64),
                    ("height", inbound.frame_height as f64),
                    ("decode_time", inbound.total_decode_time),
                    ("buffer_delay", inbound.jitter_buffer_delay),
                    ("buffer_emitted", inbound.jitter_buffer_emitted_count as f64),
                    // Not how long they took: LiveKit's SDK reads that from `totalFreezeDuration`,
                    // which libwebrtc calls `totalFreezesDuration`, so it's always 0.
                    ("freezes", inbound.freeze_count as f64),
                    ("key_frames", inbound.key_frames_decoded as f64),
                    ("pli", inbound.pli_count as f64),
                    ("nack", inbound.nack_count as f64),
                    ("concealed", inbound.concealed_samples as f64),
                    ("silent_concealed", inbound.silent_concealed_samples as f64),
                    ("samples", inbound.total_samples_received as f64),
                ] {
                    *numbers.entry(name).or_insert(0.) += value;
                }
                numbers.insert("jitter", rtp.received.jitter);
                if !inbound.decoder_implementation.is_empty() {
                    texts.insert("decoder", inbound.decoder_implementation.clone());
                }
            }
            RtcStats::RemoteInboundRtp(remote) if local => {
                numbers.insert("round_trip", remote.remote_inbound.round_trip_time);
                numbers.insert("fraction_lost", remote.remote_inbound.fraction_lost);
            }
            // The pair in use, which is the one with a round trip measured, nominated or not.
            RtcStats::CandidatePair(pair) if pair.candidate_pair.current_round_trip_time > 0. && (connection.round_trip.is_none() || pair.candidate_pair.nominated) => {
                connection.round_trip = Some(pair.candidate_pair.current_round_trip_time);
                connection.allows = Some(pair.candidate_pair.available_outgoing_bitrate).filter(|value| *value > 0.).or(connection.allows);
            }
            _ => {}
        }
    }
    for stat in stats {
        if let RtcStats::Codec(codec) = stat {
            if codec.rtc.id == codec_id {
                texts.insert("codec", codec.codec.mime_type.clone());
            }
        }
    }
    (numbers, texts, connection)
}

impl VoiceRoom {
    /// Each track's numbers now, those going out and those coming in, and the connection's.
    pub async fn samples(&self) -> (Vec<Sample>, Connection) {
        let mut samples = Vec::new();
        let mut connection = Connection::default();
        let local = self.room_handle().local_participant();
        let identity = local.identity().0;
        let user = parse_identity(&identity).map(|(user, _, _)| user).unwrap_or_default();
        for (sid, publication) in local.track_publications() {
            let Some(track) = publication.track() else { continue };
            let Ok(stats) = track.get_stats().await else { continue };
            let (numbers, texts, found) = read(&stats, true);
            if found.round_trip.is_some() {
                connection = found;
            }
            samples.push(Sample { key: format!("{identity}/{sid}"), user_id: user.clone(), local: true, video: publication.kind() == TrackKind::Video, source: source_of(publication.source()), native: false, encrypted: publication.encryption_type() != livekit::e2ee::EncryptionType::None, muted: publication.is_muted(), numbers, texts });
        }
        for participant in self.room_handle().remote_participants().values() {
            let identity = participant.identity().0;
            let Some((user, _, native)) = parse_identity(&identity) else { continue };
            for (sid, publication) in participant.track_publications() {
                let Some(track) = publication.track() else { continue };
                let Ok(stats) = track.get_stats().await else { continue };
                let (numbers, texts, found) = read(&stats, false);
                if connection.round_trip.is_none() && found.round_trip.is_some() {
                    connection = found;
                }
                samples.push(Sample { key: format!("{identity}/{sid}"), user_id: user.clone(), local: false, video: publication.kind() == TrackKind::Video, source: source_of(publication.source()), native: native || (publication.source() == TrackSource::Screenshare && publication.name() == "screen"), encrypted: publication.encryption_type() != livekit::e2ee::EncryptionType::None, muted: publication.is_muted(), numbers, texts });
            }
        }
        (samples, connection)
    }
}

#[derive(Clone, Debug)]
pub struct Row {
    pub label: &'static str,
    pub value: String,
    pub warn: bool,
}

#[derive(Clone, Debug)]
pub struct Headline {
    pub fps: Option<f64>,
    pub label: &'static str,
    pub wanted: Option<u32>,
    pub history: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub audio: bool,
    pub headline: Option<Headline>,
    pub rows: Vec<Row>,
}

fn row(label: &'static str, value: Option<String>, warn: bool) -> Option<Row> {
    value.filter(|value| !value.is_empty()).map(|value| Row { label, value, warn })
}

fn fps(value: Option<f64>) -> Option<String> {
    value.map(|value| format!("{value:.1} fps"))
}

fn ms(value: Option<f64>) -> Option<String> {
    value.map(|value| format!("{value:.1} ms"))
}

fn bits(per_second: Option<f64>) -> Option<String> {
    per_second.map(|value| if value >= 1_000_000. { format!("{:.1} Mbit/s", value / 1_000_000.) } else { format!("{} kbit/s", (value / 1000.).round()) })
}

fn count(value: Option<f64>) -> Option<String> {
    value.map(|value| {
        let whole = value.round() as i64;
        let text = whole.abs().to_string();
        let mut out = String::new();
        for (index, digit) in text.chars().enumerate() {
            if index > 0 && (text.len() - index) % 3 == 0 {
                out.push(',');
            }
            out.push(digit);
        }
        if whole < 0 { format!("-{out}") } else { out }
    })
}

fn percent(value: Option<f64>) -> Option<String> {
    value.map(|value| format!("{:.*}%", if value > 0. && value < 0.1 { 2 } else { 1 }, value * 100.))
}

fn size(width: Option<f64>, height: Option<f64>) -> Option<String> {
    match (width, height) {
        (Some(width), Some(height)) if width > 0. && height > 0. => Some(format!("{width}×{height}")),
        _ => None,
    }
}

fn joined(parts: &[Option<String>]) -> Option<String> {
    let parts: Vec<&String> = parts.iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.iter().map(|part| part.as_str()).collect::<Vec<_>>().join(", "))
}

/// Reads stream stats a second at a time, keeping what's needed to tell rates.
#[derive(Default)]
pub struct Reader {
    previous: HashMap<String, (Instant, HashMap<&'static str, f64>)>,
    history: HashMap<String, VecDeque<f64>>,
}

/// What else the panel shows besides the tracks.
pub struct Extra<'a> {
    pub status: &'a str,
    pub host: String,
    pub people: usize,
    pub encrypted: bool,
    pub key: Option<(i32, u64)>,
    pub share: Option<&'a ShareInfo>,
    pub native: Option<&'a serde_json::Value>,
    pub filters: String,
}

impl Reader {
    fn history(&mut self, key: &str, value: Option<f64>) -> Vec<f64> {
        let list = self.history.entry(key.to_string()).or_default();
        if let Some(value) = value {
            list.push_back(value);
            while list.len() > HISTORY {
                list.pop_front();
            }
        }
        list.iter().copied().collect()
    }

    pub fn read(&mut self, samples: &[Sample], connection: &Connection, extra: &Extra, name_of: &dyn Fn(&str) -> String) -> Vec<Section> {
        let mut sections = vec![Section {
            id: "connection".into(),
            title: "Connection".into(),
            audio: false,
            headline: None,
            rows: [
                row("Status", Some(extra.status.into()), extra.status != "connected"),
                row("Media server", Some(extra.host.clone()), false),
                row("In the room", Some(extra.people.to_string()), false),
                row("Encryption", Some(if extra.encrypted { format!("End to end{}", extra.key.map(|(index, epoch)| format!(", key {index} from epoch {epoch}")).unwrap_or_default()) } else { "Off".into() }), !extra.encrypted),
                row("Round trip", connection.round_trip.map(|value| format!("{:.0} ms", value * 1000.)), false),
                row("Network allows", bits(connection.allows), false),
            ]
            .into_iter()
            .flatten()
            .collect(),
        }];
        if let (Some(share), Some(native)) = (extra.share, extra.native) {
            let number = |name: &str| native.get(name).and_then(serde_json::Value::as_f64);
            let sent = number("fps");
            let history = self.history("native", sent);
            sections.push(Section {
                id: "native".into(),
                title: "Your screen".into(),
                audio: false,
                headline: Some(Headline { fps: sent, label: "sent", wanted: Some(share.fps), history }),
                rows: [
                    row("Sent through", Some("This app, on the graphics card".into()), false),
                    row("Sharing", Some(share.name.clone()), false),
                    row("Capture and encoder", share.info.as_ref().and_then(|info| info.get("description")).and_then(serde_json::Value::as_str).map(str::to_string), false),
                    row("Picture", size(number("width"), number("height")), false),
                    row("Tallest asked for", (share.height > 0).then(|| format!("{} lines", share.height)), false),
                    row("Held to the server's limits", (!share.held.is_empty()).then(|| share.held.join(", ")), false),
                    row("New frames", fps(number("fps")), false),
                    row("Repeated frames", fps(number("repeatFps")), false),
                    row("Bitrate", bits(number("kbps").map(|value| value * 1000.)), false),
                    row("Most asked for", bits(Some(share.kbps as f64 * 1000.)), false),
                    row("Network allows", bits(number("targetKbps").map(|value| value * 1000.)), false),
                    row("Encoder set to", bits(number("encoderKbps").map(|value| value * 1000.)), false),
                    row("Encode time", number("encodeMsAvg").map(|average| format!("{average:.1} ms, at most {:.1} ms", number("encodeMsMax").unwrap_or(0.))), false),
                    row("CPU", number("cpuCores").map(|cores| format!("{:.1}% of a core", cores * 100.)), false),
                    row("Keyframes", number("allKeys").map(|keys| format!("{}, {} asked for, {} for a new bitrate", count(Some(keys)).unwrap_or_default(), count(number("allKeyRequests")).unwrap_or_default(), count(number("allBitrateChanges")).unwrap_or_default())), false),
                    row("Frames refused", count(number("rejected")), number("rejected").unwrap_or(0.) > 0.),
                    row("Encryption", share.info.as_ref().map(|info| if info.get("e2ee").and_then(serde_json::Value::as_bool).unwrap_or(false) { "End to end".to_string() } else { "Off".to_string() }), false),
                ]
                .into_iter()
                .flatten()
                .collect(),
            });
        }
        let now = Instant::now();
        for sample in samples {
            let before = self.previous.insert(sample.key.clone(), (now, sample.numbers.clone()));
            let taken = before.as_ref().map(|(at, _)| now.duration_since(*at).as_secs_f64()).unwrap_or(0.);
            let get = |name: &str| sample.numbers.get(name).copied();
            let change = |name: &str| -> Option<f64> {
                let (_, previous) = before.as_ref()?;
                if taken <= 0. {
                    return None;
                }
                Some(get(name).unwrap_or(0.) - previous.get(name).copied().unwrap_or(0.))
            };
            let per_second = |name: &str| change(name).map(|moved| moved / taken);
            let each = |total: &str, of: &str| -> Option<f64> {
                let items = change(of)?;
                (items > 0.).then(|| change(total).unwrap_or(0.) / items)
            };
            let bitrate = per_second("bytes").map(|bytes| bytes * 8.);
            let text = |name: &str| sample.texts.get(name).cloned();
            let encryption = row("Encryption", Some(if sample.encrypted { "End to end".into() } else { "Off".into() }), !sample.encrypted);
            let (mine, theirs) = match sample.source {
                Source::Microphone => ("Your microphone", "microphone"),
                Source::Camera => ("Your camera", "camera"),
                Source::Screen => ("Your screen", "screen"),
                Source::ScreenSound => ("Your computer's sound", "shared sound"),
            };
            let title = if sample.local { mine.to_string() } else { format!("{}'s {theirs}", name_of(&sample.user_id)) };
            let section = match (sample.local, sample.video) {
                (true, true) => {
                    let sent = per_second("frames_sent");
                    let history = self.history(&sample.key, sent);
                    let lost = get("fraction_lost");
                    let limited = text("limited").filter(|reason| reason != "none");
                    Section {
                        id: sample.key.clone(),
                        title,
                        audio: false,
                        headline: Some(Headline { fps: sent, label: "sent", wanted: None, history }),
                        rows: [
                            row("Encoding", fps(per_second("frames_encoded")), false),
                            row("Sending", fps(sent), false),
                            row("Picture", size(get("width"), get("height")), false),
                            row("Codec", text("codec"), false),
                            row("Encoder", text("encoder"), false),
                            row("Bitrate", bits(bitrate), false),
                            row("Encoder aims for", bits(get("target_bitrate").filter(|value| *value > 0.)), false),
                            row("Encode time", ms(each("encode_time", "frames_encoded").map(|seconds| seconds * 1000.)), false),
                            row("Limited by", Some(limited.clone().unwrap_or_else(|| "Nothing".into())), limited.is_some()),
                            row("Keyframes", joined(&[count(get("key_frames")), Some(format!("{} asked for", count(get("pli")).unwrap_or_else(|| "0".into())))]), false),
                            row("Huge frames", count(get("huge_frames").filter(|value| *value > 0.)), false),
                            row("Packets", joined(&[count(get("packets")), Some(format!("{} sent again", count(get("resent")).unwrap_or_else(|| "0".into()))), Some(format!("{} NACK", count(get("nack")).unwrap_or_else(|| "0".into())))]), false),
                            row("Lost on the way", percent(lost), lost.unwrap_or(0.) > NOTICEABLE_LOSS),
                            row("Round trip", get("round_trip").filter(|value| *value > 0.).map(|value| format!("{:.0} ms", value * 1000.)), false),
                            encryption,
                        ]
                        .into_iter()
                        .flatten()
                        .collect(),
                    }
                }
                (false, true) => {
                    let decoded = per_second("frames_decoded");
                    let history = self.history(&sample.key, decoded);
                    let lost = match (change("lost"), change("packets")) {
                        (Some(lost), Some(received)) if lost + received > 0. => Some(lost.max(0.) / (lost.max(0.) + received)),
                        _ => None,
                    };
                    let dropped = per_second("frames_dropped");
                    Section {
                        id: sample.key.clone(),
                        title,
                        audio: false,
                        headline: Some(Headline { fps: decoded, label: "decoded", wanted: None, history }),
                        rows: [
                            row("Sent through", (sample.source == Source::Screen).then(|| if sample.native { "Their desktop app, on their graphics card".to_string() } else { "Their browser".to_string() }), false),
                            row("Receiving", fps(per_second("frames_received")), false),
                            row("Decoding", fps(decoded), false),
                            row("Frames dropped", joined(&[count(get("frames_dropped")), dropped.filter(|value| *value > 0.).map(|value| format!("{value:.1} a second"))]), dropped.unwrap_or(0.) > 0.),
                            row("Picture", size(get("width"), get("height")), false),
                            row("Codec", text("codec"), false),
                            row("Decoder", text("decoder"), false),
                            row("Bitrate", bits(bitrate), false),
                            row("Decode time", ms(each("decode_time", "frames_decoded").map(|seconds| seconds * 1000.)), false),
                            row("Jitter buffer", ms(each("buffer_delay", "buffer_emitted").map(|seconds| seconds * 1000.)), false),
                            row("Network jitter", ms(get("jitter").map(|seconds| seconds * 1000.)), false),
                            row("Freezes", count(get("freezes")), change("freezes").unwrap_or(0.) > 0.),
                            row("Keyframes", joined(&[count(get("key_frames")), Some(format!("{} asked for", count(get("pli")).unwrap_or_else(|| "0".into())))]), false),
                            row("Packets", joined(&[count(get("packets")), Some(format!("{} NACK", count(get("nack")).unwrap_or_else(|| "0".into())))]), false),
                            row("Lost", joined(&[count(get("lost")), percent(lost)]), lost.unwrap_or(0.) > NOTICEABLE_LOSS),
                            encryption,
                        ]
                        .into_iter()
                        .flatten()
                        .collect(),
                    }
                }
                (true, false) => {
                    let lost = get("fraction_lost");
                    Section {
                        id: sample.key.clone(),
                        title,
                        audio: true,
                        headline: None,
                        rows: [
                            row("Muted", sample.muted.then(|| "Yes".to_string()), false),
                            row("Cleaned up by", (sample.source == Source::Microphone).then(|| extra.filters.clone()), false),
                            row("Codec", text("codec"), false),
                            row("Bitrate", bits(bitrate), false),
                            row("Encoder aims for", bits(get("target_bitrate").filter(|value| *value > 0.)), false),
                            row("Packets", count(get("packets")), false),
                            row("Lost on the way", percent(lost), lost.unwrap_or(0.) > NOTICEABLE_LOSS),
                            row("Round trip", get("round_trip").filter(|value| *value > 0.).map(|value| format!("{:.0} ms", value * 1000.)), false),
                            encryption,
                        ]
                        .into_iter()
                        .flatten()
                        .collect(),
                    }
                }
                (false, false) => {
                    // What's made up over silence, as while they're muted or quiet with DTX,
                    // is comfort noise, not a gap anyone hears.
                    let concealed = change("samples").filter(|samples| *samples > 0.).map(|samples| (change("concealed").unwrap_or(0.) - change("silent_concealed").unwrap_or(0.)).max(0.) / samples);
                    let lost = match (change("lost"), change("packets")) {
                        (Some(lost), Some(received)) if lost + received > 0. => Some(lost.max(0.) / (lost.max(0.) + received)),
                        _ => None,
                    };
                    Section {
                        id: sample.key.clone(),
                        title,
                        audio: true,
                        headline: None,
                        rows: [
                            row("Muted", sample.muted.then(|| "Yes".to_string()), false),
                            row("Codec", text("codec"), false),
                            row("Bitrate", bits(bitrate), false),
                            row("Jitter buffer", ms(each("buffer_delay", "buffer_emitted").map(|seconds| seconds * 1000.)), false),
                            row("Network jitter", ms(get("jitter").map(|seconds| seconds * 1000.)), false),
                            row("Made up to hide gaps", percent(concealed), !sample.muted && concealed.unwrap_or(0.) > NOTICEABLE_LOSS),
                            row("Packets", count(get("packets")), false),
                            row("Lost", joined(&[count(get("lost")), percent(lost)]), lost.unwrap_or(0.) > NOTICEABLE_LOSS),
                            encryption,
                        ]
                        .into_iter()
                        .flatten()
                        .collect(),
                    }
                }
            };
            sections.push(section);
        }
        sections
    }
}

/// All of it as text, for pasting somewhere.
pub fn as_text(sections: &[Section]) -> String {
    sections
        .iter()
        .map(|section| {
            let mut lines = vec![format!("# {}", section.title)];
            if let Some(headline) = &section.headline {
                lines.push(format!("{}: {}{}", headline.label, fps(headline.fps).unwrap_or_else(|| "?".into()), headline.wanted.map(|wanted| format!(" (wanted {wanted})")).unwrap_or_default()));
            }
            for row in &section.rows {
                lines.push(format!("{}: {}{}", row.label, row.value, if row.warn { "  (!)" } else { "" }));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
