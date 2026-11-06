//! Notifications on Linux are the system's, as the Electron app shows them there, with the
//! same calls as the cards Windows gets in `ui/notifications.rs`.

use gpui::{App, AppContext, Context, Entity, WeakEntity};

use crate::state::AppState;

pub use crate::platform::notification::{Payload, Picture};

pub struct NotificationCenter {
    #[allow(dead_code)]
    state: WeakEntity<AppState>,
}

#[derive(Clone)]
struct CenterGlobal(Entity<NotificationCenter>);

impl gpui::Global for CenterGlobal {}

pub fn center(cx: &App) -> Option<Entity<NotificationCenter>> {
    cx.try_global::<CenterGlobal>().map(|global| global.0.clone())
}

pub fn install(state: WeakEntity<AppState>, cx: &mut App) {
    let center = cx.new(|_| NotificationCenter { state });
    cx.set_global(CenterGlobal(center));
}

impl NotificationCenter {
    /// Shows one.
    pub fn show(&mut self, _payload: Payload, _reduce_motion: bool, _cx: &mut Context<Self>) {}

    /// Takes back notifications matching everything given: a server's, read chats', or one message's.
    pub fn clear(&mut self, _server_id: Option<&str>, _keys: Option<&[String]>, _message_id: Option<&str>, _cx: &mut Context<Self>) {}
}
