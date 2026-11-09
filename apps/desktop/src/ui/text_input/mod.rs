//! An editable text field, one line or several that wrap and grow, as the web's
//! inputs and its message box are. Based on GPUI's own input example, with wrapping,
//! vertical movement, words, masking and a blinking caret.

mod actions;
mod element;

use element::TextElement;

use std::ops::Range;
use std::time::Duration;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler, Entity, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, GlobalElementId, Hsla, KeyBinding, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad,
    Pixels, Point, SharedString, Style, Task, TextRun, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, point,
    prelude::*, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::Theme;

actions!(
    text_input,
    [
        Backspace,
        Delete,
        BackspaceWord,
        DeleteWord,
        Left,
        Right,
        Up,
        Down,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectWordLeft,
        SelectWordRight,
        SelectAll,
        Home,
        End,
        SelectHome,
        SelectEnd,
        BackspaceLine,
        TextStart,
        TextEnd,
        SelectTextStart,
        SelectTextEnd,
        Paste,
        Cut,
        Copy,
        Enter,
        Newline,
        Escape,
        Tab,
    ]
);

pub fn bind_keys(cx: &mut App) {
    let context = Some("TextInput");
    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("shift-backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("ctrl-backspace", BackspaceWord, context),
        KeyBinding::new("ctrl-delete", DeleteWord, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("ctrl-left", WordLeft, context),
        KeyBinding::new("ctrl-right", WordRight, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("ctrl-shift-left", SelectWordLeft, context),
        KeyBinding::new("ctrl-shift-right", SelectWordRight, context),
        KeyBinding::new("ctrl-a", SelectAll, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("shift-home", SelectHome, context),
        KeyBinding::new("shift-end", SelectEnd, context),
        KeyBinding::new("ctrl-v", Paste, context),
        KeyBinding::new("shift-insert", Paste, context),
        KeyBinding::new("ctrl-c", Copy, context),
        KeyBinding::new("ctrl-insert", Copy, context),
        KeyBinding::new("ctrl-x", Cut, context),
        KeyBinding::new("enter", Enter, context),
        KeyBinding::new("ctrl-enter", Enter, context),
        KeyBinding::new("shift-enter", Newline, context),
        KeyBinding::new("escape", Escape, context),
        KeyBinding::new("tab", Tab, context),
    ]);
    // macOS's own: ⌘ for the clipboard and the text's ends, ⌥ by word, and ⌘ with the arrows
    // to the line's ends, as every field on a Mac takes them.
    #[cfg(target_os = "macos")]
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("shift-backspace", Backspace, context),
        KeyBinding::new("ctrl-h", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("ctrl-d", Delete, context),
        KeyBinding::new("alt-backspace", BackspaceWord, context),
        KeyBinding::new("alt-delete", DeleteWord, context),
        KeyBinding::new("cmd-backspace", BackspaceLine, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("alt-left", WordLeft, context),
        KeyBinding::new("alt-right", WordRight, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("alt-shift-left", SelectWordLeft, context),
        KeyBinding::new("alt-shift-right", SelectWordRight, context),
        KeyBinding::new("cmd-a", SelectAll, context),
        KeyBinding::new("cmd-left", Home, context),
        KeyBinding::new("cmd-right", End, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("ctrl-a", Home, context),
        KeyBinding::new("ctrl-e", End, context),
        KeyBinding::new("cmd-shift-left", SelectHome, context),
        KeyBinding::new("cmd-shift-right", SelectEnd, context),
        KeyBinding::new("shift-home", SelectHome, context),
        KeyBinding::new("shift-end", SelectEnd, context),
        KeyBinding::new("cmd-up", TextStart, context),
        KeyBinding::new("cmd-down", TextEnd, context),
        KeyBinding::new("cmd-shift-up", SelectTextStart, context),
        KeyBinding::new("cmd-shift-down", SelectTextEnd, context),
        KeyBinding::new("cmd-v", Paste, context),
        KeyBinding::new("cmd-c", Copy, context),
        KeyBinding::new("cmd-x", Cut, context),
        KeyBinding::new("enter", Enter, context),
        KeyBinding::new("cmd-enter", Enter, context),
        KeyBinding::new("shift-enter", Newline, context),
        KeyBinding::new("escape", Escape, context),
        KeyBinding::new("tab", Tab, context),
    ]);
}

/// What a field tells whoever holds it.
#[derive(Clone, Debug, PartialEq)]
pub enum InputEvent {
    Changed,
    /// The caret moved without the text changing: a click, an arrow, Home or End.
    CaretMoved,
    /// Enter, in a field where Enter doesn't make a new line.
    Submit,
    Escape,
    Tab,
    /// Up or Down where the caret can't go further, for suggestions and editing the last message.
    Up,
    Down,
    Focused,
    Blurred,
    /// Files pasted into a field that takes them: copied files, or a picture saved for sending.
    Files(Vec<std::path::PathBuf>),
}

pub struct TextInput {
    focus_handle: FocusHandle,
    content: String,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    /// Several lines that wrap; Enter still submits unless `newline_on_enter`.
    multiline: bool,
    newline_on_enter: bool,
    masked: bool,
    disabled: bool,
    /// Where the caret goes back to when moving up and down through lines.
    goal_x: Option<Pixels>,
    lines: Vec<WrappedLine>,
    line_height: Pixels,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    caret_visible: bool,
    blink: Option<Task<()>>,
    was_focused: bool,
    /// Whether the caret shows and blinks: in a focused field of a window in front. A window
    /// behind shows none, as a system field and a browser's do.
    blinking: bool,
    /// Pasted files and pictures go to whoever holds the field, as the message box's do.
    accepts_files: bool,
    /// While suggestions show, the arrows and Enter pick among them instead of moving or sending.
    suggesting: bool,
}

impl EventEmitter<InputEvent> for TextInput {}

thread_local! {
    /// Every field's focus, to tell whether typing already has somewhere to go.
    static FIELDS: std::cell::RefCell<Vec<gpui::WeakFocusHandle>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Whether any text field has focus.
pub fn any_focused(window: &Window) -> bool {
    FIELDS.with(|fields| {
        let mut fields = fields.borrow_mut();
        fields.retain(|field| field.upgrade().is_some());
        fields.iter().any(|field| field.upgrade().is_some_and(|field| field.is_focused(window)))
    })
}

impl TextInput {
    pub fn new(cx: &mut Context<Self>, placeholder: impl Into<SharedString>) -> Self {
        let focus_handle = cx.focus_handle();
        FIELDS.with(|fields| fields.borrow_mut().push(focus_handle.downgrade()));
        TextInput {
            focus_handle,
            content: String::new(),
            placeholder: placeholder.into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            multiline: false,
            newline_on_enter: false,
            masked: false,
            disabled: false,
            goal_x: None,
            lines: Vec::new(),
            line_height: px(20.),
            last_bounds: None,
            is_selecting: false,
            caret_visible: true,
            blink: None,
            was_focused: false,
            blinking: false,
            accepts_files: false,
            suggesting: false,
        }
    }

    pub fn accepts_files(mut self) -> Self {
        self.accepts_files = true;
        self
    }

    pub fn set_suggesting(&mut self, suggesting: bool) {
        self.suggesting = suggesting;
    }

    pub fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }

    pub fn masked(mut self, masked: bool) -> Self {
        self.masked = masked;
        self
    }

    pub fn set_masked(&mut self, masked: bool, cx: &mut Context<Self>) {
        self.masked = masked;
        cx.notify();
    }

    pub fn set_newline_on_enter(&mut self, newline: bool) {
        self.newline_on_enter = newline;
    }

    pub fn set_placeholder(&mut self, placeholder: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.placeholder = placeholder.into();
        cx.notify();
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn cursor(&self) -> usize {
        self.cursor_offset()
    }

    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.content = text.into();
        let end = self.content.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    /// Replaces a range of the text, leaving the caret after what was put in.
    pub fn replace_range(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        // Either end may be stale or reversed, which String::replace_range would panic on.
        let snap = |offset: usize| {
            let mut offset = offset.min(self.content.len());
            while !self.content.is_char_boundary(offset) {
                offset -= 1;
            }
            offset
        };
        let (start, end) = (snap(range.start), snap(range.end));
        let range = start.min(end)..start.max(end);
        self.content.replace_range(range.clone(), text);
        let caret = range.start + text.len();
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    pub fn insert(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, text, window, cx);
    }

    fn display_text(&self) -> String {
        if self.masked { "•".repeat(self.content.chars().count()) } else { self.content.clone() }
    }

    /// The display text's offset for a content offset: masking makes every character three bytes.
    fn to_display(&self, offset: usize) -> usize {
        if !self.masked {
            return offset;
        }
        self.content[..offset.min(self.content.len())].chars().count() * '•'.len_utf8()
    }

    fn from_display(&self, offset: usize) -> usize {
        if !self.masked {
            return offset.min(self.content.len());
        }
        let chars = offset / '•'.len_utf8();
        self.content.char_indices().nth(chars).map(|(index, _)| index).unwrap_or(self.content.len())
    }

    // --- Moving and selecting ---

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed { self.selected_range.start } else { self.selected_range.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let before = self.cursor_offset();
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.caret_moved(before, cx);
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let before = self.cursor_offset();
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        self.caret_moved(before, cx);
    }

    fn caret_moved(&mut self, before: usize, cx: &mut Context<Self>) {
        self.show_caret(cx);
        if self.cursor_offset() != before {
            cx.emit(InputEvent::CaretMoved);
        }
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).rev().find_map(|(index, _)| (index < offset).then_some(index)).unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).find_map(|(index, _)| (index > offset).then_some(index)).unwrap_or(self.content.len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        let before = &self.content[..offset];
        let trimmed = before.trim_end();
        trimmed.unicode_word_indices().last().map(|(index, _)| index).unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        let after = &self.content[offset..];
        for (index, word) in after.unicode_word_indices() {
            let end = offset + index + word.len();
            if end > offset {
                return end;
            }
        }
        self.content.len()
    }

    fn line_start(&self, offset: usize) -> usize {
        self.content[..offset].rfind('\n').map(|index| index + 1).unwrap_or(0)
    }

    fn line_end(&self, offset: usize) -> usize {
        self.content[offset..].find('\n').map(|index| offset + index).unwrap_or(self.content.len())
    }

    /// Where an offset is drawn, relative to the field's top left.
    fn position_for(&self, offset: usize) -> Option<Point<Pixels>> {
        let display = self.to_display(offset);
        let mut start = 0;
        let mut y = px(0.);
        for line in &self.lines {
            let length = line.len();
            if display <= start + length {
                let local = line.position_for_index(display - start, self.line_height)?;
                return Some(point(local.x, y + local.y));
            }
            start += length + 1;
            y += line.size(self.line_height).height;
        }
        Some(point(px(0.), y))
    }

    /// The offset nearest a point relative to the field's top left.
    fn offset_for(&self, position: Point<Pixels>) -> usize {
        let mut start = 0;
        let mut y = px(0.);
        for (index, line) in self.lines.iter().enumerate() {
            let height = line.size(self.line_height).height;
            if position.y < y + height || index == self.lines.len() - 1 {
                let local = point(position.x, (position.y - y).max(px(0.)).min(height - px(1.)));
                let found = match line.closest_index_for_position(local, self.line_height) {
                    Ok(found) | Err(found) => found,
                };
                return self.from_display(start + found);
            }
            start += line.len() + 1;
            y += height;
        }
        self.content.len()
    }

    fn vertical(&mut self, direction: f32, select: bool, cx: &mut Context<Self>) -> bool {
        let cursor = self.cursor_offset();
        let Some(position) = self.position_for(cursor) else { return false };
        let x = *self.goal_x.get_or_insert(position.x);
        let target_y = position.y + self.line_height * direction + self.line_height / 2.;
        let total: Pixels = self.lines.iter().map(|line| line.size(self.line_height).height).fold(px(0.), |a, b| a + b);
        if target_y < px(0.) || target_y >= total {
            return false;
        }
        let offset = self.offset_for(point(x, target_y));
        let goal = self.goal_x;
        if select {
            self.select_to(offset, cx)
        } else {
            self.move_to(offset, cx)
        }
        self.goal_x = goal;
        true
    }

    fn show_caret(&mut self, cx: &mut Context<Self>) {
        self.caret_visible = true;
        if !self.blinking {
            self.blink = None;
            return;
        }
        self.blink = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(530)).await;
                if this
                    .update(cx, |input, cx| {
                        input.caret_visible = !input.caret_visible;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    // --- UTF-16, for the system's input methods ---

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;
        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }
        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;
        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }
        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus_handle.is_focused(window);
        // The window going behind or coming to the front draws everything again, so this follows it.
        let blinking = focused && window.is_window_active();
        if blinking != self.blinking {
            self.blinking = blinking;
            self.show_caret(cx);
        }
        if focused != self.was_focused {
            self.was_focused = focused;
            cx.emit(if focused { InputEvent::Focused } else { InputEvent::Blurred });
        }
        div()
            .flex()
            .w_full()
            .key_context("TextInput")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::backspace_word))
            .on_action(cx.listener(Self::delete_word))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::text_start))
            .on_action(cx.listener(Self::text_end))
            .on_action(cx.listener(Self::select_text_start))
            .on_action(cx.listener(Self::select_text_end))
            .on_action(cx.listener(Self::backspace_line))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::enter))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::escape))
            .on_action(cx.listener(Self::tab))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(TextElement { input: cx.entity() })
    }
}
