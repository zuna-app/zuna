//! A voice channel, open: everyone in it, what they're sharing, and its chat alongside. A
//! call is the same, above its conversation's chat, which it can take the whole of
//! (VoiceStage.tsx).

mod tiles;
mod controls;
mod watch;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    AnyElement, App, Bounds, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Pixels, Render, RenderImage, SharedString, Styled, Subscription, Task, Window,
    anchored, canvas, deferred, div, img, prelude::*, px,
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
    /// A shared screen over the whole of the window, made full screen for it, by its key, as
    /// the web's tile is with `requestFullscreen`, and whether the window has been full
    /// screen since.
    full_screen: Option<(String, bool)>,
    /// Escape, which brings it back, ahead of whatever has focus.
    full_screen_keys: Option<Subscription>,
    /// The share a click just went to, what had the stage before it, and when, so a second
    /// click puts that share on the whole screen wherever the first one moved it to.
    screen_clicked: Option<(String, Option<String>, std::time::Instant)>,
    /// The window's size changing, as it goes full screen and back.
    window_bounds: Option<Subscription>,
    _tick: Task<()>,
    /// The screen stays on while the stage is open with a video on it (`voice/awake.rs`).
    _open: crate::voice::awake::StageOpen,
    /// YouTube's player, while this device watches what the room has on and it fills the stage.
    watch_player: Option<watch::WatchPlayer>,
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
        VoiceStage { state, voice, room, chat: None, chat_open: false, stats: None, expanded: false, images: HashMap::new(), retired: Vec::new(), area: Rc::new(Cell::new(Bounds::default())), full_screen: None, full_screen_keys: None, screen_clicked: None, window_bounds: None, _tick: tick, _open: crate::voice::awake::StageOpen::new(), watch_player: None }
    }

    /// The channel's chat beside it closed, from its ×.
    pub fn hide_chat(&mut self, cx: &mut Context<Self>) {
        self.chat_open = false;
        cx.notify();
    }

    /// A video's newest picture, as an image. Whole, it's the one made where the frame was
    /// decoded, with nothing copied. Covering a 16:9 tile, it's cropped to 16:9 first, once per
    /// frame: GPUI rounds a covering picture's corners past the tile's, where they'd be cut off
    /// square. Your own camera comes mirrored already.
    fn picture(&mut self, tile: &VideoTile, cover: bool) -> Option<Arc<RenderImage>> {
        let frame = tile.feed.lock().clone()?;
        let key = if cover { format!("{}#cover", tile.key) } else { tile.key.clone() };
        if let Some((serial, image)) = self.images.get(&key) {
            if *serial == frame.serial {
                return Some(image.clone());
            }
        }
        let whole = frame.image?;
        let (width, height) = (frame.width, frame.height);
        let shape = 16. / 9.;
        let (keep_width, keep_height) = if !cover || width == 0 || height == 0 {
            (width, height)
        } else if width as f32 / height as f32 > shape {
            (((height as f32 * shape).round() as u32).clamp(1, width), height)
        } else {
            (width, ((width as f32 / shape).round() as u32).clamp(1, height))
        };
        let image = if (keep_width, keep_height) == (width, height) {
            whole
        } else {
            // Cropped by copying only the rows and columns kept, straight from the frame.
            let pixels = whole.as_bytes(0)?;
            let (left, top) = ((width - keep_width) / 2, (height - keep_height) / 2);
            let mut kept = Vec::with_capacity((keep_width * keep_height * 4) as usize);
            for row in top..top + keep_height {
                let start = ((row * width + left) * 4) as usize;
                kept.extend_from_slice(pixels.get(start..start + (keep_width * 4) as usize)?);
            }
            let buffer = image::RgbaImage::from_raw(keep_width, keep_height, kept)?;
            Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]))
        };
        if let Some((_, old)) = self.images.insert(key, (frame.serial, image.clone())) {
            self.retired.push(old);
        }
        Some(image)
    }

    /// What VideoToolbox decoded, drawn by GPUI from the GPU as it is, on macOS.
    #[cfg(target_os = "macos")]
    fn surface(tile: &VideoTile, fit: gpui::ObjectFit, radius: Pixels) -> Option<AnyElement> {
        let picture = tile.feed.lock().as_ref()?.surface.clone()?;
        Some(gpui::surface(picture.0).size_full().object_fit(fit).rounded(radius).into_any_element())
    }

    fn video(&mut self, tile: &VideoTile, contain: bool) -> AnyElement {
        #[cfg(target_os = "macos")]
        if let Some(surface) = Self::surface(tile, if contain { gpui::ObjectFit::Contain } else { gpui::ObjectFit::Cover }, RADIUS_L) {
            return surface;
        }
        match self.picture(tile, !contain) {
            Some(image) => img(image).size_full().object_fit(if contain { gpui::ObjectFit::Contain } else { gpui::ObjectFit::Fill }).rounded(RADIUS_L).into_any_element(),
            None => div().size_full().bg(gpui::black()).into_any_element(),
        }
    }

}

