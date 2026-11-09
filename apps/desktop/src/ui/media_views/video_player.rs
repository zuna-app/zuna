//! A video playing where it's shown, with its sound when it's heard.

use super::*;

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
    _tick: Option<Task<()>>,
}

impl VideoPlayer {
    pub fn new(key: String, path: PathBuf, round: bool, duration: f64, clip: Option<Clip>, cx: &mut Context<Self>) -> Self {
        let mut player = VideoPlayer { key, path, round, duration, heard: !round, playing: false, clip, frame: None, retired: Vec::new(), next: None, frames: None, origin: Instant::now(), from: 0., position: 0., drawn: Instant::now(), offscreen: false, _tick: None };
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
        self.playing = true;
        if self.heard {
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
        if self.heard && self.clip.is_some() {
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

    pub(super) fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.playing = false;
            self.from = self.position;
            player::pause(&self.key);
        } else {
            let from = if self.frames.is_none() || self.position <= 0. { 0. } else { self.position };
            self.start(from, cx);
        }
        cx.notify();
    }
}

impl Render for VideoPlayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for old in self.retired.drain(..) {
            window.drop_image(old).ok();
        }
        self.drawn = Instant::now();
        if self.offscreen {
            self.offscreen = false;
            // Back on screen, a video message loops again without sound.
            if self.round {
                self.start(0., cx);
            }
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
        // A video's own controls: play or pause, how far it's got, and the time.
        let duration = self.clip.as_ref().map(|clip| clip.duration()).unwrap_or(0.);
        let playing = self.playing;
        stage
            .id(SharedString::from(format!("video-stage-{}", self.key)))
            .group("video-stage")
            .cursor_pointer()
            .on_click(cx.listener(|player, _, _, cx| player.toggle_pause(cx)))
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
                    .child(format!("{} / {}", format_duration(self.position), format_duration(duration))),
            )
            .into_any_element()
    }
}
