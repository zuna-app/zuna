//! A video playing where it's shown, with its sound when it's heard: in its message, or over
//! the whole screen in the viewer (`ui/image_viewer.rs`), as a picture opens there.

use super::*;

/// Where a video was sent, so it can open in the viewer among its chat's pictures and videos.
#[derive(Clone)]
pub struct VideoSource {
    pub server_id: String,
    pub list_id: String,
    pub attachment: Attachment,
}

/// How long the bar has to stay still before the video is decoded from where it was moved to,
/// so dragging it doesn't open a decoder for every step.
const SEEK_SETTLE: Duration = Duration::from_millis(120);

/// The player shown in the viewer, over the whole screen, which the chat leaves out while it's
/// there. A global, not the player's own, so the chat behind doesn't draw again with each of
/// the video's frames to learn it.
#[derive(Default)]
pub struct ShownFull(pub Option<gpui::EntityId>);

impl gpui::Global for ShownFull {}

/// Plays a video's pictures where it's shown, with its sound when it's heard.
pub struct VideoPlayer {
    key: String,
    path: PathBuf,
    /// A video message plays by itself without sound, over and over, until it's pressed.
    round: bool,
    /// Its length, as its message gives it.
    duration: f64,
    heard: bool,
    playing: bool,
    clip: Option<Clip>,
    frame: Option<Arc<RenderImage>>,
    retired: Vec<Arc<RenderImage>>,
    next: Option<(f64, Arc<RenderImage>)>,
    frames: Option<Receiver<(f64, Arc<RenderImage>)>>,
    origin: Instant,
    from: f64,
    position: f64,
    /// When it was last drawn: off screen it stops, as the web's video does when its
    /// chat is left, instead of decoding frames nobody sees.
    drawn: Instant,
    /// Stopped for being off screen, so a video message starts its loop again when it's back.
    offscreen: bool,
    /// Where it was sent, which opens it over the whole screen.
    source: Option<VideoSource>,
    /// Shown in the viewer, with the viewer's controls, rather than in its message.
    full: bool,
    /// Where the bar was moved to, while it waits to stay still.
    seeking: Option<f64>,
    /// Moved while paused: the first picture from there shows, and it stays paused.
    hold: bool,
    _seek: Option<Task<()>>,
    _tick: Option<Task<()>>,
}

impl VideoPlayer {
    pub fn new(key: String, path: PathBuf, round: bool, duration: f64, clip: Option<Clip>, source: VideoSource, cx: &mut Context<Self>) -> Self {
        let mut player = VideoPlayer {
            key,
            path,
            round,
            duration,
            heard: !round,
            playing: false,
            clip,
            frame: None,
            retired: Vec::new(),
            next: None,
            frames: None,
            origin: Instant::now(),
            from: 0.,
            position: 0.,
            drawn: Instant::now(),
            offscreen: false,
            source: Some(source),
            full: false,
            seeking: None,
            hold: false,
            _seek: None,
            _tick: None,
        };
        player.start(0., cx);
        player
    }

    /// Its sound, once decoded, which it plays with when it's heard.
    pub fn set_clip(&mut self, clip: Clip, cx: &mut Context<Self>) {
        self.clip = Some(clip);
        cx.notify();
    }

    pub(super) fn start(&mut self, from: f64, cx: &mut Context<Self>) {
        let (sender, receiver) = sync_channel(3);
        let path = self.path.clone();
        let square = self.round;
        // A video message playing by itself goes round on the same decoder: opening the file
        // and a decoder again for each pass cost more than playing it.
        let looping = self.round && !self.heard;
        std::thread::spawn(move || {
            let Ok(mut frames) = crate::media::mf::VideoFrames::open(&path) else { return };
            if from > 0. {
                frames.seek(from).ok();
            }
            // Each pass's times follow on from the last one's, so the clock just carries on.
            let (mut offset, mut last, mut gap) = (0., 0., 1. / 30.);
            loop {
                match frames.next() {
                    Ok(Some(frame)) => {
                        if frame.at > last {
                            gap = (frame.at - last).clamp(0.001, 0.5);
                        }
                        last = frame.at;
                        let Some(mut buffer) = image::RgbaImage::from_raw(frames.width, frames.height, frame.bgra) else { break };
                        if square && frames.width != frames.height {
                            let side = frames.width.min(frames.height);
                            buffer = image::imageops::crop_imm(&buffer, (frames.width - side) / 2, (frames.height - side) / 2, side, side).to_image();
                        }
                        let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
                        if sender.send((offset + frame.at, image)).is_err() {
                            break;
                        }
                    }
                    Ok(None) if looping => {
                        if frames.seek(0.).is_err() {
                            break;
                        }
                        offset += last + gap;
                        last = 0.;
                    }
                    _ => break,
                }
            }
        });
        self.frames = Some(receiver);
        self.next = None;
        self.origin = Instant::now();
        self.from = from;
        self.position = from;
        self.playing = true;
        // Back where it's shown, it isn't stopped for having been away while it waited.
        self.drawn = Instant::now();
        if self.heard && !self.hold {
            if let Some(clip) = &self.clip {
                player::play(&self.key, clip, from, 1.);
            }
        }
        // Wakes when the next frame is due rather than every few milliseconds, and draws only
        // when the picture changed, as each draw redraws what's around it too.
        self._tick = Some(cx.spawn(async move |player, cx| {
            let mut wait = Duration::from_millis(5);
            loop {
                cx.background_executor().timer(wait).await;
                match player.update(cx, |player, cx| player.tick(cx)) {
                    Ok(Some(next)) => wait = next,
                    _ => break,
                }
            }
        }));
    }

