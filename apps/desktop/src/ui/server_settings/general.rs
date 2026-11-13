//! The server's overview, invites, emotes and storage.

use super::*;

impl ServerSettings {
    pub(super) fn overview(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let icon_url = server.info.as_ref().filter(|info| info.has_icon).map(|_| format!("{}/api/icon?v={}", server.entry.url, self.icon_version));
        let icon_image = icon_url.and_then(|url| self.state.update(cx, |state, cx| state.remote_picture(&url, cx)));
        let picture = div()
            .id("server-icon-edit")
            .relative()
            .size(px(72.))
            .flex_none()
            .rounded(RADIUS_XL)
            .overflow_hidden()
            .group("server-icon")
            .cursor_pointer()
            .on_click(cx.listener(|_, _, _, cx| {
                let picked = crate::media::pick_avatar(cx);
                cx.spawn(async move |view, cx| {
                    let Some(prepared) = picked.await else { return };
                    view.update(cx, |view, cx| match prepared {
                        Ok(file) => {
                            view.icon_version = crate::format::now_ms() as u64;
                            view.run("updateServerIcon", vec![crate::host::file(&file.to_string_lossy(), "image/jpeg")], None, cx);
                        }
                        Err(()) => view.state.update(cx, |state, cx| state.toast("That image couldn't be processed.", ToastKind::Error, cx)),
                    })
                    .ok();
                })
                .detach();
            }))
            .child(match icon_image {
                Some(image) => cover(image, 1., 144, cx).size_full().rounded(RADIUS_XL).into_any_element(),
                None => avatar(AvatarProps { name: server.entry.name.clone(), seed: server.entry.url.clone(), image: None, size: 72., online: false, rounded: true, dot_border: theme.bg1 }, cx).into_any_element(),
            })
            .child(div().absolute().inset_0().flex().items_center().justify_center().bg(crate::theme::color(crate::theme::black_a(0.5))).opacity(0.).group_hover("server-icon", |style| style.opacity(1.)).child(icon("image", 18., gpui::white())));
        let name = self.name.read(cx).text().trim().to_string();
        let changed = !name.is_empty() && name != server.entry.name;
        let busy = self.busy;
        let version = server.info.as_ref().map(|info| info.version.clone()).unwrap_or_default();
        vec![
            Self::heading("Server"),
            Self::lead("The name and picture are public: they appear on invite pages before anyone signs in.", cx),
            div().flex().items_center().gap(px(18.)).child(picture).child(div().flex_1().child(field(Some("Server name"), self.name.clone(), None, None, false, None, cx))).into_any_element(),
            div()
                .flex()
                .child(button("save-server", ButtonKind::Primary, ButtonSize::Normal, !changed || busy, cx).child("Save changes").when(changed && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "name": name })], Some("Saved".into()), cx)))
                }))
                .into_any_element(),
            Self::divider(cx),
            Self::row("Address", Some("People and apps reach your server here."), div().max_w(px(260.)).font_family(FONT_MONO).text_size(px(12.5)).child(server.entry.address.clone()).into_any_element(), cx),
            Self::row("Version", None, div().font_family(FONT_MONO).text_size(px(12.5)).child(version).into_any_element(), cx),
        ]
    }

    pub(super) fn invites_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let info = server.info.clone().unwrap_or_default();
        let open = info.registration == "open";
        let members_invite = info.allow_member_invites;
        vec![
            Self::heading("Invites"),
            Self::lead("Invite links are the safest way for people to join.", cx),
            self.invites.clone().into_any_element(),
            Self::divider(cx),
            Self::row(
                "Let members create invite links",
                Some("If off, only admins can."),
                switch("member-invites", members_invite, cx).on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "allow_member_invites": !members_invite })], None, cx))).into_any_element(),
                cx,
            ),
            Self::row(
                "Open sign-ups",
                Some("Anyone who knows the address can join. This gives the server the key that protects profiles, so it can read display names and pictures. Messages stay encrypted."),
                switch("open-signups", open, cx).on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "registration": if open { "invite" } else { "open" } })], None, cx))).into_any_element(),
                cx,
            ),
        ]
    }

    pub(super) fn emotes(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let set_id = server.emotes.set_id.clone();
        let count = server.emotes.emotes.len();
        let busy = self.busy || self.refreshing;
        let link = self.emote_link.read(cx).text().trim().to_string();
        let mut grid = div().flex().flex_wrap().gap(px(4.));
        for emote in server.emotes.emotes.iter().take(80) {
            let url = crate::models::emote_url(&server.entry.url, &emote.id);
            let image = self.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            grid = grid.child(div().id(SharedString::from(format!("emote-preview-{}", emote.id))).size(px(40.)).p(px(4.)).tooltip(tooltip(emote.name.clone())).when_some(image, |el, image| el.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain))));
        }
        vec![
            Self::heading("Emotes"),
            Self::lead("Everyone on this server shares one 7TV emote set. Your server downloads and caches the images, so 7TV never sees your members' addresses. It checks 7TV for changes to the set every few hours.", cx),
            div()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(12.))
                .py(px(10.))
                .rounded(RADIUS_M)
                .bg(theme.bg2)
                .child(icon("face-slightly-smiling", 18., theme.text2))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).child(if server.emotes.set_name.is_empty() { "No emote set".to_string() } else { server.emotes.set_name.clone() }))
                        .child(div().text_size(px(12.5)).text_color(theme.text3).child(format!("{count} emotes"))),
                )
                .when(!set_id.is_empty(), |el| {
                    el.child(button("refresh-emotes", ButtonKind::Default, ButtonSize::Small, busy, cx).child(if self.refreshing { "Refreshing…" } else { "Refresh" }).when(!busy, |el| {
                        el.on_click(cx.listener(move |view, _, _, cx| {
                            view.refreshing = true;
                            view.set_emotes(set_id.clone(), "Updated", cx);
                        }))
                    }))
                })
                .into_any_element(),
            field(Some("Use a different set"), self.emote_link.clone(), None, Some("Paste a link to any emote set on 7TV.".into()), false, None, cx).into_any_element(),
            div()
                .flex()
                .child(button("use-set", ButtonKind::Primary, ButtonSize::Normal, link.is_empty() || busy, cx).child("Use this set").when(!link.is_empty() && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        view.busy = true;
                        view.set_emotes(link.clone(), "Now using", cx);
                    }))
                }))
                .into_any_element(),
            grid.into_any_element(),
        ]
    }

    pub(super) fn set_emotes(&mut self, set: String, verb: &'static str, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "setEmoteSet", vec![json!(set)]);
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.refreshing = false;
                match result {
                    Ok(value) => {
                        let name = value.get("set_name").and_then(|name| name.as_str()).unwrap_or_default().to_string();
                        let count = value.get("count").and_then(|count| count.as_f64()).unwrap_or(0.);
                        if verb == "Now using" {
                            view.emote_link.update(cx, |input, cx| input.set_text("", cx));
                        }
                        view.state.update(cx, |state, cx| state.toast(format!("{verb} {name} ({} emotes)", count as u64), ToastKind::Info, cx));
                    }
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn storage(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let max: f64 = self.max_upload.read(cx).text().trim().parse().unwrap_or(0.);
        let keep: f64 = self.retention.read(cx).text().trim().parse().unwrap_or(-1.);
        let valid = max >= 1. && keep >= 0.;
        let busy = self.busy;
        let theme = theme(cx);
        let suffix = |text: &str| div().text_size(px(13.)).text_color(theme.text3).child(text.to_string()).into_any_element();
        vec![
            Self::heading("Storage"),
            field(Some("Largest file members can send"), self.max_upload.clone(), None, None, false, Some(suffix("MB")), cx).into_any_element(),
            field(
                Some("Delete messages after"),
                self.retention.clone(),
                None,
                Some("0 keeps messages forever. Pinned messages are kept. This is enforced by the server, so it only removes the server's copy.".into()),
                false,
                Some(suffix("days")),
                cx,
            )
            .into_any_element(),
            div()
                .flex()
                .child(button("save-storage", ButtonKind::Primary, ButtonSize::Normal, !valid || busy, cx).child("Save changes").when(valid && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "max_upload_mb": max, "retention_days": keep })], Some("Saved".into()), cx)))
                }))
                .into_any_element(),
        ]
    }
}

