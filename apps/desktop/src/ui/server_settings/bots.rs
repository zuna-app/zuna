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
const SENT: &str = "Sent to the bot. It'll update the next time it's running";

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
            if bot.set_up { "It'll be signed out and removed from all its chats. Messages it sent will stay. This can't be undone." } else { "Its setup link will stop working." }.into(),
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
            .child(notice("terminal", "Set up the bot on the computer that will run it within the next hour. Its keys are created there, so not even you have them. This link works once and won't be shown again.", cx).bg(theme.bg3))
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
            .child(hint("Then start it with zuna-bot run. Whoever controls the computer running a bot can read its chats.", cx))
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
                Some("If off, the bot is private: only you and people in chats with it can see it. Other admins can't."),
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
            Some("Up to the server's file size limit."),
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
                .child(button("make-bot", ButtonKind::Primary, ButtonSize::Normal, !valid || busy, cx).child(if busy { "Making…" } else { "Create bot" }).when(valid && !busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.create(cx)))))
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
        named_div(SharedString::from(format!("bot-{}", bot.id)))
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
            settings = settings.child(hint("The bot hasn't been set up yet. If the link expired or got lost, make a new one. The old link will stop working.", cx)).child(
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
                Some(if may_list { "If off, the bot is private: only you and people in chats with it can see it. It will leave its channels." } else { "Only the server's admins can list a bot." }),
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
                    named_div(SharedString::from(format!("bot-channel-{}", channel.id)))
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
                    .child(hint("It joins the channels you pick and reads what's said there from then on.", cx))
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
            ServerSettings::lead("A bot is an account run by a program, on a computer its owner chooses. It can read everything said in its chats after it's added, and always shows a bot badge next to its name.", cx),
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
                    .when(full, |el| el.child(hint("You've reached this server's limit of bots per person.", cx)))
                    .into_any_element(),
            );
        } else {
            parts.push(notice("bot", "On this server, only admins can create bots.", cx).into_any_element());
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
                "Let members create private bots",
                Some("If off, only admins can create bots. Listed bots can only ever be created by admins."),
                switch("member-bots", allow, cx).on_click(cx.listener(move |view, _, _, cx| view.call("updateServerSettings", vec![json!({ "allow_member_bots": !allow })], |_, _, _| {}, cx))).into_any_element(),
                cx,
            ));
            parts.push(ServerSettings::row("Bots per person", None, div().w(px(90.)).flex_none().child(select_box("max-bots", most.to_string(), choices, cx)).into_any_element(), cx));
        }
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}

#[cfg(test)]
mod tests {
    //! A server's bots in its settings, clicked through as an owner and admin uses them: one's
    //! settings opened, its profile, listing, who may add it, its files and channels changed,
    //! messaged and deleted; a new one made, listed or private, with its setup link copied; one
    //! waiting to be set up given a new link; and the server's own rules for bots.

    use gpui::TestAppContext;
    use serde_json::{Value, json};

    use super::*;
    use crate::state::Overlay;
    use crate::testing::fixtures::*;
    use crate::testing::{App as Running, World, refused};

