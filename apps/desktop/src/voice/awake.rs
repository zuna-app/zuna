//! Keeping the screen on while there's something to watch on it, as `useScreenAwake` in
//! packages/ui/src/lib/awake.ts does: while a stage is open with a camera or a shared screen
//! on it and the window is on screen, and while this device's camera or screen goes out,
//! wherever the person is in the app, as the others are watching it. A call that's only
//! heard dims as usual.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::StreamExt;
use gpui::{App, Entity};

use super::{Voice, VoiceStatus};

/// How many stages are open: one, or two for a moment as one takes another's place.
static STAGES: AtomicUsize = AtomicUsize::new(0);

/// Held by a stage while it's open.
pub struct StageOpen(());

impl StageOpen {
    pub fn new() -> Self {
        STAGES.fetch_add(1, Ordering::Relaxed);
        StageOpen(())
    }
}

impl Drop for StageOpen {
    fn drop(&mut self) {
        STAGES.fetch_sub(1, Ordering::Relaxed);
    }
}

fn wanted(voice: &Voice) -> bool {
    let sending = voice.status != VoiceStatus::Idle && (voice.camera || voice.screen.is_some());
    let watching = matches!(voice.status, VoiceStatus::Connected | VoiceStatus::Reconnecting) && !voice.videos.is_empty() && STAGES.load(Ordering::Relaxed) > 0 && crate::platform::main_visible();
    sending || watching
}

/// Holds the screen on whenever it's wanted, for as long as the app runs.
pub fn start(voice: &Entity<Voice>, cx: &mut App) {
    let (changed, mut changes) = futures::channel::mpsc::unbounded::<()>();
    cx.observe(voice, move |_, _| {
        changed.unbounded_send(()).ok();
    })
    .detach();
    let voice = voice.downgrade();
    cx.spawn(async move |cx| {
        let mut held = false;
        loop {
            let Ok((wanted, in_voice)) = voice.update(cx, |voice, _| (wanted(voice), voice.status != VoiceStatus::Idle)) else { break };
            if wanted != held {
                held = wanted;
                log::info!("{}", if wanted { "keeping the screen on" } else { "letting the screen sleep" });
                crate::platform::keep_screen_on(wanted);
            }
            // A stage opening or closing, or the window being minimized, tells the voice nothing,
            // so they're looked at each second while in a room. Out of one, nothing changes until it does.
            if in_voice {
                let second = cx.background_executor().timer(Duration::from_secs(1));
                futures::future::select(changes.next(), second).await;
            } else if changes.next().await.is_none() {
                break;
            }
        }
    })
    .detach();
}
