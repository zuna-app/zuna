//! Onboarding, step by step, as a person goes through it: an invite opened and an account made
//! with its recovery key and the server named, signing in, recovering an account, and what a
//! server that can't be reached says.

use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

use super::*;
use crate::testing::fixtures::*;
use crate::testing::{App, World, refused};

/// The app with no server yet, which shows onboarding, and onboarding itself.
fn open(cx: &mut TestAppContext, name: &str) -> (App, Entity<Onboarding>) {
    let mut world = World::new(name);
    world.client.insert("listServers".into(), json!([]));
    let app = App::open(cx, &world);
    crate::ui::motion::set_reduced(true);
    let onboarding = app.window.update(cx, |root, _, _| root.onboarding.clone()).unwrap();
    (app, onboarding)
}

fn go(app: &App, onboarding: &Entity<Onboarding>, cx: &mut TestAppContext, step: Step) {
    app.window.update(cx, |_, window, cx| onboarding.update(cx, |view, cx| view.go(step, window, cx))).unwrap();
    app.run(cx);
}

fn submit(app: &App, onboarding: &Entity<Onboarding>, cx: &mut TestAppContext) {
    app.window.update(cx, |_, window, cx| onboarding.update(cx, |view, cx| view.submit(window, cx))).unwrap();
    app.run(cx);
}

/// Focuses a field and types into it as the keyboard would.
fn type_into(app: &App, onboarding: &Entity<Onboarding>, cx: &mut TestAppContext, field: impl Fn(&Onboarding) -> Entity<TextInput>, text: &str) {
    let input = cx.read(|cx| field(onboarding.read(cx)));
    app.window.update(cx, |_, window, cx| input.focus_handle(cx).focus(window, cx)).unwrap();
    app.run(cx);
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_input(text);
    app.run(cx);
}

fn step_name(onboarding: &Entity<Onboarding>, cx: &mut TestAppContext) -> &'static str {
    cx.read(|cx| match onboarding.read(cx).step {
        Step::Welcome => "welcome",
        Step::Link => "link",
        Step::Invite(_) => "invite",
        Step::RecoveryKey { .. } => "recovery key",
        Step::NameServer { .. } => "name server",
        Step::SignIn => "sign in",
        Step::Recover { .. } => "recover",
    })
}

fn error(onboarding: &Entity<Onboarding>, cx: &mut TestAppContext) -> Option<String> {
    cx.read(|cx| onboarding.read(cx).error.clone())
}

#[gpui::test]
fn an_invite_makes_an_account_and_names_the_server(cx: &mut TestAppContext) {
    let (app, onboarding) = open(cx, "onboarding-invite");
    assert_eq!(step_name(&onboarding, cx), "welcome");
    app.answer("previewInvite", |args| {
        if args[0].as_str().is_some_and(|link| link.contains("unreachable")) {
            return Err(refused("error sending request for url"));
        }
        Ok(json!({ "url": "https://server-9.example", "code": "abc", "setup": true, "server": { "name": "New place", "registration": "invite", "user_count": 0 } }))
    });
    app.answer("register", |_| Ok(json!({ "serverId": "server-9", "recoveryKey": "ABCD-EFGH-IJKL-MNOP" })));
    app.answer("updateServerSettings", |_| Ok(Value::Null));

    // A link that leads nowhere says so plainly.
    go(&app, &onboarding, cx, Step::Link);
    type_into(&app, &onboarding, cx, |view| view.link.clone(), "https://unreachable.example/invite/abc");
    keys(&app, cx, "enter");
    assert_eq!(error(&onboarding, cx).as_deref(), Some("Couldn't reach that server. Check the address and your connection."));
    assert_eq!(step_name(&onboarding, cx), "link");

    // One that works shows the server, and asks for a name, username and password.
    keys(&app, cx, "ctrl-a backspace");
    type_into(&app, &onboarding, cx, |view| view.link.clone(), "https://server-9.example/invite/abc#k=key");
    submit(&app, &onboarding, cx);
    assert_eq!(step_name(&onboarding, cx), "invite");
    assert_eq!(error(&onboarding, cx), None);

    // The username follows the name until it's changed by hand.
    type_into(&app, &onboarding, cx, |view| view.display_name.clone(), "Zoë Smith");
    assert_eq!(cx.read(|cx| onboarding.read(cx).username.read(cx).text().to_string()), "zo_smith");
    type_into(&app, &onboarding, cx, |view| view.password.clone(), "a long and fine password");
    app.window.update(cx, |_, _, cx| onboarding.update(cx, |view, _| view.show_password = !view.show_password)).unwrap();
    // A password that doesn't match isn't sent.
    type_into(&app, &onboarding, cx, |view| view.confirm.clone(), "a different one");
    onboarding.update(cx, |view, _| view.strength = (4, "Strong".into()));
    submit(&app, &onboarding, cx);
    assert!(app.calls_of("register").is_empty());
    keys(&app, cx, "ctrl-a backspace");
    type_into(&app, &onboarding, cx, |view| view.confirm.clone(), "a long and fine password");
    onboarding.update(cx, |view, _| view.strength = (4, "Strong".into()));
    submit(&app, &onboarding, cx);
    let registered = app.calls_of("register");
    assert_eq!(registered.len(), 1);
    assert_eq!((registered[0][1].clone(), registered[0][2].clone()), (json!("zo_smith"), json!("a long and fine password")));
    assert_eq!(step_name(&onboarding, cx), "recovery key");

    // The recovery key has to be saved before going on; then the new server gets its name.
    submit(&app, &onboarding, cx);
    assert_eq!(step_name(&onboarding, cx), "recovery key");
    onboarding.update(cx, |view, _| view.saved = true);
    submit(&app, &onboarding, cx);
    assert_eq!(step_name(&onboarding, cx), "name server");
    type_into(&app, &onboarding, cx, |view| view.server_name.clone(), "Our place");
    submit(&app, &onboarding, cx);
    assert_eq!(app.calls_of("updateServerSettings"), vec![vec![json!({ "name": "Our place" })]]);
}

