//! A message's text: its runs, links and mentions, code blocks, emotes alone or in a line, and
//! the time and ticks at its end.

use super::*;

pub(super) fn meta_element(message: &MessageView, own: bool, is_deleted: bool, read_up_to: f64, color: Hsla, overlay: bool, theme: &Theme, window: &mut Window) -> gpui::Div {
    let color = if overlay { gpui::white() } else { color };
    let mut meta = div().flex().flex_none().items_center().gap(px(3.)).h(px(16.)).text_size(px(11.5)).line_height(px(16.)).text_color(color).whitespace_nowrap();
    if overlay {
        meta = meta.px(px(6.)).h(px(18.)).rounded(px(9.)).bg(theme::color(theme::black_a(0.55)));
    }
    if message.time_differs == Some(true) {
        meta = meta.child(icon("shield-alert", 11., color));
    }
    if message.expires_at.is_some() {
        meta = meta.child(icon("timer", 10., color));
    }
    if message.pinned_at.is_some() {
        meta = meta.child(icon("pin", 10., color).with_transformation(gpui::Transformation::rotate(gpui::radians(35f32.to_radians()))));
    }
    if message.edited_at.is_some() && !is_deleted {
        meta = meta.child("edited");
    }
    meta = meta.child(format_time(message.created_at));
    if own && !is_deleted {
        let ticks = |read: bool| {
            gpui::svg()
                .path(if read { "icons/ticks-read.svg" } else { "icons/ticks-sent.svg" })
                .w(px(18.))
                .h(px(10.))
                .text_color(if read { theme.accent_text } else { color })
        };
        // Ticks pop in when they first show, as `.msg.is-fresh .msg-tick`, under one id while the
        // message sends and once it's sent, so a quick send's tick is simply there all along. Shown
        // only after the clock, they're new to GPUI, and pop in then.
        let popping = |ticks: gpui::Svg| ticks.enter(SharedString::from(format!("tick-sent-{}", message.id)), Enter::Pop, 120).into_any_element();
        let tick: AnyElement = match message.status.as_str() {
            // Shown as sent at once, as nearly every message is a moment later. Its time is this
            // device's own until the server takes it, so this is how long it's been sending.
            "sending" if read_up_to >= 0. && crate::format::now_ms() - message.created_at < SLOW_SEND_MS => {
                // Drawn again to show the clock if it's still sending by then.
                window.request_animation_frame();
                popping(ticks(false))
            }
            // `.msg-tick.is-sending`: once it's been sending for as long as the bubble takes to dim.
            "sending" => icon("clock", 11., color).enter(SharedString::from(format!("tick-sending-{}", message.id)), Enter::Fade, 120).into_any_element(),
            "failed" => icon("circle-alert", 12., theme.danger_text).into_any_element(),
            _ => match message.seq {
                Some(seq) if read_up_to >= 0. => {
                    let read = read_up_to >= seq;
                    // A just-sent message's ticks, or one sent from another device.
                    if crate::format::now_ms() - message.created_at < 1500. {
                        popping(ticks(read))
                    } else {
                        ticks(read).into_any_element()
                    }
                }
                _ => div().into_any_element(),
            },
        };
        meta = meta.child(div().flex_none().w(px(18.)).h(px(14.)).ml(px(3.)).mr(px(-3.)).mb(px(2.)).flex().items_center().justify_center().child(tick));
    }
    meta
}

/// How much room the time takes at the end of the last line, as spaces of the message's own font:
/// as wide as `meta_element` draws it, 12 px from the text as `.msg-meta`'s margin, less the 2 px
/// it reaches into the bubble's padding.
pub(super) fn meta_padding(message: &MessageView, own: bool, theme: &Theme, window: &mut Window) -> String {
    let small = TextRun { len: 0, font: gpui::font(FONT_UI), color: gpui::black(), background_color: None, underline: None, strikethrough: None };
    let mut label = format_time(message.created_at);
    if message.edited_at.is_some() {
        label = format!("edited {label}");
    }
    let measure = |text: &str, size: Pixels, window: &mut Window| -> f32 {
        let run = TextRun { len: text.len(), ..small.clone() };
        f32::from(window.text_system().shape_line(SharedString::from(text.to_string()), size, &[run], None).width)
    };
    let mut width = measure(&label, px(11.5), window) + 10.;
    if own {
        width += 21.;
    }
    if message.time_differs == Some(true) {
        width += 14.;
    }
    if message.pinned_at.is_some() {
        width += 13.;
    }
    if message.expires_at.is_some() {
        width += 13.;
    }
    let space = measure("\u{a0}\u{a0}\u{a0}\u{a0}", theme.message_size, window) / 4.;
    let count = (width / space.max(1.)).round() as usize;
    "\u{a0}".repeat(count)
}

