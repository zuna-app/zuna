//! A voice channel, open: everyone in it, what they're sharing, and its chat alongside. A
//! call is the same, above its conversation's chat, which it can take the whole of
//! (VoiceStage.tsx).

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    AnyElement, App, Bounds, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Pixels, Render, RenderImage, SharedString, Styled, Task, Window, canvas, div, img,
    prelude::*, px,
};

use super::components::*;
use super::motion::{Enter, Motion};
use super::menu::{Header, MenuEntry, open_menu_with_header};
use super::voice::mix;
use crate::format::avatar_color;
use crate::models::VoiceMember;
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, RADIUS_L, RADIUS_S};
use crate::voice::room::{VideoSource, VideoTile};
use crate::voice::{self, Voice, VoiceStatus};

const GAP: f32 = 10.;
const STRIP_HEIGHT: f32 = 104.;
const STRIP_WIDTH: f32 = 170.;

/// Which room the stage is of.
#[derive(Clone)]
pub struct StageRoom {
    pub server_id: String,
    pub id: String,
    /// A conversation's call, which sits above its chat, rather than a voice channel's room.
    pub call: bool,
}

pub struct VoiceStage {
    state: Entity<AppState>,
    voice: Entity<Voice>,
    room: StageRoom,
    /// A voice channel's chat, beside it.
    chat: Option<Entity<super::chat::ChatView>>,
    chat_open: bool,
    stats: Option<Entity<super::stream_stats::StreamStatsPanel>>,
    /// A call's stage takes the whole of its conversation, without the chat.
    pub expanded: bool,
    /// Each video's picture as last drawn, by its key: (serial, image).
    images: HashMap<String, (u64, Arc<RenderImage>)>,
    retired: Vec<Arc<RenderImage>>,
    area: Rc<Cell<Bounds<Pixels>>>,
    _tick: Task<()>,
}

impl VoiceStage {
    pub fn new(state: Entity<AppState>, room: StageRoom, cx: &mut Context<Self>) -> Self {
        let voice = voice::get(cx).expect("voice starts with the app");
        cx.observe(&voice, |_, _, cx| cx.notify()).detach();
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        // Videos are drawn as each new picture comes, on the screen's next frame, and a call's
        // time each second. A timer between them held a 60 fps share to about 30, as Windows
        // rounds a 33 ms wait up to its 15.6 ms ticks.
        let mut pictures = crate::voice::room::pictures();
        let tick = cx.spawn(async move |this, cx| loop {
            let videos = this.update(cx, |stage, cx| !stage.voice.read(cx).videos.is_empty()).unwrap_or(false);
            let second = cx.background_executor().timer(Duration::from_millis(500));
            if videos {
                futures::future::select(std::pin::pin!(pictures.changed()), second).await;
            } else {
                second.await;
            }
            if this.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        });
        VoiceStage { state, voice, room, chat: None, chat_open: false, stats: None, expanded: false, images: HashMap::new(), retired: Vec::new(), area: Rc::new(Cell::new(Bounds::default())), _tick: tick }
    }

