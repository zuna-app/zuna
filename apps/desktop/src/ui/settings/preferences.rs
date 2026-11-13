//! The Privacy, Notifications and Appearance sections, and the confirmation for keeping files'
//! metadata.

use super::*;

impl SettingsView {
    pub(super) fn privacy(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let settings = self.state.read(cx).settings.clone();
        let receipts = server.prefs.send_read_receipts;
        let (state_a, state_b, state_c, state_d) = (self.state.clone(), self.state.clone(), self.state.clone(), self.state.clone());
        let hides = me.hides_last_seen;
        let mut parts = vec![
            Self::heading("Privacy", &theme),
            Self::lead(format!("These apply to {}. Each server you join has its own settings.", server.entry.name), &theme),
            Self::row(
                "Send read receipts",
                Some("Others see when you've read their messages. If off, your devices still stay in sync."),
                switch("receipts", receipts, cx).on_click(move |_, _, cx| state_a.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ "sendReadReceipts": !receipts })], cx))),
                &theme,
            ),
            Self::row(
                "Show when I'm online",
                Some("If off, people see “last seen recently” instead of your status."),
                switch("online", !hides, cx).on_click(move |_, _, cx| state_b.update(cx, |state, cx| state.act("setHideLastSeen", vec![json!(!hides)], cx))),
                &theme,
            ),
            Self::divider(&theme),
            Self::subheading("Blocked people"),
        ];
        let blocked: Vec<_> = server.prefs.blocked().iter().filter_map(|id| server.users.get(id).cloned()).collect();
        if blocked.is_empty() {
            parts.push(div().text_size(px(12.5)).text_color(theme.text2).child("Nobody. You can block someone from their details in a chat, or from a group's members.").into_any_element());
        }
        for user in blocked {
            let state = self.state.clone();
            let id = user.id.clone();
            parts.push(Self::row(
                &user.display_name,
                Some(&format!("@{}", user.username)),
                button(SharedString::from(format!("unblock-{}", user.id)), ButtonKind::Default, ButtonSize::Small, false, cx)
                    .child("Unblock")
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(false)], cx))),
                &theme,
            ));
        }
        parts.push(div().text_size(px(12.5)).text_color(theme.text2).child("You don't see messages from people you block, or hear about them. Nobody is told, and your server can't see who you block.").into_any_element());
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("On this device"));
        let link_previews = settings.link_previews;
        parts.push(Self::row(
            "Link previews",
            Some("When you write a link, this device fetches the page to show its title and picture, and sends them encrypted with your message. The site sees your address, as when you open a link. Your server never sees it."),
            switch("link-previews", link_previews, cx).on_click(move |_, _, cx| state_c.update(cx, |state, cx| state.update_settings(|s| s.link_previews = !link_previews, cx))),
            &theme,
        ));
        let remove = settings.remove_metadata;
        parts.push(Self::row(
            "Remove metadata from files",
            Some("Before a file is sent, this device takes out where and when it was made, the camera or phone and its serial number, the program, and editing history. Photos: JPEG, PNG, WebP, GIF, HEIC and AVIF. Videos: MP4, MOV, 3GP, WebM and MKV. Drawings: SVG. Other files are sent as they are."),
            switch("remove-metadata", remove, cx).on_click(cx.listener(move |view, _, _, cx| {
                if remove {
                    view.confirming_keep = true;
                    cx.notify();
                } else {
                    state_d.update(cx, |state, cx| state.update_settings(|s| s.remove_metadata = true, cx));
                }
            })),
            &theme,
        ));
        let proxy = settings.proxy.clone();
        let state_p = self.state.clone();
        parts.push(Self::row(
            "Proxy",
            Some(&if proxy.on {
                format!("Everything this device sends goes through the SOCKS5 proxy at {}, for every server on it. Your servers see its address rather than yours.", crate::host::net::proxy().map(|proxy| proxy.address()).unwrap_or_else(|| proxy.host.clone()))
            } else {
                "Off. A SOCKS5 proxy can carry everything this device sends, so that your servers see its address rather than yours.".to_string()
            }),
            button("proxy-settings", ButtonKind::Default, ButtonSize::Small, false, cx)
                .child(if proxy.on { "Change" } else { "Set up" })
                .on_click(move |_, _, cx| state_p.update(cx, |state, cx| state.set_overlay(Some(Overlay::Proxy { from_settings: true }), cx))),
            &theme,
        ));
        let play_youtube = settings.play_youtube;
        let state_y = self.state.clone();
        parts.push(Self::row(
            "Play YouTube videos",
            Some("A voice channel or a call can watch a YouTube video together. Watching one, this device plays it from YouTube, which learns its IP address, which video and when. Until you press Watch, it contacts nobody. Off, pressing Watch asks first."),
            switch("play-youtube", play_youtube, cx).on_click(move |_, _, cx| state_y.update(cx, |state, cx| state.update_settings(|s| s.play_youtube = !play_youtube, cx))),
            &theme,
        ));
        parts
    }

    pub(super) fn notifications(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let settings = self.state.read(cx).settings.clone();
        let (on_state, sound_state, tray_state) = (self.state.clone(), self.state.clone(), self.state.clone());
        let (on, sound, tray) = (settings.notifications, settings.notification_sound, settings.close_to_tray);
        let preview_label = match settings.notification_preview.as_str() {
            "sender" => "Sender only",
            "none" => "Nothing",
            _ => "Sender and message",
        };
        let preview_state = self.state.clone();
        // As the web's select: the choice, and a menu of the three under it.
        let (select_bounds, select_probe) = bounds_probe();
        let select = div()
            .id("notification-preview")
            .w(px(180.))
            .h(px(36.))
            .px(px(10.))
            .flex()
            .items_center()
            .justify_between()
            .rounded(RADIUS_M)
            .bg(theme.bg2)
            .border_1()
            .border_color(theme.line)
            .text_size(px(13.5))
            .cursor_pointer()
            .child(select_probe)
            .on_click(move |_, _, cx| {
                let choice = |label: &str, value: &'static str| {
                    let state = preview_state.clone();
                    crate::ui::menu::MenuEntry::new(label, "bell", move |_, cx| {
                        state.update(cx, |state, cx| state.update_settings(|settings| settings.notification_preview = value.to_string(), cx))
                    })
                };
                let entries = vec![choice("Sender and message", "full"), choice("Sender only", "sender"), choice("Nothing", "none")];
                let at = select_bounds.get();
                crate::ui::menu::open_menu(gpui::point(at.left(), at.bottom() + px(4.)), entries, false, cx);
            })
            .child(preview_label)
            .child(icon("chevron-down", 15., theme.text2));
        let mut parts = vec![
            Self::heading("Notifications", &theme),
            Self::lead("Previews are decrypted on this device. No notification service ever sees them.".into(), &theme),
            Self::row(
                "Desktop notifications",
                Some("While you're on another device, they wait 30 seconds, and don't show if you read the chat there."),
                switch("notifications-on", on, cx).on_click(move |_, _, cx| on_state.update(cx, |state, cx| state.update_settings(|s| s.notifications = !on, cx))),
                &theme,
            ),
            Self::row(
                "Sound",
                None,
                switch("notification-sound", sound, cx).on_click(move |_, _, cx| sound_state.update(cx, |state, cx| state.update_settings(|s| s.notification_sound = !sound, cx))),
                &theme,
            ),
            Self::row("What notifications show", Some("Choose less if others can see your screen."), select, &theme),
        ];
        // macOS keeps every app running with its window closed, and has no tray, as the
        // Electron app didn't offer this there.
        if cfg!(not(target_os = "macos")) {
            parts.push(Self::row(
                "Keep running when closed",
                Some("Zuna stays in the system tray so messages still arrive."),
                switch("close-to-tray", tray, cx).on_click(move |_, _, cx| tray_state.update(cx, |state, cx| state.update_settings(|s| s.close_to_tray = !tray, cx))),
                &theme,
            ));
        }
        parts
    }

    pub(super) fn appearance(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let settings = self.state.read(cx).settings.clone();
        let swatches = div().flex().gap(px(8.)).children(Accent::ALL.into_iter().map(|accent| {
            let active = settings.accent == accent;
            let check = if matches!(accent, Accent::Neutral | Accent::Amber) { theme::color(theme::hex(0x111113)) } else { gpui::white() };
            let state = self.state.clone();
            div()
                .id(SharedString::from(format!("accent-{}", accent.label())))
                .size(px(32.))
                .rounded_full()
                .bg(Theme::swatch(accent))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .relative()
                .border_1()
                .border_color(theme::color(theme::white_a(0.1)))
                .when(active, |el| el.child(div().absolute().top(px(-5.)).left(px(-5.)).size(px(40.)).rounded_full().border_2().border_color(theme.text1)))
                
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.update_settings(|s| s.accent = accent, cx)))
                .when(active, |el| el.child(icon("check", 15., check)))
        }));
        let segmented = div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.)).children([TextSize::Small, TextSize::Medium, TextSize::Large].into_iter().map(|size| {
            let active = settings.message_size == size;
            let label = match size {
                TextSize::Small => "Small",
                TextSize::Medium => "Medium",
                TextSize::Large => "Large",
            };
            let state = self.state.clone();
            div()
                .id(label)
                .px(px(11.))
                .py(px(4.))
                .rounded(RADIUS_S)
                .text_size(px(13.))
                .text_color(if active { theme.text1 } else { theme.text2 })
                .when(active, |el| el.bg(theme.bg5))
                .cursor_pointer()
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.update_settings(|s| s.message_size = size, cx)))
                .child(label)
        }));
        let (motion_state, enter_state) = (self.state.clone(), self.state.clone());
        let reduce = settings.reduce_motion;
        let enter = settings.enter_to_send;
        // Themes plugins give, which only show once one is installed.
        let themes = crate::plugins::get(cx).map(|plugins| plugins.read(cx).themes()).unwrap_or_default();
        let theme_row = (!themes.is_empty()).then(|| {
            let chosen = settings.theme.clone().and_then(|key| themes.iter().find(|(theme_key, _, _)| *theme_key == key).map(|(_, name, plugin)| format!("{name} ({plugin})"))).unwrap_or_else(|| "Zuna".into());
            let mut choices: Vec<(String, std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)>)> = Vec::new();
            let state = self.state.clone();
            choices.push(("Zuna".into(), std::rc::Rc::new(move |_, cx| state.update(cx, |state, cx| state.update_settings(|s| s.theme = None, cx)))));
            for (key, name, plugin) in themes {
                let state = self.state.clone();
                choices.push((format!("{name} ({plugin})"), std::rc::Rc::new(move |_, cx| {
                    let key = key.clone();
                    state.update(cx, |state, cx| state.update_settings(|s| s.theme = Some(key), cx))
                })));
            }
            Self::row("Theme", Some("From your plugins. The accent above applies under Zuna's own."), div().w(px(220.)).child(select_box("plugin-theme", chosen, choices, cx)), &theme)
        });
        vec![
            Self::heading("Appearance", &theme),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Accent color"))
                .child(swatches)
                .into_any_element(),
        ]
        .into_iter()
        .chain(theme_row)
        .chain([
            Self::row("Message size", None, segmented, &theme),
            Self::row(
                "Reduce motion",
                Some("Turns off most animations."),
                switch("reduce-motion", reduce, cx).on_click(move |_, _, cx| motion_state.update(cx, |state, cx| state.update_settings(|s| s.reduce_motion = !reduce, cx))),
                &theme,
            ),
            Self::row(
                "Press Enter to send",
                Some(if cfg!(target_os = "macos") { "If off, use ⌘Return to send and Return for new lines." } else { "If off, use Ctrl+Enter to send and Enter for new lines." }),
                switch("enter-to-send", enter, cx).on_click(move |_, _, cx| enter_state.update(cx, |state, cx| state.update_settings(|s| s.enter_to_send = !enter, cx))),
                &theme,
            ),
        ])
        .collect()
    }

    pub(super) fn keep_metadata_confirm(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.clone();
        div()
            .id("keep-metadata-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            .occlude()
            .child(
                div()
                    .w(px(440.))
                    .flex()
                    .flex_col()
                    .bg(theme.bg1)
                    .border_1()
                    .border_color(theme.line_strong)
                    .rounded(px(14.))
                    .shadow(shadow_l())
                    .child(div().flex().items_center().gap(px(10.)).pt(px(16.)).pr(px(16.)).pb(px(4.)).pl(px(20.)).child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child("Send files with their metadata?")))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .px(px(20.))
                            .pt(px(10.))
                            .pb(px(20.))
                            .text_size(px(13.5))
                            .child("Photos and videos from phones usually record where they were taken, to within a few meters, and when. With this off, everyone in a chat you send them to can see that, along with the camera or phone and its serial number, the program used, and what was changed in it. So can anyone they pass the files on to.")
                            .child(div().text_color(theme.text2).child("Your server still can't see any of it, as files are encrypted. This is only for this device, and for files you send from now on.")),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .px(px(20.))
                            .pb(px(16.))
                            .child(button("keep-cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                                view.confirming_keep = false;
                                cx.notify();
                            })))
                            .child(button("keep-confirm", ButtonKind::Danger, ButtonSize::Normal, false, cx).child("Turn off").on_click(cx.listener(move |view, _, _, cx| {
                                view.confirming_keep = false;
                                state.update(cx, |state, cx| state.update_settings(|s| s.remove_metadata = false, cx));
                                cx.notify();
                            }))),
                    ),
            )
            .into_any_element()
    }
}