pub(super) fn runs_for(rich: &Rich, own: bool, revealed: bool, theme: &Theme, base: Hsla) -> Vec<TextRun> {
    let mut runs = Vec::new();
    let mut position = 0;
    let plain_font = gpui::font(FONT_UI);
    for (range, style) in &rich.spans {
        if range.start > position {
            runs.push(TextRun { len: range.start - position, font: plain_font.clone(), color: base, background_color: None, underline: None, strikethrough: None });
        }
        let mut font = if style.code { gpui::font(FONT_MONO) } else { plain_font.clone() };
        if style.bold {
            font.weight = FontWeight::BOLD;
        }
        if style.mention.is_some() {
            font.weight = FontWeight::MEDIUM;
        }
        if style.italic {
            font.style = FontStyle::Italic;
        }
        let mut color = base;
        let mut background = None;
        let mut underline = None;
        if style.code {
            background = Some(theme::color(theme::white_a(0.09)));
        }
        if let Some((_, is_self)) = &style.mention {
            background = Some(theme::color(theme::white_a(if *is_self { 0.18 } else { 0.09 })));
        }
        if style.link.is_some() {
            if own {
                color = theme.bubble_own_text;
                underline = Some(UnderlineStyle { color: Some(color), thickness: px(1.), wavy: false });
            } else {
                color = theme.link;
            }
        }
        if style.emote.is_some() {
            color = theme.text2;
        }
        if style.spoiler && !revealed {
            color = gpui::transparent_black();
            background = Some(theme.bg5);
        }
        runs.push(TextRun {
            len: range.end - range.start,
            font,
            color,
            background_color: background,
            underline,
            strikethrough: style.strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(color) }),
        });
        position = range.end;
    }
    if position < rich.text.len() {
        runs.push(TextRun { len: rich.text.len() - position, font: plain_font, color: base, background_color: None, underline: None, strikethrough: None });
    }
    runs
}

/// A block with emotes in it, as words and pictures that wrap together: 26 px emotes
/// on the line, as `.emote-inline` draws them, and a gap for the time at the end.
#[allow(clippy::too_many_arguments)]
pub(super) fn flow_text(
    message: &MessageView,
    index: usize,
    rich: &Rich,
    own: bool,
    revealed: bool,
    trailing: bool,
    color: gpui::Hsla,
    context: &ChatContext,
    theme: &Theme,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut row = div().flex().flex_wrap().items_end();
    let mut piece = 0;
    for (range, style) in &rich.spans {
        let text = &rich.text[range.clone()];
        if let Some((name, emote)) = &style.emote {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            let image = context.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            let zero_width = emote.zero_width == Some(true);
            let width = emote_width(context, &emote.id, 26., 110.);
            let picture = match image {
                Some(image) => with_emote_card(
                    img(image)
                        .h(px(26.))
                        .when_some(width, |el, width| el.w(px(width)))
                        .max_w(px(110.))
                        .object_fit(gpui::ObjectFit::Contain)
                        // An id keeps an animated emote's place between frames.
                        .id(SharedString::from(format!("emote-{}-{}-{}", message.id, index, range.start))),
                    SharedString::from(format!("emote-card-{}-{}-{}", message.id, index, range.start)),
                    name,
                    emote,
                    None,
                    context,
                    cx,
                )
                .mx(px(1.))
                .my(px(-3.))
                .when(zero_width, |el| el.ml(px(-28.)))
                .into_any_element(),
                None => emote_placeholder(context, &url, name, width, 26., cx).mx(px(1.)).my(px(-3.)).when(zero_width, |el| el.ml(px(-28.))).into_any_element(),
            };
            // Selected whole, and copied as its name.
            row = row.child(selection::selectable(&message.id, index * 10_000 + piece, index, name.clone(), None, picture));
            piece += 1;
            continue;
        }
        // Words with their spaces, so lines break between them.
        let mut start = 0;
        let mut words = Vec::new();
        for (offset, ch) in text.char_indices() {
            if ch.is_whitespace() {
                let end = offset + ch.len_utf8();
                words.push(&text[start..end]);
                start = end;
            }
        }
        if start < text.len() {
            words.push(&text[start..]);
        }
        for word in words {
            let mut single = Rich { text: word.to_string(), spans: vec![(0..word.len(), style.clone())] };
            single.spans.retain(|(range, _)| !range.is_empty());
            let runs = runs_for(&single, own, revealed, theme, color);
            let len = single.text.len();
            row = row.child(interactive_text(&message.id, index * 10_000 + piece, index, single, runs, len, context));
            piece += 1;
        }
    }
    if trailing {
        // Room for the time, which wraps to a line of its own when the last one is full.
        let padding = meta_padding(message, own, theme, window);
        let run = TextRun { len: padding.len(), font: gpui::font(FONT_UI), color: gpui::transparent_black(), background_color: None, underline: None, strikethrough: None };
        row = row.child(StyledText::new(SharedString::from(padding)).with_runs(vec![run]));
    }
    row.into_any_element()
}

