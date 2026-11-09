//! How the field's text is laid out and painted, and how the system's input methods edit it.

use super::*;

impl EntityInputHandler for TextInput {
    fn text_for_range(&mut self, range_utf16: Range<usize>, actual_range: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(&mut self, _ignore_disabled_input: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected_range), reversed: self.selection_reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(&mut self, range_utf16: Option<Range<usize>>, new_text: &str, _: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let text = if self.multiline { new_text.to_string() } else { new_text.replace('\n', " ") };
        self.content.replace_range(range.clone(), &text);
        self.selected_range = range.start + text.len()..range.start + text.len();
        self.selection_reversed = false;
        self.marked_range.take();
        self.goal_x = None;
        self.show_caret(cx);
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        self.marked_range = if new_text.is_empty() { None } else { Some(range.start..range.start + new_text.len()) };
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .map(|new_range| new_range.start + range.start..new_range.end + range.start)
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(&mut self, range_utf16: Range<usize>, bounds: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        let start = self.position_for(range.start)?;
        let end = self.position_for(range.end)?;
        Some(Bounds::from_corners(bounds.origin + start, bounds.origin + point(end.x, end.y + self.line_height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let bounds = self.last_bounds?;
        Some(self.offset_to_utf16(self.offset_for(point - bounds.origin)))
    }
}

pub(super) struct TextElement {
    pub(super) input: Entity<TextInput>,
}

pub(super) struct PrepaintState {
    lines: Vec<WrappedLine>,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
    line_height: Pixels,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// The runs for a text: one style, with the part being composed underlined.
pub(super) fn runs_for(text_len: usize, marked: Option<Range<usize>>, run: TextRun) -> Vec<TextRun> {
    match marked {
        Some(marked) if marked.end <= text_len => vec![
            TextRun { len: marked.start, ..run.clone() },
            TextRun { len: marked.end - marked.start, underline: Some(UnderlineStyle { color: Some(run.color), thickness: px(1.0), wavy: false }), ..run.clone() },
            TextRun { len: text_len - marked.end, ..run },
        ]
        .into_iter()
        .filter(|run| run.len > 0)
        .collect(),
        _ => vec![TextRun { len: text_len, ..run }],
    }
}

pub(super) fn shape(input: &TextInput, wrap_width: Option<Pixels>, window: &mut Window, color: Hsla, placeholder_color: Hsla) -> Vec<WrappedLine> {
    let style = window.text_style();
    let font_size = style.font_size.to_pixels(window.rem_size());
    let (text, color) = if input.content.is_empty() { (input.placeholder.to_string(), placeholder_color) } else { (input.display_text(), color) };
    let run = TextRun { len: text.len(), font: style.font(), color, background_color: None, underline: None, strikethrough: None };
    let marked = if input.content.is_empty() { None } else { input.marked_range.clone().map(|range| input.to_display(range.start)..input.to_display(range.end)) };
    let runs = runs_for(text.len(), marked, run);
    let wrap = if input.multiline { wrap_width } else { None };
    window
        .text_system()
        .shape_text(SharedString::from(text), font_size, &runs, wrap, None)
        .map(|lines| lines.into_vec())
        .unwrap_or_default()
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let input = self.input.clone();
        let line_height = window.line_height();
        if !input.read(cx).multiline {
            style.size.height = line_height.into();
            return (window.request_layout(style, [], cx), ());
        }
        let theme = *cx.global::<Theme>();
        let layout = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.or(match available.width {
                gpui::AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            let lines = shape(input.read(cx), width, window, theme.text1, theme.text3);
            let height: Pixels = lines.iter().map(|line| line.size(line_height).height).fold(px(0.), |a, b| a + b).max(line_height);
            size(width.unwrap_or(px(100.)), height)
        });
        (layout, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> PrepaintState {
        let theme = *cx.global::<Theme>();
        let line_height = window.line_height();
        let input = self.input.read(cx);
        let lines = shape(input, Some(bounds.size.width), window, theme.text1, theme.text3);
        // Measure against these lines, then work out where the caret and selection are. The probe
        // holds the lines while it measures, and gives them back after.
        let mut probe = TextInput { lines, line_height, ..clone_for_probe(input) };
        probe.masked = input.masked;
        let selection = input.selected_range.clone();
        let mut selections = Vec::new();
        let mut cursor = None;
        let selection_color = gpui::rgba(0xffffff38);
        if input.content.is_empty() || selection.is_empty() {
            if let Some(position) = probe.position_for(input.cursor_offset()) {
                cursor = Some(fill(Bounds::new(bounds.origin + point(position.x, position.y), size(px(1.), line_height)), theme.text1));
            }
        } else if let (Some(start), Some(end)) = (probe.position_for(selection.start), probe.position_for(selection.end)) {
            // One rectangle per visual line the selection crosses.
            let mut y = start.y;
            while y <= end.y {
                let left = if y == start.y { start.x } else { px(0.) };
                let right = if y == end.y { end.x } else { bounds.size.width };
                if right > left {
                    selections.push(fill(Bounds::from_corners(bounds.origin + point(left, y), bounds.origin + point(right, y + line_height)), selection_color));
                }
                y += line_height;
            }
        }
        PrepaintState { lines: std::mem::take(&mut probe.lines), cursor, selections, line_height }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        for selection in prepaint.selections.drain(..) {
            window.paint_quad(selection)
        }
        let mut y = bounds.origin.y;
        for line in &prepaint.lines {
            line.paint(point(bounds.origin.x, y), prepaint.line_height, gpui::TextAlign::Left, None, window, cx).ok();
            y += line.size(prepaint.line_height).height;
        }
        let input = self.input.read(cx);
        if focus_handle.is_focused(window) && window.is_window_active() && input.caret_visible && !input.disabled {
            if let Some(cursor) = prepaint.cursor.take() {
                window.paint_quad(cursor);
            }
        }
        let lines = std::mem::take(&mut prepaint.lines);
        let line_height = prepaint.line_height;
        self.input.update(cx, |input, _| {
            input.lines = lines;
            input.line_height = line_height;
            input.last_bounds = Some(bounds);
        });
    }
}

/// A copy of the parts of a field that measuring needs, without its handles.
pub(super) fn clone_for_probe(input: &TextInput) -> TextInput {
    TextInput {
        focus_handle: input.focus_handle.clone(),
        content: input.content.clone(),
        placeholder: input.placeholder.clone(),
        selected_range: input.selected_range.clone(),
        selection_reversed: input.selection_reversed,
        marked_range: input.marked_range.clone(),
        multiline: input.multiline,
        newline_on_enter: input.newline_on_enter,
        masked: input.masked,
        disabled: input.disabled,
        goal_x: None,
        lines: Vec::new(),
        line_height: input.line_height,
        last_bounds: None,
        is_selecting: false,
        caret_visible: true,
        blink: None,
        was_focused: false,
        blinking: false,
        accepts_files: input.accepts_files,
        suggesting: input.suggesting,
    }
}
