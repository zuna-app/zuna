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
            "It can't be undone. What you sent stays with the people you sent it to, from \"Deleted account\".".into(),
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
                Self::lead(&format!("You own {name}, and a server can't be without its owner, so your account there can't be deleted. Stopping the server and deleting its data removes everything on it."), cx),
            ];
        }
        let typed = !self.delete_password.read(cx).text().is_empty();
        let busy = self.busy;
        vec![
            Self::heading("Delete account"),
            Self::lead(
                &format!("This deletes your account on {name}, with your profile and keys, signs out your other devices, and erases this device's copy of your messages. What you sent stays with the people you sent it to, from \"Deleted account\". Your username becomes free for someone else. It can't be undone."),
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