/// How many messages' parsed text a chat keeps, all let go together once there are more.
pub(super) const PARSED_KEPT: usize = 5000;

/// What a message's parsed text depends on: its text, its emotes and who can be mentioned.
pub(super) fn parse_key(message: &MessageView, mentionable_print: u64) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    message.text.hash(&mut hasher);
    let mut emotes: Vec<(&String, &String)> = message.emotes.iter().map(|(name, emote)| (name, &emote.id)).collect();
    emotes.sort();
    emotes.hash(&mut hasher);
    mentionable_print.hash(&mut hasher);
    hasher.finish()
}

/// Who can be mentioned, reduced to a number that doesn't depend on the map's order.
pub(in crate::ui) fn mentionable_print(mentionable: &HashMap<String, String>) -> u64 {
    use std::hash::{Hash, Hasher};
    mentionable
        .iter()
        .map(|pair| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            pair.hash(&mut hasher);
            hasher.finish()
        })
        .fold(mentionable.len() as u64, |print, one| print ^ one.rotate_left(1).wrapping_add(one))
}

pub(in crate::ui) fn text_body(message: &MessageView, own: bool, meta_in_text: bool, context: &ChatContext, theme: &Theme, window: &mut Window, cx: &mut App) -> AnyElement {
    let key = parse_key(message, context.mentionable_print);
    let cached = context.parsed.borrow().get(&message.id).filter(|(parsed_from, _)| *parsed_from == key).map(|(_, blocks)| blocks.clone());
    let blocks = cached.unwrap_or_else(|| {
        let markup_context = markup::Context { emotes: &message.emotes, mentionable: &context.mentionable, self_id: &context.self_id };
        let blocks = Rc::new(markup::parse(&message.text, &markup_context));
        let mut parsed = context.parsed.borrow_mut();
        if parsed.len() > PARSED_KEPT {
            parsed.clear();
        }
        parsed.insert(message.id.clone(), (key, blocks.clone()));
        blocks
    });
    let base = if own { theme.bubble_own_text } else { theme.text1 };
    let revealed = context.revealed.borrow().contains(&message.id);
    let last_text = blocks.iter().rposition(|block| matches!(block, Block::Text(_)));
    let ends_in_text = matches!(blocks.last(), Some(Block::Text(_)));
    let mut column = div().flex().flex_col().gap(px(3.));
    for (index, block) in blocks.iter().enumerate() {
        match block {
            Block::Text(rich) | Block::Quote(rich) => {
                let quote = matches!(block, Block::Quote(_));
                let mut rich = rich.clone();
                let color = if quote { if own { theme.bubble_own_faint } else { theme.text2 } } else { base };
                if rich.has_emotes() {
                    // Pictures can't sit inside GPUI's text, so the block flows as words and emotes.
                    let trailing = meta_in_text && Some(index) == last_text && ends_in_text;
                    let element = flow_text(message, index, &rich, own, revealed, trailing, color, context, theme, window, cx);
                    column = column.child(if quote {
                        div().pl(px(9.)).my(px(2.)).border_l_2().border_color(if own { theme.bubble_own_faint } else { theme.text3 }).child(element).into_any_element()
                    } else {
                        element
                    });
                    continue;
                }
                // What can be selected: the text, not the room left for the time.
                let len = rich.text.len();
                if meta_in_text && Some(index) == last_text && ends_in_text {
                    let padding = meta_padding(message, own, theme, window);
                    let start = rich.text.len();
                    rich.text.push_str(&padding);
                    rich.spans.push((start..rich.text.len(), markup::SpanStyle::default()));
                }
                let mut runs = runs_for(&rich, own, revealed, theme, color);
                if meta_in_text && Some(index) == last_text && ends_in_text {
                    if let Some(last) = runs.last_mut() {
                        last.color = gpui::transparent_black();
                        last.background_color = None;
                    }
                }
                let element = interactive_text(&message.id, index * 10_000, index, rich, runs, len, context);
                column = column.child(if quote {
                    div().pl(px(9.)).my(px(2.)).border_l_2().border_color(if own { theme.bubble_own_faint } else { theme.text3 }).child(element).into_any_element()
                } else {
                    element
                });
            }
            Block::Code { text, language } => {
                column = column.child(code_block(text, language.as_deref(), &message.id, index, theme));
            }
        }
    }
    if meta_in_text && !ends_in_text {
        column = column.child(div().h(px(16.)));
    }
    column.into_any_element()
}

