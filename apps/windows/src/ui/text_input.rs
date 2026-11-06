//! An editable text field, one line or several that wrap and grow, as the desktop's
//! inputs and its message box are. Based on GPUI's own input example, with wrapping,
//! vertical movement, words, masking and a blinking caret.

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
}

/// What a field tells whoever holds it.
#[derive(Clone, Debug, PartialEq)]
pub enum InputEvent {
    Changed,
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

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
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
        let range = range.start.min(self.content.len())..range.end.min(self.content.len());
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

    pub fn focus(&self, window: &mut Window) {
        window.focus(&self.focus_handle);
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
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.show_caret(cx);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        self.show_caret(cx);
        cx.notify()
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

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx)
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx)
        }
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        if self.suggesting || !self.multiline || !self.vertical(-1., false, cx) {
            cx.emit(InputEvent::Up);
        }
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        if self.suggesting || !self.multiline || !self.vertical(1., false, cx) {
            cx.emit(InputEvent::Down);
        }
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        if !self.vertical(-1., true, cx) {
            self.select_to(0, cx);
        }
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        if !self.vertical(1., true, cx) {
            self.select_to(self.content.len(), cx);
        }
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.previous_word(self.cursor_offset()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.next_word(self.cursor_offset()), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_word(self.cursor_offset()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_word(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx)
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.line_start(self.cursor_offset()), cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.line_end(self.cursor_offset()), cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_start(self.cursor_offset()), cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_end(self.cursor_offset()), cx);
    }

    // --- Editing ---

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn backspace_word(&mut self, _: &BackspaceWord, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_word(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete_word(&mut self, _: &DeleteWord, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_word(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    pub fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if self.accepts_files {
            let files = crate::platform::clipboard_files();
            if !files.is_empty() {
                cx.emit(InputEvent::Files(files));
                return;
            }
            // A picture alone, as a screenshot is, goes as a file; one with text pastes the text.
            if let Some(item) = cx.read_from_clipboard() {
                let has_text = item.entries().iter().any(|entry| matches!(entry, gpui::ClipboardEntry::String(_)));
                let image = item.entries().iter().find_map(|entry| match entry {
                    gpui::ClipboardEntry::Image(image) => Some(image.clone()),
                    _ => None,
                });
                if let (false, Some(image)) = (has_text, image) {
                    if let Some(path) = crate::platform::save_pasted_image(&image) {
                        cx.emit(InputEvent::Files(vec![path]));
                    }
                    return;
                }
            }
        }
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let text = text.replace("\r\n", "\n");
            let text = if self.multiline { text } else { text.replace('\n', " ") };
            self.replace_text_in_range(None, &text, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() && !self.masked {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() && !self.masked {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
            self.replace_text_in_range(None, "", window, cx)
        }
    }

    fn enter(&mut self, _: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline && self.newline_on_enter && !self.suggesting {
            self.replace_text_in_range(None, "\n", window, cx);
        } else {
            cx.emit(InputEvent::Submit);
        }
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            self.replace_text_in_range(None, "\n", window, cx);
        } else {
            cx.emit(InputEvent::Submit);
        }
    }

    fn escape(&mut self, _: &Escape, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Escape);
    }

    fn tab(&mut self, _: &Tab, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Tab);
    }

    // --- The mouse ---

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        window.focus(&self.focus_handle);
        self.goal_x = None;
        let Some(bounds) = self.last_bounds else { return };
        let offset = self.offset_for(event.position - bounds.origin);
        if event.click_count >= 3 {
            self.move_to(self.line_start(offset), cx);
            self.select_to(self.line_end(offset), cx);
            return;
        }
        if event.click_count == 2 {
            let start = self.previous_word(self.next_boundary(offset).min(self.content.len()));
            let end = self.next_word(start);
            self.move_to(start, cx);
            self.select_to(end, cx);
            return;
        }
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(offset, cx);
        } else {
            self.move_to(offset, cx)
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            if let Some(bounds) = self.last_bounds {
                let offset = self.offset_for(event.position - bounds.origin);
                self.select_to(offset, cx);
            }
        }
    }

    // --- The caret ---

    fn show_caret(&mut self, cx: &mut Context<Self>) {
        self.caret_visible = true;
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

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus_handle.is_focused(window);
        if focused != self.was_focused {
            self.was_focused = focused;
            if focused {
                self.show_caret(cx);
                cx.emit(InputEvent::Focused);
            } else {
                self.blink = None;
                cx.emit(InputEvent::Blurred);
            }
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

struct TextElement {
    input: Entity<TextInput>,
}

struct PrepaintState {
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
fn runs_for(text_len: usize, marked: Option<Range<usize>>, run: TextRun) -> Vec<TextRun> {
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

fn shape(input: &TextInput, wrap_width: Option<Pixels>, window: &mut Window, color: Hsla, placeholder_color: Hsla) -> Vec<WrappedLine> {
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
        // Measure against these lines, then work out where the caret and selection are.
        let mut probe = TextInput { lines: lines.clone(), line_height, ..clone_for_probe(input) };
        probe.masked = input.masked;
        let selection = input.selected_range.clone();
        let mut selections = Vec::new();
        let mut cursor = None;
        let selection_color = gpui::rgba(0xffffff38);
        if input.content.is_empty() || selection.is_empty() {
            if let Some(position) = probe.position_for(input.cursor_offset()) {
                cursor = Some(fill(Bounds::new(bounds.origin + point(position.x, position.y), size(px(1.), line_height)), theme.text1));
            }
        } else {
            // One rectangle per visual line the selection crosses.
            let (Some(start), Some(end)) = (probe.position_for(selection.start), probe.position_for(selection.end)) else {
                return PrepaintState { lines, cursor, selections, line_height };
            };
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
        PrepaintState { lines, cursor, selections, line_height }
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
        if focus_handle.is_focused(window) && input.caret_visible && !input.disabled {
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
fn clone_for_probe(input: &TextInput) -> TextInput {
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
        accepts_files: input.accepts_files,
        suggesting: input.suggesting,
    }
}
