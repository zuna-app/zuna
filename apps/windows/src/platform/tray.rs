//! The tray's icon, with the unread count over it and a menu to open or quit, as the
//! desktop's (createTray in apps/desktop/src/main/index.ts). It lives on a thread of its
//! own with a hidden window for its messages, and tells the app what was clicked.

use std::sync::{Mutex, OnceLock};

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{HSTRING, PCWSTR, w};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayEvent {
    Open,
    Quit,
}

const CALLBACK: u32 = WM_APP + 1;
const UPDATE: u32 = WM_APP + 2;
const REMOVE: u32 = WM_APP + 3;
const MENU_OPEN: usize = 1;
const MENU_QUIT: usize = 2;

struct Shared {
    hwnd: isize,
    unread: u32,
    events: Option<UnboundedSender<TrayEvent>>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { hwnd: 0, unread: 0, events: None });
static TASKBAR_CREATED: OnceLock<u32> = OnceLock::new();

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Puts the icon in the tray. What's clicked arrives on the receiver.
pub fn start() -> UnboundedReceiver<TrayEvent> {
    let (sender, receiver) = unbounded();
    shared().events = Some(sender);
    std::thread::Builder::new().name("zuna-tray".into()).spawn(run).ok();
    receiver
}

/// Shows the unread count over the icon and in its tooltip.
pub fn set_unread(count: u32) {
    let hwnd = {
        let mut shared = shared();
        shared.unread = count;
        shared.hwnd
    };
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), UPDATE, WPARAM(0), LPARAM(0));
        }
    }
}

/// Takes the icon away before the app quits, so none is left behind.
pub fn remove() {
    let hwnd = shared().hwnd;
    if hwnd != 0 {
        unsafe {
            let _ = SendMessageW(HWND(hwnd as *mut _), REMOVE, Some(WPARAM(0)), Some(LPARAM(0)));
        }
    }
}

fn data(hwnd: HWND) -> NOTIFYICONDATAW {
    let mut data = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: 1, ..Default::default() };
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    data.uCallbackMessage = CALLBACK;
    data
}

/// The icon and tooltip for the count now, sharp on the main screen.
fn apply(hwnd: HWND, message: windows::Win32::UI::Shell::NOTIFY_ICON_MESSAGE) {
    let unread = shared().unread;
    let ratio = unsafe { windows::Win32::UI::HiDpi::GetDpiForSystem() }.max(96) as f32 / 96.;
    let mut data = data(hwnd);
    let icon = super::icons::hicon(&super::icons::tray_icon(unread, ratio));
    if let Some(icon) = icon {
        data.hIcon = icon;
    }
    let tip = if unread > 0 { format!("Zuna: {unread} unread") } else { "Zuna".to_string() };
    for (slot, unit) in data.szTip.iter_mut().zip(tip.encode_utf16().chain([0])) {
        *slot = unit;
    }
    unsafe {
        let _ = Shell_NotifyIconW(message, &data);
        if let Some(icon) = icon {
            let _ = DestroyIcon(icon);
        }
    }
}

fn send(event: TrayEvent) {
    if let Some(sender) = &shared().events {
        sender.unbounded_send(event).ok();
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            CALLBACK => {
                match (lparam.0 & 0xffff) as u32 {
                    WM_LBUTTONUP => send(TrayEvent::Open),
                    WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd),
                    _ => {}
                }
                LRESULT(0)
            }
            UPDATE => {
                apply(hwnd, NIM_MODIFY);
                LRESULT(0)
            }
            REMOVE => {
                let data = data(hwnd);
                let _ = Shell_NotifyIconW(NIM_DELETE, &data);
                LRESULT(0)
            }
            _ if Some(&message) == TASKBAR_CREATED.get() => {
                // Explorer started again, and its tray with it, without the icon.
                apply(hwnd, NIM_ADD);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}

/// Open Zuna, a line, and Quit, at the mouse.
unsafe fn show_menu(hwnd: HWND) {
    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        let _ = AppendMenuW(menu, MF_STRING, MENU_OPEN, w!("Open Zuna"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_STRING, MENU_QUIT, w!("Quit"));
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        // Without this the menu stays open when clicking elsewhere.
        let _ = SetForegroundWindow(hwnd);
        let chosen = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, point.x, point.y, Some(0), hwnd, None);
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        match chosen.0 as usize {
            MENU_OPEN => send(TrayEvent::Open),
            MENU_QUIT => send(TrayEvent::Quit),
            _ => {}
        }
    }
}

fn run() {
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = w!("ZunaTray");
        let window_class = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&window_class);
        let _ = TASKBAR_CREATED.set(RegisterWindowMessageW(&HSTRING::from("TaskbarCreated")));
        // A real window, if hidden, as a message-only one never hears that the taskbar came back.
        let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("Zuna tray"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(instance.into()), None) else {
            return;
        };
        shared().hwnd = hwnd.0 as isize;
        apply(hwnd, NIM_ADD);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