fn keys(app: &App, cx: &mut TestAppContext, keystrokes: &str) {
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_keystrokes(keystrokes);
    app.run(cx);
}

#[gpui::test]
fn signing_in_and_recovering(cx: &mut TestAppContext) {
    let (app, onboarding) = open(cx, "onboarding-sign-in");
    app.answer("login", |args| if args[2] == "wrong" { Err(refused("Wrong username or password.")) } else { Ok(json!(SERVER)) });
    app.answer("recover", |_| Ok(json!(SERVER)));

    go(&app, &onboarding, cx, Step::SignIn);
    // Nothing goes until everything is filled in.
    submit(&app, &onboarding, cx);
    assert!(app.calls_of("login").is_empty());
    type_into(&app, &onboarding, cx, |view| view.server.clone(), "https://server-1.example");
    type_into(&app, &onboarding, cx, |view| view.username.clone(), "alice");
    type_into(&app, &onboarding, cx, |view| view.password.clone(), "wrong");
    keys(&app, cx, "enter");
    assert_eq!(error(&onboarding, cx).as_deref(), Some("Wrong username or password."));
    keys(&app, cx, "ctrl-a backspace");
    type_into(&app, &onboarding, cx, |view| view.password.clone(), "right");
    submit(&app, &onboarding, cx);
    assert_eq!(app.calls_of("login").len(), 2);

    // A forgotten password, with the recovery key.
    go(&app, &onboarding, cx, Step::Recover { url: "https://server-1.example".into(), username: "alice".into() });
    type_into(&app, &onboarding, cx, |view| view.recovery.clone(), "ABCD-EFGH");
    onboarding.update(cx, |view, cx| {
        view.password.update(cx, |input, cx| input.set_text("a new long password", cx));
        view.confirm.update(cx, |input, cx| input.set_text("a new long password", cx));
        view.strength = (3, "Good".into());
    });
    submit(&app, &onboarding, cx);
    assert_eq!(app.calls_of("recover")[0][2], json!("ABCD-EFGH"));

    // Back to the start, and every step drawn on the way.
    for step in [Step::Welcome, Step::Link, Step::RecoveryKey { server_id: SERVER.into(), recovery_key: "KEY".into(), setup: false }] {
        go(&app, &onboarding, cx, step);
    }
    onboarding.update(cx, |view, _| view.saved = true);
    submit(&app, &onboarding, cx);
}

#[test]
fn usernames_suggested_and_checked() {
    assert_eq!(suggest_username("Zoë Smith"), "zo_smith");
    assert_eq!(suggest_username("  ..Alex.. "), "alex");
    assert_eq!(suggest_username("a-b_c.d"), "a-b_c.d");
    assert!(valid_username("alex"));
    assert!(valid_username("_x"));
    assert!(!valid_username("a"));
    assert!(!valid_username(".alex"));
    assert!(!valid_username("al ex"));
    assert!(!valid_username(&"a".repeat(33)));
    assert_eq!(describe_error("Load failed"), "Couldn't reach that server. Check the address and your connection.");
    assert_eq!(describe_error("Username taken."), "Username taken.");
}
