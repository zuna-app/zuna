//! Text cut off after a number of lines, as `-webkit-line-clamp` cuts it.

use super::*;

/// Text of at most `lines` lines, ending in "…" when there's more, as `-webkit-line-clamp`
/// does. GPUI's own `line_clamp` stops wrapping at its last line, which then runs on past
/// the box, and puts its ellipsis after `lines` widths of text, out of sight. It takes the
/// size, weight and color of the text around it.
pub fn clamped(text: impl Into<SharedString>, lines: usize) -> Clamped {
    Clamped { text: text.into(), lines: lines.max(1), colors: Vec::new() }
}

pub struct Clamped {
    text: SharedString,
    lines: usize,
    /// Colors for its first runs of bytes, in order; the rest is the text color around it.
    colors: Vec<(usize, Hsla)>,
}

impl Clamped {
    /// Colors its first runs of bytes, such as an author before what they wrote.
    pub fn colored(mut self, colors: Vec<(usize, Hsla)>) -> Self {
        self.colors = colors;
        self
    }
}

#[derive(Default)]
pub struct ClampedLayout {
    width: Option<Pixels>,
    shaped: smallvec::SmallVec<[gpui::WrappedLine; 1]>,
    line_height: Pixels,
    font_size: Pixels,
    run: Option<gpui::TextRun>,
    colors: Vec<(usize, Hsla)>,
}

pub(super) fn line_count(shaped: &[gpui::WrappedLine]) -> usize {
    shaped.iter().map(|line| line.wrap_boundaries().len() + 1).sum()
}

/// The text wrapped at `width` and cut to `lines`, with "…" where it was cut.
pub(super) fn clamp_lines(text: &str, font_size: Pixels, run: &gpui::TextRun, colors: &[(usize, Hsla)], width: Option<Pixels>, lines: usize, window: &Window) -> smallvec::SmallVec<[gpui::WrappedLine; 1]> {
    // A cut text is a start of the whole, so its colored runs are the whole's, cut short.
    let shape = |text: String| {
        let mut runs = Vec::new();
        let mut at = 0;
        for (length, color) in colors {
            if at >= text.len() {
                break;
            }
            let take = (*length).min(text.len() - at);
            if take > 0 {
                runs.push(gpui::TextRun { len: take, color: *color, ..run.clone() });
            }
            at += take;
        }
        if at < text.len() {
            runs.push(gpui::TextRun { len: text.len() - at, ..run.clone() });
        }
        window.text_system().shape_text(SharedString::from(text), font_size, &runs, width, None).unwrap_or_default()
    };
    let whole = shape(text.to_string());
    if line_count(&whole) <= lines {
        return whole;
    }
    let Some(_) = width else {
        // Unwrapped, only its first lines count.
        return whole.into_iter().take(lines).collect();
    };
    // The longest start that fits with its ellipsis: lo fits, hi doesn't.
    let ends: Vec<usize> = text.char_indices().map(|(at, _)| at).chain(std::iter::once(text.len())).collect();
    let cut = |end: usize| format!("{}…", text[..ends[end]].trim_end());
    let (mut lo, mut hi) = (0, ends.len() - 1);
    while hi - lo > 1 {
        let middle = (lo + hi) / 2;
        if line_count(&shape(cut(middle))) <= lines { lo = middle } else { hi = middle }
    }
    shape(cut(lo))
}

impl IntoElement for Clamped {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for Clamped {
    type RequestLayoutState = std::rc::Rc<std::cell::RefCell<ClampedLayout>>;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, _: &mut App) -> (gpui::LayoutId, Self::RequestLayoutState) {
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = style.line_height_in_pixels(window.rem_size());
        let run = style.to_run(self.text.len());
        let layout = std::rc::Rc::new(std::cell::RefCell::new(ClampedLayout { line_height, font_size, run: Some(run.clone()), colors: self.colors.clone(), ..Default::default() }));
        let (text, lines, measured, colors) = (self.text.clone(), self.lines, layout.clone(), self.colors.clone());
        let id = window.request_measured_layout(gpui::Style::default(), move |known, available, window, _| {
            let width = known.width.or(match available.width {
                gpui::AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            // At its narrowest it gives way, as min-width: 0 lets text.
            if width.is_none() && matches!(available.width, gpui::AvailableSpace::MinContent) {
                return gpui::size(px(0.), line_height);
            }
            let shaped = clamp_lines(&text, font_size, &run, &colors, width, lines, window);
            let height = line_height * line_count(&shaped).min(lines) as f32;
            let widest = shaped.iter().map(|line| line.width()).fold(px(0.), |a, b| a.max(b));
            let mut layout = measured.borrow_mut();
            layout.width = width;
            layout.shaped = shaped;
            gpui::size(known.width.unwrap_or(widest), height)
        });
        (id, layout)
    }

    fn prepaint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: gpui::Bounds<Pixels>, layout: &mut Self::RequestLayoutState, window: &mut Window, _: &mut App) {
        let mut layout = layout.borrow_mut();
        // Measured at another width than it was given: wrapped again at its own.
        if layout.width != Some(bounds.size.width) {
            if let Some(run) = layout.run.clone() {
                let colors = layout.colors.clone();
                layout.shaped = clamp_lines(&self.text, layout.font_size, &run, &colors, Some(bounds.size.width), self.lines, window);
                layout.width = Some(bounds.size.width);
            }
        }
    }

    fn paint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: gpui::Bounds<Pixels>, layout: &mut Self::RequestLayoutState, _: &mut (), window: &mut Window, cx: &mut App) {
        let layout = layout.borrow();
        let mut top = bounds.origin.y;
        for line in &layout.shaped {
            line.paint(point(bounds.origin.x, top), layout.line_height, gpui::TextAlign::Left, Some(bounds), window, cx).ok();
            top += line.size(layout.line_height).height;
        }
    }
}
