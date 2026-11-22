//! What each step of onboarding shows, and the pieces they share: headers, fields, the
//! password's strength and the buttons.

use super::*;

impl Onboarding {
    pub(super) fn header(&self, icon_name: Option<&str>, title: String, text: Option<String>, back: Option<Step>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        div()
            .relative()
            .flex()
            .flex_col()
            .items_center()
            .text_center()
            .gap(px(6.))
            .when_some(back, |el, back| {
                el.child(div().absolute().left(px(-6.)).top(px(-4.)).child(icon_button("back", "arrow-left", 18., false, false, cx).on_click(cx.listener(move |view, _, window, cx| view.go(back.clone(), window, cx)))))
            })
            .when_some(icon_name, |el, name| el.child(div().mb(px(4.)).child(icon(name, 26., theme.text2))))
            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .when_some(text, |el, text| el.child(div().text_size(px(13.5)).text_color(theme.text2).child(text)))
            .into_any_element()
    }

    pub(super) fn input_field(&self, index: usize, input: &Entity<TextInput>, label: Option<&str>, hint: Option<&str>, error: Option<String>, suffix: Option<AnyElement>, cx: &mut Context<Self>) -> AnyElement {
        field(label, input.clone(), error, hint.map(str::to_string), self.focused == Some(index), suffix, cx).into_any_element()
    }

    pub(super) fn password_suffix(&self, cx: &mut Context<Self>) -> AnyElement {
        let visible = self.show_password;
        icon_button("toggle-password", if visible { "eye-off" } else { "eye" }, 15., true, false, cx)
            .on_click(cx.listener(|view, _, _, cx| {
                view.show_password = !view.show_password;
                let masked = !view.show_password;
                view.password.update(cx, |input, cx| input.set_masked(masked, cx));
                view.confirm.update(cx, |input, cx| input.set_masked(masked, cx));
                cx.notify();
            }))
            .into_any_element()
    }

    pub(super) fn strength_meter(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let (score, label) = &self.strength;
        let colors = [theme.bg5, theme.red, theme.amber, theme.text2, theme.green];
        let typed = !self.password.read(cx).text().is_empty();
        // The core's rating comes with its words in English, so its score is named here.
        let label = if label.is_empty() || !typed { tr!("onboarding.passwordMinimum", count = MIN_PASSWORD) } else { crate::ui::password_strength(*score).to_string() };
        let color = if *score > 0 && typed { colors[*score as usize] } else { theme.text3 };
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(18.))
            .mt(px(3.))
            .text_size(px(12.))
            .child(div().flex().gap(px(3.)).w(px(84.)).flex_none().children((1..=4u8).map(|bar| {
                div().h(px(3.)).flex_1().rounded(px(3.)).bg(if typed && *score >= bar { colors[*score as usize] } else { theme.bg4 })
            })))
            .child(div().text_color(color).child(label))
            .into_any_element()
    }

    pub(super) fn primary(&self, id: &'static str, label: &str, enabled: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let busy = self.busy;
        button(id, ButtonKind::Primary, ButtonSize::Large, !enabled || busy, cx)
            .w_full()
            .when(busy, |el| el.child(spinner(18., theme.text3)))
            .when(!busy, |el| el.child(label.to_string()))
            .when(enabled && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
            .into_any_element()
    }

    pub(super) fn welcome(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let chip = |icon_name: &str, label: &str| {
            div()
                .flex()
                .items_center()
                .gap(px(5.))
                .px(px(10.))
                .py(px(4.))
                .rounded_full()
                .bg(theme.bg2)
                .text_color(theme.text2)
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .child(icon(icon_name, 13., theme.text2))
                .child(label.to_string())
        };
        vec![
            div()
                .flex()
                .flex_col()
                .items_center()
                .text_center()
                .gap(px(6.))
                .child(div().mb(px(14.)).child(logo(64.)))
                .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(t("onboarding.welcome.title")))
                .child(div().text_size(px(13.5)).text_color(theme.text2).child(t("onboarding.welcome.tagline")))
                // Two rows, as they wrap at this width on the web. GPUI measures a wrapping
                // row as one line when centering, which would put everything lower.
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.))
                        .mt(px(10.))
                        .child(div().flex().gap(px(6.)).child(chip("lock", t("onboarding.welcome.encrypted"))).child(chip("shield-check", t("onboarding.welcome.openSource"))))
                        .child(chip("server", t("onboarding.welcome.selfHosted"))),
                )
                .into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .mt(px(16.))
                .child(
                    button("join", ButtonKind::Primary, ButtonSize::Large, false, cx)
                        .w_full()
                        .child(icon("link", 16., theme.on_accent))
                        .child(t("onboarding.welcome.join"))
                        .on_click(cx.listener(|view, _, window, cx| view.go(Step::Link, window, cx))),
                )
                .child(button("sign-in", ButtonKind::Default, ButtonSize::Large, false, cx).w_full().child(t("onboarding.signIn.title")).on_click(cx.listener(|view, _, window, cx| view.go(Step::SignIn, window, cx))))
                .child(
                    div()
                        .id("host-own")
                        .self_center()
                        .h(px(32.))
                        .mt(px(2.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.text1))
                        .on_click(|_, _, cx| cx.open_url("https://github.com/zuna-app/zuna/blob/main/docs/SELF_HOSTING.md"))
                        .child(icon("server", 14., theme.text2))
                        .child(t("onboarding.welcome.host"))
                        .child(icon("arrow-up-right", 14., theme.text2)),
                )
                // Before any server is joined, so that even signing up goes through it.
                .child({
                    let state = self.state.clone();
                    let on = state.read(cx).settings.proxy.on;
                    div()
                        .id("use-proxy")
                        .self_center()
                        .h(px(28.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.text1))
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Proxy), cx)))
                        .child(icon("shield", 14., theme.text2))
                        .child(if on { t("onboarding.welcome.proxyOn") } else { t("onboarding.welcome.proxy") })
                })
                .into_any_element(),
        ]
    }
}

