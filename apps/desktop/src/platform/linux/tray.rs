//! The tray's icon, a StatusNotifierItem, with a menu to open or quit, as the Electron app's
//! was. As there on Linux, the
//! unread count is in its tooltip, and on the taskbar's icon (`icons`), not drawn over it.
//! KDE shows it, and GNOME with the AppIndicator extension.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::{MenuItem, StandardItem};

pub use crate::platform::TrayEvent;

static TRAY: Mutex<Option<Handle<ZunaTray>>> = Mutex::new(None);
static AVAILABLE: AtomicBool = AtomicBool::new(false);

struct ZunaTray {
    unread: u32,
    events: UnboundedSender<TrayEvent>,
}

impl ZunaTray {
    fn send(&self, event: TrayEvent) {
        self.events.unbounded_send(event).ok();
    }
}

impl ksni::Tray for ZunaTray {
    fn id(&self) -> String {
        crate::platform::APP_ID.into()
    }

    fn title(&self) -> String {
        "Zuna".into()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::Communications
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        [16u32, 22, 24, 32, 48, 64]
            .into_iter()
            .map(|size| {
                let image = crate::platform::app_icon(size);
                // ARGB, a byte at a time, as the specification has it.
                let data = image.pixels().flat_map(|pixel| [pixel[3], pixel[0], pixel[1], pixel[2]]).collect();
                ksni::Icon { width: size as i32, height: size as i32, data }
            })
            .collect()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        let title = if self.unread > 0 { format!("Zuna: {} unread", self.unread) } else { "Zuna".into() };
        ksni::ToolTip { title, ..Default::default() }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        // KDE hands over a token first, which brings the window to the front.
        if let Some(token) = ksni::current_xdg_activation_token() {
            super::set_activation_token(token);
        }
        self.send(TrayEvent::Open);
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem { label: "Open Zuna".into(), activate: Box::new(|tray: &mut Self| tray.send(TrayEvent::Open)), ..Default::default() }.into(),
            MenuItem::Separator,
            StandardItem { label: "Quit".into(), activate: Box::new(|tray: &mut Self| tray.send(TrayEvent::Quit)), ..Default::default() }.into(),
        ]
    }
}

/// Puts the icon in the tray. What's clicked arrives on the receiver.
pub fn start() -> UnboundedReceiver<TrayEvent> {
    let (events, receiver) = unbounded();
    match (ZunaTray { unread: 0, events }).spawn() {
        Ok(handle) => {
            AVAILABLE.store(true, Ordering::Relaxed);
            *TRAY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
        }
        Err(error) => log::info!("no tray: {error}"),
    }
    receiver
}

/// Whether there's a tray to run in, so that closing the window can leave the app running.
pub fn available() -> bool {
    AVAILABLE.load(Ordering::Relaxed)
}

/// Shows the unread count in the icon's tooltip.
pub fn set_unread(count: u32) {
    if let Some(tray) = TRAY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
        tray.update(|tray| tray.unread = count);
    }
}

/// Takes the icon away before the app quits, so none is left behind.
pub fn remove() {
    if let Some(tray) = TRAY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        tray.shutdown().wait();
    }
}
