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
        // Made once: ksni asks for it on every change, as the unread count changes, and decoding
        // and resizing six pictures each time came to more than the change.
        static ICONS: std::sync::OnceLock<Vec<ksni::Icon>> = std::sync::OnceLock::new();
        ICONS
            .get_or_init(|| {
                [16u32, 22, 24, 32, 48, 64]
                    .into_iter()
                    .map(|size| {
                        let image = crate::platform::app_icon(size);
                        // ARGB, a byte at a time, as the specification has it.
                        let data = image.pixels().flat_map(|pixel| [pixel[3], pixel[0], pixel[1], pixel[2]]).collect();
                        ksni::Icon { width: size as i32, height: size as i32, data }
                    })
                    .collect()
            })
            .clone()
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

#[cfg(test)]
mod tests {
    use super::*;
    use ksni::Tray;

    fn tray(unread: u32) -> (ZunaTray, UnboundedReceiver<TrayEvent>) {
        let (events, receiver) = unbounded();
        (ZunaTray { unread, events }, receiver)
    }

    #[test]
    fn names_itself_as_the_app() {
        let (tray, _) = tray(0);
        assert_eq!(tray.id(), "zuna");
        assert_eq!(tray.title(), "Zuna");
        assert_eq!(tray.category(), ksni::Category::Communications);
    }

    #[test]
    fn says_how_many_are_unread_in_its_tooltip() {
        assert_eq!(tray(0).0.tool_tip().title, "Zuna");
        assert_eq!(tray(1).0.tool_tip().title, "Zuna: 1 unread");
        assert_eq!(tray(42).0.tool_tip().title, "Zuna: 42 unread");
    }

    #[test]
    fn hands_over_its_icon_in_argb_at_six_sizes() {
        let icons = tray(0).0.icon_pixmap();
        assert_eq!(icons.iter().map(|icon| (icon.width, icon.height)).collect::<Vec<_>>(), [16, 22, 24, 32, 48, 64].map(|side| (side, side)));
        for icon in &icons {
            assert_eq!(icon.data.len(), (icon.width * icon.height * 4) as usize);
            let rgba = crate::platform::app_icon(icon.width as u32);
            let argb: Vec<u8> = rgba.pixels().flat_map(|pixel| [pixel[3], pixel[0], pixel[1], pixel[2]]).collect();
            assert!(icon.data == argb, "at {}", icon.width);
        }
        // The same each time it's asked.
        assert_eq!(tray(3).0.icon_pixmap()[2].data, icons[2].data);
    }

    #[test]
    fn opens_and_quits_from_its_menu() {
        let (mut tray, mut events) = tray(0);
        let menu = tray.menu();
        assert_eq!(menu.len(), 3);
        assert!(matches!(menu[1], MenuItem::Separator));
        let mut picked = Vec::new();
        for item in &menu {
            if let MenuItem::Standard(item) = item {
                (item.activate)(&mut tray);
                picked.push((item.label.clone(), events.try_recv().ok()));
            }
        }
        assert_eq!(picked, [("Open Zuna".to_string(), Some(TrayEvent::Open)), ("Quit".to_string(), Some(TrayEvent::Quit))]);
    }

    #[test]
    fn sends_nothing_once_nobody_listens() {
        let (tray, events) = tray(0);
        drop(events);
        tray.send(TrayEvent::Open);
    }
}