    pub(super) fn clock(&self) -> f64 {
        if self.heard && self.clip.is_some() && !self.hold {
            if let Some((at, _)) = player::position(&self.key) {
                return at;
            }
        }
        self.from + self.origin.elapsed().as_secs_f64()
    }

    /// Shows the frame that's due, and says how long until the next one, or nothing once it stopped.
    pub(super) fn tick(&mut self, cx: &mut Context<Self>) -> Option<Duration> {
        if !self.playing {
            return None;
        }
        if self.drawn.elapsed() > Duration::from_millis(500) {
            // Its chat was left. Frames retired since it was last drawn were never painted, so
            // they're let go here, all but the one that was, which its next draw gives back.
            self.playing = false;
            self.frames = None;
            self.next = None;
            self.retired.truncate(1);
            if self.heard {
                player::stop(&self.key);
                if self.round {
                    self.heard = false;
                }
            }
            self.offscreen = true;
            return None;
        }
        let clock = self.clock();
        let shown_second = self.position.floor();
        self.position = clock;
        let mut ended = false;
        let mut changed = false;
        loop {
            if self.next.is_none() {
                match self.frames.as_ref().map(|frames| frames.try_recv()) {
                    Some(Ok(frame)) => self.next = Some(frame),
                    Some(Err(TryRecvError::Disconnected)) | None => {
                        ended = true;
                        break;
                    }
                    Some(Err(TryRecvError::Empty)) => break,
                }
            }
            match &self.next {
                Some((at, _)) if *at <= clock => {
                    let (_, image) = self.next.take().unwrap();
                    if let Some(old) = self.frame.replace(image) {
                        self.retired.push(old);
                    }
                    changed = true;
                }
                _ => break,
            }
        }
        if self.hold && (changed || ended) {
            // Moved while paused: the picture from there is showing, and it stays paused.
            self.hold = false;
            self.playing = false;
            self.from = self.position;
            cx.notify();
            return None;
        }
        if ended && self.next.is_none() {
            if self.round && !self.heard {
                // Over and over, without sound.
                self.start(0., cx);
                return None;
            }
            if self.round {
                // Heard to the end, it goes back to playing by itself without sound.
                self.heard = false;
                player::stop(&self.key);
                self.start(0., cx);
                return None;
            }
            self.playing = false;
            player::stop(&self.key);
            cx.notify();
            return None;
        }
        // The time shown moves each second, even while the decoder catches up.
        if changed || clock.floor() != shown_second {
            cx.notify();
        }
        // Back when the next frame is due, or soon while it's still being decoded.
        let wait = match &self.next {
            Some((at, _)) => Duration::from_secs_f64((at - clock).clamp(0.001, 0.1)),
            None => Duration::from_millis(4),
        };
        // Drawn now and then while nothing changes, so it learns when it's no longer shown.
        if !changed && self.drawn.elapsed() > Duration::from_millis(250) {
            cx.notify();
        }
        Some(wait)
    }

    /// From the start with its sound, or back to playing by itself without.
    pub fn toggle_heard(&mut self, cx: &mut Context<Self>) {
        if self.heard {
            if let Some((_, true)) = player::position(&self.key) {
                player::pause(&self.key);
                self.playing = false;
            } else {
                self.heard = false;
                self.start(0., cx);
            }
        } else {
            self.heard = true;
            self.start(0., cx);
        }
        cx.notify();
    }