/// Text beside a link, in a row of its own: the spaces at its edges are kept by making them
/// non-breaking, as a space at the end of a line of its own would be lost.
fn keep_edges(text: &str) -> String {
    let trimmed_start = text.trim_start_matches(' ');
    let leading = text.len() - trimmed_start.len();
    let trimmed = trimmed_start.trim_end_matches(' ');
    let trailing = trimmed_start.len() - trimmed.len();
    format!("{}{}{}", "\u{a0}".repeat(leading), trimmed, "\u{a0}".repeat(trailing))
}

/// A form's error, which takes a place only when there is one: without it, an empty row
/// pulls the next one up by the gap it would have added.
pub(super) fn error_slot(error: Option<String>, theme: &crate::theme::Theme) -> AnyElement {
    match error {
        Some(error) => div().text_size(px(12.5)).text_color(theme.red).child(error).into_any_element(),
        None => div().mt(px(-14.)).into_any_element(),
    }
}

impl Render for Onboarding {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        if let Some(input) = self.pending_focus.take() {
            input.focus_handle(cx).focus(window, cx);
        }
        let error = self.error.clone();
        let step = self.step.clone();
        let mut gap = 14.;
        let children: Vec<AnyElement> = match step {
            Step::Welcome => {
                gap = 10.;
                self.welcome(cx)
            }
            Step::Link => {
                gap = 18.;
                let has_link = !self.link.read(cx).text().trim().is_empty();
                let back = if self.embedded { None } else { Some(Step::Welcome) };
                let mut parts = vec![
                    self.header(Some("link"), t("onboarding.link.title").into(), Some(t("onboarding.link.lead").into()), back, cx),
                    self.input_field(0, &self.link.clone(), None, None, error, None, cx),
                ];
                let busy = self.busy;
                parts.push(
                    button("continue", ButtonKind::Primary, ButtonSize::Large, !has_link || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)))
                        .when(!busy, |el| el.child(t("common.continue")).child(icon("arrow-right", 17., if has_link { theme.on_accent } else { theme.text3 })))
                        .when(has_link && !busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.preview_invite(cx))))
                        .into_any_element(),
                );
                if self.embedded {
                    parts.push(button("have-account", ButtonKind::Default, ButtonSize::Large, false, cx).w_full().child(t("onboarding.link.haveAccount")).on_click(cx.listener(|view, _, window, cx| view.go(Step::SignIn, window, cx))).into_any_element());
                }
                parts
            }
            Step::Invite(preview) => {
                let server = &preview.server;
                let icon_image = if server.has_icon {
                    let url = format!("{}/api/icon", preview.url);
                    self.state.update(cx, |state, cx| state.remote_picture(&url, cx))
                } else {
                    None
                };
                let display_name = self.display_name.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                let username_error = if error.as_ref().is_some_and(|e| e.to_lowercase().contains("username")) {
                    error.clone()
                } else if !username.is_empty() && !valid_username(&username) {
                    Some(t("onboarding.invite.usernameInvalid").to_string())
                } else {
                    None
                };
                let error = error.filter(|e| !e.to_lowercase().contains("username"));
                let confirm_error = if !confirm.is_empty() && !password.starts_with(&confirm) { Some(t("common.passwordsDontMatch").to_string()) } else { None };
                let can_submit = !display_name.is_empty() && valid_username(&username) && password.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == password;
                let members = server.user_count as u64;
                let subtitle: AnyElement = if preview.setup {
                    div().child(t("onboarding.invite.owner")).into_any_element()
                } else if members > 0 {
                    div().flex().items_center().gap(px(5.)).child(icon("users", 13., theme.text2)).child(tr!("onboarding.invite.members", count = members)).into_any_element()
                } else {
                    div().child(t("onboarding.invite.openSignUps")).into_any_element()
                };
                let suffix = self.password_suffix(cx);
                let confirm_suffix = self.password_suffix(cx);
                let busy = self.busy;
                vec![
                    div()
                        .relative()
                        .flex()
                        .flex_col()
                        .items_center()
                        .text_center()
                        .gap(px(6.))
                        .mb(px(6.))
                        .child(div().absolute().left(px(-6.)).top(px(-4.)).child(icon_button("back", "arrow-left", 18., false, false, cx).on_click(cx.listener(|view, _, window, cx| view.go(Step::Link, window, cx)))))
                        .child(avatar(AvatarProps { name: server.name.clone(), seed: preview.url.clone(), image: icon_image, size: 56., online: false, rounded: true, dot_border: theme.bg0 }, cx))
                        .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(if preview.setup { t("onboarding.invite.setUpTitle").to_string() } else { tr!("onboarding.invite.joinTitle", server = server.name) }))
                        .child(div().text_color(theme.text2).child(subtitle))
                        .into_any_element(),
                    self.input_field(1, &self.display_name.clone(), Some(t("onboarding.invite.yourName")), None, None, None, cx),
                    self.input_field(2, &self.username.clone(), Some(t("common.username")), Some(t("onboarding.invite.usernameHint")), username_error, None, cx),
                    div().flex().flex_col().child(self.input_field(3, &self.password.clone(), Some(t("common.password")), None, None, Some(suffix), cx)).child(self.strength_meter(cx)).into_any_element(),
                    self.input_field(4, &self.confirm.clone(), Some(t("common.confirmPassword")), None, confirm_error, Some(confirm_suffix), cx),
                    div()
                        .flex()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(10.))
                        .rounded(RADIUS_M)
                        .bg(theme.bg2)
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .child(div().mt(px(1.)).child(icon("lock", 15., theme.text2)))
                        .child(div().flex_1().min_w_0().child(t("onboarding.invite.passwordNote")))
                        .into_any_element(),
                    error_slot(error.clone(), &theme),
                    button("create", ButtonKind::Primary, ButtonSize::Large, !can_submit || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)).child(t("onboarding.invite.securing")))
                        .when(!busy, |el| el.child(t("onboarding.invite.create")))
                        .when(can_submit && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
                        .into_any_element(),
                    div()
                        .flex()
                        .flex_wrap()
                        .justify_center()
                        .text_size(px(12.5))
                        .text_color(theme.text3)
                        // One sentence, around the link to the terms where it says {terms}.
                        .children({
                            let agreement = t("onboarding.invite.terms");
                            let (before, after) = agreement.split_once("{terms}").unwrap_or((agreement, ""));
                            [
                                div().child(keep_edges(before)).into_any_element(),
                                div().id("terms").text_color(theme.text2).cursor_pointer().hover(move |style| style.text_color(theme.text1)).on_click(|_, _, cx| cx.open_url(crate::ui::TERMS_URL)).child(t("onboarding.invite.termsLink")).into_any_element(),
                                div().child(keep_edges(after)).into_any_element(),
                            ]
                        })
                        .into_any_element(),
                ]
            }
            Step::RecoveryKey { recovery_key, .. } => {
                gap = 16.;
                let key_for_copy = recovery_key.clone();
                let key_for_file = recovery_key.clone();
                let saved = self.saved;
                let copied = self.copied;
                vec![
                    self.header(
                        Some("key-round"),
                        t("onboarding.recovery.title").into(),
                        Some(t("onboarding.recovery.lead").into()),
                        None,
                        cx,
                    ),
                    div()
                        .grid()
                        .grid_cols(5)
                        .gap(px(8.))
                        .p(px(14.))
                        .bg(theme.bg2)
                        .border_1()
                        .border_color(theme.line)
                        .rounded(RADIUS_M)
                        .font_family(FONT_MONO)
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .children(recovery_key.split('-').map(|part| div().flex().justify_center().child(part.to_string())))
                        .into_any_element(),
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(
                            button("copy-key", ButtonKind::Default, ButtonSize::Normal, false, cx)
                                .flex_1()
                                .child(icon(if copied { "check" } else { "copy" }, 15., theme.text1))
                                .child(if copied { t("common.copied") } else { t("common.copy") })
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(key_for_copy.clone()));
                                    view.copied = true;
                                    cx.notify();
                                    cx.spawn(async move |view, cx| {
                                        cx.background_executor().timer(Duration::from_millis(1500)).await;
                                        view.update(cx, |view, cx| {
                                            view.copied = false;
                                            cx.notify();
                                        })
                                        .ok();
                                    })
                                    .detach();
                                })),
                        )
                        .child(button("save-key", ButtonKind::Default, ButtonSize::Normal, false, cx).flex_1().child(icon("download", 15., theme.text1)).child(t("common.saveAsFile")).on_click(move |_, _, cx| {
                            let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                            let chosen = cx.prompt_for_new_path(&downloads, Some("zuna-recovery-key.txt"));
                            let text = tr!("onboarding.recoveryKey.file", key = key_for_file);
                            cx.spawn(async move |_| {
                                if let Ok(Ok(Some(path))) = chosen.await {
                                    std::fs::write(path, text).ok();
                                }
                            })
                            .detach();
                        }))
                        .into_any_element(),
                    div()
                        .id("saved-check")
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .text_size(px(13.5))
                        .cursor_pointer()
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.saved = !view.saved;
                            cx.notify();
                        }))
                        .child(
                            div()
                                .size(px(18.))
                                .rounded(px(4.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .border_1()
                                .border_color(if saved { theme.accent } else { theme.line_strong })
                                .bg(if saved { theme.accent } else { theme.bg2 })
                                .when(saved, |el| el.child(icon("check", 13., theme.on_accent))),
                        )
                        .child(t("onboarding.recovery.stored"))
                        .into_any_element(),
                    self.primary("continue", t("common.continue"), saved, cx),
                ]
            }
            Step::NameServer { .. } => vec![
                self.header(Some("server"), t("onboarding.nameServer.title").into(), Some(t("onboarding.nameServer.hint").into()), None, cx),
                self.input_field(7, &self.server_name.clone(), None, None, error, None, cx),
                self.primary("save-name", t("common.continue"), true, cx),
            ],
            Step::SignIn => {
                let url = self.server.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                let enabled = !url.is_empty() && !username.is_empty() && !password.is_empty();
                let suffix = self.password_suffix(cx);
                let busy = self.busy;
                let back = if self.embedded { Step::Link } else { Step::Welcome };
                vec![
                    self.header(None, t("onboarding.signIn.title").into(), Some(t("onboarding.signIn.lead").into()), Some(back), cx),
                    self.input_field(5, &self.server.clone(), Some(t("onboarding.signIn.address")), Some(t("onboarding.signIn.addressHint")), None, None, cx),
                    self.input_field(2, &self.username.clone(), Some(t("common.username")), None, None, None, cx),
                    self.input_field(3, &self.password.clone(), Some(t("common.password")), None, None, Some(suffix), cx),
                    error_slot(error.clone(), &theme),
                    button("sign-in-submit", ButtonKind::Primary, ButtonSize::Large, !enabled || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)).child(t("onboarding.signIn.unlocking")))
                        .when(!busy, |el| el.child(t("onboarding.signIn.title")))
                        .when(enabled && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
                        .into_any_element(),
                    div()
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .id("forgot")
                                .text_size(px(13.))
                                .text_color(theme.text2)
                                .when(url.is_empty() || username.is_empty(), |el| el.opacity(0.45))
                                .when(!url.is_empty() && !username.is_empty(), |el| {
                                    el.cursor_pointer().hover(move |style| style.text_color(theme.text1)).on_click(cx.listener(move |view, _, window, cx| {
                                        view.go(Step::Recover { url: url.clone(), username: username.clone() }, window, cx)
                                    }))
                                })
                                .child(t("onboarding.signIn.forgot")),
                        )
                        .into_any_element(),
                ]
            }
            Step::Recover { username, .. } => {
                let key = self.recovery.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                let enabled = !key.is_empty() && password.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == password;
                let confirm_error = if !confirm.is_empty() && !password.starts_with(&confirm) { Some(t("common.passwordsDontMatch").to_string()) } else { None };
                let suffix = self.password_suffix(cx);
                vec![
                    self.header(None, t("onboarding.recover.title").into(), Some(tr!("onboarding.recover.hint", username = username)), Some(Step::SignIn), cx),
                    self.input_field(6, &self.recovery.clone(), Some(t("onboarding.recover.key")), None, None, None, cx),
                    div().flex().flex_col().child(self.input_field(3, &self.password.clone(), Some(t("onboarding.recover.newPassword")), None, None, Some(suffix), cx)).child(self.strength_meter(cx)).into_any_element(),
                    self.input_field(4, &self.confirm.clone(), Some(t("onboarding.recover.confirmPassword")), None, confirm_error, None, cx),
                    error_slot(error.clone(), &theme),
                    self.primary("recover", t("onboarding.recover.submit"), enabled, cx),
                ]
            }
        };
        let _ = SharedString::default();
        // As CSS grid centering in a scrolling box: in the middle while it fits, from the top when it doesn't.
        div()
            .id("onboarding")
            .flex_1()
            .min_w_0()
            .overflow_y_scroll()
            .track_scroll(&scroll_handle("onboarding"))
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(24.))
            .pr(px(24.) + gutter(&scroll_handle("onboarding")))
            .py(px(32.))
            // A width of its own, so wrapping text is measured at it when centering.
            // `.onboarding-step`: each step fades in over 120 ms.
            .child(div().flex_none().w(px(360.)).max_w_full().flex().flex_col().gap(px(gap)).children(children).enter(
                match &self.step {
                    Step::Welcome => "step-welcome",
                    Step::Link => "step-link",
                    Step::Invite(_) => "step-invite",
                    Step::RecoveryKey { .. } => "step-recovery-key",
                    Step::NameServer { .. } => "step-name-server",
                    Step::SignIn => "step-sign-in",
                    Step::Recover { .. } => "step-recover",
                },
                Enter::Fade,
                120,
            ))
            .child(scrollbar("onboarding", Scrolls::Div(scroll_handle("onboarding"))))
            .reveals_focus(&scroll_handle("onboarding"))
    }
}
