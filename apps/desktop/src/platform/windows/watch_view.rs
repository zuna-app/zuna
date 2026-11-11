//! The player a video watched together plays in on Windows: WebView2 holding `watch.html` from
//! packages/watch and nothing else, as a child of the GPUI window where the stage's tile is, as
//! macOS holds it in a WKWebView (platform/macos/watch_view.rs). The page is answered from
//! memory under `https://chat.zuna.desktop`, the Referer YouTube needs, in an InPrivate profile
//! whose few files sit in the app's cache, which is emptied as it starts and quits. It frames
//! YouTube's player alone under the page's content security policy, opens a link pressed in it in
//! the browser, opens no window, downloads nothing, and gets no camera, microphone or anything
//! else it asks for. It draws over whatever GPUI draws inside its rectangle, so whoever holds it
//! hides it while something of GPUI's is on top.
//!
//! WebView2's processes can die under it, as RivaTuner Statistics Server's hooks have been seen to
//! crash its browser process as a video seeks, which leaves the view black and silent. The view
//! then says it failed (`failed`), and whoever holds it makes a new one.
//!
//! WebView2 makes its environment and controller asynchronously, calling back on this thread as
//! GPUI's message loop runs, so the view is there a moment after `new`, and what it's told before
//! then is kept until it is.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::channel::mpsc::UnboundedSender;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler, DownloadStartingEventHandler, ExecuteScriptCompletedHandler,
    FocusChangedEventHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler, WebMessageReceivedEventHandler,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SHCreateMemStream, SetWindowSubclass, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNORMAL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_NCLBUTTONDOWN, WM_POINTERDOWN, WM_RBUTTONDOWN};
use windows::core::{HSTRING, Interface, PCWSTR, PWSTR, w};

/// Whether the WebView2 Runtime is installed.
pub fn available() -> bool {
    let mut version = PWSTR::null();
    // SAFETY: the loader writes a string WebView2 allocated, which take_pwstr frees.
    let found = unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }.is_ok();
    found && !version.is_null() && !take_pwstr(version).is_empty()
}

/// What the view is, shared with WebView2's callbacks, which hold it weakly.
struct Shared {
    parent: HWND,
    controller: Option<ICoreWebView2Controller>,
    webview: Option<ICoreWebView2>,
    /// Where it goes, in the window's logical points from its top left, and whether it's hidden,
    /// kept for when the controller arrives.
    frame: Option<(f32, f32, f32, f32)>,
    hidden: bool,
}

pub struct WatchView {
    shared: Rc<RefCell<Shared>>,
    /// Whether the player has the keyboard, which goes back to the window when it's hidden or goes.
    focused: Rc<Cell<bool>>,
    /// Whether GPUI's window is subclassed to give the keyboard back on a click (`watch_clicks`).
    subclassed: bool,
    /// Whether WebView2 couldn't start, or a process the page needs died, so the view shows nothing.
    failed: Rc<Cell<bool>>,
}

