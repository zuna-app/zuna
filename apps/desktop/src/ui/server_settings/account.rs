//! Deleting this account, and leaving the server.

use super::*;

impl ServerSettings {
    /// Asks before deleting the account, as `DeleteAccountSection` does.
    pub(super) fn delete_confirm(&mut self, server_name: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.deleting {
            return None;
        }
        let (cancel, delete) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(crate::ui::overlays::confirm(
            format!("Delete your account on {server_name}?"),
            "Delete account",
            "It can't be undone. Messages you sent stay with the people you sent them to, shown as from \"Deleted account\".".into(),
            move |_, cx| {
                cancel
                    .update(cx, |view, cx| {
                        view.deleting = false;
                        cx.notify();
                    })
                    .ok();
            },
            move |_, cx| {
                delete.update(cx, |view, cx| view.delete_account(cx)).ok();
            },
            cx,
        ))
    }

    /// Deletes the account on this server, and everything this device keeps for it.
    pub(super) fn delete_account(&mut self, cx: &mut Context<Self>) {
        self.deleting = false;
        let Some(id) = self.state.read(cx).active_server.clone() else { return };
        let password = self.delete_password.read(cx).text().to_string();
        let call = self.state.read(cx).core.call(None, "deleteAccount", vec![json!(id), json!(password)]);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.state.update(cx, |state, cx| match result {
                    Ok(_) => {
                        state.set_overlay(None, cx);
                        state.remove_server(&id, cx);
                    }
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn delete_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let name = &server.entry.name;
        // A server can't be without its owner, whom nobody else can become.
        if server.me.as_ref().is_some_and(|me| me.role == "owner") {
            return vec![
                Self::heading("Delete account"),
                Self::lead(&format!("You own {name}, and a server can't exist without its owner, so you can't delete your account there. To remove everything, shut down the server and delete its data."), cx),
            ];
        }
        let typed = !self.delete_password.read(cx).text().is_empty();
        let busy = self.busy;
        vec![
            Self::heading("Delete account"),
            Self::lead(
                &format!("This deletes your account on {name}, with your profile and keys, signs out your other devices, and erases this device's copy of your messages. Messages you sent stay with the people you sent them to, shown as from \"Deleted account\". Someone else will be able to take your username. It can't be undone."),
                cx,
            ),
            field(Some("Password"), self.delete_password.clone(), None, None, false, None, cx).into_any_element(),
            div()
                .flex()
                .child(
                    button("delete-account", ButtonKind::Danger, ButtonSize::Normal, !typed || busy, cx)
                        .when(busy, |el| el.child(spinner(15., theme.red)))
                        .when(!busy, |el| el.child(icon("trash", 15., theme.red)).child("Delete my account"))
                        .when(typed && !busy, |el| {
                            el.on_click(cx.listener(|view, _, window, cx| {
                                view.deleting = true;
                                window.focus(&view.focus, cx);
                                cx.notify();
                            }))
                        }),
                )
                .into_any_element(),
        ]
    }

    pub(super) fn leave(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let busy = self.busy;
        let id = server.entry.id.clone();
        vec![
            Self::heading("Sign out"),
            div()
                .text_size(px(13.5))
                .text_color(theme.text2)
                .child(format!(
                    "This signs you out of {} on this device and erases its local copy of your messages. Your account and history stay on the server, and you can sign back in with your password.",
                    server.entry.name
                ))
                .into_any_element(),
            div()
                .flex()
                .child(button("sign-out-server", ButtonKind::Danger, ButtonSize::Normal, busy, cx).child(icon("log-out", 15., theme.red)).child("Sign out and erase local data").when(!busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        view.busy = true;
                        let id = id.clone();
                        let call = view.state.read(cx).core.call(None, "leaveServer", vec![json!(id)]);
                        cx.spawn(async move |view, cx| {
                            let result = call.await;
                            view.update(cx, |view, cx| {
                                view.busy = false;
                                view.state.update(cx, |state, cx| match result {
                                    Ok(_) => {
                                        state.set_overlay(None, cx);
                                        state.remove_server(&id, cx);
                                    }
                                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                });
                            })
                            .ok();
                        })
                        .detach();
                    }))
                }))
                .into_any_element(),
        ]
    }
}

#[cfg(test)]
mod tests {
    //! Deleting this account on a server, asked about first, and signing out of one.

    use gpui::TestAppContext;
    use serde_json::{Value, json};

    use super::*;
    use crate::state::Overlay;
    use crate::testing::fixtures::*;
    use crate::testing::{App as Running, World, refused};

    fn open(cx: &mut TestAppContext, name: &str, section: &str, role: &str) -> Running {
        let mut world = World::new(name);
        world.server["getCalls"] = json!([]);
        world.server["getSelf"]["role"] = json!(role);
        let app = Running::open(cx, &world);
        app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.select_server(SERVER, cx);
            state.set_overlay(Some(Overlay::ServerSettings { section: Some(section.into()) }), cx);
        });
        app
    }

    fn settings(app: &Running, cx: &mut TestAppContext) -> Entity<ServerSettings> {
        app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<ServerSettings>().ok())).unwrap().expect("the server's settings are open")
    }

    #[gpui::test]
    fn an_account_is_deleted_only_once_asked_and_never_its_owners(cx: &mut TestAppContext) {
        let app = open(cx, "delete-account", "delete", "member");
        app.answer("deleteAccount", |args| if args[1] == "wrong" { Err(refused("That isn't your password.")) } else { Ok(Value::Null) });
        let view = settings(&app, cx);
        let password = cx.read(|cx| view.read(cx).delete_password.clone());
        password.update(cx, |input, cx| input.set_text("wrong", cx));
        app.run(cx);
        app.click(cx, "delete-account");
        app.click(cx, "confirm-cancel");
        assert!(app.calls_of("deleteAccount").is_empty());
        app.click(cx, "delete-account");
        app.click(cx, "confirm-action");
        assert!(app.toasts(cx).contains(&"That isn't your password.".to_string()));
        password.update(cx, |input, cx| input.set_text("right", cx));
        app.run(cx);
        app.click(cx, "delete-account");
        app.click(cx, "confirm-action");
        assert_eq!(app.calls_of("deleteAccount").last().unwrap(), &vec![json!(SERVER), json!("right")]);
        assert!(app.read(cx, |state| !state.servers.contains_key(SERVER) && state.overlay.is_none()));
        // A server's owner is told why there's nothing to delete.
        let app = open(cx, "delete-owner", "delete", "owner");
        assert!(!app.drawn(cx, "delete-account"));
    }

    #[gpui::test]
    fn signing_out_of_a_server_erases_it_here(cx: &mut TestAppContext) {
        let app = open(cx, "leave-server", "leave", "member");
        app.answer("leaveServer", |_| Err(refused("Not now.")));
        app.click(cx, "sign-out-server");
        assert!(app.toasts(cx).contains(&"Not now.".to_string()));
        assert!(app.read(cx, |state| state.servers.contains_key(SERVER)));
        app.answer("leaveServer", |_| Ok(Value::Null));
        app.click(cx, "sign-out-server");
        assert_eq!(app.calls_of("leaveServer").last().unwrap(), &vec![json!(SERVER)]);
        assert!(app.read(cx, |state| !state.servers.contains_key(SERVER)));
    }
}
