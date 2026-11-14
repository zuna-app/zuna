//! The Telegram account linked on this device (docs/TELEGRAM_PLAN.md): linking it, which its
//! dialog follows step by step, and unlinking it. Once linked it's a rail icon like a server's,
//! under the server ID `telegram`, whose session answers the same calls.

use super::*;
use crate::telegram::SERVER_ID;

impl AppState {
    /// Whether this build can link an account, and none is linked yet.
    pub fn can_link_telegram(&self) -> bool {
        crate::telegram::available() && !self.servers.contains_key(SERVER_ID)
    }

    /// Starts linking, from the dialog's first screen: the engine starts, and the steps come as events.
    pub fn link_telegram(&mut self, cx: &mut Context<Self>) {
        self.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            if let Err(error) = core.call(None, "linkTelegram", vec![]).await {
                this.update(cx, |state, cx| {
                    state.telegram_link = Some(TelegramLink { step: "failed".into(), reason: error.message, ..Default::default() });
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    /// Starts linking over from nothing: TDLib takes no phone number once it has shown a QR code,
    /// so moving from the code to a number begins again, with nothing linked to lose.
    pub fn restart_telegram_link(&mut self, cx: &mut Context<Self>) {
        self.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            core.call(None, "unlinkTelegram", vec![]).await.ok();
            let linked = core.call(None, "linkTelegram", vec![]).await;
            this.update(cx, |state, cx| {
                if let Err(error) = linked {
                    state.telegram_link = Some(TelegramLink { step: "failed".into(), reason: error.message, ..Default::default() });
                } else if state.telegram_link.as_ref().is_none_or(|link| link.step == "unlinked") {
                    state.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Unlinks the account: it's signed out at Telegram if it can be, and everything of it here is
    /// erased either way. Also what cancelling a link half done does.
    pub fn unlink_telegram(&mut self, cx: &mut Context<Self>) {
        let core = self.core.clone();
        let linked = self.servers.contains_key(SERVER_ID);
        cx.spawn(async move |this, cx| {
            let result = core.call(None, "unlinkTelegram", vec![]).await;
            this.update(cx, |state, cx| {
                if state.servers.contains_key(SERVER_ID) {
                    state.remove_server(SERVER_ID, cx);
                }
                state.telegram_link = None;
                match result {
                    Ok(value) if linked && value.get("signedOut").and_then(Value::as_bool) != Some(true) => state.toast(
                        "Telegram was unlinked from this device, but Zuna couldn't tell Telegram. End Zuna's session in Telegram's app, under Devices.",
                        ToastKind::Info,
                        cx,
                    ),
                    Ok(_) => {}
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Deletes a Telegram message for everyone where Telegram allows it, and otherwise for this
    /// account alone, saying so.
    pub fn delete_telegram_message(&mut self, group: String, id: String, cx: &mut Context<Self>) {
        let core = self.core.clone();
        // Saved messages are the account's alone, so there are no others to keep a message for.
        let saved = self.servers.get(SERVER_ID).is_some_and(|server| server.self_id() == group);
        cx.spawn(async move |this, cx| {
            let choices = core.call(Some(SERVER_ID), "deleteChoices", vec![json!(group), json!(id)]).await.unwrap_or_default();
            let everyone = choices.get("forEveryone").and_then(Value::as_bool) == Some(true);
            let alone = choices.get("forSelf").and_then(Value::as_bool) == Some(true);
            let result = if everyone || alone { Some(core.call(Some(SERVER_ID), "deleteMessages", vec![json!(group), json!([id]), json!(everyone)]).await) } else { None };
            this.update(cx, |state, cx| match result {
                None => state.toast("Telegram doesn't let this message be deleted.", ToastKind::Info, cx),
                Some(Err(error)) => state.toast(error.message, ToastKind::Error, cx),
                Some(Ok(_)) if !everyone && !saved => state.toast("Deleted only for you. Others in the chat can still see it.", ToastKind::Info, cx),
                Some(Ok(_)) => {}
            })
            .ok();
        })
        .detach();
    }

    /// Presses a bot's button in a Telegram chat, and shows what the bot answers, if anything.
    pub fn press_telegram_button(&mut self, group: String, message: String, row: usize, column: usize, cx: &mut Context<Self>) {
        let call = self.core.call(Some(SERVER_ID), "pressButton", vec![json!(group), json!(message), json!(row), json!(column)]);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |state, cx| match result {
                Ok(Value::String(answer)) if !answer.is_empty() => state.toast(answer, ToastKind::Info, cx),
                Ok(_) => {}
                Err(error) => state.toast(error.message, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Joins a Telegram group by a link to it, and opens it.
    pub fn join_telegram_group(&mut self, link: String, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let call = self.core.call(Some(SERVER_ID), "joinByLink", vec![json!(link)]);
        cx.spawn(async move |this, cx| {
            let chat = call.await.map_err(|error| error.message)?;
            let chat = chat.as_str().unwrap_or_default().to_string();
            this.update(cx, |state, cx| {
                state.select_server(SERVER_ID, cx);
                state.select_conversation(Some(format!("group:{chat}")), cx);
                state.set_overlay(None, cx);
            })
            .ok();
            Ok(())
        })
    }

    /// Keeps what's written in a Telegram chat as its draft there, which the account's other devices show.
    /// Telegram is told once typing pauses, of what's written then.
    pub fn save_telegram_draft(&mut self, key: String, cx: &mut Context<Self>) {
        self.debounced(format!("telegram-draft:{key}"), 1500, cx, move |state, cx| {
            let text = state.drafts.get(&key).cloned().unwrap_or_default();
            let call = state.core.call(Some(SERVER_ID), "saveDraft", vec![json!(key), json!(text)]);
            cx.spawn(async move |_, _| {
                call.await.ok();
            })
            .detach();
        });
    }

    /// Takes Telegram's draft for a chat that has none here, as written on another device.
    pub fn load_telegram_draft(&mut self, key: String, cx: &mut Context<Self>) -> Task<Option<String>> {
        let call = (!self.drafts.contains_key(&key)).then(|| self.core.call(Some(SERVER_ID), "getDraft", vec![json!(key)]));
        cx.spawn(async move |_, _| {
            let text = call?.await.ok()?.as_str()?.to_string();
            (!text.is_empty()).then_some(text)
        })
    }

    /// A step of linking, or the account's going.
    pub(super) fn telegram_moved(&mut self, link: TelegramLink, cx: &mut Context<Self>) {
        match link.step.as_str() {
            "ready" => {
                self.telegram_link = None;
                if !self.servers.contains_key(SERVER_ID) {
                    // Linked just now, in its dialog, which closing before then cancels, or only
                    // ready again as the app starts, which mustn't take the person there.
                    let linked_now = matches!(self.overlay, Some(Overlay::Telegram));
                    self.add_server(SERVER_ID.into(), linked_now, cx);
                }
            }
            "unlinked" => {
                // Ended from another device, or unlinked here: what it held is gone. A link begun
                // over, from the QR code to a phone number, has nothing in the rail to take away.
                if self.servers.contains_key(SERVER_ID) {
                    if self.telegram_link.is_none() && !matches!(self.overlay, Some(Overlay::Telegram)) {
                        self.toast("Your Telegram session was ended, so Telegram was unlinked from this device.", ToastKind::Info, cx);
                    }
                    self.remove_server(SERVER_ID, cx);
                }
                self.telegram_link = None;
            }
            // While it's being linked, the dialog follows. Once it is, a step here means it
            // stopped working, which its rail shows.
            _ if self.servers.contains_key(SERVER_ID) => {
                if link.step == "failed" {
                    self.toast(link.reason.clone(), ToastKind::Error, cx);
                }
            }
            _ => self.telegram_link = Some(link),
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    //! The linked Telegram account as the state keeps it: each step of linking, the account
    //! joining the rail and leaving it, and what's done in its chats that the core answers.

    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    use gpui::TestAppContext;
    use serde_json::{Value, json};

    use super::SERVER_ID;
    use crate::testing::{App, World, refused};

    fn entry() -> Value {
        json!({ "id": SERVER_ID, "kind": "telegram", "name": "Telegram", "username": "alice", "userId": "tg-me" })
    }

    /// The fixtures' world with an account linked, or not.
    fn world(name: &str, linked: bool) -> World {
        let mut world = World::new(name);
        if linked {
            world.client["listServers"].as_array_mut().unwrap().push(entry());
        }
        world
    }

    fn step(app: &App, cx: &mut TestAppContext, link: Value) {
        app.event(cx, json!({ "type": "telegram", "link": link }));
    }

    fn linking(app: &App, cx: &mut TestAppContext) -> Option<String> {
        app.read(cx, |state| state.telegram_link.as_ref().map(|link| link.step.clone()))
    }

    #[gpui::test]
    fn linking_follows_each_step_into_the_rail_and_out_again(cx: &mut TestAppContext) {
        let app = App::open(cx, &world("telegram-linking", false));
        assert_eq!(app.read(cx, |state| state.can_link_telegram()), crate::telegram::available());
        app.answer("linkTelegram", |_| Err(refused("Telegram's engine is missing.")));
        app.update(cx, |state, cx| state.link_telegram(cx));
        assert_eq!(linking(&app, cx).as_deref(), Some("failed"));
        assert_eq!(app.read(cx, |state| state.telegram_link.as_ref().unwrap().reason.clone()), "Telegram's engine is missing.");

        app.answer("linkTelegram", |_| Ok(Value::Null));
        app.answer("unlinkTelegram", |_| Ok(json!({ "signedOut": true })));
        app.update(cx, |state, cx| state.link_telegram(cx));
        assert_eq!(linking(&app, cx).as_deref(), Some("starting"));
        step(&app, cx, json!({ "step": "code", "via": "telegram", "length": 5 }));
        assert_eq!(linking(&app, cx).as_deref(), Some("code"));
        // Begun over, as from the QR code to a phone number: unlinked, then linked again.
        app.forget_calls();
        app.update(cx, |state, cx| state.restart_telegram_link(cx));
        let order: Vec<String> = app.calls().into_iter().map(|call| call.method).filter(|method| method.ends_with("Telegram")).collect();
        assert_eq!(order, vec!["unlinkTelegram", "linkTelegram"]);
        assert_eq!(linking(&app, cx).as_deref(), Some("starting"));
        step(&app, cx, json!({ "step": "unlinked" }));
        assert_eq!(linking(&app, cx), None, "nothing in the rail to take away");
        app.answer("linkTelegram", |_| Err(refused("No network.")));
        app.update(cx, |state, cx| state.restart_telegram_link(cx));
        assert_eq!(linking(&app, cx).as_deref(), Some("failed"));

        // Ready, in its dialog: it joins the rail and is shown, as a server joined is.
        let mut servers = World::new("telegram-linking").client["listServers"].clone();
        servers.as_array_mut().unwrap().push(entry());
        app.answer("listServers", move |_| Ok(servers.clone()));
        app.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Telegram), cx));
        step(&app, cx, json!({ "step": "ready" }));
        assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
        assert_eq!(linking(&app, cx), None);
        assert!(app.read(cx, |state| state.servers.contains_key(SERVER_ID) && state.active_server.as_deref() == Some(SERVER_ID)));
        assert!(!app.read(cx, |state| state.can_link_telegram()), "one account at a time");
        // A step once it's linked means it stopped working.
        step(&app, cx, json!({ "step": "failed", "reason": "Telegram can't be reached." }));
        assert!(app.toasts(cx).contains(&"Telegram can't be reached.".to_string()));
        assert_eq!(linking(&app, cx), None, "the dialog isn't brought back for it");
        step(&app, cx, json!({ "step": "starting" }));
        // Ended from another device.
        step(&app, cx, json!({ "step": "unlinked" }));
        assert!(!app.read(cx, |state| state.servers.contains_key(SERVER_ID)));
        assert!(app.toasts(cx).contains(&"Your Telegram session was ended, so Telegram was unlinked from this device.".to_string()));
    }

    /// The app as it starts with an account linked before: its engine says it's ready a moment
    /// after the servers are shown.
    fn started_before_telegram(cx: &mut TestAppContext, name: &str) -> App {
        let app = App::open(cx, &world(name, false));
        let mut servers = World::new(name).client["listServers"].clone();
        servers.as_array_mut().unwrap().push(entry());
        app.answer("listServers", move |_| Ok(servers.clone()));
        app
    }

    #[gpui::test]
    fn ready_as_the_app_starts_leaves_the_person_where_they_are(cx: &mut TestAppContext) {
        // It once took them to Telegram each time the app started, and kept that as where they'd been.
        let app = started_before_telegram(cx, "telegram-starting");
        let shown = app.read(cx, |state| state.active_server.clone());
        assert!(shown.is_some());
        step(&app, cx, json!({ "step": "starting" }));
        step(&app, cx, json!({ "step": "ready" }));
        assert!(app.read(cx, |state| state.servers.contains_key(SERVER_ID)), "it's in the rail");
        assert_eq!(app.read(cx, |state| state.active_server.clone()), shown);
        assert_eq!(app.read(cx, |state| state.settings.last_server.clone()), None);
    }

    #[gpui::test]
    fn ready_as_the_app_starts_opens_it_where_it_was_shown_last(cx: &mut TestAppContext) {
        let app = started_before_telegram(cx, "telegram-shown-last");
        app.update(cx, |state, _| state.settings.last_server = Some(SERVER_ID.into()));
        step(&app, cx, json!({ "step": "starting" }));
        step(&app, cx, json!({ "step": "ready" }));
        assert_eq!(app.read(cx, |state| state.active_server.clone()).as_deref(), Some(SERVER_ID));
    }

    #[gpui::test]
    fn unlinking_says_when_telegram_couldnt_be_told(cx: &mut TestAppContext) {
        let app = App::open(cx, &world("telegram-unlinking", true));
        assert!(app.read(cx, |state| state.servers.contains_key(SERVER_ID)));
        app.answer("unlinkTelegram", |_| Ok(json!({ "signedOut": false })));
        app.update(cx, |state, cx| state.unlink_telegram(cx));
        assert!(!app.read(cx, |state| state.servers.contains_key(SERVER_ID)), "erased here either way");
        assert!(app.toasts(cx).iter().any(|toast| toast.starts_with("Telegram was unlinked from this device, but Zuna couldn't tell Telegram.")));
        app.answer("unlinkTelegram", |_| Err(refused("The engine stopped.")));
        app.update(cx, |state, cx| state.unlink_telegram(cx));
        assert!(app.toasts(cx).contains(&"The engine stopped.".to_string()));
    }

    #[gpui::test]
    fn what_is_done_in_telegrams_chats_says_what_telegram_allowed(cx: &mut TestAppContext) {
        let app = App::open(cx, &world("telegram-chats", true));
        app.update(cx, |state, _| state.toasts.clear());
        let delete = |cx: &mut TestAppContext, choices: Value| {
            app.answer("deleteChoices", move |_| Ok(choices.clone()));
            app.update(cx, |state, cx| state.delete_telegram_message("chat-1".into(), "m-1".into(), cx));
        };
        app.answer("deleteMessages", |_| Ok(Value::Null));
        delete(cx, json!({ "forEveryone": true, "forSelf": true }));
        assert_eq!(app.calls_of("deleteMessages"), vec![vec![json!("chat-1"), json!(["m-1"]), json!(true)]]);
        assert!(app.toasts(cx).is_empty(), "for everyone, nothing to say");
        delete(cx, json!({ "forSelf": true }));
        assert_eq!(app.calls_of("deleteMessages")[1][2], json!(false));
        assert_eq!(app.toasts(cx).last().unwrap(), "Deleted only for you. Others in the chat can still see it.");
        delete(cx, json!({}));
        assert_eq!(app.toasts(cx).last().unwrap(), "Telegram doesn't let this message be deleted.");
        app.answer("deleteMessages", |_| Err(refused("MESSAGE_DELETE_FORBIDDEN")));
        delete(cx, json!({ "forEveryone": true }));
        assert_eq!(app.toasts(cx).last().unwrap(), "MESSAGE_DELETE_FORBIDDEN");

        // A bot's button, and what the bot answers.
        for (answer, toast) in [(Ok(json!("Done!")), Some("Done!")), (Ok(json!("")), None), (Err(refused("BOT_RESPONSE_TIMEOUT")), Some("BOT_RESPONSE_TIMEOUT"))] {
            app.update(cx, |state, _| state.toasts.clear());
            let answer = RefCell::new(Some(answer));
            app.answer("pressButton", move |_| answer.borrow_mut().take().unwrap());
            app.update(cx, |state, cx| state.press_telegram_button("chat-1".into(), "m-2".into(), 1, 2, cx));
            assert_eq!(app.toasts(cx).first().map(String::as_str), toast);
        }
        assert_eq!(app.calls_of("pressButton")[0], vec![json!("chat-1"), json!("m-2"), json!(1), json!(2)]);

        // A group joined by its link opens.
        let joined = Rc::new(RefCell::new(Vec::new()));
        let join = |cx: &mut TestAppContext, link: &str| {
            let task = app.state.update(cx, |state, cx| state.join_telegram_group(link.into(), cx));
            let joined = joined.clone();
            cx.update(|cx| cx.spawn(async move |_| joined.borrow_mut().push(task.await)).detach());
            app.run(cx);
        };
        app.answer("joinByLink", |args| if args[0] == "bad" { Err(refused("INVITE_HASH_INVALID")) } else { Ok(json!("777")) });
        join(cx, "https://t.me/+abc");
        join(cx, "bad");
        assert_eq!(*joined.borrow(), vec![Ok(()), Err("INVITE_HASH_INVALID".to_string())]);
        assert_eq!(app.read(cx, |state| (state.active_server.clone(), state.servers[SERVER_ID].active_key.clone())), (Some(SERVER_ID.into()), Some("group:777".into())));

        // A draft goes to Telegram once typing pauses, and one from another device comes back.
        let key = "group:777".to_string();
        app.update(cx, |state, cx| {
            state.drafts.insert(key.clone(), "half written".into());
            state.save_telegram_draft(key.clone(), cx);
            state.save_telegram_draft(key.clone(), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(1600));
        cx.run_until_parked();
        assert_eq!(app.calls_of("saveDraft"), vec![vec![json!(key), json!("half written")]], "once, as it paused");
        let loaded = Rc::new(RefCell::new(Vec::new()));
        app.answer("getDraft", |args| Ok(json!(if args[0] == "group:888" { "from my phone" } else { "" })));
        for key in ["group:777", "group:888", "group:999"] {
            let task = app.state.update(cx, |state, cx| state.load_telegram_draft(key.into(), cx));
            let loaded = loaded.clone();
            cx.update(|cx| cx.spawn(async move |_| loaded.borrow_mut().push(task.await)).detach());
            cx.run_until_parked();
        }
        assert_eq!(*loaded.borrow(), vec![None, Some("from my phone".to_string()), None], "one written here stays, and an empty one is none");
        assert_eq!(app.calls_of("getDraft").len(), 2);
    }
}