impl WatchView {
    /// Puts the page in the window, hidden until it's given a place. `page` is `watch.html`,
    /// `origin` the address it's loaded under, and what it says comes to `messages`.
    pub fn new(window: &gpui::Window, page: &str, origin: &str, messages: UnboundedSender<String>) -> Option<WatchView> {
        let parent = super::hwnd_of(window)?;
        if !available() {
            log::warn!("watch: the WebView2 Runtime isn't installed");
            return None;
        }
        let folder = crate::host::cache_dir().join("webview2");
        std::fs::create_dir_all(&folder).ok()?;
        let shared = Rc::new(RefCell::new(Shared { parent, controller: None, webview: None, frame: None, hidden: true }));
        let focused = Rc::new(Cell::new(false));
        let failed = Rc::new(Cell::new(false));
        let options = CoreWebView2EnvironmentOptions::default();
        // A video someone pressed Watch for plays with its sound, as WKWebView is told on macOS.
        #[allow(unused_mut)]
        let mut arguments = String::from("--autoplay-policy=no-user-gesture-required");
        // A development build's checks may add their own, such as painting a window that's off
        // every screen, where they keep the app out of the person's way.
        #[cfg(debug_assertions)]
        if let Ok(more) = std::env::var("ZUNA_WEBVIEW2_ARGUMENTS") {
            arguments = format!("{arguments} {more}");
        }
        // SAFETY: the options are only read by the loader, on this thread.
        unsafe { options.set_additional_browser_arguments(arguments) };
        let options: ICoreWebView2EnvironmentOptions = options.into();
        let (weak, focus, page, origin) = (Rc::downgrade(&shared), focused.clone(), page.to_string(), origin.trim_end_matches('/').to_string());
        let (failed_to_start, failed_later) = (failed.clone(), failed.clone());
        let created = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
            if let Err(error) = result {
                log::warn!("watch: WebView2's environment didn't start: {error}");
                failed_to_start.set(true);
                return Err(error);
            }
            let Some(environment) = environment else { return Ok(()) };
            if weak.upgrade().is_none() {
                return Ok(());
            }
            // SAFETY: WebView2's objects, used on the thread that made them.
            let options = unsafe { environment.cast::<ICoreWebView2Environment10>()?.CreateCoreWebView2ControllerOptions()? };
            // InPrivate, so no cookie or storage outlives the player.
            unsafe { options.SetIsInPrivateModeEnabled(true)? };
            let environment_for_setup = environment.clone();
            let failed_to_start = failed_to_start.clone();
            let made = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
                if let Err(error) = result {
                    log::warn!("watch: WebView2's controller didn't start: {error}");
                    failed_to_start.set(true);
                    return Err(error);
                }
                let Some(controller) = controller else { return Ok(()) };
                let Some(shared) = weak.upgrade() else {
                    // It was let go of while WebView2 was starting.
                    // SAFETY: closing a controller nobody holds, on its own thread.
                    unsafe { controller.Close().ok() };
                    return Ok(());
                };
                if let Err(error) = setup(&shared, &environment_for_setup, &controller, page, &origin, messages, focus, failed_later) {
                    log::warn!("watch: WebView2 couldn't be set up: {error}");
                    failed_to_start.set(true);
                    // SAFETY: as above.
                    unsafe { controller.Close().ok() };
                }
                Ok(())
            }));
            // SAFETY: GPUI's window outlives what's in it, and the handler runs on this thread.
            unsafe { environment.cast::<ICoreWebView2Environment10>()?.CreateCoreWebView2ControllerWithOptions(parent, &options, &made) }
        }));
        // SAFETY: the folder and options outlive the call, and the handler runs on this thread
        // as GPUI's loop pumps its messages, as COM's single-threaded apartment needs.
        if let Err(error) = unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &HSTRING::from(folder.as_os_str()), &options, &created) } {
            log::warn!("watch: WebView2 didn't start: {error}");
            return None;
        }
        let subclassed = watch_clicks(parent);
        Some(WatchView { shared, focused, subclassed, failed })
    }

    /// Whether the view shows nothing and never will, as WebView2 didn't start or a process the page
    /// needs died, so that a new one has to be made.
    pub fn failed(&self) -> bool {
        self.failed.get()
    }

    /// Where the player goes, in the window's own logical coordinates from its top left.
    pub fn set_frame(&self, x: f32, y: f32, width: f32, height: f32) {
        let frame = (x, y, width.max(1.), height.max(1.));
        let (controller, parent) = {
            let mut shared = self.shared.borrow_mut();
            if shared.frame == Some(frame) {
                return;
            }
            shared.frame = Some(frame);
            (shared.controller.clone(), shared.parent)
        };
        if let Some(controller) = controller {
            place(&controller, parent, frame);
        }
    }

    pub fn set_hidden(&self, hidden: bool) {
        let controller = {
            let mut shared = self.shared.borrow_mut();
            if shared.hidden == hidden {
                return;
            }
            shared.hidden = hidden;
            shared.controller.clone()
        };
        if let Some(controller) = controller {
            // SAFETY: WebView2's controller, on its own thread.
            unsafe { controller.SetIsVisible(!hidden).ok() };
        }
        if hidden && self.focused.get() {
            // The keyboard goes back to the app with the player out of sight.
            // SAFETY: GPUI's own window, on its thread.
            unsafe { SetFocus(Some(self.shared.borrow().parent)).ok() };
        }
    }

    /// Tells the page something, as JSON the app made.
    pub fn send(&self, json: &str) {
        let Some(webview) = self.shared.borrow().webview.clone() else { return };
        let script = HSTRING::from(format!("window.zunaWatch && window.zunaWatch.receive({json})"));
        let done = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
        // SAFETY: WebView2's view, on its own thread.
        unsafe { webview.ExecuteScript(&script, &done).ok() };
    }

    /// Writes what the player shows to a PNG, for a development build's checks, which keep the
    /// app's window off every screen, where nothing else can capture WebView2's picture.
    #[cfg(debug_assertions)]
    pub fn snapshot(&self, path: &str) {
        use windows::Win32::System::Com::{STGM_CREATE, STGM_WRITE};
        use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
        let Some(webview) = self.shared.borrow().webview.clone() else { return };
        // SAFETY: WebView2's view and a file stream it writes to, on its own thread; the stream
        // is held until it's done.
        unsafe {
            let Ok(stream) = SHCreateStreamOnFileEx(&HSTRING::from(path), (STGM_CREATE | STGM_WRITE).0, 0, true, None) else { return };
            let held = stream.clone();
            let done = webview2_com::CapturePreviewCompletedHandler::create(Box::new(move |_| {
                drop(held);
                Ok(())
            }));
            webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &done).ok();
        }
    }
}

