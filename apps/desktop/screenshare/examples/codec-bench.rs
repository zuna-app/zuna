//! Encodes the same screen-like scene in H.264 and in AV1 through the share's own encoder
//! (native/encoder.c, with the options a share uses), at several bitrates, and measures what comes
//! out against the scene: PSNR and SSIM through the FFmpeg the repository pins, how long a frame
//! took to encode, and how large the first keyframe was. docs/SCREEN_SHARE.md has what it found.
//!
//! What's counted is what a share sends: H.264 after `h264.rs` has taken out NVENC's filler and
//! SEI, and AV1 without the temporal delimiters and padding LiveKit takes out. Quality is measured
//! on the picture the encoder was given, made 4:2:0 with the matrix the streams say they're in, so
//! that what 4:2:0 itself loses of coloured text, the same for both, doesn't hide the codecs'
//! difference: in RGB, neither got past 32 dB at any bitrate.
//!
//!   cargo run --release -p zuna-screenshare --features bench --example codec-bench -- \
//!     [--size 1920x1080] [--fps 60] [--seconds 10] [--kbps 1000,2000,4000,8000] [--encoder nvenc]
//!     [--effort balanced] [--codecs h264,av1] [--through encoder|pipeline]
//!
//! The scene is drawn here, the same every time: code in an editor that scrolls, then stands still
//! with its caret blinking, then has a video playing in a corner, then has a window dragged across
//! it, and last a full screen game, a detailed landscape the camera pans across. Frames reach the
//! encoder from CPU memory, as BGRA, which NVENC and AMF take as they are and VA-API uploads; a
//! share hands NVENC and AMF the same BGRA in the GPU's own textures. The encoder is `nvenc`,
//! `amf` or, on Linux, `vaapi`: Media Foundation's only take NV12 from the GPU.
//!
//! `--through pipeline` runs the encoder as a share does (pipeline.rs), at the frame rate, with
//! its bitrate starting at 3 Mbit/s and following an estimate of the network that's always the
//! most it may send, and also says how far its busiest second went past that, and how large its
//! largest keyframe was against the VBV. Otherwise each frame goes straight to the encoder, at the
//! bitrate asked for from the start.

#[cfg(target_os = "macos")]
fn main() {
    eprintln!("The share encodes on the GPU itself on Windows and Linux only.");
    std::process::exit(2);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    bench::main();
}