#[cfg(test)]
mod tests {
    //! The server's invites and emote set, and this person's profile, from their settings.

    use gpui::TestAppContext;
    use serde_json::{Value, json};

    use super::*;
    use crate::state::Overlay;
    use crate::testing::fixtures::*;
    use crate::testing::{App as Running, World, refused};

    fn open(cx: &mut TestAppContext, name: &str, overlay: Overlay) -> Running {
        let mut world = World::new(name);
        world.server["getCalls"] = json!([]);
        world.server["invites"][0]["expiresAt"] = json!(NOW + 86_400_000.0 * 3.0);
        let app = Running::open(cx, &world);
        app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.select_server(SERVER, cx);
            state.set_overlay(Some(overlay), cx);
        });
        app
    }

    fn settings(app: &Running, cx: &mut TestAppContext) -> Entity<ServerSettings> {
        app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<ServerSettings>().ok())).unwrap().expect("the server's settings are open")
    }

    fn pick(app: &Running, cx: &mut TestAppContext, select: &str, entry: usize) {
        app.click(cx, select);
        let label = cx.read(|cx| crate::ui::menu::open_labels(cx))[entry].clone();
        assert!(app.window.update(cx, |_, window, cx| crate::ui::menu::choose(&label, window, cx)).unwrap());
        app.run(cx);
    }

    #[gpui::test]
    fn invites_are_made_copied_and_revoked(cx: &mut TestAppContext) {
        let app = open(cx, "invite-settings", Overlay::ServerSettings { section: Some("invites".into()) });
        app.answer("createInvite", |_| Ok(json!("https://server-1.example/invite/new")));
        app.answer("linkForInvite", |_| Ok(json!("https://server-1.example/invite/abc")));
        app.answer("revokeInvite", |_| Ok(Value::Null));
        pick(&app, cx, "invite-expiry", 0);
        pick(&app, cx, "invite-uses", 0);
        app.click(cx, "create-invite");
        let made = &app.calls_of("createInvite")[0];
        assert_eq!(made.len(), 2);
        assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("https://server-1.example/invite/new"), "copied as it's made");
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(String::new()));
        app.click(cx, "copy-invite");
        assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("https://server-1.example/invite/new"));
        app.click(cx, "copy-abc");
        assert_eq!(app.calls_of("linkForInvite"), vec![vec![json!("abc")]]);
        app.click(cx, "revoke-abc");
        assert_eq!(app.calls_of("revokeInvite"), vec![vec![json!("abc")]]);
        app.answer("createInvite", |_| Err(refused("Too many invites.")));
        app.click(cx, "create-invite");
        assert!(app.toasts(cx).contains(&"Too many invites.".to_string()));
    }

    #[gpui::test]
    fn a_new_emote_set_and_the_one_in_use_refreshed(cx: &mut TestAppContext) {
        let app = open(cx, "emote-settings", Overlay::ServerSettings { section: Some("emotes".into()) });
        app.answer("setEmoteSet", |args| if args[0] == "bad" { Err(refused("That isn't a 7TV set.")) } else { Ok(json!({ "set_name": "Fresh", "count": 12 })) });
        let view = settings(&app, cx);
        let link = cx.read(|cx| view.read(cx).emote_link.clone());
        link.update(cx, |input, cx| input.set_text("https://7tv.app/emote-sets/01NEWSET", cx));
        app.run(cx);
        app.click(cx, "use-set");
        assert!(app.toasts(cx).contains(&"Now using Fresh (12 emotes)".to_string()));
        assert_eq!(cx.read(|cx| link.read(cx).text().to_string()), "", "the link emptied once it's used");
        app.click(cx, "refresh-emotes");
        assert_eq!(app.calls_of("setEmoteSet").last().unwrap(), &vec![json!("set")], "the set in use, read again");
        link.update(cx, |input, cx| input.set_text("bad", cx));
        app.run(cx);
        app.click(cx, "use-set");
        assert!(app.toasts(cx).contains(&"That isn't a 7TV set.".to_string()));
    }

    #[gpui::test]
    fn a_profile_is_saved_and_its_picture_taken_off(cx: &mut TestAppContext) {
        let mut world = World::new("profile-settings");
        world.server["getCalls"] = json!([]);
        world.server["getUsers"][0]["avatar"] = json!({ "fileId": "a".repeat(32), "key": "k", "prefix": "p", "chunks": 1, "mime": "image/png" });
        let app = Running::open(cx, &world);
        app.answer("updateProfile", |args| if args[0]["displayName"] == "" { Err(refused("A name is needed.")) } else { Ok(Value::Null) });
        app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.select_server(SERVER, cx);
            state.set_overlay(Some(Overlay::Settings { section: Some("profile".into()) }), cx);
        });
        let view = app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<crate::ui::settings::SettingsView>().ok())).unwrap().expect("Settings are open");
        let (name, bio) = cx.read(|cx| view.read(cx).profile_fields());
        name.update(cx, |input, cx| input.set_text("Alice A.", cx));
        bio.update(cx, |input, cx| input.set_text("Still me", cx));
        app.run(cx);
        app.click(cx, "save-profile");
        assert_eq!(app.calls_of("updateProfile")[0], vec![json!({ "displayName": "Alice A.", "bio": "Still me" })]);
        app.click(cx, "remove-avatar");
        assert_eq!(app.calls_of("updateProfile")[1], vec![json!({}), Value::Null]);
    }
}
