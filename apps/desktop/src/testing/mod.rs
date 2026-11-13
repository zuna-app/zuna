//! The interface's tests: the app's state and its window, on GPUI's test platform, against a
//! stand-in for the core that answers each call the app makes from fixture data the test gives,
//! at once and on the test's own thread, as the test platform needs. The state fills as the
//! app's does, and every screen draws from it.

pub mod fixtures;
mod screens;
mod state;

pub use fixtures::World;

use std::collections::HashMap;
use std::sync::{Arc, Once};
use std::time::Duration;

use futures::channel::mpsc;
use gpui::{AppContext, Entity, TestAppContext, WindowHandle};
use parking_lot::Mutex;
use serde_json::Value;

use crate::host::{Core, CoreError};
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

/// The keys that empty a text box, as each system's own select everything first.
pub const CLEAR_KEYS: &str = if cfg!(target_os = "macos") { "cmd-a backspace" } else { "ctrl-a backspace" };

/// A call the app made of the core.
#[derive(Clone, Debug)]
pub struct Call {
    pub server: Option<String>,
    pub method: String,
    pub args: Vec<Value>,
}

/// What a test answers a method with, from its arguments, in place of the fixtures.
pub type Answer = Box<dyn Fn(&[Value]) -> Result<Value, CoreError> + Send>;

/// An error as the core would give it.
pub fn refused(message: &str) -> CoreError {
    CoreError { message: message.into(), code: Some("refused".into()), status: Some(400) }
}

/// The stand-in for the core: it notes each call, and answers it as the test said to, or from
/// `fixtures`, which hold, by server ID ("" for the client itself), what each method gives, and
/// refuses anything else as the core would refuse a call it can't make.
fn fake_core(fixtures: Value, calls: Arc<Mutex<Vec<Call>>>, answers: Arc<Mutex<HashMap<String, Answer>>>) -> Core {
    Core::fake(Box::new(move |server, method, args| {
        calls.lock().push(Call { server: server.map(str::to_string), method: method.to_string(), args: args.to_vec() });
        if let Some(answer) = answers.lock().get(method) {
            return answer(args);
        }
        fixtures
            .get(server.unwrap_or(""))
            .and_then(|table| table.get(method))
            .cloned()
            .ok_or_else(|| CoreError { message: format!("The stand-in has no {method}."), code: Some("missing".into()), status: None })
    }))
}

/// The app with its window open, booted against the stand-in, and a way to send it the
/// core's events as the core would.
pub struct App {
    pub state: Entity<AppState>,
    pub window: WindowHandle<Root>,
    pub events: mpsc::UnboundedSender<Value>,
    calls: Arc<Mutex<Vec<Call>>>,
    answers: Arc<Mutex<HashMap<String, Answer>>>,
}

impl App {
    pub fn open(cx: &mut TestAppContext, world: &World) -> App {
        data_dir();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(HashMap::new()));
        let core = fake_core(world.fixtures(), calls.clone(), answers.clone());
        let (events, receiver) = mpsc::unbounded();
        let state = cx.update(|cx| {
            crate::assets::load_fonts(cx);
            crate::ui::text_input::bind_keys(cx);
            crate::ui::bind_keys(cx);
            let state = cx.new(|cx| AppState::new(core.clone(), receiver, cx));
            cx.set_global(Store(state.clone()));
            crate::voice::init(&state, cx);
            #[cfg(windows)]
            crate::ui::notifications::install(state.downgrade(), cx);
            state
        });
        // Nothing a test does makes a sound.
        state.update(cx, |state, _| state.settings.notification_sound = false);
        let window = cx.add_window(|window, cx| Root::new(state.clone(), window, cx));
        state.update(cx, |state, cx| state.boot(async { Ok(()) }, false, cx));
        let app = App { state, window, events, calls, answers };
        app.settle(cx, |state| !matches!(state.phase, crate::state::Phase::Booting));
        app
    }

    /// Answers a method from its arguments from now on, in place of the fixtures.
    pub fn answer(&self, method: &str, answer: impl Fn(&[Value]) -> Result<Value, CoreError> + Send + 'static) {
        self.answers.lock().insert(method.to_string(), Box::new(answer));
    }

    /// The arguments of each call of a method so far.
    pub fn calls_of(&self, method: &str) -> Vec<Vec<Value>> {
        self.calls.lock().iter().filter(|call| call.method == method).map(|call| call.args.clone()).collect()
    }

    /// Every call so far.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }

    pub fn forget_calls(&self) {
        self.calls.lock().clear();
    }

    /// The toasts showing, newest last.
    pub fn toasts(&self, cx: &mut TestAppContext) -> Vec<String> {
        cx.read(|cx| self.state.read(cx).toasts.iter().map(|toast| toast.message.clone()).collect())
    }

    /// Reads the state.
    pub fn read<T>(&self, cx: &mut TestAppContext, read: impl FnOnce(&AppState) -> T) -> T {
        cx.read(|cx| read(self.state.read(cx)))
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

    /// Clicks the button, icon button or switch with this id where the window drew it, as the
    /// person would, and lets what follows run.
    pub fn click(&self, cx: &mut TestAppContext, id: &str) {
        let selector: &'static str = Box::leak(id.to_string().into_boxed_str());
        let mut window = gpui::VisualTestContext::from_window(self.window.into(), cx);
        let bounds = window.debug_bounds(selector).unwrap_or_else(|| panic!("nothing drawn is called {id}"));
        window.simulate_click(bounds.center(), gpui::Modifiers::none());
        self.run(cx);
    }

    /// Whether a control with this id is drawn.
    pub fn drawn(&self, cx: &mut TestAppContext, id: &str) -> bool {
        let selector: &'static str = Box::leak(id.to_string().into_boxed_str());
        gpui::VisualTestContext::from_window(self.window.into(), cx).debug_bounds(selector).is_some()
    }

    /// Changes the window's root as the person would, and lets it draw what follows.
    pub fn root(&self, cx: &mut TestAppContext, change: impl FnOnce(&mut Root, &mut gpui::Window, &mut gpui::Context<Root>)) {
        self.window.update(cx, |root, window, cx| change(root, window, cx)).expect("the window is open");
        self.run(cx);
    }
}
