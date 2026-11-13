//! The text field on GPUI's test platform, edited as keys, the mouse, the clipboard and the
//! system's input methods edit it. Each action is dispatched by itself, so the tests hold on every
//! system, whichever keys it binds them to.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, TestAppContext, WindowHandle};

use super::*;

struct Fields {
    one: Entity<TextInput>,
    many: Entity<TextInput>,
    scope: FocusHandle,
}

impl Render for Fields {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w(px(300.)).flex().flex_col().track_focus(&self.scope).tab_scope(&self.scope).child(self.one.clone()).child(self.many.clone())
    }
}

/// A window with a field of one line and one of several, and what both told.
struct Test {
    window: WindowHandle<Fields>,
    one: Entity<TextInput>,
    many: Entity<TextInput>,
    events: Rc<RefCell<Vec<InputEvent>>>,
}

fn open(cx: &mut TestAppContext) -> Test {
    cx.update(|cx| {
        crate::assets::load_fonts(cx);
        bind_keys(cx);
        cx.set_global(Theme::new(crate::theme::Accent::Neutral, crate::theme::TextSize::Medium));
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    let window = cx.add_window(|_, cx| {
        let one = cx.new(|cx| TextInput::new(cx, "One line"));
        let many = cx.new(|cx| TextInput::new(cx, "Many lines").multiline());
        for input in [&one, &many] {
            let seen = seen.clone();
            cx.subscribe(input, move |_, _, event: &InputEvent, _| seen.borrow_mut().push(event.clone())).detach();
        }
        Fields { one, many, scope: cx.focus_handle() }
    });
    let (one, many) = window.update(cx, |fields, _, _| (fields.one.clone(), fields.many.clone())).unwrap();
    let test = Test { window, one, many, events };
    cx.run_until_parked();
    test
}

impl Test {
    fn focus(&self, cx: &mut TestAppContext, input: &Entity<TextInput>) {
        let handle = cx.read(|cx| input.focus_handle(cx));
        self.window.update(cx, |_, window, cx| window.focus(&handle, cx)).unwrap();
        cx.run_until_parked();
    }

    fn act(&self, cx: &mut TestAppContext, action: impl gpui::Action) {
        cx.dispatch_action(self.window.into(), action);
        cx.run_until_parked();
    }

    fn type_in(&self, cx: &mut TestAppContext, text: &str) {
        cx.simulate_input(self.window.into(), text);
        cx.run_until_parked();
    }

    /// Sets a field's text and what's selected.
    fn set(&self, cx: &mut TestAppContext, input: &Entity<TextInput>, text: &str, selected: Range<usize>, reversed: bool) {
        input.update(cx, |input, cx| {
            input.set_text(text, cx);
            input.selected_range = selected;
            input.selection_reversed = reversed;
            input.goal_x = None;
        });
        cx.run_until_parked();
        self.events.borrow_mut().clear();
    }

    fn text(&self, cx: &mut TestAppContext, input: &Entity<TextInput>) -> String {
        cx.read(|cx| input.read(cx).text().to_string())
    }

    fn selected(&self, cx: &mut TestAppContext, input: &Entity<TextInput>) -> Range<usize> {
        cx.read(|cx| input.read(cx).selected_range.clone())
    }

    fn caret(&self, cx: &mut TestAppContext, input: &Entity<TextInput>) -> usize {
        cx.read(|cx| input.read(cx).cursor())
    }

    fn took(&self) -> Vec<InputEvent> {
        std::mem::take(&mut *self.events.borrow_mut())
    }

    /// Where an offset of a field is drawn in the window, halfway down its line.
    fn point_at(&self, cx: &mut TestAppContext, input: &Entity<TextInput>, offset: usize) -> Point<Pixels> {
        cx.read(|cx| {
            let input = input.read(cx);
            let bounds = input.last_bounds.expect("the field was drawn");
            let at = input.position_for(offset).unwrap();
            bounds.origin + at - point(input.scroll_x, px(0.)) + point(px(0.5), input.line_height / 2.)
        })
    }

    fn click(&self, cx: &mut TestAppContext, position: Point<Pixels>, click_count: usize, modifiers: Modifiers) {
        let mut window = gpui::VisualTestContext::from_window(self.window.into(), cx);
        window.simulate_event(MouseDownEvent { position, modifiers, button: MouseButton::Left, click_count, first_mouse: false });
        window.simulate_event(MouseUpEvent { position, modifiers, button: MouseButton::Left, click_count });
    }

    fn focused(&self, cx: &mut TestAppContext, input: &Entity<TextInput>) -> bool {
        self.window.update(cx, |_, window, cx| input.focus_handle(cx).is_focused(window)).unwrap()
    }
}

const TEXT: &str = "héllo wörld 👍🏽";

#[gpui::test]
fn the_caret_moves_by_character_word_line_and_text(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    assert!(test.took().contains(&InputEvent::Focused));
    test.type_in(cx, TEXT);
    assert_eq!(test.text(cx, &test.one), TEXT);
    let end = TEXT.len();
    let thumb = TEXT.find('👍').unwrap();
    let world = TEXT.find("wörld").unwrap();
    assert_eq!(test.caret(cx, &test.one), end);
    test.act(cx, Left);
    assert_eq!(test.caret(cx, &test.one), thumb, "a thumb and its skin tone are one step");
    test.act(cx, Right);
    test.act(cx, Right);
    assert_eq!(test.caret(cx, &test.one), end, "and no further than the end");
    test.act(cx, WordLeft);
    assert_eq!(test.caret(cx, &test.one), world);
    test.act(cx, WordLeft);
    assert_eq!(test.caret(cx, &test.one), 0);
    test.act(cx, WordRight);
    assert_eq!(test.caret(cx, &test.one), "héllo".len());
    test.act(cx, Home);
    assert_eq!(test.caret(cx, &test.one), 0);
    test.act(cx, End);
    assert_eq!(test.caret(cx, &test.one), end);
    test.act(cx, TextStart);
    test.act(cx, Left);
    assert_eq!(test.caret(cx, &test.one), 0, "and no further back than the start");
    test.act(cx, TextEnd);
    assert_eq!(test.caret(cx, &test.one), end);
    let moved = test.took().iter().filter(|event| **event == InputEvent::CaretMoved).count();
    assert_eq!(moved, 9, "each move that moved it says so, and only those");
    test.act(cx, WordRight);
    assert!(test.took().is_empty(), "a move to where it was says nothing");

    // Home and End stay on their line in a field of several.
    test.focus(cx, &test.many);
    test.set(cx, &test.many, "one\ntwo three\nfour", 6..6, false);
    test.act(cx, Home);
    assert_eq!(test.caret(cx, &test.many), 4);
    test.act(cx, End);
    assert_eq!(test.caret(cx, &test.many), 13);
    test.act(cx, TextEnd);
    assert_eq!(test.caret(cx, &test.many), 18);
}

#[gpui::test]
fn a_selection_grows_either_way_and_collapses_to_its_ends(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    let (end, thumb, world) = (TEXT.len(), TEXT.find('👍').unwrap(), TEXT.find("wörld").unwrap());
    test.set(cx, &test.one, TEXT, end..end, false);
    test.act(cx, SelectLeft);
    assert_eq!(test.selected(cx, &test.one), thumb..end);
    assert!(cx.read(|cx| test.one.read(cx).selection_reversed), "the caret is at its start");
    test.act(cx, SelectWordLeft);
    assert_eq!(test.selected(cx, &test.one), world..end);
    test.act(cx, SelectRight);
    assert_eq!(test.selected(cx, &test.one), world + "w".len()..end);
    test.act(cx, SelectHome);
    assert_eq!(test.selected(cx, &test.one), 0..end);
    test.act(cx, SelectEnd);
    assert_eq!(test.selected(cx, &test.one), end..end, "back over itself, it collapses at the end");
    test.act(cx, SelectTextStart);
    assert_eq!(test.selected(cx, &test.one), 0..end);
    test.act(cx, SelectWordRight);
    assert_eq!(test.selected(cx, &test.one), "héllo".len()..end);
    test.act(cx, SelectTextEnd);
    test.act(cx, SelectAll);
    assert_eq!(test.selected(cx, &test.one), 0..end);
    test.act(cx, Right);
    assert_eq!(test.selected(cx, &test.one), end..end, "Right goes to a selection's end");
    test.act(cx, SelectAll);
    test.act(cx, Left);
    assert_eq!(test.selected(cx, &test.one), 0..0, "and Left to its start");

    // Up and Down in a field of one line go to its ends as they select, and tell whoever holds it otherwise.
    test.set(cx, &test.one, TEXT, world..world, false);
    test.act(cx, SelectUp);
    assert_eq!(test.selected(cx, &test.one), 0..world);
    test.act(cx, SelectDown);
    assert_eq!(test.selected(cx, &test.one), world..end);
    test.took();
    test.act(cx, Up);
    test.act(cx, Down);
    assert_eq!(test.took(), vec![InputEvent::Up, InputEvent::Down]);
}

#[gpui::test]
fn deleting_by_character_word_line_and_selection(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    let end = TEXT.len();
    test.set(cx, &test.one, TEXT, end..end, false);
    test.act(cx, Backspace);
    assert_eq!(test.text(cx, &test.one), "héllo wörld ", "a thumb and its skin tone go together");
    assert_eq!(test.took(), vec![InputEvent::CaretMoved, InputEvent::Changed]);
    test.act(cx, BackspaceWord);
    assert_eq!(test.text(cx, &test.one), "héllo ");
    test.act(cx, TextStart);
    test.act(cx, Delete);
    assert_eq!(test.text(cx, &test.one), "éllo ");
    test.act(cx, DeleteWord);
    assert_eq!(test.text(cx, &test.one), " ");
    test.set(cx, &test.one, TEXT, 0..6, false);
    test.act(cx, Delete);
    assert_eq!(test.text(cx, &test.one), " wörld 👍🏽", "a selection goes whole");
    test.set(cx, &test.one, TEXT, 0..6, true);
    test.act(cx, BackspaceWord);
    assert_eq!(test.text(cx, &test.one), " wörld 👍🏽");
    test.set(cx, &test.one, TEXT, 0..6, false);
    test.type_in(cx, "Hi,");
    assert_eq!(test.text(cx, &test.one), "Hi, wörld 👍🏽", "what's typed takes a selection's place");
    test.set(cx, &test.one, TEXT, 7..7, false);
    test.act(cx, DeleteWord);
    assert_eq!(test.text(cx, &test.one), "héllo  👍🏽");

    // Back to a line's start, and at its start, the break before it.
    test.focus(cx, &test.many);
    test.set(cx, &test.many, "one\ntwo", 7..7, false);
    test.act(cx, BackspaceLine);
    assert_eq!(test.text(cx, &test.many), "one\n");
    test.act(cx, BackspaceLine);
    assert_eq!(test.text(cx, &test.many), "one");
    test.set(cx, &test.many, "one\ntwo", 1..6, false);
    test.act(cx, BackspaceLine);
    assert_eq!(test.text(cx, &test.many), "oo");
}

#[gpui::test]
fn the_clipboard_copies_cuts_and_pastes_but_never_a_password(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    let world = TEXT.find("wörld").unwrap();
    test.set(cx, &test.one, TEXT, world..world + "wörld".len(), false);
    test.act(cx, Copy);
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("wörld"));
    test.act(cx, Cut);
    assert_eq!(test.text(cx, &test.one), "héllo  👍🏽");
    test.set(cx, &test.one, "", 0..0, false);
    test.act(cx, Copy);
    test.act(cx, Cut);
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("wörld"), "nothing selected copies nothing");

    cx.write_to_clipboard(gpui::ClipboardItem::new_string("a\r\nb\nc".into()));
    test.act(cx, Paste);
    assert_eq!(test.text(cx, &test.one), "a b c", "a field of one line takes lines as spaces");
    test.focus(cx, &test.many);
    test.act(cx, Paste);
    assert_eq!(test.text(cx, &test.many), "a\nb\nc");

    // A masked field shows bullets, and gives nothing of itself to the clipboard.
    test.focus(cx, &test.one);
    test.one.update(cx, |input, cx| input.set_masked(true, cx));
    test.set(cx, &test.one, "pässword", 0..9, false);
    assert_eq!(cx.read(|cx| test.one.read(cx).display_text()), "••••••••");
    test.act(cx, Copy);
    test.act(cx, Cut);
    assert_eq!(test.text(cx, &test.one), "pässword");
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("a\r\nb\nc"));
    cx.read(|cx| {
        let input = test.one.read(cx);
        assert_eq!(input.to_display(3), 2 * '•'.len_utf8(), "after p and ä, two bullets");
        assert_eq!(input.from_display(2 * '•'.len_utf8()), 3);
        assert_eq!(input.from_display(100), "pässword".len());
    });
}