impl Drop for WatchView {
    fn drop(&mut self) {
        if self.subclassed {
            // SAFETY: the subclass this view set, removed on the thread that set it.
            let _ = unsafe { RemoveWindowSubclass(self.shared.borrow().parent, Some(on_window_message), CLICKS) };
        }
        let (controller, parent) = {
            let mut shared = self.shared.borrow_mut();
            shared.webview = None;
            (shared.controller.take(), shared.parent)
        };
        if let Some(controller) = controller {
            // SAFETY: WebView2's controller, closed on its own thread, which ends its browser
            // process once nothing else uses it.
            unsafe { controller.Close().ok() };
        }
        if self.focused.get() {
            // SAFETY: GPUI's own window, on its thread.
            unsafe { SetFocus(Some(parent)).ok() };
        }
    }
}

/// Puts the controller where the frame says, in the window's physical pixels.
fn place(controller: &ICoreWebView2Controller, parent: HWND, (x, y, width, height): (f32, f32, f32, f32)) {
    // SAFETY: GPUI's own window.
    let scale = match unsafe { GetDpiForWindow(parent) } {
        0 => 1.,
        dpi => dpi as f32 / 96.,
    };
    let bounds = RECT { left: (x * scale).round() as i32, top: (y * scale).round() as i32, right: ((x + width) * scale).round() as i32, bottom: ((y + height) * scale).round() as i32 };
    // SAFETY: WebView2's controller, on its own thread.
    unsafe { controller.SetBounds(bounds).ok() };
}

/// Opens a link from the player in the browser, if it's the web's.
fn open_in_browser(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    // SAFETY: a plain call to the shell with strings that outlive it.
    unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
}

/// Whether RivaTuner Statistics Server is running, whose hooks have crashed WebView2's browser
/// process as a video seeks, so that the app can say how to keep them out of it.
pub fn rtss_running() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
    // SAFETY: a snapshot of the system's processes, read and closed here.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more && !found {
            let length = entry.szExeFile.iter().position(|&unit| unit == 0).unwrap_or(entry.szExeFile.len());
            found = String::from_utf16_lossy(&entry.szExeFile[..length]).eq_ignore_ascii_case("RTSS.exe");
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        CloseHandle(snapshot).ok();
        found
    }
}

