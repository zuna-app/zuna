//! The interface's tests: the app's state and its window, on GPUI's test platform, against a
//! stand-in for the core that answers each call the app makes from fixture data the test gives,
//! at once and on the test's own thread, as the test platform needs. The state fills as the
//! app's does, and every screen draws from it.

mod fixtures;
mod screens;
mod state;

pub use fixtures::World;

use std::sync::Once;
use std::time::Duration;

use futures::channel::mpsc;
use gpui::{AppContext, Entity, TestAppContext, WindowHandle};
use serde_json::Value;

use crate::host::Core;
use crate::state::{AppState, Store};
use crate::ui::Root;

/// A data folder of the tests' own, so that nothing a test does touches a real one.
pub fn data_dir() -> std::path::PathBuf {
    static SET: Once = Once::new();
    let dir = std::env::temp_dir().join(format!("zuna-desktop-tests-{}", std::process::id()));
    SET.call_once(|| {
        std::fs::create_dir_all(&dir).expect("a folder for the tests");
        // SAFETY: set once, before anything reads it, by whichever test gets here first.
        unsafe { std::env::set_var("ZUNA_DATA_DIR", &dir) };
    });
    dir
}

/// The stand-in for the core: it answers each call from `fixtures`, which hold, by server ID
/// ("" for the client itself), what each method gives, and refuses anything else as the core
/// would refuse a call it can't make.
fn fake_core(fixtures: Value) -> Core {
    Core::fake(Box::new(move |server, method, _args| {
        fixtures
            .get(server.unwrap_or(""))
            .and_then(|table| table.get(method))
            .cloned()
            .ok_or_else(|| crate::host::CoreError { message: format!("The stand-in has no {method}."), code: Some("missing".into()), status: None })
    }))
}

/// The app with its window open, booted against the stand-in, and a way to send it the
/// core's events as the core would.
pub struct App {
    pub state: Entity<AppState>,
    pub window: WindowHandle<Root>,
    pub events: mpsc::UnboundedSender<Value>,
}

impl App {
    pub fn open(cx: &mut TestAppContext, world: &World) -> App {
        data_dir();
        let core = fake_core(world.fixtures());
        let (events, receiver) = mpsc::unbounded();
        let state = cx.update(|cx| {
            crate::assets::load_fonts(cx);
            crate::ui::text_input::bind_keys(cx);
            crate::ui::bind_keys(cx);
            let state = cx.new(|cx| AppState::new(core.clone(), receiver, cx));
            cx.set_global(Store(state.clone()));
            crate::voice::init(&state, cx);
            state
        });
        let window = cx.add_window(|window, cx| Root::new(state.clone(), window, cx));
        state.update(cx, |state, cx| state.boot(async { Ok(()) }, false, cx));
        let app = App { state, window, events };
        app.settle(cx, |state| !matches!(state.phase, crate::state::Phase::Booting));
        app
    }

    /// Runs everything waiting, the core's answers and the timers they start, until `done`
    /// says so, or fails the test after a while.
    pub fn settle(&self, cx: &mut TestAppContext, done: impl Fn(&AppState) -> bool) {
        for _ in 0..400 {
            cx.run_until_parked();
            if cx.read(|cx| done(self.state.read(cx))) {
                // Whatever that set going, such as a refresh after it.
                for _ in 0..5 {
                    cx.executor().advance_clock(Duration::from_millis(200));
                    std::thread::sleep(Duration::from_millis(5));
                    cx.run_until_parked();
                }
                return;
            }
            cx.executor().advance_clock(Duration::from_millis(50));
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("the app never got where the test waited for it to");
    }

    /// Lets everything that's waiting run, with the core's answers, for a moment.
    pub fn run(&self, cx: &mut TestAppContext) {
        self.settle(cx, |_| true);
    }

    /// Sends the app an event, as the core would.
    pub fn event(&self, cx: &mut TestAppContext, event: Value) {
        self.events.unbounded_send(event).expect("the app listens");
        self.run(cx);
    }

    /// Changes the state as the interface would, and lets the window draw what follows.
    pub fn update(&self, cx: &mut TestAppContext, change: impl FnOnce(&mut AppState, &mut gpui::Context<AppState>)) {
        self.state.update(cx, change);
        self.run(cx);
    }

    /// Changes the window's root as the person would, and lets it draw what follows.
    pub fn root(&self, cx: &mut TestAppContext, change: impl FnOnce(&mut Root, &mut gpui::Window, &mut gpui::Context<Root>)) {
        self.window.update(cx, |root, window, cx| change(root, window, cx)).expect("the window is open");
        self.run(cx);
    }
}