    /// A video's newest picture, made into an image once per frame. Covering a 16:9 tile, it's
    /// cropped to 16:9 first: GPUI rounds a covering picture's corners past the tile's, where
    /// they'd be cut off square.
    fn picture(&mut self, tile: &VideoTile, cover: bool) -> Option<Arc<RenderImage>> {
        let frame = tile.feed.lock().clone()?;
        let key = if cover { format!("{}#cover", tile.key) } else { tile.key.clone() };
        if let Some((serial, image)) = self.images.get(&key) {
            if *serial == frame.serial {
                return Some(image.clone());
            }
        }
        let (mut width, mut height) = (frame.width, frame.height);
        let mut bytes = frame.bgra.as_ref().clone();
        if cover && width > 0 && height > 0 {
            let shape = 16. / 9.;
            let (keep_width, keep_height) = if width as f32 / height as f32 > shape { (((height as f32 * shape).round() as u32).clamp(1, width), height) } else { (width, ((width as f32 / shape).round() as u32).clamp(1, height)) };
            if (keep_width, keep_height) != (width, height) {
                let (left, top) = ((width - keep_width) / 2, (height - keep_height) / 2);
                let mut kept = Vec::with_capacity((keep_width * keep_height * 4) as usize);
                for row in top..top + keep_height {
                    let start = ((row * width + left) * 4) as usize;
                    kept.extend_from_slice(&bytes[start..start + (keep_width * 4) as usize]);
                }
                (bytes, width, height) = (kept, keep_width, keep_height);
            }
        }
        // Your own camera as you'd see yourself in a mirror.
        if tile.local && tile.source == VideoSource::Camera {
            let row = width as usize * 4;
            for line in bytes.chunks_mut(row) {
                let pixels: Vec<[u8; 4]> = line.chunks(4).rev().map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]]).collect();
                for (index, pixel) in pixels.iter().enumerate() {
                    line[index * 4..index * 4 + 4].copy_from_slice(pixel);
                }
            }
        }
        let buffer = image::RgbaImage::from_raw(width, height, bytes)?;
        let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
        if let Some((_, old)) = self.images.insert(key, (frame.serial, image.clone())) {
            self.retired.push(old);
        }
        Some(image)
    }

    fn video(&mut self, tile: &VideoTile, contain: bool) -> AnyElement {
        match self.picture(tile, !contain) {
            Some(image) => img(image).size_full().object_fit(if contain { gpui::ObjectFit::Contain } else { gpui::ObjectFit::Fill }).rounded(RADIUS_L).into_any_element(),
            None => div().size_full().bg(gpui::black()).into_any_element(),
        }
    }

    fn open_member_menu(&self, user_id: String, member: Option<VoiceMember>, position: gpui::Point<Pixels>, cx: &mut App) {
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id) else { return };
        let voice = self.voice.read(cx);
        let self_id = server.self_id().to_string();
        let is_self = user_id == self_id;
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let target_role = server.users.get(&user_id).map(|user| user.role.clone()).unwrap_or_default();
        // In a call, which is between the people in it, admins have no say.
        let can_moderate = !self.room.call && !is_self && (role == "owner" || (role == "admin" && target_role == "member"));
        let stream_sound = voice.videos.iter().any(|video| video.user_id == user_id && video.sound);
        let mut entries = Vec::new();
        let voice_entity = self.voice.clone();
        if is_self {
            // On yourself, what the buttons below the call do, as there's nothing to do to yourself.
            if !voice.server_muted && !voice.no_mic {
                let voice = voice_entity.clone();
                let off = voice_entity.read(cx).muted || voice_entity.read(cx).deafened;
                entries.push(MenuEntry::new(if off { "Unmute" } else { "Mute" }, if off { "mic" } else { "mic-off" }, move |_, cx| voice.update(cx, |voice, cx| voice.toggle_mute(cx))));
            }
            let deafened = voice.deafened;
            let deafen = voice_entity.clone();
            entries.push(MenuEntry::new(if deafened { "Undeafen" } else { "Deafen" }, if deafened { "headphones" } else { "headphone-off" }, move |_, cx| deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))));
            let settings = self.state.clone();
            entries.push(MenuEntry::new("Voice settings", "settings", move |_, cx| settings.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some("voice".into()) }), cx))));
        } else {
            let local_muted = voice.local_mutes.contains(&user_id);
            let (mute, user) = (voice_entity.clone(), user_id.clone());
            entries.push(MenuEntry::new(if local_muted { "Unmute for me" } else { "Mute for me" }, if local_muted { "volume-2" } else { "volume-x" }, move |_, cx| mute.update(cx, |voice, cx| voice.toggle_local_mute(&user, cx))));
            let (verify, user) = (self.state.clone(), user_id.clone());
            entries.push(MenuEntry::new("Verify with emoji", "lock", move |_, cx| verify.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user.clone() }), cx))));
        }
        if can_moderate {
            entries.push(MenuEntry::separator());
            let server_muted = member.as_ref().is_some_and(|member| member.server_muted);
            let act = |method: &'static str, args: Vec<serde_json::Value>| {
                let (state, server_id) = (self.state.clone(), self.room.server_id.clone());
                move |_: &mut Window, cx: &mut App| {
                    let args = args.clone();
                    state.update(cx, |state, cx| {
                        state.call(Some(&server_id), method, args, cx, |state, result, cx| {
                            if let Err(error) = result {
                                state.toast(error.message, ToastKind::Error, cx);
                            }
                        })
                    })
                }
            };
            let channel = serde_json::json!(self.room.id);
            let user = serde_json::json!(user_id);
            entries.push(MenuEntry::new(if server_muted { "Let them talk" } else { "Mute for everyone" }, "shield-off", act("voiceMute", vec![channel.clone(), user.clone(), serde_json::json!(!server_muted)])));
            if member.as_ref().is_some_and(|member| member.screen) {
                entries.push(MenuEntry::new("Stop their screen share", "monitor-off", act("voiceScreenStopOf", vec![channel.clone(), user.clone()])));
            }
            entries.push(MenuEntry::new("Disconnect", "user-x", act("voiceDisconnect", vec![channel, user])).danger());
        }
        let header: Option<Header> = (!is_self).then(|| {
            let (voice, user) = (voice_entity.clone(), user_id.clone());
            Rc::new(move |_: &mut Window, cx: &mut App| -> AnyElement {
                let theme = theme(cx);
                let current = voice.read(cx);
                let level = current.volumes.get(&user).copied().unwrap_or(1.);
                let stream = current.stream_volumes.get(&user).copied().unwrap_or(1.);
                let row = |id: &'static str, label: &'static str, value: f32, stream_volume: bool, voice: Entity<Voice>, user: String, cx: &App| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .px(px(10.))
                        .pt(px(6.))
                        .pb(px(6.))
                        .min_w(px(210.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .child(div().flex().gap(px(4.)).child(label).child(div().font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(format!("{}%", (value * 100.).round()))))
                        .child(slider(id, value / 2., move |fraction, _, cx| {
                            let user = user.clone();
                            voice.update(cx, |voice, cx| if stream_volume { voice.set_stream_volume(&user, fraction * 2., cx) } else { voice.set_volume(&user, fraction * 2., cx) })
                        }, cx))
                };
                let mut header = div().flex().flex_col().child(row("member-volume", "Volume", level, false, voice.clone(), user.clone(), cx));
                if stream_sound {
                    header = header.child(row("member-stream-volume", "Stream volume", stream, true, voice.clone(), user.clone(), cx));
                }
                header.into_any_element()
            }) as Header
        });
        open_menu_with_header(position, header, entries, false, cx);
    }

    fn person_tile(&mut self, member: &VoiceMember, camera: Option<&VideoTile>, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id) else { return div().into_any_element() };
        let is_self = member.user_id == server.self_id();
        let user = server.users.get(&member.user_id).cloned();
        let voice = self.voice.read(cx);
        let speaking = if is_self { voice.self_speaking() } else { voice.speaking.contains(&member.user_id) };
        let local_muted = voice.local_mutes.contains(&member.user_id);
        let sounding = voice.sounding.get(&member.user_id).cloned();
        let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = self.room.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        let content = match camera {
            Some(tile) => self.video(tile, false),
            None => avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 84., online: false, rounded: false, dot_border: theme.bg2 }, cx).into_any_element(),
        };
        let user_id = member.user_id.clone();
        let menu_member = member.clone();
        let focus_key = camera.map(|tile| tile.key.clone());
        let mut label = div().absolute().left(px(8.)).bottom(px(8.)).max_w(px(size.0 - 16.)).flex().items_center().gap(px(5.)).px(px(8.)).py(px(3.)).rounded(px(6.)).text_size(px(12.5)).text_color(gpui::white()).bg(theme::color(theme::black_a(0.62)));
        if member.server_muted {
            label = label.child(icon("mic-off", 13., theme.red));
        } else if member.muted {
            label = label.child(icon("mic-off", 13., gpui::white()));
        }
        if member.deafened {
            label = label.child(icon("headphone-off", 13., gpui::white()));
        }
        if local_muted {
            label = label.child(icon("volume-x", 13., gpui::white()));
        }
        label = label.child(div().min_w_0().one_line().child(if is_self { format!("{name} (you)") } else { name.clone() }));
        div()
            .id(SharedString::from(format!("person-{}", member.device_id)))
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .rounded(RADIUS_L)
            .bg(if camera.is_some() { gpui::black() } else { mix(theme::css(avatar_color(&member.user_id)), theme.bg2, 0.16) })
            .child(content)
            .when_some(sounding, |el, emoji| {
                // `.voice-tile-played`: in over 160 ms, as it starts playing.
                el.child(div().absolute().right(px(8.)).top(px(8.)).min_w(px(30.)).h(px(30.)).px(px(6.)).flex().items_center().justify_center().rounded(px(15.)).bg(theme::color(theme::black_a(0.62))).text_size(px(17.)).child(emoji.clone()).appear(SharedString::from(format!("played-{}-{emoji}", member.user_id)), Enter::Pop, 160))
            })
            .child(label)
            .when(speaking, |el| el.child(div().absolute().inset_0().rounded(RADIUS_L).border_2().border_color(theme.green)))
            .when_some(focus_key, |el, key| {
                let voice = self.voice.clone();
                el.cursor_pointer().on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_focus(Some(key.clone()), cx)))
            })
            .on_mouse_down(MouseButton::Right, cx.listener(move |stage, event: &gpui::MouseDownEvent, _, cx| {
                stage.open_member_menu(user_id.clone(), Some(menu_member.clone()), event.position, cx);
                cx.stop_propagation();
            }))
            .into_any_element()
    }

    fn screen_tile(&mut self, tile: &VideoTile, focused: bool, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let name = self.state.read(cx).servers.get(&self.room.server_id).and_then(|server| server.users.get(&tile.user_id)).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let video = self.video(tile, true);
        let key = tile.key.clone();
        let user_id = tile.user_id.clone();
        let group = SharedString::from(format!("screen-{}", tile.key));
        let voice = self.voice.clone();
        let toggle_focus = {
            let (voice, key) = (voice.clone(), key.clone());
            move |cx: &mut App| voice.update(cx, |voice, cx| voice.set_focus(if focused { None } else { Some(key.clone()) }, cx))
        };
        let toggle_focus_click = toggle_focus.clone();
        let stream_volume = self.voice.read(cx).stream_volumes.get(&tile.user_id).copied().unwrap_or(1.);
        let mut element = div()
            .id(SharedString::from(format!("screen-tile-{}", tile.key)))
            .group(group.clone())
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .overflow_hidden()
            .rounded(RADIUS_L)
            .bg(gpui::black())
            .cursor_pointer()
            .on_click(move |event, window, cx| {
                if event.click_count() >= 2 {
                    window.toggle_fullscreen();
                } else {
                    toggle_focus_click(cx);
                }
            })
            .child(video)
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .bottom(px(8.))
                    .max_w(px((size.0 - if tile.sound { 150. } else { 16. }).max(40.)))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .bg(theme::color(theme::black_a(0.62)))
                    .child(icon("monitor-up", 13., gpui::white()))
                    .child(div().min_w_0().one_line().child(if tile.local { "Your screen".to_string() } else { format!("{name}'s screen") })),
            )
            .child(
                div()
                    .absolute()
                    .right(px(8.))
                    .top(px(8.))
                    .flex()
                    .gap(px(4.))
                    .opacity(0.)
                    .group_hover(group.clone(), |style| style.opacity(1.))
                    .child(
                        div()
                            .id(SharedString::from(format!("screen-pin-{key}")))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_S)
                            .bg(theme::color(theme::black_a(0.62)))
                            .tip(if focused { "Back to everyone" } else { "Fill the stage" }, Side::Bottom)
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                toggle_focus(cx);
                            })
                            .child(icon(if focused { "pin-off" } else { "pin" }, 15., gpui::white())),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("screen-full-{key}")))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_S)
                            .bg(theme::color(theme::black_a(0.62)))
                            .tip("Full screen", Side::Bottom)
                            .on_click(|_, window, cx| {
                                cx.stop_propagation();
                                window.toggle_fullscreen();
                            })
                            .child(icon("expand", 15., gpui::white())),
                    ),
            )
            .on_mouse_down(MouseButton::Right, cx.listener(move |stage, event: &gpui::MouseDownEvent, _, cx| {
                stage.open_member_menu(user_id.clone(), None, event.position, cx);
                cx.stop_propagation();
            }));
        if tile.sound {
            // A share's sound, at the bottom right as in a video player, with room left for the name.
            let (mute_voice, slide_voice, user, slide_user) = (voice.clone(), voice, tile.user_id.clone(), tile.user_id.clone());
            let silent = stream_volume == 0.;
            element = element.child(
                div()
                    .id(SharedString::from(format!("screen-sound-{key}")))
                    .absolute()
                    .right(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .pr(px(10.))
                    .rounded(px(6.))
                    .bg(theme::color(theme::black_a(0.62)))
                    .opacity(0.)
                    .group_hover(group, |style| style.opacity(1.))
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .id(SharedString::from(format!("screen-mute-{key}")))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .tooltip(tooltip(if silent { "Unmute stream" } else { "Mute stream" }))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let user = user.clone();
                                mute_voice.update(cx, |voice, cx| {
                                    let before = voice.stream_volumes.get(&user).copied().unwrap_or(1.);
                                    voice.set_stream_volume(&user, if before == 0. { 1. } else { 0. }, cx);
                                });
                            })
                            .child(icon(if silent { "volume-x" } else { "volume-2" }, 15., gpui::white())),
                    )
                    .when(size.0 > 300., |el| {
                        el.child(div().w(px(96.)).child(slider(SharedString::from(format!("screen-volume-{key}")), stream_volume / 2., move |fraction, _, cx| {
                            let user = slide_user.clone();
                            slide_voice.update(cx, |voice, cx| voice.set_stream_volume(&user, fraction * 2., cx));
                        }, cx)))
                    }),
            );
        }
        let _ = theme;
        element.into_any_element()
    }

    fn ringing_tile(&mut self, user_id: &str, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let user = self.state.read(cx).servers.get(&self.room.server_id).and_then(|server| server.users.get(user_id)).cloned();
        let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = self.room.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        div()
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .rounded(RADIUS_L)
            .opacity(0.8)
            .bg(mix(theme::css(avatar_color(user_id)), theme.bg2, 0.1))
            .child(
                div().child(avatar(AvatarProps { name: name.clone(), seed: user_id.to_string(), image, size: 84., online: false, rounded: false, dot_border: theme.bg2 }, cx)).map(|ring| super::motion::pulse(ring, SharedString::from(format!("ringing-{user_id}")), 1600, |el, delta| el.opacity(1. - 0.3 * (1. - (delta * 2. - 1.).abs())))),
            )
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .bg(theme::color(theme::black_a(0.62)))
                    .child(div().one_line().child(name))
                    .child(div().text_color(theme::color(theme::white_a(0.7))).child("Calling…")),
            )
            .into_any_element()
    }

    fn controls(&mut self, share_refusal: Option<&'static str>, sounds: bool, chat_unread: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let voice = self.voice.read(cx);
        let mic_off = voice.mic_off();
        let (deafened, camera, sharing, open, server_muted, no_mic) = (voice.deafened, voice.camera, voice.screen.is_some(), voice.open, voice.server_muted, voice.no_mic);
        let control = |id: &'static str, icon_name: &'static str, color: gpui::Hsla, bg: gpui::Hsla, label: String, disabled: bool| {
            let key = format!("control-{id}");
            super::motion::track_hover(div().id(id), key.clone())
                .relative()
                .size(px(44.))
                .flex_none()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(bg)
                .when(!disabled, |el| el.cursor_pointer())
                // `.voice-control:hover`: bg-4 over 100 ms, which a lit one keeps its color through.
                .when(!disabled && bg == theme.bg3, |el| el.child(super::motion::hover_layer(&key, theme.bg4, px(22.), 100)))
                .when(disabled, |el| el.opacity(0.55))
                .tip(label, Side::Top)
                .child(icon(icon_name, 20., color))
        };
        let group = |id: &'static str, more: &'static str, off: bool, main: gpui::Stateful<gpui::Div>, input: bool, voice: Entity<Voice>, state: Entity<AppState>| {
            div()
                .id(id)
                .flex()
                .items_center()
                .h(px(44.))
                .overflow_hidden()
                .rounded(px(22.))
                .bg(if off { theme.red_soft } else { theme.bg3 })
                .child(main)
                .child(
                    super::motion::track_hover(div().id(more), format!("control-{more}"))
                        .group(more)
                        .relative()
                        .flex()
                        .items_center()
                        .justify_center()
                        .pl(px(5.))
                        .pr(px(15.))
                        .h_full()
                        // GPUI clips to a rectangle, not the pill's rounding, so each half rounds its own end.
                        .rounded_r(px(22.))
                        .cursor_pointer()
                        .child(super::motion::hover_layer_corners(&format!("control-{more}"), theme.hover_strong, gpui::Corners { top_left: px(0.), bottom_left: px(0.), top_right: px(22.), bottom_right: px(22.) }, 100))
                        .on_click(move |event, _, cx| device_menu(&voice, &state, input, event.position(), cx))
                        .child(icon("chevron-up", 14., theme.text2).group_hover(more, move |style| style.text_color(theme.text1))),
                )
        };
        let pill = |id: &'static str, icon_name: &'static str, color: gpui::Hsla, label: String, disabled: bool| {
            let key = format!("control-{id}");
            super::motion::track_hover(div().id(id), key.clone())
                .relative()
                .flex()
                .items_center()
                .h_full()
                .pl(px(15.))
                .pr(px(5.))
                .rounded_l(px(22.))
                .when(!disabled, |el| el.cursor_pointer().child(super::motion::hover_layer_corners(&key, theme.hover_strong, gpui::Corners { top_left: px(22.), bottom_left: px(22.), top_right: px(0.), bottom_right: px(0.) }, 100)))
                .when(disabled, |el| el.opacity(0.55))
                .tip(label, Side::Top)
                .child(icon(icon_name, 20., color))
        };
        let mic_label = if server_muted { "An admin muted you" } else if no_mic { "No microphone" } else if mic_off { "Unmute" } else { "Mute" };
        let mic_color = if mic_off { theme.red } else if open { theme.green } else { theme.text1 };
        let (mute, deafen, cam, share, leave) = (self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone());
        let picker = self.state.clone();
        let mic_group = group("mic-group", "mic-more", mic_off, pill("mic-control", if mic_off { "mic-off" } else { "mic" }, mic_color, mic_label.into(), server_muted || no_mic).on_click(move |_, _, cx| mute.update(cx, |voice, cx| voice.toggle_mute(cx))), true, self.voice.clone(), self.state.clone());
        let deafen_group = group("deafen-group", "deafen-more", deafened, pill("deafen-control", if deafened { "headphone-off" } else { "headphones" }, if deafened { theme.red } else { theme.text1 }, if deafened { "Undeafen".into() } else { "Deafen".into() }, false).on_click(move |_, _, cx| deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))), false, self.voice.clone(), self.state.clone());
        let mut bar = div()
            .flex_none()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .pt(px(6.))
            .px(px(12.))
            .pb(px(if self.room.call { 10. } else { 14. }))
            .child(mic_group)
            .child(deafen_group);
        bar = bar
            .child(control("camera-control", if camera { "camera" } else { "camera-off" }, if camera { theme.on_accent } else { theme.text1 }, if camera { theme.accent } else { theme.bg3 }, if camera { "Turn off camera".into() } else { "Turn on camera".into() }, false).on_click(move |_, _, cx| cam.update(cx, |voice, cx| voice.toggle_camera(cx))))
            .child(
                control("share-control", if sharing { "monitor-off" } else { "monitor-up" }, if sharing { theme.on_accent } else { theme.text1 }, if sharing { theme.accent } else { theme.bg3 }, if sharing { "Stop sharing".into() } else { share_refusal.unwrap_or("Share your screen").into() }, !sharing && share_refusal.is_some()).on_click(move |_, _, cx| {
                    if sharing {
                        share.update(cx, |voice, cx| voice.stop_screen(cx));
                    } else if share_refusal.is_none() {
                        picker.update(cx, |state, cx| state.set_overlay(Some(Overlay::ScreenPicker), cx));
                    }
                }),
            )
            .child(super::soundboard::soundboard_button(&self.state, &self.voice, sounds, cx));
        if !self.room.call {
            let chat_open = self.chat_open;
            bar = bar.child(
                control("chat-control", "message-square", if chat_open { theme.on_accent } else { theme.text1 }, if chat_open { theme.accent } else { theme.bg3 }, if chat_open { "Hide chat".into() } else { "Show chat".into() }, false)
                    .when(chat_unread && !chat_open, |el| el.child(div().absolute().top(px(10.)).right(px(10.)).size(px(8.)).rounded_full().bg(theme.text1).border_2().border_color(theme.bg3)))
                    .on_click(cx.listener(|stage, _, _, cx| {
                        stage.chat_open = !stage.chat_open;
                        cx.notify();
                    })),
            );
        }
        bar.child(
            super::motion::track_hover(div().id("leave-control"), "leave-control".into())
                .relative()
                .w(px(56.))
                .h(px(44.))
                .flex_none()
                .rounded(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.red)
                .cursor_pointer()
                .child(super::motion::hover_layer("leave-control", theme::color(theme::hex(0xd9444a)), px(22.), 100))
                .tip("Disconnect", Side::Top)
                .on_click(move |_, _, cx| leave.update(cx, |voice, cx| voice.leave(cx)))
                .child(icon("phone-off", 20., gpui::white())),
        )
        .into_any_element()
    }

    fn header(&self, title: &str, topic: &str, call_started: Option<f64>, ring_again: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let encrypted = |text: &'static str| {
            div()
                .id("voice-e2ee")
                .flex()
                .items_center()
                .gap(px(4.))
                .px(px(8.))
                .py(px(3.))
                .rounded(px(99.))
                .bg(theme.bg2)
                .text_size(px(12.))
                .text_color(theme.text2)
                .tip(text, Side::Bottom)
                .child(icon("lock", 12., theme.text2))
                .child("Encrypted")
        };
        let stats_open = self.voice.read(cx).stats_open;
        let stats_voice = self.voice.clone();
        let stats = icon_button("voice-stats", "activity", 15., true, stats_open, cx).tip("Stream stats", Side::Bottom).on_click(move |_, _, cx| {
            stats_voice.update(cx, |voice, cx| {
                voice.stats_open = !voice.stats_open;
                cx.notify();
            })
        });
        if self.room.call {
            let voice = self.voice.clone();
            let expanded = self.expanded;
            return div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(10.))
                .h(px(40.))
                .child(encrypted("End-to-end encrypted, with keys from this conversation's members. The server and the media server can't listen in or watch."))
                .when_some(call_started, |el, started| {
                    let seconds = ((crate::format::now_ms() - started) / 1000.).max(0.) as u64;
                    let (hours, minutes, seconds) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
                    el.child(div().text_size(px(12.)).text_color(theme.text3).child(if hours > 0 { format!("{hours}:{minutes:02}:{seconds:02}") } else { format!("{minutes}:{seconds:02}") }))
                })
                .child(div().flex_1())
                .when(ring_again, |el| el.child(icon_button("ring-again", "bell-ring", 15., true, false, cx).tip("Ring everyone who isn't here", Side::Bottom).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.ring_again(cx)))))
                .child(stats)
                .child(icon_button("call-expand", if expanded { "chevrons-down-up" } else { "chevrons-up-down" }, 15., true, false, cx).tip(if expanded { "Show the chat" } else { "Hide the chat" }, Side::Bottom).on_click(cx.listener(|stage, _, _, cx| {
                    stage.expanded = !stage.expanded;
                    cx.notify();
                })))
                .into_any_element();
        }
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(14.))
            .h(px(52.))
            .border_b_1()
            .border_color(theme.line)
            .child(icon("volume-2", 18., theme.text3))
            .child(div().flex_none().max_w(gpui::relative(0.45)).one_line().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child(title.to_string()))
            .when(!topic.is_empty(), |el| el.child(div().min_w_0().one_line().border_l_1().border_color(theme.line_strong).pl(px(10.)).text_size(px(13.)).text_color(theme.text3).child(topic.to_string())))
            .child(div().flex_1())
            .child(encrypted("End-to-end encrypted, with keys from this channel's members. The server and the media server can't listen in or watch."))
            .child(stats)
            .into_any_element()
    }
}