/// A run of a message's text, which can be selected: `order` places it among the message's
/// pieces, in its `block`, and the first `len` bytes of it are the message's own.
#[allow(clippy::too_many_arguments)]
pub(super) fn interactive_text(message_id: &str, order: usize, block: usize, rich: Rich, runs: Vec<TextRun>, len: usize, context: &ChatContext) -> AnyElement {
    let targets: Vec<(std::ops::Range<usize>, Target)> = rich
        .spans
        .iter()
        .filter_map(|(range, style)| {
            if let Some(link) = &style.link {
                Some((range.clone(), Target::Link(link.clone())))
            } else if let Some((user, _)) = &style.mention {
                Some((range.clone(), Target::User(user.clone())))
            } else if style.spoiler {
                Some((range.clone(), Target::Spoiler))
            } else {
                None
            }
        })
        .collect();
    let styled = StyledText::new(SharedString::from(rich.text.clone())).with_runs(runs);
    let layout = styled.layout().clone();
    let text = SharedString::from(rich.text[..len].to_string());
    if targets.is_empty() {
        return div().whitespace_normal().child(selection::selectable(message_id, order, block, text, Some(layout), styled)).into_any_element();
    }
    let ranges: Vec<_> = targets.iter().map(|(range, _)| range.clone()).collect();
    let state = context.state.clone();
    let revealed = context.revealed.clone();
    let id = message_id.to_string();
    let interactive = InteractiveText::new(SharedString::from(format!("text-{message_id}-{order}")), styled)
        .on_click(ranges, move |clicked, _window, cx| match &targets[clicked].1 {
            Target::Link(url) => cx.open_url(url),
            Target::User(user) => state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user.clone() }), cx)),
            Target::Spoiler => {
                revealed.borrow_mut().insert(id.clone());
                state.update(cx, |_, cx| cx.notify());
            }
        });
    selection::selectable(message_id, order, block, text, Some(layout), interactive).into_any_element()
}

pub(super) enum Target {
    Link(String),
    User(String),
    Spoiler,
}

