//! A server's bots, in its settings: making one, the link its program is set up with, what it
//! may do, the channels it's given, and taking it away (`BotsSection.tsx`). A bot is its
//! owner's, and a listed one is also the server's admins' to give channels to or delete.

use std::rc::Rc;

use gpui::Focusable as _;
use serde_json::Value;

use super::*;
use crate::models::BotView;

/// Who may add a bot to groups: what the server calls each, and what people are told.
const ADD: [(&str, &str); 3] = [("owner", "Only its owner"), ("admins", "Its owner and the server's admins"), ("anyone", "Anyone on the server")];

/// What an owner is told once a change to a bot's profile is on its way.
const SENT: &str = "Sent to the bot, which sets it when it's running";

/// Whether a bot may have this username, as the server checks it.
fn username_ok(name: &str) -> bool {
    let mut letters = name.chars();
    let first = letters.next().is_some_and(|letter| letter.is_ascii_alphanumeric() || letter == '_');
    first && (2..=32).contains(&name.chars().count()) && letters.all(|letter| letter.is_ascii_alphanumeric() || matches!(letter, '_' | '.' | '-'))
}

/// A line of small print under a setting (`.setting-hint`).
fn hint(text: &'static str, cx: &gpui::App) -> gpui::Div {
    div().text_size(px(12.5)).text_color(theme(cx).text3).child(text)
}

/// The box a form or a bot's settings sit in (`.bot-settings`, `.bot-form`, `.bot-setup`).
fn card(cx: &gpui::App) -> gpui::Div {
    let theme = theme(cx);
    div().flex().flex_col().gap(px(12.)).p(px(14.)).rounded(RADIUS_M).bg(theme.bg2).border_1().border_color(theme.line)
}

/// Who can add a bot to groups, as a choice among the three.
fn add_select(id: &'static str, current: &str, on_change: Rc<dyn Fn(&'static str, &mut gpui::App)>, cx: &gpui::App) -> AnyElement {
    let label = ADD.iter().find(|(value, _)| *value == current).map(|(_, label)| *label).unwrap_or("");
    let choices = ADD
        .iter()
        .map(|(value, label)| {
            let (value, on_change) = (*value, on_change.clone());
            (label.to_string(), Rc::new(move |_: &mut Window, cx: &mut gpui::App| on_change(value, cx)) as Rc<dyn Fn(&mut Window, &mut gpui::App)>)
        })
        .collect();
    div().w(px(250.)).flex_none().child(select_box(id, label, choices, cx)).into_any_element()
}

/// A bot being made: what's typed and chosen for it so far.
struct NewBot {
    name: Entity<TextInput>,
    username: Entity<TextInput>,
    listed: bool,
    add: String,
    files: bool,
}

pub struct ServerBots {
    state: Entity<AppState>,
    /// The bots this person may manage, or nothing while they're read.
    bots: Option<Vec<BotView>>,
    /// What the server's users said of its bots when they were last read.
    known: String,
    creating: Option<NewBot>,
    /// A setup link just made, which is shown this once.
    link: Option<String>,
    /// The bot whose settings are open, with its name and what it's about as typed.
    open: Option<(String, Entity<TextInput>, Entity<TextInput>)>,
    /// A bot that deleting is being asked about.
    deleting: Option<String>,
    busy: bool,
    _subscriptions: Vec<Subscription>,
}