#[gpui::test]
fn enter_tab_and_escape_go_to_whoever_holds_the_field(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    test.set(cx, &test.one, "hi", 2..2, false);
    test.act(cx, Enter);
    test.act(cx, Newline);
    test.act(cx, Escape);
    assert_eq!(test.took(), vec![InputEvent::Submit, InputEvent::Submit, InputEvent::Escape]);
    assert_eq!(test.text(cx, &test.one), "hi");

    // Tab picks a suggestion while they show, and otherwise moves on through the fields, in turn.
    test.one.update(cx, |input, _| input.set_suggesting(true));
    test.act(cx, Tab);
    test.act(cx, ShiftTab);
    assert_eq!(test.took(), vec![InputEvent::Tab, InputEvent::Tab]);
    test.one.update(cx, |input, _| input.set_suggesting(false));
    test.act(cx, Tab);
    assert!(test.focused(cx, &test.many), "Tab went to the next field");
    assert!(test.window.update(cx, |_, window, _| any_focused(window)).unwrap());
    test.act(cx, ShiftTab);
    assert!(test.focused(cx, &test.one), "and Shift+Tab back");
    assert!(test.took().contains(&InputEvent::Blurred));

    // Enter makes a new line where it's asked to, and sends otherwise.
    test.focus(cx, &test.many);
    test.set(cx, &test.many, "hi", 2..2, false);
    test.act(cx, Enter);
    assert_eq!(test.took(), vec![InputEvent::Submit]);
    test.act(cx, Newline);
    assert_eq!(test.text(cx, &test.many), "hi\n");
    test.many.update(cx, |input, _| input.set_newline_on_enter(true));
    test.act(cx, Enter);
    assert_eq!(test.text(cx, &test.many), "hi\n\n");
    test.many.update(cx, |input, _| input.set_suggesting(true));
    test.act(cx, Enter);
    test.act(cx, Up);
    test.act(cx, Down);
    assert_eq!(test.took(), vec![InputEvent::Changed, InputEvent::Changed, InputEvent::Submit, InputEvent::Up, InputEvent::Down], "suggesting, Enter and the arrows go to the suggestions");
}