/// The microphones or speakers, to choose from, above the chevron that asked.
fn device_menu(voice: &Entity<Voice>, state: &Entity<AppState>, input: bool, position: gpui::Point<Pixels>, cx: &mut App) {
    let devices = crate::voice::audio::devices(input);
    let current = if input { voice.read(cx).settings.input_device.clone() } else { voice.read(cx).settings.output_device.clone() };
    let mut entries: Vec<MenuEntry> = devices
        .into_iter()
        .map(|device| {
            let voice = voice.clone();
            let id = device.id.clone();
            let label = format!("{}{}", if device.id == current { "✓ " } else { "" }, device.name);
            MenuEntry::plain(label, Rc::new(move |_, cx| {
                let id = id.clone();
                voice.update(cx, |voice, cx| voice.update_settings(|settings| if input { settings.input_device = id } else { settings.output_device = id }, cx));
            }))
        })
        .collect();
    entries.push(MenuEntry::separator());
    let state = state.clone();
    entries.push(MenuEntry::plain("Voice settings", Rc::new(move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some("voice".into()) }), cx)))));
    open_menu_with_header(position, None, entries, true, cx);
}

/// A 16:9 tile as large as fits a cell.
fn fit(cell_width: f32, cell_height: f32) -> (f32, f32) {
    let width = cell_width.min(cell_height * 16. / 9.).max(1.);
    (width, width * 9. / 16.)
}

