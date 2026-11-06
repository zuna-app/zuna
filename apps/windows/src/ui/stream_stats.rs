//! What's going out and coming in over a call, as the desktop's stream stats window shows it
//! (StreamStatsPanel.tsx, voice/stats.ts): the connection, and this device's share.

use gpui::{AnyElement, App, Entity, FontWeight, IntoElement, ParentElement, Styled, div, prelude::*, px};

use super::components::*;
use crate::state::AppState;
use crate::theme::{self, RADIUS_L};
use crate::voice::settings::bitrate_name;
use crate::voice::{Voice, VoiceStatus};

struct Row {
    label: &'static str,
    value: String,
    warn: bool,
}

fn row(label: &'static str, value: impl Into<String>, warn: bool) -> Option<Row> {
    let value = value.into();
    (!value.is_empty()).then_some(Row { label, value, warn })
}

/// Which filters the microphone goes through, in words.
fn mic_filters(voice: &Voice) -> String {
    let settings = &voice.settings;
    let mut filters: Vec<String> = Vec::new();
    match settings.noise_suppression.as_str() {
        "zuna" => filters.push("RNNoise".into()),
        "standard" => filters.push("WebRTC's noise suppression".into()),
        _ => {}
    }
    filters.push(if settings.input_mode == "ptt" { "push to talk".into() } else if settings.auto_sensitivity { "a gate on speech".into() } else { format!("a gate at {} dB", settings.sensitivity) });
    if settings.echo_cancellation {
        filters.push("echo cancelling".into());
    }
    if settings.auto_gain {
        filters.push("automatic gain".into());
    }
    filters.join(", ")
}

pub fn panel(state: &Entity<AppState>, voice_entity: &Entity<Voice>, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let voice = voice_entity.read(cx);
    let _ = state;
    let room = voice.room();
    let status = match voice.status {
        VoiceStatus::Connected => "connected",
        VoiceStatus::Connecting => "connecting",
        VoiceStatus::Reconnecting => "reconnecting",
        VoiceStatus::Idle => "closed",
    };
    let host = room.as_ref().map(|room| url::Url::parse(&room.url).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default()).unwrap_or_default();
    let encrypted = room.as_ref().is_some_and(|room| room.encrypted());
    let key = room.as_ref().and_then(|room| room.key_state());
    let mut sections: Vec<(&'static str, Vec<Row>)> = vec![(
        "Connection",
        [
            row("Status", status, voice.status != VoiceStatus::Connected),
            row("Media server", host, false),
            row("In the room", room.as_ref().map(|room| room.people().to_string()).unwrap_or_default(), false),
            row("Encryption", if encrypted { format!("End to end{}", key.map(|(index, epoch)| format!(", key {index} from epoch {epoch}")).unwrap_or_default()) } else { "Off".into() }, !encrypted),
            row("Quality", format!("{:?}", voice.quality).to_lowercase(), false),
        ]
        .into_iter()
        .flatten()
        .collect(),
    )];
    sections.push(("Your microphone", [row("Filters", mic_filters(voice), false), row("Sending", if voice.mic_off() { "Nothing, muted".to_string() } else if voice.open { "Your voice".to_string() } else { "Silence, the gate is closed".to_string() }, false)].into_iter().flatten().collect()));
    if let Some(share) = &voice.screen {
        let info = share.info.clone().unwrap_or_default();
        let text = |name: &str| info.get(name).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        let number = |name: &str| info.get(name).and_then(serde_json::Value::as_u64);
        sections.push((
            "Your screen",
            [
                row("Sent through", if share.native { "Native program, on the graphics card" } else { "" }, false),
                row("Sharing", share.name.clone(), false),
                row("Capture and encoder", text("description"), false),
                row("Picture", match (number("width"), number("height")) {
                    (Some(width), Some(height)) => format!("{width}×{height}"),
                    _ => String::new(),
                }, false),
                row("Frame rate asked for", format!("{} fps", share.fps), false),
                row("Tallest asked for", if share.height > 0 { format!("{} lines", share.height) } else { String::new() }, false),
                row("Held to the server's limits", share.held.join(", "), false),
                row("Most asked for", bitrate_name(share.kbps), false),
                row("Encryption", if info.get("e2ee").and_then(serde_json::Value::as_bool).unwrap_or(false) { "End to end" } else if share.info.is_some() { "Off" } else { "" }, share.info.is_some() && !info.get("e2ee").and_then(serde_json::Value::as_bool).unwrap_or(false)),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ));
    }
    let close = voice_entity.clone();
    let _ = close;
    let mut body = div().id("stream-stats-body").flex().flex_col().overflow_y_scroll();
    for (index, (title, rows)) in sections.into_iter().enumerate() {
        let mut list = div().flex().flex_col().gap(px(3.)).px(px(11.)).pb(px(9.));
        for row in rows {
            let color = if row.warn { theme.amber } else { theme.text1 };
            list = list.child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(14.))
                    .child(div().flex_none().text_color(if row.warn { theme.amber } else { theme.text3 }).child(row.label))
                    .child(div().min_w_0().text_right().font_family(theme::FONT_MONO).text_size(px(11.)).line_height(px(16.)).text_color(color).child(row.value)),
            );
        }
        body = body.child(
            div()
                .when(index > 0, |el| el.border_t_1().border_color(theme.line))
                .child(div().px(px(11.)).py(px(8.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(title))
                .child(list),
        );
    }
    div()
        .id("stream-stats")
        .occlude()
        .absolute()
        .top(px(60.))
        .right(px(12.))
        .w(px(340.))
        .max_h(px(520.))
        .flex()
        .flex_col()
        .overflow_hidden()
        .text_size(px(12.))
        .bg(theme.bg1)
        .border_1()
        .border_color(theme.line_strong)
        .rounded(RADIUS_L)
        .shadow(shadow_l())
        .child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(7.))
                .pl(px(11.))
                .pr(px(5.))
                .py(px(7.))
                .text_color(theme.text2)
                .border_b_1()
                .border_color(theme.line)
                .child(icon("activity", 14., theme.text2))
                .child(div().flex_1().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("Stream stats")),
        )
        .child(body)
        .into_any_element()
}