#[gpui::test]
fn up_and_down_go_through_lines_keeping_to_their_column(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.many);
    let text = "first line\nsecond\nthird line here";
    let (second, third) = (text.find("second").unwrap(), text.find("third").unwrap());
    test.set(cx, &test.many, text, text.len()..text.len(), false);
    let line_of = |offset: usize| text[..offset].matches('\n').count();
    test.act(cx, Up);
    let caret = test.caret(cx, &test.many);
    assert_eq!(line_of(caret), 1);
    assert_eq!(caret, second + "second".len(), "as far along as the line goes");
    test.act(cx, Up);
    let caret = test.caret(cx, &test.many);
    assert_eq!(line_of(caret), 0);
    assert_eq!(caret, "first line".len(), "back out towards the column it started from, as far as this line goes");
    test.took();
    test.act(cx, Up);
    assert_eq!(test.took(), vec![InputEvent::Up], "at the top it tells whoever holds the field");
    test.act(cx, Down);
    test.act(cx, Down);
    assert_eq!(line_of(test.caret(cx, &test.many)), 2);
    assert!(test.caret(cx, &test.many) > third + 10);
    test.took();
    test.act(cx, Down);
    assert_eq!(test.took(), vec![InputEvent::Down]);

    test.set(cx, &test.many, text, third..third, false);
    test.act(cx, SelectUp);
    assert_eq!(test.selected(cx, &test.many), second..third);
    test.act(cx, SelectUp);
    test.act(cx, SelectUp);
    assert_eq!(test.selected(cx, &test.many), 0..third, "from the top line, to the text's start");
    test.set(cx, &test.many, text, second..second, false);
    test.act(cx, SelectDown);
    assert_eq!(test.selected(cx, &test.many), second..third);
    test.act(cx, SelectDown);
    test.act(cx, SelectDown);
    assert_eq!(test.selected(cx, &test.many), second..text.len(), "from the bottom line, to its end");
}

