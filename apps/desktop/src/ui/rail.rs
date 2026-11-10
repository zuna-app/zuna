//! The title bar, and the rail of servers down the window's left side.

use super::*;

impl Root {
    pub(super) fn title_bar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let status = self.state.read(cx).active().and_then(|server| connection_status(server, &theme));
        let control = |id: &'static str, icon_name: &'static str, area: WindowControlArea, close: bool| {
            let button = div()
                .id(id)
                .flex()
                .items_center()
                .justify_center()
                .w(px(46.))
                .h_full()
                .window_control_area(area)
                .text_color(theme.text2)
                .hover(move |style| {
                    if close { style.bg(theme::color(theme::hex(0xc42b1c))).text_color(gpui::white()) } else { style.bg(theme::color(theme::white_a(0.09))) }
                })
                .child(gpui::svg().path(format!("icons/{icon_name}.svg")).size(px(10.)).text_color(theme.text2));
            // Wayland leaves the buttons to the app.
            #[cfg(target_os = "linux")]
            let button = crate::platform::title_button(button, area);
            button
        };
        let drag = div()
            .id("titlebar-drag")
            .flex()
            .flex_1()
            .h_full()
            .items_center()
            .gap(px(8.))
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text2)
                    .child(logo(14.))
                    .child("Zuna"),
            )
            .children(status);
        // Wayland and macOS leave dragging to the app.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let drag = crate::platform::title_drag(drag);
        // macOS draws its own three buttons over the title bar's left end, and none in full screen.
        #[cfg(target_os = "macos")]
        let inset = if window.is_fullscreen() { 12. } else { crate::platform::TRAFFIC_LIGHTS_WIDTH };
        #[cfg(not(target_os = "macos"))]
        let inset = 12.;
        // An update that's downloaded and checked: pressing it installs it and starts the app
        // again, as in Telegram. Only where the app updates itself is there ever one.
        let update = crate::platform::updates::current().ready.map(|update| {
            div()
                .id("update-button")
                .flex()
                .flex_none()
                .items_center()
                .h(px(22.))
                .px(px(11.))
                .mr(px(4.))
                .rounded_full()
                .bg(theme.accent)
                .text_color(theme.on_accent)
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|style| style.opacity(0.88))
                .tip(format!("Update to {} and restart", update.label()), Side::Bottom)
                .on_click(|_, _, cx| install_update(cx))
                .child("Update")
        });
        // Covers the root, whose focus tracking would otherwise take each press here and leave
        // Windows nothing to drag, minimize, maximize or close with.
        div()
            .id("titlebar")
            .occlude()
            .flex()
            .flex_none()
            .items_center()
            .h(TITLEBAR_HEIGHT)
            .pl(px(inset))
            .gap(px(8.))
            .bg(theme.bg0)
            .border_b_1()
            .border_color(theme.line)
            .text_size(px(12.))
            .text_color(theme.text3)
            .child(drag)
            .children(update)
            .when(cfg!(not(target_os = "macos")), |el| {
                el.child(
                    div()
                        .flex()
                        .h_full()
                        .child(control("win-min", "win-minimize", WindowControlArea::Min, false))
                        .child(control("win-max", if window.is_maximized() { "win-restore" } else { "win-maximize" }, WindowControlArea::Max, false))
                        .child(control("win-close", "win-close", WindowControlArea::Close, true)),
                )
            })
    }

    pub(super) fn rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let state_entity = self.state.clone();
        let state = self.state.read(cx);
        let active_id = state.active_server.clone();
        // Only what the rail shows: this draws every frame, and a whole server is its people,
        // chats, channels and emotes.
        let servers: Vec<RailItem> = state
            .order
            .iter()
            .filter_map(|id| state.servers.get(id))
            .map(|server| RailItem { id: server.entry.id.clone(), name: server.entry.name.clone(), url: server.entry.url.clone(), has_icon: server.entry.has_icon, unread: server.unread(), has_new: server.has_new() })
            .collect();
        let me = state.active().and_then(|server| server.me.as_ref().and_then(|me| server.users.get(&me.user_id)).cloned());
        let mut list = div().flex().flex_col().items_center().gap(px(8.)).w_full();
        for server in servers {
            let id = server.id.clone();
            let active = active_id.as_deref() == Some(id.as_str());
            let unread = server.unread;
            let has_new = server.has_new;
            let icon_image = if server.has_icon {
                let url = format!("{}/api/icon", server.url);
                self.state.update(cx, |state, cx| state.remote_picture(&url, cx))
            } else {
                None
            };
            let group = gpui::SharedString::from(format!("rail-{id}"));
            let hovered = self.rail_hovered.as_deref() == Some(id.as_str());
            let pill_height = if active { 28. } else if hovered { 18. } else if has_new { 8. } else { 0. };
            let hover_id = id.clone();
            let select_state = state_entity.clone();
            let select_id = id.clone();
            list = list.child(
                div()
                    .id(gpui::ElementId::Name(format!("rail-item-{id}").into()))
                    .group(group.clone())
                    .relative()
                    .w_full()
                    .flex()
                    .justify_center()
                    .on_hover(cx.listener(move |root, over: &bool, _, cx| {
                        if *over {
                            root.rail_hovered = Some(hover_id.clone());
                        } else if root.rail_hovered.as_ref() == Some(&hover_id) {
                            root.rail_hovered = None;
                        }
                        cx.notify();
                    }))
                    // `.rail-pill`: its height moves over 120 ms.
                    .child(motion::transition(
                        div().absolute().left_0().w(px(3.)).rounded_r(px(3.)).bg(theme.text1),
                        format!("rail-pill-{id}"),
                        pill_height,
                        120,
                        motion::ease_out(),
                        |el, height| el.top(px(21. - height / 2.)).h(px(height)),
                    ))
                    .child(
                        div()
                            .id(gpui::ElementId::Name(format!("rail-button-{id}").into()))
                            .rounded(RADIUS_L)
                            .cursor_pointer()
                            .tip(server.name.clone(), Side::Right)
                            .on_click(move |_, _, cx| select_state.update(cx, |state, cx| state.select_server(&select_id, cx)))
                            .child(avatar(
                                AvatarProps {
                                    name: server.name.clone(),
                                    seed: server.url.clone(),
                                    image: icon_image,
                                    size: 42.,
                                    online: false,
                                    rounded: true,
                                    dot_border: theme.bg0,
                                },
                                cx,
                            ))
                            // Inactive, it's at 72% until the pointer is on it, over 100 ms.
                            .map(|button| motion::transition(button, format!("rail-button-{id}"), if active || hovered { 1. } else { 0.72 }, 100, motion::ease(), |el, opacity| el.opacity(opacity))),
                    )
                    .when(!active && unread > 0, |el| {
                        el.child(
                            div()
                                .absolute()
                                .right(px(8.))
                                .bottom(px(-3.))
                                .min_w(px(16.))
                                .h(px(16.))
                                .px(px(4.))
                                .rounded(px(8.))
                                .bg(theme.accent)
                                .text_color(theme.on_accent)
                                .text_size(px(10.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .line_height(px(16.))
                                .flex()
                                .justify_center()
                                .border_2()
                                .border_color(theme.bg0)
                                .child(if unread > 99 { "99+".to_string() } else { unread.to_string() }),
                        )
                    }),
            );
        }
        let add_state = state_entity.clone();
        list = list.child(
            // `.rail-add`: background 0.1s.
            motion::track_hover(div().id("rail-add"), "rail-add".into())
                .relative()
                .size(px(42.))
                .rounded(RADIUS_L)
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.text3)
                .cursor_pointer()
                .child(motion::hover_layer("rail-add", theme.hover_strong, RADIUS_L, 100))
                .group("rail-add")
                .tip("Join a server", Side::Right)
                .on_click(move |_, _, cx| {
                    add_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::AddServer { link: None, sign_in_url: None }), cx))
                })
                .child(gpui::svg().path("icons/plus.svg").size(px(20.)).text_color(theme.text3).group_hover("rail-add", move |style| style.text_color(theme.text1))),
        );
        let settings_state = state_entity.clone();
        let profile_state = state_entity.clone();
        let mut footer = div().flex().flex_col().items_center().gap(px(8.)).pt(px(8.)).child(
            icon_button("rail-settings", "settings", 19., false, false, cx)
                .tip("Settings", Side::Right)
                .on_click(move |_, _, cx| settings_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: None }), cx))),
        );
        if let Some(me) = me {
            let server_id = active_id.clone().unwrap_or_default();
            let image = me.avatar.as_ref().and_then(|avatar| self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx)));
            footer = footer.child(
                div()
                    .id("rail-self")
                    .rounded_full()
                    .cursor_pointer()
                    .tip(me.display_name.clone(), Side::Right)
                    .on_click(move |_, _, cx| {
                        profile_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: Some("profile".into()) }), cx))
                    })
                    .child(avatar(
                        AvatarProps { name: me.display_name.clone(), seed: me.id.clone(), image, size: 32., online: false, rounded: false, dot_border: theme.bg0 },
                        cx,
                    )),
            );
        }
        div()
            .flex()
            .flex_col()
            .flex_none()
            .items_center()
            .w(RAIL_WIDTH)
            .py(px(10.))
            .gap(px(8.))
            .bg(theme.bg0)
            .border_r_1()
            .border_color(theme.line)
            .child(div().id("rail-list").flex_1().min_h_0().w_full().overflow_y_scroll().child(list))
            .child(footer)
    }
}