impl ServerBots {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.observe(&state, |view: &mut Self, _, cx| {
            // Read again whenever a bot is set up, changed or gone, from here or anywhere else.
            let known = view.known_bots(cx);
            if known != view.known {
                view.known = known;
                view.load(cx);
            }
            cx.notify();
        })];
        let mut view = ServerBots { state, bots: None, known: String::new(), creating: None, link: None, open: None, deleting: None, busy: false, _subscriptions: subscriptions };
        view.known = view.known_bots(cx);
        view.load(cx);
        view
    }

    fn known_bots(&self, cx: &gpui::App) -> String {
        let Some(server) = self.state.read(cx).active() else { return String::new() };
        let mut known: Vec<String> = server.users.values().filter_map(|user| user.bot.as_ref().map(|bot| format!("{}:{}:{}:{}", user.id, user.deleted, bot.listed, bot.add))).collect();
        known.sort();
        known.join(",")
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "getBots", vec![]);
        cx.spawn(async move |view, cx| {
            let found: Vec<BotView> = call.await.ok().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
            view.update(cx, |view, cx| {
                view.bots = Some(found);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Calls the server's session, with a toast if it fails, and `then` with its answer if it doesn't.
    fn call(&mut self, method: &'static str, args: Vec<Value>, then: impl FnOnce(&mut Self, Value, &mut Context<Self>) + 'static, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), method, args);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok(value) => then(view, value, cx),
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn say(&mut self, text: &'static str, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.toast(text, ToastKind::Info, cx));
    }

    fn start_creating(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| TextInput::new(cx, "Weather"));
        let username = cx.new(|cx| TextInput::new(cx, "weather"));
        for input in [&name, &username] {
            cx.subscribe(input, |view, _, event: &InputEvent, cx| {
                match event {
                    InputEvent::Submit => view.create(cx),
                    InputEvent::Escape => view.creating = None,
                    _ => {}
                }
                cx.notify();
            })
            .detach();
        }
        name.focus_handle(cx).focus(window, cx);
        self.creating = Some(NewBot { name, username, listed: false, add: "owner".into(), files: true });
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let Some(form) = &self.creating else { return };
        let name: String = form.name.read(cx).text().trim().chars().take(64).collect();
        let username = form.username.read(cx).text().trim().to_string();
        if name.is_empty() || !username_ok(&username) || self.busy {
            return;
        }
        // Who may add it is only a listed bot's to say. A private one is its owner's alone.
        let made = json!({ "username": username, "name": name, "listed": form.listed, "add": if form.listed { form.add.as_str() } else { "owner" }, "files": form.files });
        self.call(
            "createBot",
            vec![made],
            |view, made, cx| {
                view.creating = None;
                view.link = made.get("link").and_then(Value::as_str).map(str::to_string);
                view.load(cx);
            },
            cx,
        );
    }

    /// Opens a bot's settings under its row, or closes them.
    fn toggle(&mut self, bot: &BotView, cx: &mut Context<Self>) {
        if self.open.as_ref().is_some_and(|(id, _, _)| *id == bot.id) {
            self.open = None;
        } else {
            let user = self.state.read(cx).active().and_then(|server| server.users.get(&bot.id)).cloned();
            let input = |cx: &mut Context<Self>, placeholder: &'static str, text: String| {
                let input = cx.new(|cx| {
                    let mut input = TextInput::new(cx, placeholder);
                    input.set_text(text, cx);
                    input
                });
                cx.subscribe(&input, |_, _, _: &InputEvent, cx| cx.notify()).detach();
                input
            };
            let name = input(cx, "", user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| bot.username.clone()));
            let about = input(cx, "What it does", user.map(|user| user.bio).unwrap_or_default());
            self.open = Some((bot.id.clone(), name, about));
        }
        cx.notify();
    }

    fn change(&mut self, id: String, changes: Value, cx: &mut Context<Self>) {
        self.call("updateBot", vec![json!(id), changes], |view, _, cx| view.load(cx), cx);
    }

    /// Asks before a bot is deleted, over all of the settings, which is why they draw it.
    pub(super) fn delete_confirm(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let id = self.deleting.clone()?;
        let bot = self.bots.as_ref()?.iter().find(|bot| bot.id == id)?.clone();
        let name = self.state.read(cx).active().and_then(|server| server.users.get(&id)).map(|user| user.display_name.clone()).unwrap_or_else(|| bot.username.clone());
        let (cancel, delete) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(crate::ui::overlays::confirm(
            format!("Delete {name}?"),
            "Delete bot",
            if bot.set_up { "It's signed out and taken out of every chat it's in. What it sent stays with the people it sent it to. It can't be undone." } else { "Its setup link stops working." }.into(),
            move |_, cx| {
                cancel
                    .update(cx, |view, cx| {
                        view.deleting = None;
                        cx.notify();
                    })
                    .ok();
            },
            move |_, cx| {
                delete
                    .update(cx, |view, cx| {
                        view.deleting = None;
                        view.call(
                            "deleteBot",
                            vec![json!(id)],
                            |view, _, cx| {
                                view.open = None;
                                view.load(cx);
                            },
                            cx,
                        );
                    })
                    .ok();
            },
            cx,
        ))
    }

    /// Says no to deleting the bot being asked about, and whether one was.
    pub(super) fn cancel_delete(&mut self, cx: &mut Context<Self>) -> bool {
        let asking = self.deleting.take().is_some();
        if asking {
            cx.notify();
        }
        asking
    }

    /// The link a bot's program is set up with, shown once, with what to do with it.
    fn setup_link(&mut self, link: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let command = format!("zuna-bot init \"{link}\"");
        let copied = command.clone();
        card(cx)
            .child(notice("terminal", "Set the bot up on the machine that will run it, within the hour. Its keys are made there, so not even you hold them. This link works once, and this is the only time it's shown.", cx).bg(theme.bg3))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pl(px(11.))
                    .pr(px(6.))
                    .py(px(6.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg1)
                    .border_1()
                    .border_color(theme.line)
                    .text_size(px(12.))
                    .child(div().flex_1().min_w_0().one_line().font_family(FONT_MONO).child(command))
                    .child(icon_button("copy-bot-command", "copy", 14., true, false, cx).tip("Copy the command", Side::Bottom).on_click(cx.listener(move |view, _, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(copied.clone()));
                        view.say("Command copied", cx);
                    }))),
            )
            .child(hint("Then start it with zuna-bot run. Whichever machine runs a bot can read that bot's chats.", cx))
            .child(div().flex().child(button("bot-link-done", ButtonKind::Default, ButtonSize::Small, false, cx).child("Done").on_click(cx.listener(|view, _, _, cx| {
                view.link = None;
                cx.notify();
            }))))
            .into_any_element()
    }

    fn new_bot(&mut self, can_list: bool, cx: &mut Context<Self>) -> AnyElement {
        let Some(form) = &self.creating else { return div().into_any_element() };
        let (name, username, listed, add, files) = (form.name.clone(), form.username.clone(), form.listed, form.add.clone(), form.files);
        let typed = username.read(cx).text().trim().to_string();
        let valid = !name.read(cx).text().trim().is_empty() && username_ok(&typed);
        let error = (!typed.is_empty() && !username_ok(&typed)).then(|| "2 to 32 letters, numbers, dots, dashes and underscores.".to_string());
        let busy = self.busy;
        let mut form = card(cx).child(
            div()
                .flex()
                .items_start()
                .gap(px(10.))
                .child(div().flex_1().min_w_0().child(field(Some("Name"), name, None, None, false, None, cx)))
                .child(div().flex_1().min_w_0().child(field(Some("Username"), username, error, None, false, None, cx))),
        );
        if can_list {
            form = form.child(ServerSettings::row(
                "List it for everyone",
                Some("If off, it's private: only you see it, and whoever is in a chat with it. Other admins don't."),
                switch("new-bot-listed", listed, cx)
                    .on_click(cx.listener(|view, _, _, cx| {
                        if let Some(form) = &mut view.creating {
                            form.listed = !form.listed;
                        }
                        cx.notify();
                    }))
                    .into_any_element(),
                cx,
            ));
        }
        if listed {
            let weak = cx.entity().downgrade();
            let chosen: Rc<dyn Fn(&'static str, &mut gpui::App)> = Rc::new(move |value, cx| {
                weak.update(cx, |view, cx| {
                    if let Some(form) = &mut view.creating {
                        form.add = value.to_string();
                    }
                    cx.notify();
                })
                .ok();
            });
            form = form.child(ServerSettings::row("Who can add it to groups", None, add_select("new-bot-add", &add, chosen, cx), cx));
        }
        form = form.child(ServerSettings::row(
            "Let it send files",
            Some("Within the server's limit on a file's size."),
            switch("new-bot-files", files, cx)
                .on_click(cx.listener(|view, _, _, cx| {
                    if let Some(form) = &mut view.creating {
                        form.files = !form.files;
                    }
                    cx.notify();
                }))
                .into_any_element(),
            cx,
        ));
        form.child(
            div()
                .flex()
                .gap(px(8.))
                .child(button("make-bot", ButtonKind::Primary, ButtonSize::Normal, !valid || busy, cx).child(if busy { "Making…" } else { "Make the bot" }).when(valid && !busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.create(cx)))))
                .child(button("cancel-bot", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                    view.creating = None;
                    cx.notify();
                }))),
        )
        .into_any_element()
    }

    fn bot_row(&mut self, server: &ServerState, bot: &BotView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let user = server.users.get(&bot.id);
        let name = user.map(|user| user.display_name.clone()).unwrap_or_else(|| bot.username.clone());
        let image = user.and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        // Whose it is, for a bot that isn't this person's own.
        let owner = if bot.owner_id == server.self_id() { None } else { server.users.get(&bot.owner_id).map(|owner| owner.display_name.clone()) };
        let detail = match owner {
            Some(owner) => format!("@{} · {owner}'s", bot.username),
            None => format!("@{}", bot.username),
        };
        let toggled = bot.clone();
        div()
            .id(SharedString::from(format!("bot-{}", bot.id)))
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(10.))
            .py(px(8.))
            .rounded(RADIUS_M)
            .bg(theme.bg2)
            .text_size(px(13.5))
            .cursor_pointer()
            .hover(move |style| style.bg(theme.bg3))
            .on_click(cx.listener(move |view, _, _, cx| view.toggle(&toggled, cx)))
            .child(avatar(AvatarProps { name: name.clone(), seed: bot.id.clone(), image, size: 36., online: false, rounded: false, dot_border: theme.bg2 }, cx))
            .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::MEDIUM).child(name)).child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(detail)))
            .child(div().flex_none().px(px(7.)).py(px(1.)).rounded(px(10.)).text_size(px(11.5)).bg(theme.bg4).text_color(theme.text2).child(if !bot.set_up {
                "Waiting to be set up"
            } else if bot.listed {
                "Listed"
            } else {
                "Private"
            }))
            .into_any_element()
    }

    /// One bot's settings, under its row.
    fn bot_settings(&mut self, server: &ServerState, bot: &BotView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some((_, name, about)) = self.open.clone() else { return div().into_any_element() };
        let user = server.users.get(&bot.id);
        let own = bot.owner_id == server.self_id();
        let is_admin = server.is_admin();
        let busy = self.busy;
        let mut settings = card(cx).mb(px(3.));
        if !bot.set_up {
            let id = bot.id.clone();
            settings = settings.child(hint("Its program hasn't been set up yet. If the link ran out or was lost, a new one ends the one before.", cx)).child(
                div().flex().child(
                    button("new-bot-link", ButtonKind::Default, ButtonSize::Small, busy || !own, cx)
                        .child(icon("refresh-cw", 13., theme.text1))
                        .child("New setup link")
                        .when(!busy && own, |el| el.on_click(cx.listener(move |view, _, _, cx| view.call("newBotLink", vec![json!(id)], |view, link, _| view.link = link.as_str().map(str::to_string), cx)))),
                ),
            );
        } else if own {
            let shown = user.map(|user| user.display_name.clone()).unwrap_or_else(|| bot.username.clone());
            let image = user.and_then(|user| user.avatar.clone()).and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
            });
            let id = bot.id.clone();
            let picture = div()
                .id("bot-picture")
                .relative()
                .size(px(56.))
                .flex_none()
                .rounded_full()
                .overflow_hidden()
                .group("bot-picture")
                .cursor_pointer()
                .on_click(cx.listener(move |_, _, _, cx| {
                    let picked = crate::media::pick_avatar(cx);
                    let id = id.clone();
                    cx.spawn(async move |view, cx| {
                        let Some(prepared) = picked.await else { return };
                        view.update(cx, |view, cx| match prepared {
                            Ok(file) => view.call("updateBotProfile", vec![json!(id), json!({}), crate::host::file(&file.to_string_lossy(), "image/jpeg")], |view, _, cx| view.say(SENT, cx), cx),
                            Err(()) => view.state.update(cx, |state, cx| state.toast("That image couldn't be processed.", ToastKind::Error, cx)),
                        })
                        .ok();
                    })
                    .detach();
                }))
                .child(avatar(AvatarProps { name: shown, seed: bot.id.clone(), image, size: 56., online: false, rounded: false, dot_border: theme.bg2 }, cx))
                .child(div().absolute().inset_0().flex().items_center().justify_center().bg(crate::theme::color(crate::theme::black_a(0.5))).opacity(0.).group_hover("bot-picture", |style| style.opacity(1.)).child(icon("image", 16., gpui::white())));
            let (typed_name, typed_about) = (name.read(cx).text().trim().to_string(), about.read(cx).text().trim().to_string());
            let (now_name, now_about) = (user.map(|user| user.display_name.clone()).unwrap_or_default(), user.map(|user| user.bio.clone()).unwrap_or_default());
            let can_save = !busy && !typed_name.is_empty() && (typed_name != now_name || typed_about != now_about);
            let id = bot.id.clone();
            let (state, key) = (self.state.clone(), format!("user:{}", bot.id));
            settings = settings
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(14.))
                        .child(picture)
                        .child(div().flex_1().min_w_0().flex().flex_col().gap(px(8.)).child(field(Some("Name"), name, None, None, false, None, cx)).child(field(Some("About"), about, None, None, false, None, cx))),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(button("save-bot", ButtonKind::Primary, ButtonSize::Small, !can_save, cx).child("Save").when(can_save, |el| {
                            el.on_click(cx.listener(move |view, _, _, cx| {
                                let Some((_, name, about)) = view.open.clone() else { return };
                                // A profile is sealed by the account it belongs to, so the bot is asked to set it.
                                let changes = json!({ "displayName": name.read(cx).text().trim().chars().take(64).collect::<String>(), "bio": about.read(cx).text().trim().chars().take(300).collect::<String>() });
                                view.call("updateBotProfile", vec![json!(id), changes], |view, _, cx| view.say(SENT, cx), cx);
                            }))
                        }))
                        .child(button("message-bot", ButtonKind::Default, ButtonSize::Small, false, cx).child(icon("message-circle", 13., theme.text1)).child("Message").on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| {
                                state.select_conversation(Some(key.clone()), cx);
                                state.set_overlay(None, cx);
                            })
                        })),
                );
            let listed = bot.listed;
            // Only a server's admins list a bot. Anyone may take their own off the list.
            let may_list = is_admin || listed;
            let id = bot.id.clone();
            settings = settings.child(ServerSettings::row(
                "List it for everyone",
                Some(if may_list { "If off, it's private: only you see it, and whoever is in a chat with it. It leaves its channels." } else { "Only the server's admins can list a bot." }),
                switch("bot-listed", listed, cx).when(may_list && !busy, |el| el.on_click(cx.listener(move |view, _, _, cx| view.change(id.clone(), json!({ "listed": !listed }), cx)))).into_any_element(),
                cx,
            ));
            if listed {
                let (weak, id) = (cx.entity().downgrade(), bot.id.clone());
                let chosen: Rc<dyn Fn(&'static str, &mut gpui::App)> = Rc::new(move |value, cx| {
                    weak.update(cx, |view, cx| view.change(id.clone(), json!({ "add": value }), cx)).ok();
                });
                settings = settings.child(ServerSettings::row("Who can add it to groups", None, add_select("bot-add", &bot.add, chosen, cx), cx));
            }
            let (files, id) = (bot.files, bot.id.clone());
            settings = settings.child(ServerSettings::row(
                "Let it send files",
                None,
                switch("bot-files", files, cx).when(!busy, |el| el.on_click(cx.listener(move |view, _, _, cx| view.change(id.clone(), json!({ "files": !files }), cx)))).into_any_element(),
                cx,
            ));
        }
        // A listed bot joins the channels a server admin gives it, and no others.
        let channels: Vec<_> = server.channels.iter().filter(|channel| channel.kind == "text" && !channel.unreadable).collect();
        if bot.set_up && bot.listed && is_admin && !channels.is_empty() {
            let mut given = div().flex().flex_wrap().gap(px(12.)).mt(px(8.));
            for channel in channels {
                let has = bot.channels.contains(&channel.id);
                let next: Vec<String> = if has { bot.channels.iter().filter(|id| **id != channel.id).cloned().collect() } else { bot.channels.iter().cloned().chain([channel.id.clone()]).collect() };
                let id = bot.id.clone();
                given = given.child(
                    div()
                        .id(SharedString::from(format!("bot-channel-{}", channel.id)))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .max_w(px(220.))
                        .text_size(px(13.))
                        .cursor_pointer()
                        .when(!busy, |el| el.on_click(cx.listener(move |view, _, _, cx| view.call("setBotChannels", vec![json!(id), json!(next)], |view, _, cx| view.load(cx), cx))))
                        .child(
                            div()
                                .size(px(16.))
                                .rounded(px(4.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .border_1()
                                .border_color(if has { theme.accent } else { theme.line_strong })
                                .when(has, |el| el.bg(theme.accent).child(icon("check", 12., theme.on_accent))),
                        )
                        .child(div().min_w_0().one_line().child(format!("# {}", channel.name))),
                );
            }
            settings = settings.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Channels"))
                    .child(hint("It joins the ones it's given, and reads what's said there from then on.", cx))
                    .child(given),
            );
        }
        let id = bot.id.clone();
        settings
            .child(div().flex().child(button("delete-bot", ButtonKind::Danger, ButtonSize::Small, busy, cx).child(icon("trash", 13., theme.red)).child("Delete bot").when(!busy, |el| {
                el.on_click(cx.listener(move |view, _, _, cx| {
                    view.deleting = Some(id.clone());
                    cx.notify();
                }))
            })))
            .into_any_element()
    }
}

