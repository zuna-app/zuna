//! The notifications window: what draws its cards.

use super::*;

pub struct NotificationsView {
    center: Entity<NotificationCenter>,
}

impl NotificationsView {
    pub(super) fn new(center: Entity<NotificationCenter>, cx: &mut Context<Self>) -> Self {
        cx.observe(&center, |_, _, cx| cx.notify()).detach();
        NotificationsView { center }
    }

    pub(super) fn card(&self, card: &Card, opacity: f32, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let id = card.id;
        let payload = &card.payload;
        let center = self.center.clone();
        let photo: AnyElement = match &payload.picture {
            None => logo(62.).into_any_element(),
            Some(picture) => match &picture.image {
                Some(image) => cover(image.clone(), 1., 124, cx).size(px(62.)).rounded_full().into_any_element(),
                None => div()
                    .size(px(62.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme::css(avatar_color(&picture.seed)))
                    .text_color(theme::color(theme::white_a(0.92)))
                    .text_size(px(24.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(picture.initials.clone())
                    .into_any_element(),
            },
        };
        // Who said it, in a group, has its own color.
        let split = if payload.kind != "dm" { payload.body.find(": ").filter(|index| *index > 0) } else { None };
        let (author, body) = match split {
            Some(index) => (format!("{} ", &payload.body[..=index]), payload.body[index + 2..].to_string()),
            None => (String::new(), payload.body.clone()),
        };
        let group = SharedString::from(format!("card-{id}"));
        let replying = card.replying;
        let can_reply = payload.can_reply;
        let mut element = div()
            .id(("notification", id as usize))
            .group(group.clone())
            .relative()
            .w(px(CARD_WIDTH))
            .h(px(height))
            .flex_none()
            .opacity(opacity)
            .bg(theme.bg2)
            .border_1()
            .border_color(theme.bg5)
            .font_family(theme::FONT_UI)
            .text_size(px(13.))
            .line_height(px(18.))
            .text_color(theme.text1)
            .when(!replying, |el| el.cursor_pointer())
            .on_hover({
                let center = center.clone();
                move |hovered, _, cx| center.update(cx, |center, cx| center.set_hovered(*hovered, cx))
            })
            .on_mouse_down(MouseButton::Right, {
                let center = center.clone();
                move |_, _, cx| center.update(cx, |center, cx| center.dismiss(id, cx))
            })
            .on_click({
                let center = center.clone();
                move |_, _, cx| center.update(cx, |center, cx| center.open(id, cx))
            })
            .child(div().absolute().left(px(8.)).top(px(8.)).size(px(62.)).rounded_full().overflow_hidden().child(photo))
            .child(
                div()
                    .absolute()
                    .left(px(82.))
                    .top(px(6.))
                    .w(px(206.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .when(payload.kind == "group" && payload.picture.is_some(), |el| el.child(icon("users", 14., theme.text1)))
                    .child(div().min_w_0().one_line().child(payload.title.clone())),
            )
            .child(
                div()
                    .absolute()
                    .left(px(82.))
                    .top(px(29.))
                    .w(px(206.))
                    .max_h(px(36.))
                    .font_family(theme::FONT_UI)
                    .text_color(theme.text2)
                    // Two lines at most, the second ending in an ellipsis, as `-webkit-line-clamp`.
                    .child(clamped(format!("{author}{body}"), 2).colored(vec![(author.len(), theme.accent_text)])),
            )
            .child(
                div()
                    .id(("close", id as usize))
                    .absolute()
                    .top(px(1.))
                    .right_0()
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.text3)
                    .hover(move |style| style.text_color(theme.text1))
                    .on_click({
                        let center = center.clone();
                        move |_, _, cx| {
                            cx.stop_propagation();
                            center.update(cx, |center, cx| center.dismiss(id, cx))
                        }
                    })
                    .child(icon("x", 13., theme.text3)),
            );
        if can_reply && !replying {
            // Fades in over the end of the text while the mouse is on the card.
            element = element.child(
                div()
                    .absolute()
                    .top(px(24.))
                    .right_0()
                    .h(px(54.))
                    .pl(px(32.))
                    .pr(px(8.))
                    .pb(px(8.))
                    .flex()
                    .items_end()
                    .opacity(0.)
                    .group_hover(group, |style| style.opacity(1.))
                    .child(
                        div()
                            .id(("reply", id as usize))
                            .h(px(30.))
                            .px(px(14.))
                            .flex()
                            .items_center()
                            .rounded(crate::theme::RADIUS_S)
                            .bg(theme.bg2)
                            .text_color(theme.accent_text)
                            .font_weight(FontWeight::SEMIBOLD)
                            .hover(move |style| style.bg(theme.hover_strong))
                            .on_click({
                                let center = center.clone();
                                move |_, window, cx| {
                                    cx.stop_propagation();
                                    if let Some(input) = center.update(cx, |center, cx| center.start_reply(id, cx)) {
                                        input.focus_handle(cx).focus(window, cx);
                                    }
                                }
                            })
                            .child("REPLY"),
                    ),
            );
        }
        if let (true, Some(input)) = (replying, card.reply.clone()) {
            element = element.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(78.))
                    .flex()
                    .items_end()
                    .cursor_text()
                    .child(div().flex_1().min_w_0().min_h(px(36.)).max_h(px(72.)).pl(px(8.)).pr(px(8.)).pt(px(8.)).pb(px(6.)).child(input))
                    .child(
                        div()
                            .id(("send", id as usize))
                            .size(px(36.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click({
                                let center = center.clone();
                                move |_, _, cx| {
                                    cx.stop_propagation();
                                    center.update(cx, |center, cx| center.send_reply(id, cx))
                                }
                            })
                            .child(icon("send-horizontal", 18., theme.accent_text)),
                    ),
            );
        }
        element.into_any_element()
    }
}

impl Render for NotificationsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let center = self.center.read(cx);
        let hide_all = center.hide_all.as_ref().map(|hide_all| center.opacity(&hide_all.fade));
        let cards: Vec<(u64, f32, f32)> = center.shown.iter().map(|card| (card.id, center.opacity(&card.fade), NotificationCenter::card_height(card, cx))).collect();
        let mut column = div().size_full().flex().flex_col().justify_end().items_start().gap(px(GAP)).pb(px(GAP));
        if let Some(opacity) = hide_all {
            let center = self.center.clone();
            column = column.child(
                div()
                    .id("hide-all")
                    .w(px(CARD_WIDTH))
                    .h(px(HIDE_ALL_HEIGHT))
                    .flex_none()
                    .opacity(opacity)
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme.bg3)
                    .border_1()
                    .border_color(theme.bg5)
                    .font_family(theme::FONT_UI)
                    .text_size(px(13.))
                    .text_color(theme.accent_text)
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.bg4))
                    .on_click(move |_, _, cx| center.update(cx, |center, cx| center.hide_everything(cx)))
                    .child("Hide all"),
            );
        }
        let shown: Vec<(u64, f32, f32)> = cards;
        for (id, opacity, height) in shown {
            let card = {
                let center = self.center.read(cx);
                center.shown.iter().find(|card| card.id == id).map(|card| Card {
                    id: card.id,
                    payload: card.payload.clone(),
                    started: card.started,
                    waiting_for_input: card.waiting_for_input,
                    hide_at: card.hide_at,
                    fade: card.fade,
                    gone: card.gone,
                    replying: card.replying,
                    reply: card.reply.clone(),
                })
            };
            if let Some(card) = card {
                column = column.child(self.card(&card, opacity, height, cx));
            }
        }
        column
    }
}
