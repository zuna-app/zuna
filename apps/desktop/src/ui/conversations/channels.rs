//! The server's channels, under headings that fold away, with who's in each voice channel and
//! reordering them by dragging.

use super::*;

impl ConversationList {
    /// The server's channels, under headings that fold away, as in Discord (features/voice/ChannelList.tsx).
    pub(super) fn channel_rows(&self, server: &ServerState, query: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let is_admin = server.is_admin();
        let mut channels: Vec<ChannelView> = server.channels.clone();
        channels.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(dragged) = &self.drag_order {
            channels.sort_by_key(|channel| dragged.iter().position(|id| *id == channel.id).unwrap_or(usize::MAX));
        }
        if channels.is_empty() && !is_admin {
            return Vec::new();
        }
        let order: Vec<String> = channels.iter().map(|channel| channel.id.clone()).collect();
        let shown: Vec<ChannelView> = channels.into_iter().filter(|channel| query.is_empty() || channel.name.to_lowercase().contains(query)).collect();
        // A channel's own heading if it has one, or one for its type, in the order they come up.
        let mut sections: Vec<(String, String, Vec<ChannelView>)> = Vec::new();
        for channel in shown {
            let name = section_of(&channel);
            match sections.iter_mut().find(|(section, _, _)| *section == name) {
                Some((_, _, list)) => list.push(channel),
                None => sections.push((name, channel.kind.clone(), vec![channel])),
            }
        }
        let collapsed = self.state.read(cx).settings.collapsed_categories.clone();
        let mut container = div()
            .flex()
            .flex_col()
            .pt(px(2.))
            .pb(px(6.))
            .mb(px(4.))
            .border_b_1()
            .border_color(theme.line)
            // A dragged channel stays where it was dragged to, wherever it's let go of.
            .on_drop(cx.listener(|list, _: &ChannelDrag, _, cx| list.drop_channel(cx)))
            .on_mouse_up_out(
                gpui::MouseButton::Left,
                cx.listener(|list, _, _, cx| {
                    if list.dragging.is_some() {
                        list.drop_channel(cx);
                    }
                }),
            );
        for (name, kind, list) in sections {
            let folded = collapsed.contains(&name) && query.is_empty();
            let group = SharedString::from(format!("section-{name}"));
            let toggle_state = self.state.clone();
            let toggle_name = name.clone();
            let mut head = div()
                .group(group.clone())
                .flex()
                .items_center()
                .gap(px(2.))
                .pt(px(6.))
                .pr(px(8.))
                .pb(px(4.))
                .pl(px(6.))
                .min_h(px(24.))
                .child(
                    div()
                        .id(SharedString::from(format!("section-title-{name}")))
                        .group(SharedString::from(format!("section-title-{name}")))
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text3)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.text1))
                        .on_click(move |_, _, cx| {
                            let name = toggle_name.clone();
                            toggle_state.update(cx, |state, cx| {
                                state.update_settings(
                                    |settings| {
                                        if let Some(index) = settings.collapsed_categories.iter().position(|item| *item == name) {
                                            settings.collapsed_categories.remove(index);
                                        } else {
                                            settings.collapsed_categories.push(name);
                                        }
                                    },
                                    cx,
                                )
                            })
                        })
                        // `.channel-section-title svg`: turned back a quarter when folded, over 100 ms.
                        .child(crate::ui::motion::transition(icon("chevron-down", 12., theme.text3).group_hover(SharedString::from(format!("section-title-{name}")), move |style| style.text_color(theme.text1)), format!("section-chevron-{name}"), if folded { 1. } else { 0. }, 100, crate::ui::motion::ease_out(), |el, t| el.with_transformation(gpui::Transformation::rotate(gpui::radians(-t * std::f32::consts::FRAC_PI_2)))))
                        .child(div().min_w_0().one_line().child(name.to_uppercase())),
                );
            if is_admin {
                let (state, kind) = (self.state.clone(), kind.clone());
                head = head.child(
                    div().opacity(0.).group_hover(group.clone(), |style| style.opacity(1.)).child(
                        // `.channel-section-head .icon-btn`: 22 by 18, so the heading is no taller for it.
                        icon_button(SharedString::from(format!("new-in-{name}")), "plus", 14., true, false, cx)
                            .w(px(22.))
                            .h(px(18.))
                            .tip("New channel", Side::Bottom)
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: Some(kind.clone()) }), cx))),
                    ),
                );
            }
            let mut section = div().flex().flex_col().pt(px(10.)).child(head);
            // A folded heading keeps showing what someone's in, and what mentions them.
            let self_id = server.self_id().to_string();
            let visible: Vec<&ChannelView> = if folded {
                list.iter()
                    .filter(|channel| {
                        channel.conversation.as_ref().is_some_and(|c| c.unread_mentions > 0.) || server.voice.values().any(|member| member.channel_id == channel.id && member.user_id == self_id)
                    })
                    .collect()
            } else {
                list.iter().collect()
            };
            for channel in visible {
                section = section.child(self.channel_row(server, channel, is_admin && !folded && query.is_empty(), &order, cx));
            }
            container = container.child(section);
        }
        if server.channels.is_empty() && is_admin && query.is_empty() {
            let state = self.state.clone();
            container = container.child(
                div().px(px(14.)).pt(px(8.)).pb(px(10.)).child(
                    button("first-channel", ButtonKind::Default, ButtonSize::Small, false, cx)
                        .child(icon("plus", 14., theme.text1))
                        .child("New channel")
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: Some("text".into()) }), cx))),
                ),
            );
        }
        vec![container.into_any_element()]
    }

    pub(super) fn channel_row(&self, server: &ServerState, channel: &ChannelView, can_reorder: bool, order: &[String], cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let is_admin = server.is_admin();
        let active = server.active_key.as_deref() == Some(channel.key.as_str());
        let conversation = channel.conversation.as_ref();
        // A voice channel is somewhere to go, not something to read, so only a mention marks one.
        let unread = channel.kind == "text" && conversation.is_some_and(|c| c.unread > 0. && !c.muted);
        let mentions = conversation.map(|c| c.unread_mentions).unwrap_or(0.);
        let muted = conversation.is_some_and(|c| c.muted);
        let mut occupants: Vec<VoiceMember> = server.voice.values().filter(|member| member.channel_id == channel.id).cloned().collect();
        occupants.sort_by(|a, b| a.since.partial_cmp(&b.since).unwrap_or(std::cmp::Ordering::Equal));
        let full = channel.user_limit > 0. && occupants.len() as f64 >= channel.user_limit;
        let connected = crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == server.entry.id && channel_id == channel.id);
        let title = if !channel.name.is_empty() { channel.name.clone() } else if channel.unreadable { "Unreadable channel".into() } else { "Channel".into() };
        let group = SharedString::from(format!("channel-{}", channel.id));
        let (open_state, open_channel) = (self.state.clone(), channel.clone());
        let menu = self.channel_menu(server, channel);
        let mut row = div()
            .id(group.clone())
            .group(group.clone())
            .relative()
            .mx(px(8.))
            .mt(px(2.))
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .py(px(6.))
            .min_h(px(34.))
            .rounded(RADIUS_S)
            .text_size(px(16.))
            .line_height(px(20.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if active || unread { theme.text1 } else { theme.text3 })
            .when(active, |el| el.bg(theme.bg3))
            .when(!active && !channel.unreadable, |el| el.hover(move |style| style.bg(theme.hover).text_color(theme.text2)))
            .when(channel.unreadable, |el| el.opacity(0.5))
            .when(!channel.unreadable, |el| el.cursor_pointer())
            .when(!channel.topic.is_empty(), |el| el.tooltip(tooltip(channel.topic.clone())))
            .on_click(move |_, window, cx| {
                if !open_channel.unreadable {
                    crate::voice::open_channel(&open_state, &open_channel, window, cx);
                }
            })
            .on_mouse_down(gpui::MouseButton::Right, move |event, _, cx| {
                if !menu.is_empty() {
                    open_menu(event.position, menu.clone(), false, cx);
                }
            })
            .when(is_admin, |el| {
                let id = channel.id.clone();
                el.on_hover(cx.listener(move |list, hovered: &bool, _, cx| {
                    if *hovered {
                        list.hovered_channel = Some(id.clone());
                    } else if list.hovered_channel.as_ref() == Some(&id) {
                        list.hovered_channel = None;
                    }
                    cx.notify();
                }))
            })
            .when(unread, |el| el.child(div().absolute().left(px(-8.)).top(px(13.)).w(px(4.)).h(px(8.)).rounded_r(px(4.)).bg(theme.text1)))
            .child(icon(if channel.kind == "voice" { "volume-2" } else { "hash" }, 20., if connected { theme.green } else { theme.text3 }))
            .child(div().flex_1().min_w_0().one_line().when(unread, |el| el.font_weight(FontWeight::SEMIBOLD)).child(title.clone()))
            .when(muted, |el| el.child(icon("bell-off", 12., theme.text3)))
            .when(channel.kind == "voice" && channel.user_limit > 0., |el| {
                el.child(
                    div()
                        .flex_none()
                        .px(px(5.))
                        .py(px(1.))
                        .rounded(px(4.))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .bg(if full { theme.red_soft } else { theme.bg3 })
                        .text_color(if full { theme.red } else { theme.text3 })
                        .child(format!("{}/{}", occupants.len(), channel.user_limit as u32)),
                )
            })
            .when(is_admin && (active || self.hovered_channel.as_ref() == Some(&channel.id)), |el| {
                let (state, id) = (self.state.clone(), channel.id.clone());
                el.child(
                    div()
                        .id(SharedString::from(format!("edit-{}", channel.id)))
                        .group("channel-edit")
                        .flex_none()
                        .flex()
                        .tip("Edit channel", Side::Bottom)
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(id.clone()), category: None }), cx))
                        })
                        .child(icon("settings", 16., theme.text2).group_hover("channel-edit", move |style| style.text_color(theme.text1))),
                )
            })
            .when(mentions > 0., |el| {
                el.child(
                    div()
                        .flex_none()
                        .min_w(px(16.))
                        .h(px(16.))
                        .px(px(4.))
                        .rounded(px(8.))
                        .bg(theme.red)
                        .text_color(gpui::white())
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::BOLD)
                        .flex()
                        .justify_center()
                        .child(if mentions > 99. { "99+".to_string() } else { (mentions as u32).to_string() }),
                )
            });
        if can_reorder {
            row = row
                .on_drag(ChannelDrag { id: channel.id.clone(), name: title.clone(), section: section_of(channel) }, |drag, _, _, cx| cx.new(|_| drag.clone()))
                // Where the dragged channel will land, as the others make way for it.
                .when(self.dragging.as_deref() == Some(channel.id.as_str()), |el| el.bg(theme.hover_strong));
        }
        let mut block = div().flex().flex_col().child(row);
        if !occupants.is_empty() {
            let mut list = div().mt(px(2.)).mr(px(8.)).mb(px(4.)).ml(px(34.)).flex().flex_col().gap(px(1.));
            for member in occupants {
                list = list.child(self.voice_occupant(server, &member, cx));
            }
            block = block.child(list);
        }
        if !can_reorder {
            return block.into_any_element();
        }
        // Its place, which the pointer is checked against while a channel is dragged, and
        // which the row slides to as the others make way, as motion's `Reorder` moves them.
        let (target, section, order) = (channel.id.clone(), section_of(channel), order.to_vec());
        div()
            .on_drag_move(cx.listener(move |list, event: &gpui::DragMoveEvent<ChannelDrag>, _, cx| {
                let position = event.event.position;
                if event.bounds.contains(&position) {
                    let drag = event.drag(cx).clone();
                    list.drag_channel_over(&drag, &target, &section, &order, f32::from(position.y - event.bounds.center().y), cx);
                }
            }))
            .child(crate::ui::motion::sliding(format!("channel-{}", channel.id), scroll_handle("conv-list"), block))
            .into_any_element()
    }

    /// Moves the channel being dragged to where another is, once the pointer is past that
    /// one's middle the way it's going, so it doesn't flick back and forth over a taller one.
    /// Only within its own heading, as each heading's channels are a list of their own.
    pub(super) fn drag_channel_over(&mut self, drag: &ChannelDrag, target: &str, section: &str, order: &[String], past_middle: f32, cx: &mut Context<Self>) {
        if self.dragging.as_deref() != Some(drag.id.as_str()) {
            self.dragging = Some(drag.id.clone());
            cx.notify();
        }
        if drag.section != section || drag.id == target {
            return;
        }
        let mut next = self.drag_order.clone().unwrap_or_else(|| order.to_vec());
        let (Some(from), Some(to)) = (next.iter().position(|id| *id == drag.id), next.iter().position(|id| id == target)) else { return };
        if (from < to && past_middle < 0.) || (from > to && past_middle > 0.) {
            return;
        }
        let moved = next.remove(from);
        next.insert(to, moved);
        self.drag_order = Some(next);
        cx.notify();
    }

    /// Keeps the order a channel was dragged into once it's let go of, as the list shows it
    /// until the core has it.
    pub(super) fn drop_channel(&mut self, cx: &mut Context<Self>) {
        self.dragging = None;
        cx.notify();
        let Some(order) = self.drag_order.clone() else { return };
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let list = cx.entity().downgrade();
        self.state.update(cx, |state, cx| {
            state.call(Some(&server), "reorderChannels", vec![json!(order)], cx, move |state, result, cx| {
                if let Err(error) = result {
                    state.toast(error.message, ToastKind::Error, cx);
                }
                list.update(cx, |list, cx| {
                    list.drag_order = None;
                    cx.notify();
                })
                .ok();
            })
        });
    }

    /// Someone in a voice channel, under it, with a green ring while they speak.
    pub(super) fn voice_occupant(&self, server: &ServerState, member: &VoiceMember, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let user = server.users.get(&member.user_id);
        let name = user.map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        let speaking = crate::voice::is_speaking(&server.entry.id, member, cx);
        div()
            .flex()
            .items_center()
            .gap(px(7.))
            .px(px(6.))
            .py(px(2.))
            .min_h(px(26.))
            .rounded(RADIUS_S)
            .text_size(px(13.))
            .text_color(if speaking { theme.text1 } else { theme.text2 })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .rounded_full()
                    .when(speaking, |el| el.border_2().border_color(theme.green).m(px(-2.)))
                    .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 22., online: false, rounded: false, dot_border: theme.bg1 }, cx)),
            )
            .child(div().flex_1().min_w_0().one_line().child(name))
            .when(member.screen, |el| {
                el.child(div().flex_none().px(px(5.)).rounded(px(4.)).bg(theme.red).text_size(px(10.)).line_height(px(15.)).font_weight(FontWeight::BOLD).text_color(gpui::white()).child("Live"))
            })
            .when(member.camera, |el| el.child(icon("camera", 13., theme.text3)))
            .when(member.server_muted, |el| el.child(icon("mic-off", 13., theme.red)))
            .when(!member.server_muted && member.muted && !member.deafened, |el| el.child(icon("mic-off", 13., theme.text3)))
            .when(member.deafened, |el| el.child(icon("headphone-off", 13., theme.text3)))
            .into_any_element()
    }

    /// What a channel's row offers on a right click.
    pub(super) fn channel_menu(&self, server: &ServerState, channel: &ChannelView) -> Vec<MenuEntry> {
        let mut entries = Vec::new();
        if let Some(conversation) = &channel.conversation {
            let (state, key) = (self.state.clone(), channel.key.clone());
            if conversation.muted {
                entries.push(MenuEntry::new("Unmute", "volume-2", move |_, cx| state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx))));
            } else {
                entries.push(MenuEntry::submenu("Mute", "volume-x", mute_entries(key, state)));
            }
        }
        if server.is_admin() {
            let (state, id) = (self.state.clone(), channel.id.clone());
            entries.push(MenuEntry::new("Edit channel", "pencil", move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(id.clone()), category: None }), cx))));
            let (state, id, name) = (self.state.clone(), channel.id.clone(), channel.name.clone());
            entries.push(
                MenuEntry::new("Delete channel", "trash", move |window, cx| {
                    let answer = window.prompt(gpui::PromptLevel::Warning, &format!("Delete {name}?"), Some("Its messages go for everyone."), &["Delete", "Cancel"], cx);
                    let (state, id) = (state.clone(), id.clone());
                    cx.spawn(async move |cx| {
                        if answer.await == Ok(0) {
                            state.update(cx, |state, cx| state.act("deleteChannel", vec![json!(id)], cx));
                        }
                    })
                    .detach();
                })
                .danger(),
            );
        }
        entries
    }
}

/// The heading a channel goes under: its own if it has one, or one for its type.
pub(super) fn section_of(channel: &ChannelView) -> String {
    if !channel.category.is_empty() {
        channel.category.clone()
    } else if channel.kind == "voice" {
        "Voice channels".into()
    } else {
        "Text channels".into()
    }
}

/// A channel being dragged to another place in the list, and what follows the mouse.
#[derive(Clone)]
pub(super) struct ChannelDrag {
    id: String,
    name: String,
    section: String,
}

impl Render for ChannelDrag {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div().px(px(10.)).py(px(6.)).rounded(RADIUS_S).bg(theme.bg3).border_1().border_color(theme.line_strong).shadow(shadow_m()).text_size(px(14.)).text_color(theme.text1).child(self.name.clone())
    }
}
