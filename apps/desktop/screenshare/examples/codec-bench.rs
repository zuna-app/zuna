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
//!     [--size 1920x1080] [--fps 60] [--seconds 10] [--kbps 1000,2000,4000,8000] [--encoder nvenc] [--effort balanced] [--codecs h264,av1]
//!
//! The scene is drawn here, the same every time: code in an editor that scrolls, then stands still
//! with its caret blinking, then has a video playing in a corner, then has a window dragged across
//! it. Frames reach the encoder from CPU memory, as BGRA, which NVENC and AMF take as they are and
//! VA-API uploads; a share hands NVENC and AMF the same BGRA in the GPU's own textures. The encoder
//! is `nvenc`, `amf` or, on Linux, `vaapi`: Media Foundation's only take NV12 from the GPU.

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

    use zuna_screenshare::{
        bench::{Config, Encoder, Input, Pixel, Rewriter, Stream, INPUT_CPU},
        Codec, Quality,
    };

    struct Args {
        width: usize,
        height: usize,
        fps: u32,
        frames: usize,
        kbps: Vec<u64>,
        encoder: String,
        effort: Quality,
        render_node: String,
        codecs: Vec<Codec>,
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
            codecs: vec![Codec::H264, Codec::Av1],
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
                "--codecs" => args.codecs = value.split(',').map(|codec| if codec == "av1" { Codec::Av1 } else { Codec::H264 }).collect(),
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
    }

    const PARTS: [Part; 4] = [Part::Scrolling, Part::Still, Part::Video, Part::Dragging];

    impl Part {
        fn of(frame: usize, frames: usize) -> Part {
            match frame as f64 / frames as f64 {
                at if at < 0.3 => Part::Scrolling,
                at if at < 0.5 => Part::Still,
                at if at < 0.8 => Part::Video,
                _ => Part::Dragging,
            }
        }

        fn name(self) -> &'static str {
            match self {
                Part::Scrolling => "scrolling code",
                Part::Still => "still, caret blinking",
                Part::Video => "video in a corner",
                Part::Dragging => "window dragged",
            }
        }
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
    }

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
            Scene { width, height, frames, template, document, dialog }
        }

        /// Draws frame `index` into `frame`.
        fn draw(&self, index: usize, frame: &mut Canvas) {
            let part = Part::of(index, self.frames);
            let scroll_end = (self.frames as f64 * 0.3) as usize;
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
                    let start = (self.frames as f64 * 0.8) as usize;
                    let moved = index - start;
                    let (x, y) = (SIDEBAR + 60 + moved * 8 % (self.width - SIDEBAR - 800), TITLE + 40 + moved * 4 % (self.height - TITLE - 500));
                    frame.blit(&self.dialog, x, y, 0, self.dialog.height);
                }
                Part::Scrolling => {}
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

    fn encode(args: &Args, scene: &Scene, codec: Codec, kbps: u64, dir: &Path) -> Result<Encoded, String> {
        let name = codec.encoder(&args.encoder);
        let stream = Stream { width: args.width as u32, height: args.height as u32, fps: args.fps, gop: args.fps * 60, bitrate: kbps * 1000, quality: args.effort };
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
        let path = dir.join(format!("{name}-{kbps}.{}", if codec == Codec::Av1 { "ivf" } else { "h264" }));
        let mut out = BufWriter::new(File::create(&path).map_err(|error| error.to_string())?);
        if codec == Codec::Av1 {
            ivf_header(&mut out, args.width, args.height, args.fps, args.frames).map_err(|error| error.to_string())?;
        }
        let mut frame = Canvas::new(args.width, args.height, 0);
        let mut encoded = Encoded { path: path.clone(), bytes: 0, frame_bytes: vec![0; args.frames], packets: 0, key_bytes: 0, times: Vec::with_capacity(args.frames) };
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
                        let sent = match codec {
                            Codec::H264 => {
                                rewriter.prepare(packet.data, &mut prepared);
                                prepared.len()
                            }
                            Codec::Av1 => {
                                prepared.extend_from_slice(packet.data);
                                av1_sent(packet.data)
                            }
                        };
                        if encoded.packets == 0 {
                            encoded.key_bytes = sent;
                        }
                        if codec == Codec::Av1 {
                            out.write_all(&(prepared.len() as u32).to_le_bytes()).and_then(|_| out.write_all(&(encoded.packets as u64).to_le_bytes())).map_err(|error| error.to_string())?;
                        }
                        out.write_all(&prepared).map_err(|error| error.to_string())?;
                        encoded.bytes += sent;
                        encoded.frame_bytes[index] += sent;
                        encoded.packets += 1;
                    }
                    None if got || began.elapsed() >= Duration::from_millis(40) => break,
                    None => thread::sleep(Duration::from_micros(200)),
                }
            }
            encoded.times.push(began.elapsed());
        }
        out.flush().map_err(|error| error.to_string())?;
        Ok(encoded)
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

    pub fn main() {
        let args = args();
        let dir = std::env::temp_dir().join("zuna-codec-bench");
        fs::create_dir_all(&dir).expect("making a folder for what's encoded");
        println!("Drawing a {}x{} scene of {} frames at {} fps...", args.width, args.height, args.frames, args.fps);
        let scene = Scene::new(args.width, args.height, args.frames);
        let parts: Vec<Vec<usize>> = PARTS.iter().map(|part| (0..args.frames).filter(|&index| Part::of(index, args.frames) == *part).collect()).collect();

        println!("\nThe whole scene: PSNR and SSIM in Y, and PSNR in Y, U and V weighted 6:1:1.");
        println!("{:<12} {:>7} {:>8} {:>9} {:>9} {:>8} {:>7} {:>7} {:>8}", "encoder", "asked", "sent", "encode", "95%", "key", "PSNR", "YUV", "SSIM");
        println!("{:<12} {:>7} {:>8} {:>9} {:>9} {:>8} {:>7} {:>7} {:>8}", "", "kbit/s", "kbit/s", "ms", "ms", "KB", "dB", "dB", "dB");
        let mut curves: Vec<(Codec, Vec<Point>)> = Vec::new();
        for &codec in &args.codecs {
            let mut points = Vec::new();
            for &kbps in &args.kbps {
                let encoded = match encode(&args, &scene, codec, kbps, &dir) {
                    Ok(encoded) => encoded,
                    Err(problem) => {
                        println!("{:<12} {kbps:>7} {problem}", codec.encoder(&args.encoder));
                        continue;
                    }
                };
                let frames = match measure(&args, &scene, &encoded, &dir) {
                    Ok(frames) if frames.len() == args.frames => frames,
                    Ok(frames) => {
                        println!("{:<12} {kbps:>7} only {} of {} frames came out of FFmpeg ({} packets)", codec.encoder(&args.encoder), frames.len(), args.frames, encoded.packets);
                        continue;
                    }
                    Err(problem) => {
                        println!("{:<12} {kbps:>7} {problem}", codec.encoder(&args.encoder));
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
                    "{:<12} {kbps:>7} {sent:>8.0} {mean_time:>9.2} {p95:>9.2} {:>8.1} {:>7.2} {:>7.2} {:>8.2}",
                    codec.encoder(&args.encoder),
                    encoded.key_bytes as f64 / 1000.0,
                    point.psnr,
                    point.psnr_yuv,
                    point.ssim,
                );
                points.push(point);
            }
            curves.push((codec, points));
        }

        println!("\nEach part of the scene: what was sent during it, in kbit/s, and the PSNR in Y it got.");
        println!("{:<12} {:>7} | {}", "encoder", "asked", PARTS.map(|part| format!("{:>22}", part.name())).join(" "));
        for (codec, points) in &curves {
            for point in points {
                println!("{:<12} {:>7} | {}", codec.encoder(&args.encoder), point.asked, point.parts.iter().map(|(kbps, psnr)| format!("{:>22}", format!("{kbps:.0} at {psnr:.2} dB"))).collect::<Vec<_>>().join(" "));
            }
        }

        let [(_, h264), (_, av1)] = curves.as_slice() else { return };
        println!("\nAt the same bitrate asked for, as a share asks for the most it may send, AV1 against H.264:");
        for point in av1 {
            if let Some(other) = h264.iter().find(|other| other.asked == point.asked) {
                println!(
                    "  {:>6} kbit/s: {:+.2} dB of PSNR in Y and {:+.2} dB of SSIM, sending {:.0}% as much",
                    point.asked,
                    point.psnr - other.psnr,
                    point.ssim - other.ssim,
                    point.kbps / other.kbps * 100.0
                );
            }
        }
        println!("\nHow much less AV1 sends than H.264 for the same quality, over the qualities both reach:");
        let saving = |quality: &dyn Fn(&Point) -> (f64, f64)| {
            let curve = |points: &[Point]| points.iter().map(quality).collect::<Vec<_>>();
            bitrate_saving(&curve(h264), &curve(av1)).map_or("they don't overlap".into(), |saving| format!("{:.0}%", saving * 100.0))
        };
        println!("  PSNR in Y, the whole scene: {}", saving(&|point| (point.kbps, point.psnr)));
        println!("  PSNR in Y, U and V, the whole scene: {}", saving(&|point| (point.kbps, point.psnr_yuv)));
        println!("  SSIM in Y, the whole scene: {}", saving(&|point| (point.kbps, point.ssim)));
        for (index, part) in PARTS.iter().enumerate() {
            println!("  PSNR in Y, {}, by what was sent during it: {}", part.name(), saving(&|point| point.parts[index]));
        }
        println!("\nWhat was encoded is in {}", dir.display());
    }
}