pub(super) fn code_block(text: &str, language: Option<&str>, message_id: &str, index: usize, theme: &Theme) -> AnyElement {
    let copy_text = text.to_string();
    div()
        .mt(px(4.))
        .mb(px(2.))
        .rounded(RADIUS_M)
        .overflow_hidden()
        .bg(theme.bg0)
        .border_1()
        .border_color(theme.line)
        .min_w(px(300.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .pl(px(10.))
                .pr(px(5.))
                .py(px(3.))
                .text_size(px(11.5))
                .line_height(px(16.))
                .text_color(theme.text3)
                .border_b_1()
                .border_color(theme.line)
                .child(language.unwrap_or("code").to_string())
                .child(
                    div()
                        .id(SharedString::from(format!("copy-{message_id}-{index}")))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong).text_color(theme.text1))
                        .on_click(move |_, _, cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_text.clone())))
                        .child(icon("copy", 12., theme.text3))
                        .child("Copy"),
                ),
        )
        .child(
            div()
                .id(SharedString::from(format!("code-{message_id}-{index}")))
                .overflow_x_scroll()
                .px(px(11.))
                .py(px(8.))
                .font_family(FONT_MONO)
                .text_size(px(12.5))
                .line_height(relative(1.5))
                .text_color(theme::color(theme::hex(0xe6edf3)))
                .whitespace_nowrap()
                .child({
                    let styled = StyledText::new(SharedString::from(text.to_string()));
                    let layout = styled.layout().clone();
                    selection::selectable(message_id, index * 10_000, index, text.to_string(), Some(layout), styled)
                }),
        )
        .into_any_element()
}

pub(in crate::ui) fn jumbo_body(message: &MessageView, context: &ChatContext, cx: &mut App) -> AnyElement {
    let mut row = div().flex().flex_wrap().items_end().gap(px(2.));
    for (position, word) in message.text.split_whitespace().enumerate() {
        if let Some(emote) = message.emotes.get(word) {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            let image = context.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            let width = emote_width(context, &emote.id, 48., 150.);
            row = row.child(match image {
                Some(image) => {
                    let picture = img(image).h(px(48.)).when_some(width, |el, width| el.w(px(width))).max_w(px(150.)).object_fit(gpui::ObjectFit::Contain).id(SharedString::from(format!("jumbo-{}-{position}", message.id)));
                    with_emote_card(picture, SharedString::from(format!("jumbo-card-{}-{position}", message.id)), word, emote, None, context, cx).into_any_element()
                }
                None => emote_placeholder(context, &url, word, width, 48., cx).into_any_element(),
            });
        } else {
            row = row.child(div().text_size(px(34.)).line_height(relative(1.15)).child(word.to_string()));
        }
    }
    row.into_any_element()
}

/// An emote with its card, as `Emote` in `components/Emote.tsx`: after 120 ms under the
/// pointer, its picture larger, its name, who made it, and a note, such as who reacted with it.
pub(in crate::ui) fn with_emote_card(picture: impl IntoElement, id: impl Into<ElementId>, name: &str, emote: &EmoteRef, note: Option<String>, context: &ChatContext, cx: &App) -> Stateful<Div> {
    // Recorded in the message, or known from the server's set.
    let owner = emote.owner.clone().filter(|owner| !owner.is_empty()).or_else(|| {
        let server = context.state.read(cx).servers.get(&context.server_id)?;
        server.emotes.emotes.iter().find(|item| item.id == emote.id).map(|item| item.owner.clone()).filter(|owner| !owner.is_empty())
    });
    let bounds = Rc::new(std::cell::Cell::new(None));
    let seen = bounds.clone();
    let state = context.state.clone();
    let address = format!("{}/api/emotes/{}", context.server_url, emote.id);
    let name = SharedString::from(name.to_string());
    div()
        .id(id)
        .relative()
        .child(picture)
        .child(gpui::canvas(move |area, _, _| seen.set(Some(area)), |_, _, _, _| {}).absolute().inset_0())
        .tooltip_show_delay(std::time::Duration::from_millis(120))
        .tooltip(move |window, cx| {
            let card = EmoteCard {
                state: state.clone(),
                address: address.clone(),
                name: name.clone(),
                owner: owner.clone().map(SharedString::from),
                note: note.clone().map(SharedString::from),
                target: bounds.get(),
                from: window.mouse_position(),
            };
            let state = state.clone();
            cx.new(|cx| {
                // The larger picture, once it's fetched.
                cx.observe(&state, |_, _, cx| cx.notify()).detach();
                card
            })
            .into()
        })
}