#[gpui::test]
fn the_mouse_places_the_caret_and_selects_words_lines_and_what_it_drags_over(cx: &mut TestAppContext) {
    let test = open(cx);
    test.set(cx, &test.one, "hello brave world", 0..0, false);
    let at = |cx: &mut TestAppContext, offset: usize| test.point_at(cx, &test.one, offset);
    let end_of_hello = at(cx, 5);
    test.click(cx, end_of_hello, 1, Modifiers::none());
    assert!(test.focused(cx, &test.one), "a click focuses it");
    assert_eq!(test.selected(cx, &test.one), 5..5);
    let in_world = at(cx, 13);
    test.click(cx, in_world, 1, Modifiers::shift());
    assert_eq!(test.selected(cx, &test.one), 5..13, "Shift extends what's selected");
    let in_brave = at(cx, 8);
    test.click(cx, in_brave, 2, Modifiers::none());
    assert_eq!(test.selected(cx, &test.one), 6..11, "two clicks pick the word");
    test.click(cx, in_brave, 3, Modifiers::none());
    assert_eq!(test.selected(cx, &test.one), 0..17, "three, the line");

    // A drag selects what it goes over, and stops with the button.
    let (from, to, past) = (at(cx, 1), at(cx, 9), at(cx, 12));
    let mut window = gpui::VisualTestContext::from_window(test.window.into(), cx);
    window.simulate_event(MouseDownEvent { position: from, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 1, first_mouse: false });
    window.simulate_event(MouseMoveEvent { position: to, modifiers: Modifiers::none(), pressed_button: Some(MouseButton::Left) });
    window.simulate_event(MouseUpEvent { position: to, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 1 });
    window.simulate_event(MouseMoveEvent { position: past, modifiers: Modifiers::none(), pressed_button: None });
    assert_eq!(test.selected(cx, &test.one), 1..9);

    // A field that's off takes no clicks and no text.
    test.one.update(cx, |input, _| input.disabled = true);
    let in_hello = at(cx, 3);
    test.click(cx, in_hello, 1, Modifiers::none());
    assert_eq!(test.selected(cx, &test.one), 1..9);
    test.window
        .update(cx, |_, window, cx| test.one.update(cx, |input, cx| input.replace_text_in_range(None, "nope", window, cx)))
        .unwrap();
    assert_eq!(test.text(cx, &test.one), "hello brave world");
}