/// The microphones or speakers, to choose from, above the chevron that asked.
fn device_menu(voice: &Entity<Voice>, state: &Entity<AppState>, input: bool, position: gpui::Point<Pixels>, cx: &mut App) {
    let devices = crate::devices::sound(input);
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
        // Borrowed, with only what's shown taken out of it, as the stage draws with every frame of video.
        let Some(server) = state.servers.get(&self.room.server_id) else { return div().into_any_element() };
        let voice = self.voice.read(cx);
        let status = voice.status;
        let videos = voice.videos.clone();
        // Frames of tiles that went, a camera turned off or a share stopped, go with them.
        let gone: Vec<String> = self.images.keys().filter(|key| !videos.iter().any(|tile| tile.key == key.trim_end_matches("#cover"))).cloned().collect();
        for key in gone {
            if let Some((_, old)) = self.images.remove(&key) {
                self.retired.push(old);
            }
        }
        let focus = voice.focus.clone();
        let screen_share = voice.screen.clone();
        let watch = voice.watch.clone();
        let watch_focused = watch.is_some() && focus.as_deref() == Some(crate::voice::watch::WATCH_FOCUS);
        let watching = watch.as_ref().is_some_and(|watch| voice.watching.as_deref() == Some(&watch.session));
        // Anything of GPUI's over the stage, which the player's web view would cover.
        let covered = crate::ui::something_on_top() || voice.stats_open;
        let channel = server.channels.iter().find(|channel| channel.id == self.room.id).cloned();
        let conversation = if self.room.call { voice::conversation_of_group(server, &self.room.id).cloned() } else { channel.as_ref().and_then(|channel| channel.conversation.clone()) };
        let title = if self.room.call { conversation.as_ref().map(|item| item.title.clone()).unwrap_or_default() } else { channel.as_ref().map(|item| item.name.clone()).unwrap_or_default() };
        let topic = channel.as_ref().map(|item| item.topic.clone()).unwrap_or_default();
        let call = if self.room.call { server.calls.get(&self.room.id).cloned() } else { None };
        let mut members: Vec<VoiceMember> = server.voice.values().filter(|member| member.channel_id == self.room.id).cloned().collect();
        members.sort_by(|a, b| a.since.total_cmp(&b.since));
        let ringing: Vec<String> = call.as_ref().map(|call| call.ringing.iter().filter(|user| !members.iter().any(|member| &member.user_id == *user)).cloned().collect()).unwrap_or_default();
        // Someone in the group who isn't in the call, and isn't being rung, can be rung again.
        let not_here = self.room.call && conversation.as_ref().is_some_and(|conversation| conversation.kind == "group" && conversation.members.iter().any(|member| !members.iter().any(|other| other.user_id == member.user_id) && !ringing.contains(&member.user_id)));
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let share_refusal = voice::rules::screen_refusal(server.info.as_ref().and_then(|info| info.screen_share.as_ref()), &role, if self.room.call { 0. } else { channel.as_ref().map(|channel| channel.screen_limit).unwrap_or(0.) });
        let cameras: HashMap<String, VideoTile> = videos.iter().filter(|video| video.source == VideoSource::Camera).map(|video| (video.user_id.clone(), video.clone())).collect();
        let screens: Vec<VideoTile> = videos.iter().filter(|video| video.source == VideoSource::Screen).cloned().collect();
        let focused = focus.as_ref().and_then(|key| videos.iter().find(|video| &video.key == key).cloned());
        // Out of full screen some other way, or the share it showed gone: back in the stage.
        if let Some((key, seen)) = &mut self.full_screen {
            *seen |= window.is_fullscreen();
            if (*seen && !window.is_fullscreen()) || !videos.iter().any(|video| &video.key == key) {
                self.leave_full_screen(window, cx);
            }
        }
        if self.window_bounds.is_none() {
            self.window_bounds = Some(cx.observe_window_bounds(window, |_, _, cx| cx.notify()));
        }
        let full_screen = self.full_screen.as_ref().and_then(|(key, _)| videos.iter().find(|video| &video.key == key).cloned());
        let native_self_share = screen_share.clone();
        let sounds = self.room.call || channel.as_ref().is_some_and(|channel| channel.sounds);
        let chat_unread = conversation.as_ref().is_some_and(|conversation| conversation.unread > 0.);
        let header = self.header(&title, &topic, call.as_ref().filter(|_| status == VoiceStatus::Connected).map(|call| call.started_at), not_here, cx);

        self.keep_player(watch.as_ref().filter(|_| watch_focused && watching && status != VoiceStatus::Connecting), window, cx);
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
            let people = members.len() + ringing.len() + screens.len() + usize::from(native_self_share.is_some()) + usize::from(watch.is_some() && !watch_focused);
            let mut tiles: Vec<AnyElement> = Vec::new();
            let strip = focused.is_some() || watch_focused;
            // As the web's grid: columns of equal width, each tile as large as fits its cell, the cells filled row by row.
            let columns = (people.max(1) as f32).sqrt().ceil().min(4.) as usize;
            let rows = people.max(1).div_ceil(columns);
            let cell = ((area_width - GAP * (columns as f32 - 1.)) / columns as f32, (area_height - GAP * (rows as f32 - 1.)) / rows as f32);
            let size = if strip { (STRIP_WIDTH, STRIP_HEIGHT) } else { fit(cell.0, cell.1) };
            let tile_size = if strip { fit(STRIP_WIDTH, STRIP_HEIGHT) } else { size };
            if let Some(watch) = watch.as_ref().filter(|_| !watch_focused) {
                tiles.push(self.watch_thumb(watch, tile_size, cx));
            }
            for tile in screens.iter().filter(|tile| Some(&tile.key) != focused.as_ref().map(|focused| &focused.key)) {
                tiles.push(self.screen_tile(tile, false, tile_size, false, cx));
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
            // The room the tiles have, measured as it's drawn in either layout, and drawn again at
            // once when it changes. Only the grid measured it, so a stage made with a share
            // already filling it, as coming back to the channel from a text chat makes one, drew
            // the share at the least size until it was clicked. Nothing's drawn until it's known.
            let (measured, stage_id) = (self.area.clone(), cx.entity_id());
            let measure = canvas(
                move |bounds, window, _| {
                    if measured.replace(bounds) != bounds {
                        window.on_next_frame(move |_, cx| cx.notify(stage_id));
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0();
            let known = area.size.width > px(0.) && area.size.height > px(0.);
            let mut grid_area = div().flex_1().min_h_0().flex().flex_col().p(px(12.)).gap(px(GAP)).when(self.room.call, |el| el.pt_0());
            if let Some(watch) = watch.as_ref().filter(|_| watch_focused) {
                let content = self.watch_stage(watch, covered, cx);
                grid_area = grid_area.child(
                    div().relative().flex_1().min_h_0().flex().flex_col().gap(px(GAP)).child(measure).when(known, |el| {
                        el.child(div().flex_1().min_h_0().flex().child(content))
                            .child(div().id("voice-strip").flex_none().h(px(STRIP_HEIGHT)).flex().gap(px(8.)).overflow_x_scroll().children(tiles))
                    }),
                );
            } else if let Some(focused) = &focused {
                let focus_size = (area_width, (area_height - STRIP_HEIGHT - GAP).max(80.));
                let content = if focused.source == VideoSource::Screen {
                    self.screen_tile(focused, true, fit(focus_size.0, focus_size.1), false, cx)
                } else {
                    let voice = self.voice.clone();
                    let video = self.video(focused, true);
                    div().id("focused-camera").size_full().rounded(RADIUS_L).overflow_hidden().bg(gpui::black()).cursor_pointer().on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_focus(None, cx))).child(video).into_any_element()
                };
                grid_area = grid_area.child(
                    div().relative().flex_1().min_h_0().flex().flex_col().gap(px(GAP)).child(measure).when(known, |el| {
                        el.child(div().flex_1().min_h_0().flex().items_center().justify_center().child(content))
                            .child(div().id("voice-strip").flex_none().h(px(STRIP_HEIGHT)).flex().gap(px(8.)).overflow_x_scroll().children(tiles))
                    }),
                );
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
                        .child(measure)
                        .when(known, |el| el.children(tiles.into_iter().map(|tile| div().flex_none().w(px(cell.0.floor())).h(px(cell.1.floor())).flex().items_center().justify_center().child(tile)))),
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
            // A double click on a share: its first click filled the stage with it, or put it back,
            // which moves it, so the second goes to the share wherever it lands, and the stage is
            // as it was before.
            .capture_any_mouse_down(cx.listener(|stage, event: &gpui::MouseDownEvent, window, cx| {
                if event.button != MouseButton::Left || event.click_count < 2 {
                    return;
                }
                if let Some((key, before, at)) = stage.screen_clicked.take() {
                    if at.elapsed() < Duration::from_millis(500) {
                        stage.voice.update(cx, |voice, cx| voice.set_focus(before, cx));
                        stage.toggle_full_screen(&key, window, cx);
                        cx.stop_propagation();
                    }
                }
            }))
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
        if let Some(tile) = &full_screen {
            let size = window.viewport_size();
            let tile = self.screen_tile(tile, false, (f32::from(size.width), f32::from(size.height)), true, cx);
            wrap = wrap.child(deferred(anchored().position(gpui::point(px(0.), px(0.))).child(div().occlude().child(tile))).with_priority(1));
        }
        if !self.room.call && self.chat_open {
            if let Some(conversation) = &conversation {
                if self.chat.is_none() {
                    let (state, server_id, key, stage) = (self.state.clone(), self.room.server_id.clone(), conversation.key.clone(), cx.entity().downgrade());
                    self.chat = Some(cx.new(|cx| {
                        let mut chat = super::chat::ChatView::new(state, server_id, key, window, cx);
                        chat.beside_voice = Some(stage);
                        chat
                    }));
                }
                if let Some(chat) = &self.chat {
                    wrap = wrap.child(div().flex_none().w(px(400.)).flex().border_l_1().border_color(theme.line).child(chat.clone()));
                }
            }
        }
        wrap.into_any_element()
    }
}