impl Render for VoiceStage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        for old in self.retired.drain(..) {
            window.drop_image(old).ok();
        }
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id).cloned() else { return div().into_any_element() };
        let voice = self.voice.read(cx);
        let status = voice.status;
        let videos = voice.videos.clone();
        let focus = voice.focus.clone();
        let screen_share = voice.screen.clone();
        let channel = server.channels.iter().find(|channel| channel.id == self.room.id).cloned();
        let conversation = if self.room.call { voice::conversation_of_group(&server, &self.room.id).cloned() } else { channel.as_ref().and_then(|channel| channel.conversation.clone()) };
        let title = if self.room.call { conversation.as_ref().map(|item| item.title.clone()).unwrap_or_default() } else { channel.as_ref().map(|item| item.name.clone()).unwrap_or_default() };
        let topic = channel.as_ref().map(|item| item.topic.clone()).unwrap_or_default();
        let call = if self.room.call { server.calls.get(&self.room.id).cloned() } else { None };
        let mut members: Vec<VoiceMember> = server.voice.values().filter(|member| member.channel_id == self.room.id).cloned().collect();
        members.sort_by(|a, b| a.since.total_cmp(&b.since));
        let ringing: Vec<String> = call.as_ref().map(|call| call.ringing.iter().filter(|user| !members.iter().any(|member| &member.user_id == *user)).cloned().collect()).unwrap_or_default();
        // Someone in the group who isn't in the call, and isn't being rung, can be rung again.
        let not_here = self.room.call && conversation.as_ref().is_some_and(|conversation| conversation.kind == "group" && conversation.members.iter().any(|member| !members.iter().any(|other| other.user_id == member.user_id) && !ringing.contains(&member.user_id)));
        let cameras: HashMap<String, VideoTile> = videos.iter().filter(|video| video.source == VideoSource::Camera).map(|video| (video.user_id.clone(), video.clone())).collect();
        let screens: Vec<VideoTile> = videos.iter().filter(|video| video.source == VideoSource::Screen).cloned().collect();
        let focused = focus.as_ref().and_then(|key| videos.iter().find(|video| &video.key == key).cloned());
        let native_self_share = screen_share.as_ref().filter(|share| share.native).cloned();
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let share_refusal = voice::rules::screen_refusal(server.info.as_ref().and_then(|info| info.screen_share.as_ref()), &role, if self.room.call { 0. } else { channel.as_ref().map(|channel| channel.screen_limit).unwrap_or(0.) });
        let sounds = self.room.call || channel.as_ref().is_some_and(|channel| channel.sounds);
        let chat_unread = conversation.as_ref().is_some_and(|conversation| conversation.unread > 0.);
        let header = self.header(&title, &topic, call.as_ref().filter(|_| status == VoiceStatus::Connected).map(|call| call.started_at), not_here, cx);

        let stage_body: AnyElement = if status == VoiceStatus::Connecting {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(10.))
                .p(px(24.))
                .text_color(theme.text2)
                .child(spinner(26., theme.text2))
                .child(if self.room.call { "Connecting the call…".to_string() } else { format!("Coming into {title}…") })
                .into_any_element()
        } else {
            let area = self.area.get();
            let (area_width, area_height) = (f32::from(area.size.width).max(200.), f32::from(area.size.height).max(120.));
            let people = members.len() + ringing.len() + screens.len() + usize::from(native_self_share.is_some());
            let mut tiles: Vec<AnyElement> = Vec::new();
            let strip = focused.is_some();
            // As the desktop's grid: columns of equal width, each tile as large as fits its cell, the cells filled row by row.
            let columns = (people.max(1) as f32).sqrt().ceil().min(4.) as usize;
            let rows = people.max(1).div_ceil(columns);
            let cell = ((area_width - GAP * (columns as f32 - 1.)) / columns as f32, (area_height - GAP * (rows as f32 - 1.)) / rows as f32);
            let size = if strip { (STRIP_WIDTH, STRIP_HEIGHT) } else { fit(cell.0, cell.1) };
            let tile_size = if strip { fit(STRIP_WIDTH, STRIP_HEIGHT) } else { size };
            for tile in screens.iter().filter(|tile| Some(&tile.key) != focused.as_ref().map(|focused| &focused.key)) {
                tiles.push(self.screen_tile(tile, false, tile_size, cx));
            }
            if let Some(share) = &native_self_share {
                tiles.push(
                    div()
                        .w(px(tile_size.0))
                        .h(px(tile_size.1))
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(8.))
                        .p(px(12.))
                        .rounded(RADIUS_L)
                        .bg(theme.bg2)
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .text_center()
                        .child(icon("monitor-up", 30., theme.text2))
                        .child(format!("You're sharing {}", share.name))
                        .into_any_element(),
                );
            }
            for member in &members {
                let camera = cameras.get(&member.user_id).cloned();
                tiles.push(self.person_tile(member, camera.as_ref(), tile_size, cx));
            }
            for user in &ringing {
                tiles.push(self.ringing_tile(user, tile_size, cx));
            }
            let measured = self.area.clone();
            let mut grid_area = div().flex_1().min_h_0().flex().flex_col().p(px(12.)).gap(px(GAP)).when(self.room.call, |el| el.pt_0());
            if let Some(focused) = &focused {
                let focus_size = (area_width, (area_height - STRIP_HEIGHT - GAP).max(80.));
                let content = if focused.source == VideoSource::Screen {
                    self.screen_tile(focused, true, fit(focus_size.0, focus_size.1), cx)
                } else {
                    let voice = self.voice.clone();
                    let video = self.video(focused, true);
                    div().id("focused-camera").size_full().rounded(RADIUS_L).overflow_hidden().bg(gpui::black()).cursor_pointer().on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_focus(None, cx))).child(video).into_any_element()
                };
                grid_area = grid_area
                    .child(div().flex_1().min_h_0().flex().items_center().justify_center().child(content))
                    .child(div().id("voice-strip").flex_none().h(px(STRIP_HEIGHT)).flex().gap(px(8.)).overflow_x_scroll().children(tiles));
            } else {
                grid_area = grid_area.child(
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_wrap()
                        .content_center()
                        .items_center()
                        .gap(px(GAP))
                        .overflow_hidden()
                        .child(canvas(move |bounds, _, _| measured.set(bounds), |_, _, _, _| {}).absolute().inset_0())
                        .children(tiles.into_iter().map(|tile| div().flex_none().w(px(cell.0.floor())).h(px(cell.1.floor())).flex().items_center().justify_center().child(tile))),
                );
            }
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .when(status == VoiceStatus::Reconnecting, |el| el.child(div().flex_none().text_center().text_size(px(13.)).p(px(5.)).text_color(theme.amber).bg(theme.amber_soft).child("Reconnecting…")))
                .child(grid_area)
                .child(self.controls(share_refusal, sounds, chat_unread, cx))
                .into_any_element()
        };

        let stats = if self.voice.read(cx).stats_open {
            let (state, voice) = (self.state.clone(), self.voice.clone());
            Some(self.stats.get_or_insert_with(|| cx.new(|cx| super::stream_stats::StreamStatsPanel::new(state, voice, cx))).clone())
        } else {
            self.stats = None;
            None
        };
        let stage = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .bg(theme.bg0)
            .relative()
            .child(header)
            .child(stage_body)
            .when_some(stats, |el, stats| el.child(stats));
        let mut wrap = div().flex().min_w_0().min_h_0();
        if self.room.call {
            wrap = if self.expanded { wrap.flex_1() } else { wrap.flex_none().h(gpui::relative(0.46)).min_h(px(240.)).max_h(px(620.)).border_b_1().border_color(theme.line) };
        } else {
            wrap = wrap.flex_1().size_full();
        }
        wrap = wrap.child(stage);
        if !self.room.call && self.chat_open {
            if let Some(conversation) = &conversation {
                if self.chat.is_none() {
                    let (state, server_id, key) = (self.state.clone(), self.room.server_id.clone(), conversation.key.clone());
                    self.chat = Some(cx.new(|cx| super::chat::ChatView::new(state, server_id, key, window, cx)));
                }
                if let Some(chat) = &self.chat {
                    wrap = wrap.child(div().flex_none().w(px(400.)).flex().border_l_1().border_color(theme.line).child(chat.clone()));
                }
            }
        }
        wrap.into_any_element()
    }
}