#[gpui::test]
fn a_long_line_scrolls_to_keep_the_caret_in_view(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.one);
    test.type_in(cx, &"a long line of text that goes on ".repeat(6));
    assert!(cx.read(|cx| test.one.read(cx).scroll_x) > px(0.), "scrolled to the caret at the end");
    let far = cx.read(|cx| test.one.read(cx).scroll_x);
    test.act(cx, TextStart);
    assert_eq!(cx.read(|cx| test.one.read(cx).scroll_x), px(0.), "and back to the start");
    test.act(cx, TextEnd);
    assert_eq!(cx.read(|cx| test.one.read(cx).scroll_x), far);
    // A click still lands where it's drawn.
    let target = test.text(cx, &test.one).len() - 3;
    let near_end = test.point_at(cx, &test.one, target);
    test.click(cx, near_end, 1, Modifiers::none());
    assert_eq!(test.caret(cx, &test.one), target);
    test.one.update(cx, |input, cx| input.set_placeholder("Something else", cx));
    test.set(cx, &test.one, "", 0..0, false);
    assert_eq!(cx.read(|cx| test.one.read(cx).scroll_x), px(0.));
}

#[gpui::test]
fn the_systems_input_methods_edit_it_in_utf16(cx: &mut TestAppContext) {
    let test = open(cx);
    test.focus(cx, &test.many);
    test.set(cx, &test.many, "a👍b", 0..0, false);
    let input = test.many.clone();
    let with = |cx: &mut TestAppContext, edit: &dyn Fn(&mut TextInput, &mut Window, &mut Context<TextInput>)| {
        test.window.update(cx, |_, window, cx| input.update(cx, |input, cx| edit(input, window, cx))).unwrap();
    };
    // 👍 is two UTF-16 units and four bytes.
    with(cx, &|input, window, cx| {
        let mut actual = None;
        assert_eq!(input.text_for_range(1..3, &mut actual, window, cx).as_deref(), Some("👍"));
        assert_eq!(actual, Some(1..3));
        assert_eq!(input.offset_from_utf16(3), 5);
        assert_eq!(input.offset_to_utf16(5), 3);
        input.selected_range = 1..5;
        input.selection_reversed = true;
        let selection = input.selected_text_range(false, window, cx).unwrap();
        assert_eq!((selection.range, selection.reversed), (1..3, true));
    });
    // Composing: marked text, replaced as it's composed, and then committed. The selection the
    // system gives is within what it composes, wherever that is: after 👍 too.
    with(cx, &|input, window, cx| {
        input.replace_and_mark_text_in_range(Some(4..4), "ni", Some(2..2), window, cx);
        assert_eq!(input.text(), "a👍bni");
        assert_eq!(input.marked_text_range(window, cx), Some(4..6));
        assert_eq!(input.selected_range, 8..8);
        input.replace_and_mark_text_in_range(None, "n👍i", Some(1..3), window, cx);
        assert_eq!(input.selected_range, 7..11, "around the 👍 it composed");
        input.replace_and_mark_text_in_range(None, "ni", Some(0..9), window, cx);
        assert_eq!(input.selected_range, 6..8, "and never past what it put in");
        input.replace_and_mark_text_in_range(None, "nih", None, window, cx);
        assert_eq!(input.text(), "a👍bnih");
        input.replace_text_in_range(None, "你", window, cx);
        assert_eq!(input.text(), "a👍b你");
        assert_eq!(input.marked_text_range(window, cx), None);
        input.replace_and_mark_text_in_range(None, "x", None, window, cx);
        input.unmark_text(window, cx);
        assert_eq!(input.marked_text_range(window, cx), None);
        input.replace_and_mark_text_in_range(Some(0..0), "", None, window, cx);
        assert_eq!(input.marked_text_range(window, cx), None, "composing nothing marks nothing");
    });
    cx.run_until_parked();
    // Where the system draws its window for composing, and which character a point is over.
    with(cx, &|input, window, cx| {
        let bounds = input.last_bounds.unwrap();
        let found = input.bounds_for_range(0..1, bounds, window, cx).unwrap();
        assert!(found.size.width > px(0.) && found.size.height > px(0.));
        let first = bounds.origin + point(px(1.), input.line_height / 2.);
        assert_eq!(input.character_index_for_point(first, window, cx), Some(0));
    });
    // A range from elsewhere that's stale or backwards still lands on characters.
    test.many.update(cx, |input, cx| {
        input.set_text("héllo", cx);
        input.replace_range(5..2, "X", cx);
        assert_eq!(input.text(), "hXo");
        input.replace_range(1..100, "!", cx);
        assert_eq!(input.text(), "h!");
        assert_eq!(input.cursor(), 2);
    });
}
