//! The Profile section: the person's picture and display name, and signing out of the server or
//! deleting the account.

use super::*;

impl SettingsView {
    pub(super) fn profile(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let image = me.avatar.as_ref().and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let name = self.display_name.read(cx).text().trim().to_string();
        let bio = self.bio.read(cx).text().to_string();
        let dirty = name != me.display_name || bio != me.bio;
        let state = self.state.clone();
        let busy = self.busy;
        vec![
            Self::heading("Profile", &theme),
            Self::lead(format!("Only members of {} can see this. Your server stores it encrypted.", server.entry.name), &theme),
            div()
                .flex()
                .items_center()
                .gap(px(18.))
                .child(
                    div()
                        .relative()
                        .flex_none()
                        .child(avatar(AvatarProps { name: me.display_name.clone(), seed: me.id.clone(), image, size: 72., online: false, rounded: false, dot_border: theme.bg_chat }, cx))
                        .child(
                            div()
                                .id("change-avatar")
                                .absolute()
                                .right(px(-2.))
                                .bottom(px(-2.))
                                .size(px(28.))
                                .rounded_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(theme.bg4)
                                .border_2()
                                .border_color(theme.bg1)
                                .cursor_pointer()
                                .hover(move |style| style.bg(theme.bg5))
                                
                                .on_click(cx.listener(|view, _, _, cx| view.change_avatar(cx)))
                                .child(icon("camera", 17., theme.text1)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).text_size(px(15.)).child(me.display_name.clone()))
                        .child(div().text_color(theme.text2).child(format!("@{}", me.username)))
                        .when(me.avatar.is_some(), |el| {
                            let state = self.state.clone();
                            el.child(
                                div()
                                    .id("remove-avatar")
                                    .text_size(px(13.))
                                    .text_color(theme.text2)
                                    .cursor_pointer()
                                    .hover(move |style| style.text_color(theme.text1))
                                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("updateProfile", vec![json!({}), serde_json::Value::Null], cx)))
                                    .child("Remove picture"),
                            )
                        }),
                )
                .into_any_element(),
            field(Some("Display name"), self.display_name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Bio"))
                .child(
                    div()
                        .min_h(px(76.))
                        .bg(theme.bg2)
                        .border_1()
                        .border_color(if self.focused == Some(1) { theme.line_strong } else { theme.line })
                        .rounded(RADIUS_M)
                        .px(px(11.))
                        .py(px(9.))
                        .line_height(px(20.))
                        .child(self.bio.clone()),
                )
                .into_any_element(),
            div()
                .flex()
                .child(
                    button("save-profile", ButtonKind::Primary, ButtonSize::Normal, !dirty || name.is_empty() || busy, cx)
                        .child(if busy { "Saving…" } else { "Save changes" })
                        .when(dirty && !name.is_empty() && !busy, |el| {
                            el.on_click(cx.listener(move |view, _, _, cx| {
                                view.busy = true;
                                let state = state.clone();
                                state.update(cx, |state, cx| {
                                    let server = state.active_server.clone();
                                    state.call(server.as_deref(), "updateProfile", vec![json!({ "displayName": name, "bio": bio })], cx, |state, result, cx| match result {
                                        Ok(_) => state.toast("Profile saved", ToastKind::Info, cx),
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    });
                                });
                                view.busy = false;
                                cx.notify();
                            }))
                        }),
                )
                .into_any_element(),
            Self::divider(&theme),
            {
                let state = self.state.clone();
                let delete_state = self.state.clone();
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        button("sign-out", ButtonKind::Danger, ButtonSize::Normal, false, cx)
                            .child(icon("log-out", 15., theme.red))
                            .child("Sign out of this server")
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::LeaveServer), cx))),
                    )
                    .child(
                        button("delete-account", ButtonKind::Danger, ButtonSize::Normal, false, cx)
                            .child(icon("trash", 15., theme.red))
                            .child("Delete account")
                            .on_click(move |_, _, cx| delete_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some("delete".into()) }), cx))),
                    )
                    .into_any_element()
            },
        ]
    }

    /// A new profile picture: the middle square of an image, 256 pixels across, as the web makes it.
    pub(super) fn change_avatar(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.first() else { return };
            let prepared = crate::media::prepare_avatar(path);
            state.update(cx, |state, cx| match prepared {
                Some(file) => state.act("updateProfile", vec![json!({}), crate::host::file(&file.to_string_lossy(), "image/jpeg")], cx),
                None => state.toast("That image couldn't be processed.", ToastKind::Error, cx),
            });
        })
        .detach();
    }
}