    fn bots(app: &Running, cx: &mut TestAppContext) -> Entity<ServerBots> {
        let settings = app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<ServerSettings>().ok())).unwrap().expect("the server's settings are open");
        cx.read(|cx| settings.read(cx).bots.clone()).expect("on its bots")
    }

    fn open(cx: &mut TestAppContext, world: &World) -> Running {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, world);
        for method in ["updateBot", "updateBotProfile", "setBotChannels", "deleteBot", "updateServerSettings"] {
            app.answer(method, |_| Ok(Value::Null));
        }
        app.update(cx, |state, cx| {
            state.select_server(SERVER, cx);
            state.set_overlay(Some(Overlay::ServerSettings { section: Some("bots".into()) }), cx);
        });
        app
    }

    /// Picks an entry of the menu a select opened, and waits out the menu's going, which covers
    /// what's under it until it has.
    fn pick(app: &Running, cx: &mut TestAppContext, select: &str, entry: usize) {
        app.click(cx, select);
        app.click(cx, &format!("menu-item-{entry}"));
        std::thread::sleep(std::time::Duration::from_millis(200));
        app.run(cx);
    }

    fn reopen(app: &Running, cx: &mut TestAppContext) {
        app.update(cx, |state, cx| state.set_overlay(None, cx));
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some("bots".into()) }), cx));
    }

    #[gpui::test]
    fn a_bots_settings_are_changed_from_its_row(cx: &mut TestAppContext) {
        let app = open(cx, &World::new("bots-settings"));
        assert!(app.drawn(cx, &format!("bot-{BOT}")));
        app.click(cx, &format!("bot-{BOT}"));
        let view = bots(&app, cx);
        let (name, about) = cx.read(|cx| view.read(cx).open.clone().map(|(_, name, about)| (name, about))).expect("its settings open under it");
        assert_eq!(cx.read(|cx| name.read(cx).text().to_string()), "Helper");
        // Its profile, which the bot itself is asked to set.
        name.update(cx, |input, cx| input.set_text("Helpful", cx));
        about.update(cx, |input, cx| input.set_text("  Answers things  ", cx));
        app.run(cx);
        app.click(cx, "save-bot");
        assert_eq!(app.calls_of("updateBotProfile"), vec![vec![json!(BOT), json!({ "displayName": "Helpful", "bio": "Answers things" })]]);
        assert!(app.toasts(cx).contains(&SENT.to_string()));
        // Listing, who may add it, and files, each read back after.
        app.forget_calls();
        app.click(cx, "bot-files");
        app.click(cx, "bot-listed");
        pick(&app, cx, "bot-add", 1);
        assert_eq!(app.calls_of("updateBot"), vec![vec![json!(BOT), json!({ "files": false })], vec![json!(BOT), json!({ "listed": false })], vec![json!(BOT), json!({ "add": "admins" })]]);
        assert!(app.calls_of("getBots").len() >= 3);
        // The channels an admin gives it.
        app.click(cx, &format!("bot-channel-{GENERAL}"));
        assert_eq!(app.calls_of("setBotChannels"), vec![vec![json!(BOT), json!([])]], "taken out of the one it had");
        // A change the server refuses says why.
        app.answer("updateBot", |_| Err(refused("That bot isn't yours.")));
        app.click(cx, "bot-files");
        assert!(app.toasts(cx).contains(&"That bot isn't yours.".to_string()));
        // Messaging it opens its chat.
        app.click(cx, "message-bot");
        assert_eq!(app.read(cx, |state| (state.overlay.clone(), state.servers[SERVER].active_key.clone())), (None, Some(format!("user:{BOT}"))));

        // Deleting is asked about first, and a no does nothing.
        reopen(&app, cx);
        app.click(cx, &format!("bot-{BOT}"));
        app.click(cx, "delete-bot");
        let view = bots(&app, cx);
        assert_eq!(cx.read(|cx| view.read(cx).deleting.clone()).as_deref(), Some(BOT), "asked about first");
        app.click(cx, "confirm-cancel");
        assert!(app.calls_of("deleteBot").is_empty());
        app.click(cx, "delete-bot");
        app.click(cx, "confirm-action");
        assert_eq!(app.calls_of("deleteBot"), vec![vec![json!(BOT)]]);
        // A second click on its row closes its settings.
        reopen(&app, cx);
        app.click(cx, &format!("bot-{BOT}"));
        app.click(cx, &format!("bot-{BOT}"));
        let view = bots(&app, cx);
        assert!(cx.read(|cx| view.read(cx).open.is_none()));
    }

    #[gpui::test]
    fn a_bot_is_made_listed_or_private_and_set_up_by_its_link(cx: &mut TestAppContext) {
        let app = open(cx, &World::new("bots-new"));
        app.answer("createBot", |_| Ok(json!({ "link": "https://server-1.example/bot#setup" })));
        app.click(cx, "new-bot");
        let view = bots(&app, cx);
        let form = |cx: &mut TestAppContext| cx.read(|cx| view.read(cx).creating.as_ref().map(|form| (form.name.clone(), form.username.clone()))).expect("the form");
        let (name, username) = form(cx);
        name.update(cx, |input, cx| input.set_text("Weather", cx));
        username.update(cx, |input, cx| input.set_text("no spaces allowed", cx));
        app.run(cx);
        app.click(cx, "make-bot");
        assert!(app.calls_of("createBot").is_empty(), "not with a username the server wouldn't take");
        username.update(cx, |input, cx| input.set_text("weather", cx));
        app.run(cx);
        // Listed, for whoever the owner says may add it, and without files.
        app.click(cx, "new-bot-files");
        assert!(cx.read(|cx| view.read(cx).creating.as_ref().is_some_and(|form| !form.files)), "without files");
        app.click(cx, "new-bot-listed");
        pick(&app, cx, "new-bot-add", 2);
        app.click(cx, "make-bot");
        assert_eq!(app.calls_of("createBot"), vec![vec![json!({ "username": "weather", "name": "Weather", "listed": true, "add": "anyone", "files": false })]]);
        // Its setup link, this once, as a command to copy.
        app.click(cx, "copy-bot-command");
        assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("zuna-bot init \"https://server-1.example/bot#setup\""));
        assert!(app.toasts(cx).contains(&"Command copied".to_string()));
        app.click(cx, "bot-link-done");
        assert!(cx.read(|cx| view.read(cx).link.is_none()));
        // A private one is its owner's alone to add, whatever was chosen; and the form can be left.
        app.click(cx, "new-bot");
        let (name, username) = form(cx);
        name.update(cx, |input, cx| input.set_text("Mine", cx));
        username.update(cx, |input, cx| input.set_text("mine.bot", cx));
        username.update(cx, |_, cx| cx.emit(InputEvent::Submit));
        app.run(cx);
        assert_eq!(app.calls_of("createBot")[1][0]["add"], "owner");
        app.click(cx, "bot-link-done");
        app.click(cx, "new-bot");
        app.click(cx, "cancel-bot");
        assert!(cx.read(|cx| view.read(cx).creating.is_none()));
    }

    #[gpui::test]
    fn a_bot_waiting_to_be_set_up_and_the_servers_rules_for_bots(cx: &mut TestAppContext) {
        let mut world = World::new("bots-rules");
        world.server["getBots"][0]["setUp"] = json!(false);
        world.server["getInfo"]["max_bots"] = json!(7);
        let app = open(cx, &world);
        app.answer("newBotLink", |_| Ok(json!("https://server-1.example/bot#again")));
        app.click(cx, &format!("bot-{BOT}"));
        app.click(cx, "new-bot-link");
        let view = bots(&app, cx);
        assert_eq!(cx.read(|cx| view.read(cx).link.clone()).as_deref(), Some("https://server-1.example/bot#again"));
        app.click(cx, "bot-link-done");
        // The server's rules, an admin's to set.
        app.click(cx, "member-bots");
        pick(&app, cx, "max-bots", 0);
        assert_eq!(app.calls_of("updateServerSettings"), vec![vec![json!({ "allow_member_bots": true })], vec![json!({ "max_bots": 1 })]]);
        // Someone at the limit can't make another, and a member can't make one where only admins may.
        let mut world = World::new("bots-limits");
        world.server["getInfo"]["max_bots"] = json!(1);
        let app = open(cx, &world);
        app.click(cx, "new-bot");
        let view = bots(&app, cx);
        assert!(cx.read(|cx| view.read(cx).creating.is_none()), "You've reached this server's limit of bots per person.");
        let mut world = World::new("bots-member");
        world.server["getSelf"]["role"] = json!("member");
        world.server["getUsers"][0]["role"] = json!("member");
        world.server["getBots"] = json!([]);
        let app = open(cx, &world);
        assert!(!app.drawn(cx, "new-bot") && !app.drawn(cx, "member-bots"));
    }
}
