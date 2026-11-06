mod host;

use gpui::{App, Application, Bounds, Context, Window, WindowBounds, WindowOptions, div, prelude::*, px, rgb, size};

struct Hello {
    status: String,
}

impl Render for Hello {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(rgb(0x0f0f11)).text_color(rgb(0xececee)).child(self.status.clone())
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // A check of the core with no window: `zuna --core-check [args as JSON...]`.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--core-eval") {
        // Script for checks, after booting with test hooks on: `sleep:<ms>` waits between them.
        let dir = host::data_dir();
        let key = host::device_key::load(&dir).expect("a device key");
        let (core, _events) = host::Core::start(dir);
        futures::executor::block_on(core.boot(key.key, "Windows PC".into())).expect("the core boots");
        for source in &args[2..] {
            if let Some(ms) = source.strip_prefix("sleep:") {
                std::thread::sleep(std::time::Duration::from_millis(ms.parse().unwrap_or(500)));
                continue;
            }
            println!("{}", futures::executor::block_on(core.eval(source.clone())));
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--core-check") {
        let dir = host::data_dir();
        let key = host::device_key::load(&dir).expect("a device key");
        let (core, _events) = host::Core::start(dir);
        let result = futures::executor::block_on(async {
            core.boot(key.key, "Windows PC".into()).await?;
            let method = args.get(2).cloned().unwrap_or_else(|| "listServers".into());
            let call_args: Vec<serde_json::Value> = args[3.min(args.len())..].iter().map(|arg| serde_json::from_str(arg).unwrap_or(serde_json::Value::String(arg.clone()))).collect();
            core.call(None, &method, call_args).await.map_err(|error| error.message)
        });
        println!("{}", serde_json::to_string_pretty(&result.map_err(|e| serde_json::Value::String(e)).unwrap_or_else(|e| e)).unwrap());
        return;
    }

    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(800.), px(600.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(|_| Hello { status: "Zuna".into() }),
        )
        .unwrap();
    });
}