#[cfg(not(target_os = "macos"))]
mod bench {
    use std::{
        fs::{self, File},
        io::{BufWriter, Write},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    use std::sync::{Arc, Mutex};

    use zuna_screenshare::{
        bench::{starting_bitrate, Config, Encoder, Input, Pipeline, Pixel, Rewriter, Stream, INPUT_CPU},
        Codec, EncodedFrame, Output, Quality,
    };

    /// What's compared.
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Variant {
        codec: Codec,
    }

    impl Variant {
        fn name(self, args: &Args) -> String {
            self.codec.encoder(&args.encoder)
        }
    }

    struct Args {
        width: usize,
        height: usize,
        fps: u32,
        frames: usize,
        kbps: Vec<u64>,
        encoder: String,
        effort: Quality,
        render_node: String,
        variants: Vec<Variant>,
        /// Through the share's own pipeline, in real time, rather than straight to the encoder.
        pipeline: bool,
    }

    fn args() -> Args {
        let mut args = Args {
            width: 1920,
            height: 1080,
            fps: 60,
            frames: 0,
            kbps: vec![1000, 2000, 4000, 8000],
            encoder: "nvenc".into(),
            effort: Quality::Balanced,
            render_node: "/dev/dri/renderD128".into(),
            variants: vec![Variant { codec: Codec::H264 }, Variant { codec: Codec::Av1 }],
            pipeline: false,
        };
        let mut seconds = 10.0;
        let given: Vec<String> = std::env::args().skip(1).collect();
        for pair in given.chunks(2) {
            let [name, value] = pair else {
                eprintln!("Each option takes a value: {}", pair[0]);
                std::process::exit(2);
            };
            match name.as_str() {
                "--size" => {
                    let (width, height) = value.split_once('x').expect("--size WIDTHxHEIGHT");
                    (args.width, args.height) = (width.parse().unwrap(), height.parse().unwrap());
                }
                "--fps" => args.fps = value.parse().unwrap(),
                "--seconds" => seconds = value.parse().unwrap(),
                "--kbps" => args.kbps = value.split(',').map(|kbps| kbps.parse().unwrap()).collect(),
                "--encoder" => args.encoder = value.clone(),
                "--render-node" => args.render_node = value.clone(),
                "--codecs" => {
                    args.variants = value
                        .split(',')
                        .map(|variant| match variant {
                            "av1" => Variant { codec: Codec::Av1 },
                            _ => Variant { codec: Codec::H264 },
                        })
                        .collect()
                }
                "--through" => args.pipeline = value == "pipeline",
                "--effort" => {
                    args.effort = match value.as_str() {
                        "speed" => Quality::Speed,
                        "best" => Quality::Best,
                        _ => Quality::Balanced,
                    }
                }
                other => {
                    eprintln!("Unknown option {other}");
                    std::process::exit(2);
                }
            }
        }
        args.frames = (seconds * args.fps as f64).round() as usize;
        args
    }

    // --- The scene ---

    /// Each run draws the same scene, from the same seed.
    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// BGRA, as a share's capture hands it over.
    struct Canvas {
        width: usize,
        height: usize,
        pixels: Vec<u8>,
    }

    impl Canvas {
        fn new(width: usize, height: usize, color: u32) -> Self {
            let mut canvas = Canvas { width, height, pixels: vec![0; width * height * 4] };
            canvas.fill(0, 0, width, height, color);
            canvas
        }

        fn put(&mut self, x: usize, y: usize, color: u32) {
            if x < self.width && y < self.height {
                let at = (y * self.width + x) * 4;
                self.pixels[at..at + 4].copy_from_slice(&[color as u8, (color >> 8) as u8, (color >> 16) as u8, 255]);
            }
        }

        fn fill(&mut self, x: usize, y: usize, width: usize, height: usize, color: u32) {
            for row in y..(y + height).min(self.height) {
                for column in x..(x + width).min(self.width) {
                    self.put(column, row, color);
                }
            }
        }

        /// Puts another canvas here, with its top left at (x, y), as much of it as fits.
        fn blit(&mut self, from: &Canvas, x: usize, y: usize, from_y: usize, rows: usize) {
            let width = from.width.min(self.width.saturating_sub(x));
            for row in 0..rows.min(self.height.saturating_sub(y)).min(from.height.saturating_sub(from_y)) {
                let source = ((from_y + row) * from.width) * 4;
                let target = ((y + row) * self.width + x) * 4;
                self.pixels[target..target + width * 4].copy_from_slice(&from.pixels[source..source + width * 4]);
            }
        }
    }

    const GLYPH_WIDTH: usize = 7;
    const LINE_HEIGHT: usize = 18;

    /// Letters 5 pixels wide and 9 tall, as sharp as text on a screen, and as often the same.
    fn glyphs(random: &mut Random) -> Vec<[u8; 9]> {
        (0..64)
            .map(|_| {
                let mut glyph = [0u8; 9];
                // A stem down one side or the middle, as most letters have, and strokes off it.
                let stem = [0, 2, 4][random.below(3) as usize];
                for (row, bits) in glyph.iter_mut().enumerate() {
                    *bits = (1 << (4 - stem)) | (random.next() as u8 & 0b11111 & if row % 4 == 0 { 0b11111 } else { 0b10101 });
                }
                glyph
            })
            .collect()
    }

    fn draw_glyph(canvas: &mut Canvas, glyph: &[u8; 9], x: usize, y: usize, color: u32) {
        for (row, bits) in glyph.iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) != 0 {
                    canvas.put(x + column, y + row, color);
                }
            }
        }
    }

    /// A line of code: indented words, coloured as an editor colours them.
    fn draw_code_line(canvas: &mut Canvas, glyphs: &[[u8; 9]], random: &mut Random, x: usize, y: usize, columns: usize) {
        let comment = random.below(7) == 0;
        let mut column = random.below(6) as usize * 4;
        let length = if random.below(9) == 0 { 0 } else { column + 8 + random.below(columns as u64 / 2) as usize };
        while column < length.min(columns) {
            let word = 2 + random.below(9) as usize;
            let color = if comment {
                0x008000
            } else {
                [0x0033b3, 0x1f1f1f, 0x1f1f1f, 0x1f1f1f, 0xa31515, 0x098658, 0x795e26][random.below(7) as usize]
            };
            for letter in 0..word.min(columns - column) {
                draw_glyph(canvas, &glyphs[random.below(glyphs.len() as u64) as usize], x + (column + letter) * GLYPH_WIDTH, y + 4, color);
            }
            column += word + 1;
        }
    }

    const TITLE: usize = 30;
    const SIDEBAR: usize = 240;
    const GUTTER: usize = 48;

    /// What the scene is doing, by how far through it a frame is.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Part {
        Scrolling,
        Still,
        Video,
        Dragging,
        Game,
    }

    const PARTS: [Part; 5] = [Part::Scrolling, Part::Still, Part::Video, Part::Dragging, Part::Game];

    /// Where each part starts, as a fraction of the scene.
    const STILL_FROM: f64 = 0.25;
    const VIDEO_FROM: f64 = 0.4;
    const DRAGGING_FROM: f64 = 0.55;
    const GAME_FROM: f64 = 0.7;

    impl Part {
        fn of(frame: usize, frames: usize) -> Part {
            match frame as f64 / frames as f64 {
                at if at < STILL_FROM => Part::Scrolling,
                at if at < VIDEO_FROM => Part::Still,
                at if at < DRAGGING_FROM => Part::Video,
                at if at < GAME_FROM => Part::Dragging,
                _ => Part::Game,
            }
        }

        fn name(self) -> &'static str {
            match self {
                Part::Scrolling => "scrolling code",
                Part::Still => "still, caret blinking",
                Part::Video => "video in a corner",
                Part::Dragging => "window dragged",
                Part::Game => "full screen game",
            }
        }
    }

    /// A landscape of noise in three sizes, with grain, larger than the screen by as far as the
    /// game's camera pans: as hard on an encoder as most of what fills a screen and moves.
    fn terrain(width: usize, height: usize, random: &mut Random) -> Canvas {
        let mut canvas = Canvas::new(width, height, 0);
        let lattices: Vec<(usize, Vec<f64>)> = [96usize, 24, 6]
            .iter()
            .map(|&spacing| {
                let (columns, rows) = (width / spacing + 2, height / spacing + 2);
                (spacing, (0..columns * rows).map(|_| (random.next() % 1000) as f64 / 1000.0).collect())
            })
            .collect();
        for y in 0..height {
            for x in 0..width {
                let mut value = 0.0;
                for (octave, (spacing, values)) in lattices.iter().enumerate() {
                    let columns = width / spacing + 2;
                    let (fx, fy) = (x as f64 / *spacing as f64, y as f64 / *spacing as f64);
                    let (cx, cy) = (fx as usize, fy as usize);
                    let (tx, ty) = (fx - cx as f64, fy - cy as f64);
                    let at = |column: usize, row: usize| values[row * columns + column];
                    let top = at(cx, cy) * (1.0 - tx) + at(cx + 1, cy) * tx;
                    let bottom = at(cx, cy + 1) * (1.0 - tx) + at(cx + 1, cy + 1) * tx;
                    value += (top * (1.0 - ty) + bottom * ty) / (1 << octave) as f64;
                }
                let grain = (random.next() % 25) as f64 - 12.0;
                let shade = |base: f64, spread: f64| (base + value * spread + grain).clamp(0.0, 255.0) as u32;
                let color = if value < 0.6 {
                    (shade(20.0, 40.0) << 16) | (shade(60.0, 60.0) << 8) | shade(140.0, 80.0)
                } else if value < 1.1 {
                    (shade(40.0, 60.0) << 16) | (shade(100.0, 80.0) << 8) | shade(30.0, 30.0)
                } else {
                    (shade(110.0, 60.0) << 16) | (shade(90.0, 50.0) << 8) | shade(60.0, 40.0)
                };
                canvas.put(x, y, color);
            }
        }
        canvas
    }

    struct Scene {
        width: usize,
        height: usize,
        frames: usize,
        /// Everything that doesn't move: the title bar and the file tree.
        template: Canvas,
        /// The whole file, taller than the screen, which scrolls.
        document: Canvas,
        /// The window that's dragged.
        dialog: Canvas,
        /// What the game's camera pans across.
        terrain: Canvas,
    }

    /// How far the game's camera moves each frame, across and down.
    const PAN: (usize, usize) = (3, 2);

    impl Scene {
        fn new(width: usize, height: usize, frames: usize) -> Scene {
            let mut random = Random(0x5eed_2026_1109);
            let glyphs = glyphs(&mut random);
            let mut template = Canvas::new(width, height, 0xffffff);
            template.fill(0, 0, width, TITLE, 0x3c3c3c);
            for letter in 0..24 {
                draw_glyph(&mut template, &glyphs[letter % glyphs.len()], width / 2 - 84 + letter * GLYPH_WIDTH, 10, 0xcccccc);
            }
            template.fill(0, TITLE, SIDEBAR, height - TITLE, 0x252526);
            for line in 0..(height - TITLE) / 22 {
                let y = TITLE + 6 + line * 22;
                if line == 5 {
                    template.fill(0, y - 3, SIDEBAR, 22, 0x37373d);
                }
                let indent = 12 + random.below(4) as usize * 12;
                for letter in 0..4 + random.below(14) as usize {
                    draw_glyph(&mut template, &glyphs[random.below(64) as usize], indent + letter * GLYPH_WIDTH, y + 3, 0xcccccc);
                }
            }

            let editor = width - SIDEBAR;
            let lines = (height + frames) / LINE_HEIGHT + 2;
            let mut document = Canvas::new(editor, lines * LINE_HEIGHT, 0xffffff);
            document.fill(0, 0, GUTTER, document.height, 0xf3f3f3);
            for line in 0..lines {
                let y = line * LINE_HEIGHT;
                // The line's number, from the glyphs standing in for digits.
                let mut number = line + 1;
                let mut x = GUTTER - 10;
                while number > 0 {
                    x -= GLYPH_WIDTH;
                    draw_glyph(&mut document, &glyphs[number % 10], x, y + 4, 0x6e7681);
                    number /= 10;
                }
                draw_code_line(&mut document, &glyphs, &mut random, GUTTER + 8, y, (editor - GUTTER - 16) / GLYPH_WIDTH);
            }

            let mut dialog = Canvas::new(720, 440, 0xffffff);
            dialog.fill(0, 0, 720, 28, 0xdddddd);
            dialog.fill(0, 0, 720, 1, 0x888888);
            dialog.fill(0, 439, 720, 1, 0x888888);
            dialog.fill(0, 0, 1, 440, 0x888888);
            dialog.fill(719, 0, 1, 440, 0x888888);
            for line in 0..20 {
                draw_code_line(&mut dialog, &glyphs, &mut random, 16, 36 + line * LINE_HEIGHT, 96);
            }
            let game_frames = frames - (frames as f64 * GAME_FROM) as usize + 1;
            let terrain = terrain(width + game_frames * PAN.0, height + game_frames * PAN.1, &mut random);
            Scene { width, height, frames, template, document, dialog, terrain }
        }

        /// Draws frame `index` into `frame`.
        fn draw(&self, index: usize, frame: &mut Canvas) {
            let part = Part::of(index, self.frames);
            if part == Part::Game {
                let moved = index - (self.frames as f64 * GAME_FROM) as usize;
                let (left, top) = (moved * PAN.0, moved * PAN.1);
                for row in 0..self.height {
                    let source = ((top + row) * self.terrain.width + left) * 4;
                    let target = row * self.width * 4;
                    frame.pixels[target..target + self.width * 4].copy_from_slice(&self.terrain.pixels[source..source + self.width * 4]);
                }
                return;
            }
            let scroll_end = (self.frames as f64 * STILL_FROM) as usize;
            frame.pixels.copy_from_slice(&self.template.pixels);
            // 2 pixels a frame while it scrolls: 120 a second at 60 frames a second.
            let scrolled = 2 * index.min(scroll_end);
            frame.blit(&self.document, SIDEBAR, TITLE, scrolled, self.height - TITLE);
            match part {
                Part::Still => {
                    // The caret, blinking every half second.
                    if (index / 30) % 2 == 0 {
                        frame.fill(SIDEBAR + GUTTER + 8 + 30 * GLYPH_WIDTH, TITLE + 8 * LINE_HEIGHT + 1, 2, LINE_HEIGHT - 2, 0x000000);
                    }
                }
                Part::Video => {
                    let (left, top, width, height) = (self.width - 680, self.height - 400, 640, 360);
                    let t = index as f64 / 30.0;
                    for y in 0..height {
                        for x in 0..width {
                            let (fx, fy) = (x as f64, y as f64);
                            let v = (fx * 0.031 + t).sin() + (fy * 0.043 - t * 1.3).sin() + ((fx + fy) * 0.017 + t * 0.7).sin() + ((fx * fx + fy * fy).sqrt() * 0.05 - t * 2.0).sin();
                            let channel = |phase: f64| ((v * 0.8 + phase).sin() * 127.0 + 128.0) as u32;
                            frame.put(left + x, top + y, (channel(0.0) << 16) | (channel(2.1) << 8) | channel(4.2));
                        }
                    }
                }
                Part::Dragging => {
                    let start = (self.frames as f64 * DRAGGING_FROM) as usize;
                    let moved = index - start;
                    let (x, y) = (SIDEBAR + 60 + moved * 8 % (self.width - SIDEBAR - 800), TITLE + 40 + moved * 4 % (self.height - TITLE - 500));
                    frame.blit(&self.dialog, x, y, 0, self.dialog.height);
                }
                Part::Scrolling | Part::Game => {}
            }
        }
    }

    // --- Encoding ---

    struct Encoded {
        path: PathBuf,
        bytes: usize,
        /// What each frame sent, as its packet comes with it.
        frame_bytes: Vec<usize>,
        packets: usize,
        key_bytes: usize,
        times: Vec<Duration>,
        /// Each keyframe: which frame, and how large.
        keys: Vec<(usize, usize)>,
        /// What the pipeline said each second, through it.
        reports: Vec<serde_json::Value>,
    }

    /// AV1 goes into IVF, which FFmpeg reads frame by frame, and H.264 as its own Annex B.
    fn ivf_header(out: &mut impl Write, width: usize, height: usize, fps: u32, frames: usize) -> std::io::Result<()> {
        out.write_all(b"DKIF")?;
        out.write_all(&0u16.to_le_bytes())?;
        out.write_all(&32u16.to_le_bytes())?;
        out.write_all(b"AV01")?;
        out.write_all(&(width as u16).to_le_bytes())?;
        out.write_all(&(height as u16).to_le_bytes())?;
        out.write_all(&fps.to_le_bytes())?;
        out.write_all(&1u32.to_le_bytes())?;
        out.write_all(&(frames as u32).to_le_bytes())?;
        out.write_all(&0u32.to_le_bytes())
    }

    /// How much of an AV1 temporal unit goes out: all but its temporal delimiters, tile lists and
    /// padding, which LiveKit takes out before it's sent (`NormalizeForRtp` in webrtc-sys).
    fn av1_sent(data: &[u8]) -> usize {
        let (mut at, mut sent) = (0, 0);
        while at < data.len() {
            let start = at;
            let header = data[at];
            at += 1 + ((header >> 2) & 1) as usize;
            let mut size = data.len().saturating_sub(at);
            if header & 0b10 != 0 {
                let (mut value, mut shift) = (0usize, 0);
                while at < data.len() {
                    let byte = data[at];
                    at += 1;
                    value |= ((byte & 0x7f) as usize) << shift;
                    shift += 7;
                    if byte & 0x80 == 0 {
                        break;
                    }
                }
                size = value;
            }
            at = (at + size).min(data.len());
            if !matches!((header >> 3) & 0x0f, 2 | 8 | 15) {
                sent += at - start;
            }
        }
        sent
    }

    /// Where what's encoded goes: to a file FFmpeg reads, counting what a share would send.
    struct Recorder {
        codec: Codec,
        out: BufWriter<File>,
        encoded: Encoded,
    }

    impl Recorder {
        /// The frame `index`'s packet, as the share would send it.
        fn record(&mut self, index: usize, key: bool, data: &[u8]) -> Result<(), String> {
            let sent = if self.codec == Codec::Av1 { av1_sent(data) } else { data.len() };
            let encoded = &mut self.encoded;
            if encoded.packets == 0 {
                encoded.key_bytes = sent;
            }
            if key {
                encoded.keys.push((index, sent));
            }
            if self.codec == Codec::Av1 {
                self.out.write_all(&(data.len() as u32).to_le_bytes()).and_then(|_| self.out.write_all(&(encoded.packets as u64).to_le_bytes())).map_err(|error| error.to_string())?;
            }
            self.out.write_all(data).map_err(|error| error.to_string())?;
            encoded.bytes += sent;
            if let Some(bytes) = encoded.frame_bytes.get_mut(index) {
                *bytes += sent;
            }
            encoded.packets += 1;
            Ok(())
        }
    }

    /// LiveKit, as the pipeline sees it: it takes every frame, asks for no keyframe, and its
    /// estimate of the network is the most the share may send, as on a link with room to spare.
    struct Network {
        recorder: Arc<Mutex<Recorder>>,
        cap: u64,
    }

    impl Output for Network {
        fn send(&mut self, frame: &EncodedFrame) -> bool {
            let mut recorder = self.recorder.lock().unwrap();
            let index = recorder.encoded.packets;
            recorder.record(index, frame.key, frame.data).is_ok()
        }

        fn take_keyframe_request(&mut self) -> bool {
            false
        }

        fn take_target_bitrate(&mut self) -> Option<u64> {
            Some(self.cap)
        }
    }

    fn encode(args: &Args, scene: &Scene, variant: Variant, kbps: u64, dir: &Path) -> Result<Encoded, String> {
        let codec = variant.codec;
        let name = codec.encoder(&args.encoder);
        // Through the pipeline, the bitrate starts low and climbs to the most it may send, as a share's does.
        let bitrate = if args.pipeline { starting_bitrate(kbps * 1000) } else { kbps * 1000 };
        let stream = Stream { width: args.width as u32, height: args.height as u32, fps: args.fps, gop: args.fps * 60, bitrate, quality: args.effort };
        let mut encoder = Encoder::open(&Config {
            codec: &name,
            input: INPUT_CPU,
            pixel: Pixel::Bgra,
            source_width: args.width as u32,
            source_height: args.height as u32,
            stream,
            d3d11_device: std::ptr::null_mut(),
            render_node: Some(&args.render_node),
        })?;
        let label = name.clone();
        let path = dir.join(format!("{label}-{kbps}.{}", if codec == Codec::Av1 { "ivf" } else { "h264" }));
        let mut out = BufWriter::new(File::create(&path).map_err(|error| error.to_string())?);
        if codec == Codec::Av1 {
            ivf_header(&mut out, args.width, args.height, args.fps, args.frames).map_err(|error| error.to_string())?;
        }
        let encoded = Encoded { path: path.clone(), bytes: 0, frame_bytes: vec![0; args.frames], packets: 0, key_bytes: 0, times: Vec::with_capacity(args.frames), keys: Vec::new(), reports: Vec::new() };
        let recorder = Arc::new(Mutex::new(Recorder { codec, out, encoded }));
        let mut frame = Canvas::new(args.width, args.height, 0);
        let mut times = Vec::with_capacity(args.frames);
        if args.pipeline {
            let reports = Arc::new(Mutex::new(Vec::new()));
            let heard = reports.clone();
            let network = Network { recorder: recorder.clone(), cap: kbps * 1000 };
            let mut pipeline = Pipeline::new(
                encoder,
                codec,
                Box::new(network),
                Box::new(move |report| heard.lock().unwrap().push(report)),
                args.width as u32,
                args.height as u32,
                args.fps,
                bitrate,
                kbps * 1000,
                None,
            );
            // At the frame rate, as a capture hands frames over, since the pipeline goes by the clock.
            let start = Instant::now();
            for index in 0..args.frames {
                scene.draw(index, &mut frame);
                let due = start + Duration::from_secs_f64(index as f64 / args.fps as f64);
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    thread::sleep(wait);
                }
                let began = Instant::now();
                pipeline.on_frame(Input::Cpu { data: &frame.pixels, stride: args.width * 4 })?;
                times.push(began.elapsed());
            }
            drop(pipeline);
            recorder.lock().unwrap().encoded.reports = std::mem::take(&mut *reports.lock().unwrap());
        } else {
            let mut rewriter = Rewriter::new(true);
            let mut prepared = Vec::new();
            for index in 0..args.frames {
                scene.draw(index, &mut frame);
                let pts = index as i64 * 1_000_000 / args.fps as i64;
                let began = Instant::now();
                encoder.send(Input::Cpu { data: &frame.pixels, stride: args.width * 4 }, pts, index == 0)?;
                // As the share waits for each frame's packet (pipeline.rs).
                let mut got = false;
                loop {
                    match encoder.receive()? {
                        Some(packet) => {
                            got = true;
                            // What the share would send, which is also what's decoded here.
                            prepared.clear();
                            match codec {
                                Codec::H264 => rewriter.prepare(packet.data, &mut prepared),
                                Codec::Av1 => prepared.extend_from_slice(packet.data),
                            }
                            recorder.lock().unwrap().record(index, packet.key, &prepared)?;
                        }
                        None if got || began.elapsed() >= Duration::from_millis(40) => break,
                        None => thread::sleep(Duration::from_micros(200)),
                    }
                }
                times.push(began.elapsed());
            }
        }
        let mut recorder = Arc::try_unwrap(recorder).ok().expect("the pipeline has let go").into_inner().unwrap();
        recorder.out.flush().map_err(|error| error.to_string())?;
        recorder.encoded.times = times;
        Ok(recorder.encoded)
    }

    // --- Measuring ---

    fn ffmpeg() -> PathBuf {
        let dir = std::env::var_os("FFMPEG_DIR").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.deps/ffmpeg"));
        dir.join("bin").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
    }

    /// One frame's mean squared error in each of Y, U and V, and its SSIM in Y.
    #[derive(Clone, Copy)]
    struct Measured {
        y: f64,
        u: f64,
        v: f64,
        ssim: f64,
    }

    /// Each frame of what was encoded against the scene, made 4:2:0 as the streams say they are:
    /// BT.601 at studio range, which is how NVENC converts RGB.
    fn measure(args: &Args, scene: &Scene, encoded: &Encoded, dir: &Path) -> Result<Vec<Measured>, String> {
        let raw = encoded.path.extension().is_some_and(|extension| extension == "h264");
        let size = format!("{}x{}", args.width, args.height);
        let fps = args.fps.to_string();
        // Both by frame number, whatever the clocks of their containers say.
        let graph = format!(
            "[0:v]settb=1/{fps},setpts=N,format=yuv420p,split[d1][d2];\
             [1:v]settb=1/{fps},setpts=N,scale=out_color_matrix=bt601:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p,split[r1][r2];\
             [d1][r1]psnr=stats_file=psnr.log;[d2][r2]ssim=stats_file=ssim.log"
        );
        let mut command = Command::new(ffmpeg());
        command.current_dir(dir).args(["-hide_banner", "-nostats", "-loglevel", "error"]);
        if raw {
            command.args(["-framerate", &fps, "-f", "h264"]);
        }
        command.arg("-i").arg(&encoded.path);
        command.args(["-f", "rawvideo", "-pix_fmt", "bgra", "-video_size", &size, "-framerate", &fps, "-i", "pipe:0", "-filter_complex", &graph, "-f", "null", "-"]);
        let mut child = command.stdin(Stdio::piped()).spawn().map_err(|error| format!("Starting {}: {error}", ffmpeg().display()))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut frame = Canvas::new(args.width, args.height, 0);
        for index in 0..args.frames {
            scene.draw(index, &mut frame);
            if stdin.write_all(&frame.pixels).is_err() {
                break;
            }
        }
        drop(stdin);
        let status = child.wait().map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("FFmpeg failed measuring {}", encoded.path.display()));
        }
        let field = |line: &str, name: &str| line.split_whitespace().find_map(|part| part.strip_prefix(name)).and_then(|value| value.parse::<f64>().ok());
        let psnr = fs::read_to_string(dir.join("psnr.log")).map_err(|error| error.to_string())?;
        let ssim = fs::read_to_string(dir.join("ssim.log")).map_err(|error| error.to_string())?;
        Ok(psnr
            .lines()
            .zip(ssim.lines())
            .filter_map(|(psnr, ssim)| Some(Measured { y: field(psnr, "mse_y:")?, u: field(psnr, "mse_u:")?, v: field(psnr, "mse_v:")?, ssim: field(ssim, "Y:")? }))
            .collect())
    }

    fn psnr(mse: f64) -> f64 {
        if mse <= 0.0 {
            100.0
        } else {
            10.0 * (255.0 * 255.0 / mse).log10()
        }
    }

    /// SSIM in decibels, which spreads out the values close to 1 that good pictures have.
    fn ssim_db(ssim: f64) -> f64 {
        -10.0 * (1.0 - ssim).max(1e-10).log10()
    }

    struct Point {
        /// What the encoder was set to, as a share sets it to the most it may send.
        asked: u64,
        /// What it sent.
        kbps: f64,
        /// In Y, where text's edges are.
        psnr: f64,
        /// Y, U and V weighted 6:1:1, as codecs are usually compared.
        psnr_yuv: f64,
        /// What it sent during each part of the scene, and the PSNR in Y it got for that.
        parts: Vec<(f64, f64)>,
        /// In Y, in decibels.
        ssim: f64,
    }

    /// How much less bitrate the second curve needs than the first for the same quality, as a
    /// fraction, averaged over the qualities both reach: Bjøntegaard's measure, with straight lines
    /// between the points, from bitrate and a quality for each.
    fn bitrate_saving(first: &[(f64, f64)], second: &[(f64, f64)]) -> Option<f64> {
        let curve = |points: &[(f64, f64)]| {
            let mut sorted: Vec<(f64, f64)> = points.iter().map(|&(kbps, quality)| (quality, kbps.log10())).collect();
            sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
            sorted
        };
        let (first, second) = (curve(first), curve(second));
        let low = first.first()?.0.max(second.first()?.0);
        let high = first.last()?.0.min(second.last()?.0);
        if high <= low {
            return None;
        }
        let at = |curve: &[(f64, f64)], quality: f64| {
            let after = curve.iter().position(|point| point.0 >= quality).unwrap_or(curve.len() - 1).max(1);
            let (a, b) = (curve[after - 1], curve[after]);
            a.1 + (b.1 - a.1) * (quality - a.0) / (b.0 - a.0).max(1e-9)
        };
        let steps = 100;
        let difference = (0..=steps).map(|step| low + (high - low) * step as f64 / steps as f64).map(|quality| at(&second, quality) - at(&first, quality)).sum::<f64>() / (steps + 1) as f64;
        Some(1.0 - 10f64.powf(difference))
    }

    /// What only a run through the pipeline says: how far it went past the most it may send in
    /// its busiest second, and its largest keyframe against the VBV of the bitrate it went at.
    struct Through {
        peak: f64,
        largest_key: f64,
        keys: usize,
    }

    fn through(args: &Args, encoded: &Encoded, kbps: u64) -> Through {
        let second = args.fps as usize;
        let peak = encoded.frame_bytes.windows(second).map(|frames| frames.iter().sum::<usize>()).max().unwrap_or(0) as f64 * 8.0 / 1000.0 / kbps as f64;
        // The bitrate the encoder was set to at a frame, from the report of the second it was in.
        let bitrate_at = |index: usize| {
            let at = index as f64 / args.fps as f64;
            encoded.reports.iter().find(|report| report["t"].as_f64().unwrap_or(0.0) >= at).and_then(|report| report["encoderKbps"].as_u64()).unwrap_or(kbps)
        };
        let largest_key = encoded.keys.iter().map(|&(index, bytes)| bytes as f64 / (bitrate_at(index) as f64 * 1000.0 / 32.0)).fold(0.0, f64::max);
        Through { peak, largest_key, keys: encoded.keys.len() }
    }

    pub fn main() {
        let args = args();
        let dir = std::env::temp_dir().join("zuna-codec-bench");
        fs::create_dir_all(&dir).expect("making a folder for what's encoded");
        println!("Drawing a {}x{} scene of {} frames at {} fps...", args.width, args.height, args.frames, args.fps);
        let scene = Scene::new(args.width, args.height, args.frames);
        let parts: Vec<Vec<usize>> = PARTS.iter().map(|part| (0..args.frames).filter(|&index| Part::of(index, args.frames) == *part).collect()).collect();
        let width = args.variants.iter().map(|variant| variant.name(&args).len()).max().unwrap_or(12).max(12);

        println!("\nThe whole scene{}: PSNR and SSIM in Y, and PSNR in Y, U and V weighted 6:1:1.", if args.pipeline { ", through the share's pipeline in real time" } else { "" });
        println!("{:<width$} {:>7} {:>8} {:>9} {:>9} {:>8} {:>7} {:>7} {:>8}", "encoder", "asked", "sent", "encode", "95%", "key", "PSNR", "YUV", "SSIM");
        println!("{:<width$} {:>7} {:>8} {:>9} {:>9} {:>8} {:>7} {:>7} {:>8}", "", "kbit/s", "kbit/s", "ms", "ms", "KB", "dB", "dB", "dB");
        let mut curves: Vec<(Variant, Vec<Point>)> = Vec::new();
        let mut throughs: Vec<(String, u64, Through)> = Vec::new();
        for &variant in &args.variants {
            let name = variant.name(&args);
            let mut points = Vec::new();
            for &kbps in &args.kbps {
                let encoded = match encode(&args, &scene, variant, kbps, &dir) {
                    Ok(encoded) => encoded,
                    Err(problem) => {
                        println!("{name:<width$} {kbps:>7} {problem}");
                        continue;
                    }
                };
                let frames = match measure(&args, &scene, &encoded, &dir) {
                    Ok(frames) if frames.len() == args.frames => frames,
                    Ok(frames) => {
                        println!("{name:<width$} {kbps:>7} only {} of {} frames came out of FFmpeg ({} packets)", frames.len(), args.frames, encoded.packets);
                        continue;
                    }
                    Err(problem) => {
                        println!("{name:<width$} {kbps:>7} {problem}");
                        continue;
                    }
                };
                let mut times: Vec<f64> = encoded.times.iter().map(|time| time.as_secs_f64() * 1000.0).collect();
                let mean_time = times.iter().sum::<f64>() / times.len() as f64;
                times.sort_by(f64::total_cmp);
                let p95 = times[times.len() * 95 / 100];
                let rate = |indices: &[usize]| indices.iter().map(|&index| encoded.frame_bytes[index]).sum::<usize>() as f64 * 8.0 / (indices.len().max(1) as f64 / args.fps as f64) / 1000.0;
                let all: Vec<usize> = (0..args.frames).collect();
                let sent = rate(&all);
                // The mean squared error over the frames, then its PSNR, rather than the mean of each frame's PSNR.
                let mean = |indices: &[usize], plane: fn(&Measured) -> f64| indices.iter().map(|&index| plane(&frames[index])).sum::<f64>() / indices.len().max(1) as f64;
                let point = Point {
                    asked: kbps,
                    kbps: sent,
                    psnr: psnr(mean(&all, |frame| frame.y)),
                    psnr_yuv: (6.0 * psnr(mean(&all, |frame| frame.y)) + psnr(mean(&all, |frame| frame.u)) + psnr(mean(&all, |frame| frame.v))) / 8.0,
                    parts: parts.iter().map(|indices| (rate(indices), psnr(mean(indices, |frame| frame.y)))).collect(),
                    ssim: ssim_db(mean(&all, |frame| frame.ssim)),
                };
                println!(
                    "{name:<width$} {kbps:>7} {sent:>8.0} {mean_time:>9.2} {p95:>9.2} {:>8.1} {:>7.2} {:>7.2} {:>8.2}",
                    encoded.key_bytes as f64 / 1000.0,
                    point.psnr,
                    point.psnr_yuv,
                    point.ssim,
                );
                if args.pipeline {
                    throughs.push((name.clone(), kbps, through(&args, &encoded, kbps)));
                }
                points.push(point);
            }
            curves.push((variant, points));
        }

        println!("\nEach part of the scene: what was sent during it, in kbit/s, and the PSNR in Y it got.");
        println!("{:<width$} {:>7} | {}", "encoder", "asked", PARTS.map(|part| format!("{:>22}", part.name())).join(" "));
        for (variant, points) in &curves {
            for point in points {
                println!("{:<width$} {:>7} | {}", variant.name(&args), point.asked, point.parts.iter().map(|(kbps, psnr)| format!("{:>22}", format!("{kbps:.0} at {psnr:.2} dB"))).collect::<Vec<_>>().join(" "));
            }
        }

        if args.pipeline {
            println!("\nThrough the pipeline: the busiest second against the most it may send, and the largest keyframe against its VBV.");
            for (name, kbps, through) in &throughs {
                println!(
                    "{name:<width$} {kbps:>7} | busiest second {:>4.0}%, largest keyframe {:>4.0}% of the VBV, {:>2} keyframes",
                    through.peak * 100.0,
                    through.largest_key * 100.0,
                    through.keys,
                );
            }
        }

        let Some(((first, base), rest)) = curves.split_first() else { return };
        for (variant, points) in rest {
            let (name, against) = (variant.name(&args), first.name(&args));
            println!("\nAt the same bitrate asked for, as a share asks for the most it may send, {name} against {against}:");
            for point in points {
                if let Some(other) = base.iter().find(|other| other.asked == point.asked) {
                    println!(
                        "  {:>6} kbit/s: {:+.2} dB of PSNR in Y and {:+.2} dB of SSIM, sending {:.0}% as much",
                        point.asked,
                        point.psnr - other.psnr,
                        point.ssim - other.ssim,
                        point.kbps / other.kbps * 100.0
                    );
                }
            }
            println!("\nHow much less {name} sends than {against} for the same quality, over the qualities both reach:");
            let saving = |quality: &dyn Fn(&Point) -> (f64, f64)| {
                let curve = |points: &[Point]| points.iter().map(quality).collect::<Vec<_>>();
                bitrate_saving(&curve(base), &curve(points)).map_or("they don't overlap".into(), |saving| format!("{:.0}%", saving * 100.0))
            };
            println!("  PSNR in Y, the whole scene: {}", saving(&|point| (point.kbps, point.psnr)));
            println!("  PSNR in Y, U and V, the whole scene: {}", saving(&|point| (point.kbps, point.psnr_yuv)));
            println!("  SSIM in Y, the whole scene: {}", saving(&|point| (point.kbps, point.ssim)));
            for (index, part) in PARTS.iter().enumerate() {
                println!("  PSNR in Y, {}, by what was sent during it: {}", part.name(), saving(&|point| point.parts[index]));
            }
        }
        println!("\nWhat was encoded is in {}", dir.display());
    }
}