impl Render for ServerBots {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div() };
        let is_admin = server.is_admin();
        let info = server.info.clone().unwrap_or_default();
        let may_make = is_admin || info.allow_member_bots;
        let most = if info.max_bots >= 1. { info.max_bots as usize } else { 5 };
        let bots = self.bots.clone();
        let mine = bots.as_ref().map(|bots| bots.iter().filter(|bot| bot.owner_id == server.self_id()).count()).unwrap_or(0);
        let mut parts = vec![
            ServerSettings::heading("Bots"),
            ServerSettings::lead("A bot is an account a program runs, on a machine its owner chooses. It reads everything said in the chats it's in, from when it was added, and shows a badge wherever its name does.", cx),
        ];
        if let Some(link) = self.link.clone() {
            parts.push(self.setup_link(link, cx));
        } else if self.creating.is_some() {
            parts.push(self.new_bot(is_admin, cx));
        } else if may_make {
            let full = mine >= most;
            parts.push(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(6.))
                    .child(button("new-bot", ButtonKind::Primary, ButtonSize::Normal, full, cx).child(icon("plus", 15., theme.on_accent)).child("New bot").when(!full, |el| el.on_click(cx.listener(|view, _, window, cx| view.start_creating(window, cx)))))
                    .when(full, |el| el.child(hint("You have as many bots as this server lets one person have.", cx)))
                    .into_any_element(),
            );
        } else {
            parts.push(notice("bot", "On this server, only admins can make bots.", cx).into_any_element());
        }
        match bots {
            None => parts.push(div().py(px(8.)).child(spinner(18., theme.text3)).into_any_element()),
            Some(bots) if bots.is_empty() => parts.push(div().text_color(theme.text2).child("No bots yet.").into_any_element()),
            Some(bots) => {
                let mut list = div().flex().flex_col().gap(px(3.));
                for bot in &bots {
                    list = list.child(self.bot_row(&server, bot, cx));
                    if self.open.as_ref().is_some_and(|(id, _, _)| *id == bot.id) {
                        list = list.child(self.bot_settings(&server, bot, cx));
                    }
                }
                parts.push(list.into_any_element());
            }
        }
        if is_admin {
            let allow = info.allow_member_bots;
            let mut options: Vec<usize> = vec![1, 3, 5, 10, 25];
            if !options.contains(&most) {
                options.push(most);
                options.sort();
            }
            let weak = cx.entity().downgrade();
            let choices = options
                .into_iter()
                .map(|value| {
                    let weak = weak.clone();
                    let choose: Rc<dyn Fn(&mut Window, &mut gpui::App)> = Rc::new(move |_, cx| {
                        weak.update(cx, |view, cx| view.call("updateServerSettings", vec![json!({ "max_bots": value })], |_, _, _| {}, cx)).ok();
                    });
                    (value.to_string(), choose)
                })
                .collect();
            parts.push(ServerSettings::divider(cx));
            parts.push(ServerSettings::row(
                "Let members make private bots",
                Some("If off, only admins make bots. Only admins ever make listed ones."),
                switch("member-bots", allow, cx).on_click(cx.listener(move |view, _, _, cx| view.call("updateServerSettings", vec![json!({ "allow_member_bots": !allow })], |_, _, _| {}, cx))).into_any_element(),
                cx,
            ));
            parts.push(ServerSettings::row("Bots each person can have", None, div().w(px(90.)).flex_none().child(select_box("max-bots", most.to_string(), choices, cx)).into_any_element(), cx));
        }
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}