    pub fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.playing = false;
            self.from = self.position;
            player::pause(&self.key);
        } else {
            // A move of the bar still waiting starts from where it is now anyway.
            self.seeking = None;
            self._seek = None;
            self.hold = false;
            let from = if self.frames.is_none() || self.position <= 0. || self.at_end() { 0. } else { self.position };
            self.start(from, cx);
        }
        cx.notify();
    }

    /// Paused, if it's playing.
    pub fn pause(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.toggle_pause(cx);
        }
    }

    #[cfg(test)]
    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Played to its end, so playing it again starts over.
    fn at_end(&self) -> bool {
        let duration = self.length();
        duration > 0. && self.position >= duration - 0.05
    }

    /// Its length: its sound's once decoded, as the message gives it until then.
    pub fn length(&self) -> f64 {
        self.clip.as_ref().map(|clip| clip.duration()).filter(|duration| *duration > 0.).unwrap_or(self.duration)
    }

    #[cfg(test)]
    pub fn position(&self) -> f64 {
        self.position
    }

    /// Moves it to a moment, from the bar: shown at once on the bar, and decoded from there
    /// once the bar stays still, playing on if it was.
    pub fn seek(&mut self, at: f64, cx: &mut Context<Self>) {
        let length = self.length();
        let at = if length > 0. { at.clamp(0., length) } else { at.max(0.) };
        self.position = at;
        self.from = at;
        self.seeking = Some(at);
        // Nothing plays while the bar moves.
        self._tick = None;
        player::stop(&self.key);
        self._seek = Some(cx.spawn(async move |player, cx| {
            cx.background_executor().timer(SEEK_SETTLE).await;
            player.update(cx, |player, cx| player.settle(cx)).ok();
        }));
        cx.notify();
    }

    fn settle(&mut self, cx: &mut Context<Self>) {
        let Some(at) = self.seeking.take() else { return };
        self.hold = !self.playing;
        self.start(at, cx);
        cx.notify();
    }

    /// The picture's own size, once a frame of it is decoded.
    pub fn natural_size(&self) -> Option<(f32, f32)> {
        let frame = self.frame.as_ref()?;
        let size = frame.size(0);
        (size.width.0 > 0 && size.height.0 > 0).then(|| (size.width.0 as f32, size.height.0 as f32))
    }

    /// Shown in the viewer, over the whole screen, or back in its message.
    pub fn set_full(&mut self, full: bool, cx: &mut Context<Self>) {
        self.full = full;
        let id = cx.entity_id();
        if full {
            cx.set_global(ShownFull(Some(id)));
        } else if cx.try_global::<ShownFull>().is_some_and(|shown| shown.0 == Some(id)) {
            cx.set_global(ShownFull(None));
        }
        cx.notify();
    }

    #[cfg(test)]
    pub fn is_full(&self) -> bool {
        self.full
    }

    /// Opens it in the viewer, over the whole screen, among its chat's pictures and videos, as
    /// a picture opens.
    fn open_full(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(source), Some(state)) = (self.source.clone(), cx.try_global::<crate::state::Store>().map(|store| store.0.clone())) else { return };
        let gallery = {
            let state = state.read(cx);
            let messages = state.lists.get(&source.list_id).map(|list| list.items.as_slice()).unwrap_or_default();
            let blocked = state.servers.get(&source.server_id).map(|server| server.prefs.blocked().to_vec()).unwrap_or_default();
            crate::ui::image_viewer::Gallery::among(&source.server_id, &source.list_id, messages, &source.attachment, None, &blocked)
        };
        crate::ui::image_viewer::open(gallery, window, cx);
    }

    /// Over the whole screen: the picture fitted to the box the viewer gives it, and a bar
    /// along its bottom to play, pause, move through it and leave full screen.
    fn render_full(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let playing = self.playing;
        let length = self.length();
        let fraction = if length > 0. { (self.position / length).clamp(0., 1.) as f32 } else { 0. };
        let control = |id: &'static str, name: &'static str| {
            named_div(id)
                .size(px(30.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(RADIUS_M)
                .cursor_pointer()
                .hover(|style| style.bg(theme::color(theme::white_a(0.12))))
                .child(icon(name, 18., gpui::white()))
        };
        let seek = cx.entity().downgrade();
        div()
            .id(SharedString::from(format!("video-full-stage-{}", self.key)))
            .size_full()
            .relative()
            .cursor_pointer()
            .when_some(self.frame.clone(), |el, frame| el.child(img(frame).size_full().object_fit(gpui::ObjectFit::Contain).rounded(crate::theme::RADIUS_S)))
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|player, _, _, cx| {
                cx.stop_propagation();
                player.toggle_pause(cx);
            }))
            .when(!playing, |el| {
                el.child(div().absolute().inset_0().flex().items_center().justify_center().child(div().size(px(64.)).rounded_full().flex().items_center().justify_center().bg(theme::color(theme::black_a(0.55))).child(icon("play", 30., gpui::white()))))
            })
            .child(
                div()
                    .id("video-full-bar")
                    .absolute()
                    .left(px(12.))
                    .right(px(12.))
                    .bottom(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(px(8.))
                    .bg(theme::color(theme::black_a(0.6)))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .cursor_default()
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(control("video-play-pause", if playing { "pause" } else { "play" }).tip(if playing { "Pause" } else { "Play" }, Side::Top).on_click(cx.listener(|player, _, _, cx| {
                        cx.stop_propagation();
                        player.toggle_pause(cx);
                    })))
                    .child(div().flex_none().child(format_duration(self.position)))
                    .child(named_div("video-seek-bar").flex_1().min_w_0().child(slider("video-seek", fraction, move |fraction, _, cx| {
                        seek.update(cx, |player, cx| {
                            let at = fraction as f64 * player.length();
                            player.seek(at, cx);
                        })
                        .ok();
                    }, cx)))
                    .child(div().flex_none().child(format_duration(length)))
                    .child(control("video-exit-full", "shrink").tip("Exit full screen", Side::Top).on_click(|_, window, cx| {
                        cx.stop_propagation();
                        // The viewer's window, whose going gives the video back to its message.
                        window.remove_window();
                    })),
            )
            .into_any_element()
    }
}