/// Sets the controller and its view up, once WebView2 has made them.
fn setup(
    shared: &Rc<RefCell<Shared>>,
    environment: &ICoreWebView2Environment,
    controller: &ICoreWebView2Controller,
    page: String,
    origin: &str,
    messages: UnboundedSender<String>,
    focused: Rc<Cell<bool>>,
    failed: Rc<Cell<bool>>,
) -> windows::core::Result<()> {
    let address = format!("{origin}/");
    let mut token = 0i64;
    // SAFETY: WebView2's objects, set up on the thread that made them, with handlers it calls on it.
    unsafe {
        let webview = controller.CoreWebView2()?;
        if let Ok(controller) = controller.cast::<ICoreWebView2Controller2>() {
            // Black while the page loads, as the stage is, rather than white.
            controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 255, R: 0, G: 0, B: 0 })?;
        }
        let settings = webview.Settings()?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        settings.SetAreDevToolsEnabled(cfg!(debug_assertions))?;
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            // No reload, print, find or zoom from the keyboard.
            settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() {
            settings.SetIsGeneralAutofillEnabled(false)?;
            settings.SetIsPasswordAutosaveEnabled(false)?;
        }

        // The page itself, from memory, at its own address and nothing else there.
        webview.AddWebResourceRequestedFilter(&HSTRING::from(format!("{origin}/*")), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        let (environment, wanted) = (environment.clone(), address.clone());
        webview.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Request()?.Uri(&mut uri)?;
                let response = if take_pwstr(uri) == wanted {
                    let stream = SHCreateMemStream(Some(page.as_bytes()));
                    environment.CreateWebResourceResponse(stream.as_ref(), 200, w!("OK"), w!("Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store"))?
                } else {
                    environment.CreateWebResourceResponse(None, 404, w!("Not Found"), PCWSTR::null())?
                };
                args.SetResponse(&response)
            })),
            &mut token,
        )?;

        // Nothing but the page in the main frame: a link pressed in the player opens in the browser.
        let wanted = address.clone();
        webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if uri != wanted {
                    args.SetCancel(true)?;
                    open_in_browser(&uri);
                }
                Ok(())
            })),
            &mut token,
        )?;
        // No new windows: what YouTube opens in one opens in the browser.
        webview.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                open_in_browser(&take_pwstr(uri));
                args.SetHandled(true)
            })),
            &mut token,
        )?;
        // No camera, microphone, location, notifications or anything else it asks for.
        webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)
            })),
            &mut token,
        )?;
        if let Ok(webview) = webview.cast::<ICoreWebView2_4>() {
            webview.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    args.SetCancel(true)?;
                    args.SetHandled(true)
                })),
                &mut token,
            )?;
        }
        // What the page says, from the page alone, which the app checks as anything from outside.
        let source = address.clone();
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut from = PWSTR::null();
                args.Source(&mut from)?;
                if take_pwstr(from) != source {
                    return Ok(());
                }
                let mut text = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut text).is_ok() {
                    let text = take_pwstr(text);
                    if text.len() < 10_000 {
                        messages.unbounded_send(text).ok();
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if let Some(args) = args {
                    args.ProcessFailedKind(&mut kind)?;
                }
                log::warn!("watch: a WebView2 process failed ({})", kind.0);
                // The browser's, or the page's or the player frame's renderer: what's left shows
                // nothing and plays nothing. Chromium starts a GPU or utility process again itself.
                if [
                    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                ]
                .contains(&kind)
                {
                    failed.set(true);
                }
                Ok(())
            })),
            &mut token,
        )?;
        if let Ok(webview) = webview.cast::<ICoreWebView2_8>() {
            // Whether the page plays sound, for the log: the echo canceller doesn't hear it on
            // Windows yet, as process loopback hears nothing from WebView2's processes.
            webview.add_IsDocumentPlayingAudioChanged(
                &webview2_com::IsDocumentPlayingAudioChangedEventHandler::create(Box::new(|sender, _| {
                    let mut playing = windows::core::BOOL(0);
                    if let Some(sender) = sender.and_then(|sender| sender.cast::<ICoreWebView2_8>().ok()) {
                        sender.IsDocumentPlayingAudio(&mut playing)?;
                    }
                    log::info!("watch: the player {} sound", if playing.as_bool() { "plays" } else { "stopped playing" });
                    Ok(())
                })),
                &mut token,
            )?;
        }
        let (got, lost) = (focused.clone(), focused);
        controller.add_GotFocus(&FocusChangedEventHandler::create(Box::new(move |_, _| Ok(got.set(true)))), &mut token)?;
        controller.add_LostFocus(&FocusChangedEventHandler::create(Box::new(move |_, _| Ok(lost.set(false)))), &mut token)?;

        let (parent, frame, hidden) = {
            let mut held = shared.borrow_mut();
            held.controller = Some(controller.clone());
            held.webview = Some(webview.clone());
            (held.parent, held.frame, held.hidden)
        };
        if let Some(frame) = frame {
            place(controller, parent, frame);
        }
        controller.SetIsVisible(!hidden)?;
        webview.Navigate(&HSTRING::from(address))?;
    }
    Ok(())
}

/// The id of the subclass below on GPUI's window, which no one else's shares.
const CLICKS: usize = 0x7a75_6e61;

/// A click elsewhere in GPUI's window while the player has the keyboard gives it back, as
/// Windows only moves the keyboard to a window that asks for it on a click, which GPUI's
/// doesn't. Clicks inside the player go to WebView2's own windows, so the window only gets
/// those outside it.
fn watch_clicks(parent: HWND) -> bool {
    // SAFETY: a subclass on GPUI's window, set and removed on its own thread.
    unsafe { SetWindowSubclass(parent, Some(on_window_message), CLICKS, 0).as_bool() }
}

unsafe extern "system" fn on_window_message(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
    if matches!(message, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_NCLBUTTONDOWN | WM_POINTERDOWN) {
        // SAFETY: plain calls on GPUI's own window, on its thread.
        unsafe {
            let focus = GetFocus();
            if focus != hwnd && !focus.is_invalid() {
                SetFocus(Some(hwnd)).ok();
            }
        }
    }
    // SAFETY: passing the message on to GPUI, as every subclass must.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