/// `.emote-card`, above the emote, or below it where there's no room, kept inside the window.
pub(super) struct EmoteCard {
    state: Entity<AppState>,
    address: String,
    name: SharedString,
    owner: Option<SharedString>,
    note: Option<SharedString>,
    target: Option<gpui::Bounds<Pixels>>,
    /// GPUI lays a tooltip out from the pointer, as it was when it was built.
    from: gpui::Point<Pixels>,
}

impl Render for EmoteCard {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(target) = self.target else { return div() };
        // Gone once the pointer leaves the emote, as GPUI judges by its bounds even under an overlay.
        if !target.contains(&window.mouse_position()) {
            return div();
        }
        let (large, small) = (format!("{}/3x.webp", self.address), format!("{}/2x.webp", self.address));
        let image = self.state.update(cx, |state, cx| state.remote_picture(&large, cx).or_else(|| state.remote_picture(&small, cx)));
        let measure = |text: &str, size: f32, weight: FontWeight, window: &mut Window| {
            let run = TextRun { len: text.len(), font: gpui::Font { weight, ..gpui::font(FONT_UI) }, color: theme.text1, background_color: None, underline: None, strikethrough: None };
            f32::from(window.text_system().shape_line(SharedString::from(text.to_string()), px(size), &[run], None).width)
        };
        let owner = self.owner.as_ref().map(|owner| format!("by {owner}"));
        let mut text_width = measure(&self.name, 14., FontWeight::SEMIBOLD, window);
        let mut text_height: f32 = 19.;
        if let Some(owner) = &owner {
            text_width = text_width.max(measure(owner, 12.5, FontWeight::NORMAL, window));
            text_height += 17.;
        }
        if let Some(note) = &self.note {
            text_width = text_width.max(measure(note, 11., FontWeight::NORMAL, window));
            text_height += 17.;
        }
        // Its padding, picture, gap and border around the text, from 170 to 300 px wide.
        let width = px((text_width + 10. + 56. + 12. + 14. + 2.).clamp(170., 300.));
        let height = px(text_height.max(56.) + 22.);
        let viewport = window.viewport_size();
        let left = (target.center().x - width / 2.).min(viewport.width - width - px(8.)).max(px(8.));
        let above = target.top() - height - px(8.);
        let top = if above >= px(8.) { above } else { target.bottom() + px(8.) };
        let card = div()
            .w(width)
            .flex()
            .items_center()
            .gap(px(12.))
            .pl(px(10.))
            .pr(px(14.))
            .py(px(10.))
            .bg(theme.bg3)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(theme::RADIUS_L)
            .shadow(shadow_m())
            .font_family(FONT_UI)
            .child(match image {
                Some(image) => img(image).id("emote-card-picture").size(px(56.)).flex_none().object_fit(gpui::ObjectFit::Contain).into_any_element(),
                None => div().size(px(56.)).flex_none().into_any_element(),
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().text_size(px(14.)).line_height(px(19.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(self.name.clone()))
                    .when_some(owner, |el, owner| el.child(div().text_size(px(12.5)).line_height(px(17.)).text_color(theme.text2).child(owner)))
                    .when_some(self.note.clone(), |el, note| el.child(div().mt(px(2.)).text_size(px(11.)).line_height(px(15.)).text_color(theme.text3).child(note))),
            );
        // Nothing of its own size, so GPUI never moves it, and the card placed from the pointer.
        let origin = self.from + gpui::point(px(1.), px(1.));
        div()
            .size_0()
            .child(card.absolute().left(left - origin.x).top(top - origin.y).enter("emote-card-in", Enter::Fade, 80))
            // Drawn again as the pointer moves, so it's gone as soon as it leaves.
            .child(gpui::canvas(|_, _, _| {}, |_, _, window, _| window.on_mouse_event(|_: &gpui::MouseMoveEvent, _, window, _| window.refresh())))
    }
}