impl Render for VideoPlayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Let go in every window: one drawn in the chat and then the viewer painted frames in both.
        for old in self.retired.drain(..) {
            cx.drop_image(old, Some(window));
        }
        self.drawn = Instant::now();
        if self.offscreen {
            self.offscreen = false;
            // Back on screen, a video message loops again without sound.
            if self.round {
                self.start(0., cx);
            }
        }
        if self.full {
            return self.render_full(cx);
        }
        let mut stage = div().size_full().relative();
        if self.round {
            if let Some(frame) = self.frame.clone() {
                stage = stage.child(img(frame).size_full().rounded_full());
            }
            let duration = self.clip.as_ref().map(|clip| clip.duration()).filter(|duration| *duration > 0.).unwrap_or(self.duration);
            return stage.child(round_overlay(self.heard, self.position, duration, theme(cx).accent)).into_any_element();
        }
        if let Some(frame) = self.frame.clone() {
            stage = stage.child(img(frame).size_full().object_fit(gpui::ObjectFit::Cover).rounded(RADIUS_M));
        }
        // A video's own controls: play or pause, how far it's got, the time, and full screen.
        let duration = self.length();
        let playing = self.playing;
        let can_open = self.source.is_some();
        stage
            .id(SharedString::from(format!("video-stage-{}", self.key)))
            .group("video-stage")
            .cursor_pointer()
            .on_click(cx.listener(|player, event: &gpui::ClickEvent, window, cx| {
                player.toggle_pause(cx);
                // Two clicks go full screen, as a browser's video does, playing or paused as
                // it was before them.
                if event.click_count() == 2 {
                    player.open_full(window, cx);
                }
            }))
            .when(!playing, |el| {
                el.child(div().absolute().inset_0().flex().items_center().justify_center().child(div().size(px(48.)).rounded_full().flex().items_center().justify_center().bg(theme::color(theme::black_a(0.55))).child(icon("play", 22., gpui::white()))))
            })
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .right(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(6.))
                    .bg(theme::color(theme::black_a(0.55)))
                    .text_size(px(11.))
                    .text_color(gpui::white())
                    .child(icon(if playing { "pause" } else { "play" }, 13., gpui::white()))
                    .child(div().flex_1().h(px(3.)).rounded(px(2.)).bg(theme::color(theme::white_a(0.3))).child(div().h_full().w(gpui::relative(if duration > 0. { (self.position / duration).clamp(0., 1.) as f32 } else { 0. })).rounded(px(2.)).bg(gpui::white())))
                    .child(format!("{} / {}", format_duration(self.position), format_duration(duration)))
                    .when(can_open, |el| {
                        el.child(
                            named_div(SharedString::from(format!("video-full-{}", self.key)))
                                .size(px(18.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .hover(|style| style.bg(theme::color(theme::white_a(0.15))))
                                .tip("Full screen", Side::Top)
                                .on_click(cx.listener(|player, _, window, cx| {
                                    cx.stop_propagation();
                                    player.open_full(window, cx);
                                }))
                                .child(icon("expand", 13., gpui::white())),
                        )
                    }),
            )
            .into_any_element()
    }
}
