//! The player a video watched together plays in on macOS: a WKWebView holding `watch.html`
//! from packages/watch and nothing else, laid over the GPUI window where the stage's tile is,
//! as the iPhone app holds it (apps/ios/Zuna/Voice/Watch.swift). It's loaded under
//! `https://chat.zuna.desktop`, the Referer YouTube needs, keeps no data, frames YouTube's player
//! alone under the page's content security policy, opens a link pressed in it in the browser,
//! opens no window, and gets no camera or microphone. It draws over whatever GPUI draws inside
//! its rectangle, so whoever holds it hides it while something of GPUI's is on top. With a proxy
//! set (host/net.rs), everything it loads goes through it, and nothing while it can't be had.

use std::ptr::NonNull;

use block2::RcBlock;
use futures::channel::mpsc::UnboundedSender;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSEvent, NSEventMask, NSView, NSWorkspace};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_web_kit::{
    WKAudiovisualMediaTypes, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType, WKScriptMessage, WKScriptMessageHandler, WKUIDelegate, WKUserContentController,
    WKWebView, WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

#[link(name = "Network", kind = "framework")]
unsafe extern "C" {
    fn nw_endpoint_create_host(hostname: *const std::ffi::c_char, port: *const std::ffi::c_char) -> *mut AnyObject;
    fn nw_proxy_config_create_socksv5(endpoint: *mut AnyObject) -> *mut AnyObject;
    fn nw_proxy_config_set_username_and_password(config: *mut AnyObject, username: *const std::ffi::c_char, password: *const std::ffi::c_char);
    fn nw_proxy_config_set_failover_allowed(config: *mut AnyObject, allowed: bool);
}

/// Has a data store load everything through the SOCKS5 proxy, which signs in where it has a
/// username, and never around it (`proxyConfigurations`, macOS 14). None if it can't be made,
/// and the player isn't made either.
///
/// SAFETY: on the main thread, with a store of WebKit's.
unsafe fn through_proxy(store: &WKWebsiteDataStore, proxy: &crate::host::net::Proxy) -> Option<()> {
    use std::ffi::CString;
    let host = CString::new(proxy.host.as_str()).ok()?;
    let port = CString::new(proxy.port.to_string()).ok()?;
    unsafe {
        let endpoint = nw_endpoint_create_host(host.as_ptr(), port.as_ptr());
        let endpoint: Retained<AnyObject> = Retained::from_raw(endpoint)?;
        let config: Retained<AnyObject> = Retained::from_raw(nw_proxy_config_create_socksv5(Retained::as_ptr(&endpoint) as *mut AnyObject))?;
        if !proxy.username.is_empty() {
            let username = CString::new(proxy.username.as_str()).ok()?;
            let password = CString::new(proxy.password.as_str()).ok()?;
            nw_proxy_config_set_username_and_password(Retained::as_ptr(&config) as *mut AnyObject, username.as_ptr(), password.as_ptr());
        }
        nw_proxy_config_set_failover_allowed(Retained::as_ptr(&config) as *mut AnyObject, false);
        let configurations = objc2_foundation::NSArray::from_retained_slice(&[config]);
        let _: () = msg_send![store, setProxyConfigurations: &*configurations];
        let set: Option<Retained<objc2_foundation::NSArray<AnyObject>>> = msg_send![store, proxyConfigurations];
        log::info!("watch: the player goes through the proxy at {proxy:?} ({} configuration)", set.map(|set| set.count()).unwrap_or(0));
    }
    Some(())
}

/// The name the page posts its messages to (`window.webkit.messageHandlers.zuna`).
const HANDLER: &str = "zuna";

struct Ivars {
    messages: UnboundedSender<String>,
    /// The page's own host, the one main-frame load allowed.
    host: String,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl WKScriptMessageHandler for Delegate {
        // What the page says, which the app checks as anything from outside.
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            // SAFETY: the message and its frame are WebKit's, read on the main thread it calls this on.
            unsafe {
                if !message.frameInfo().isMainFrame() {
                    return;
                }
                let body = message.body();
                if let Some(text) = body.downcast_ref::<NSString>() {
                    let text = text.to_string();
                    if text.len() < 10_000 {
                        self.ivars().messages.unbounded_send(text).ok();
                    }
                }
            }
        }
    }

    unsafe impl WKNavigationDelegate for Delegate {
        // The page itself, and YouTube's frames inside it. A link pressed in the player opens in the browser.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(&self, _web: &WKWebView, action: &WKNavigationAction, decision: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            // SAFETY: WebKit's action, read on the main thread.
            let (main_frame, url, kind) = unsafe { (action.targetFrame().map(|frame| frame.isMainFrame()), action.request().URL(), action.navigationType()) };
            if main_frame == Some(false) {
                return decision.call((WKNavigationActionPolicy::Allow,));
            }
            let host = url.as_ref().and_then(|url| url.host()).map(|host| host.to_string());
            if host.as_deref() == Some(self.ivars().host.as_str()) && kind == WKNavigationType::Other {
                return decision.call((WKNavigationActionPolicy::Allow,));
            }
            if let Some(url) = url.filter(|url| url.scheme().is_some_and(|scheme| scheme.to_string() == "https" || scheme.to_string() == "http")) {
                NSWorkspace::sharedWorkspace().openURL(&url);
            }
            decision.call((WKNavigationActionPolicy::Cancel,));
        }
    }

    unsafe impl WKUIDelegate for Delegate {
        // No new windows: what YouTube opens in one opens in the browser.
        #[unsafe(method(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create(&self, _web: &WKWebView, _configuration: &WKWebViewConfiguration, action: &WKNavigationAction, _features: &WKWindowFeatures) -> *mut WKWebView {
            // SAFETY: WebKit's action, read on the main thread.
            if let Some(url) = unsafe { action.request().URL() } {
                if url.scheme().is_some_and(|scheme| scheme.to_string() == "https") {
                    NSWorkspace::sharedWorkspace().openURL(&url);
                }
            }
            std::ptr::null_mut()
        }
    }
);

impl Delegate {
    fn new(mtm: MainThreadMarker, messages: UnboundedSender<String>, host: String) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { messages, host });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

pub struct WatchView {
    web: Retained<WKWebView>,
    parent: Retained<NSView>,
    _delegate: Retained<Delegate>,
    /// Gives the keyboard back to GPUI when a click lands outside the player.
    monitor: Option<Retained<AnyObject>>,
}

impl WatchView {
    /// Puts the page in the window, hidden until it's given a place. `page` is `watch.html`,
    /// `origin` the address it's loaded under, and what it says comes to `messages`.
    pub fn new(window: &gpui::Window, page: &str, origin: &str, messages: UnboundedSender<String>) -> Option<WatchView> {
        let mtm = MainThreadMarker::new()?;
        let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else { return None };
        let view: NonNull<NSView> = handle.ns_view.cast();
        // SAFETY: GPUI's own NSView, alive as long as its window, which outlives what's in it.
        let parent = unsafe { Retained::retain(view.as_ptr())? };
        let base = NSURL::URLWithString(&NSString::from_str(origin))?;
        let host = base.host()?.to_string();
        let delegate = Delegate::new(mtm, messages, host);
        // SAFETY: WebKit's configuration and view, made and used on the main thread.
        let web = unsafe {
            let configuration = WKWebViewConfiguration::new(mtm);
            // It keeps nothing: no cookie outlives a session.
            let store = WKWebsiteDataStore::nonPersistentDataStore(mtm);
            if let Some(proxy) = crate::host::net::proxy() {
                if through_proxy(&store, &proxy).is_none() {
                    log::warn!("watch: the player's proxy couldn't be set, so it isn't made");
                    return None;
                }
            }
            configuration.setWebsiteDataStore(&store);
            configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
            configuration.userContentController().addScriptMessageHandler_name(ProtocolObject::from_ref(&*delegate), &NSString::from_str(HANDLER));
            let web = WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), CGRect::new(CGPoint::new(0., 0.), CGSize::new(1., 1.)), &configuration);
            web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            web.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            web.setHidden(true);
            parent.addSubview(&web);
            web.loadHTMLString_baseURL(&NSString::from_str(page), Some(&base));
            web
        };
        let monitor = Self::watch_clicks(&web, &parent);
        Some(WatchView { web, parent, _delegate: delegate, monitor })
    }

    /// A click on GPUI's own view while the player has the keyboard gives it back, as AppKit
    /// only moves it to a view that asks for it, which GPUI's doesn't.
    fn watch_clicks(web: &Retained<WKWebView>, parent: &Retained<NSView>) -> Option<Retained<AnyObject>> {
        let (web, parent) = (web.clone(), parent.clone());
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit's event, handed back as it came, on the main thread.
            unsafe {
                let event_ref = event.as_ref();
                let Some(window) = parent.window() else { return event.as_ptr() };
                let Some(mtm) = MainThreadMarker::new() else { return event.as_ptr() };
                if event_ref.window(mtm).is_some_and(|other| Retained::as_ptr(&other) == Retained::as_ptr(&window)) {
                    let at = web.convertPoint_fromView(event_ref.locationInWindow(), None);
                    let bounds = web.bounds();
                    let inside = !web.isHidden() && at.x >= 0. && at.y >= 0. && at.x <= bounds.size.width && at.y <= bounds.size.height;
                    let responder = window.firstResponder();
                    let in_player = responder.is_some_and(|responder| {
                        let responder: *const AnyObject = Retained::as_ptr(&responder).cast();
                        let view: Option<&NSView> = (*responder).downcast_ref::<NSView>();
                        view.is_some_and(|view| view.isDescendantOf(&web))
                    });
                    if !inside && in_player {
                        window.makeFirstResponder(Some(&parent));
                    }
                }
                event.as_ptr()
            }
        });
        // SAFETY: a local monitor for the app's own events, removed when the player goes.
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block) }
    }

    /// Where the player goes, in the window's own logical coordinates from its top left.
    pub fn set_frame(&self, x: f32, y: f32, width: f32, height: f32) {
        let bounds = self.parent.bounds();
        let top = if self.parent.isFlipped() { y as f64 } else { bounds.size.height - y as f64 - height as f64 };
        let frame = CGRect::new(CGPoint::new(x as f64, top), CGSize::new(width.max(1.) as f64, height.max(1.) as f64));
        if self.web.frame() != frame {
            self.web.setFrame(frame);
        }
    }

    pub fn set_hidden(&self, hidden: bool) {
        if self.web.isHidden() != hidden {
            self.web.setHidden(hidden);
        }
    }

    /// Tells the page something, as JSON the app made.
    pub fn send(&self, json: &str) {
        let script = format!("window.zunaWatch && window.zunaWatch.receive({json})");
        // SAFETY: evaluated on the main thread, with no completion to call.
        unsafe { self.web.evaluateJavaScript_completionHandler(&NSString::from_str(&script), None) };
    }
}

impl Drop for WatchView {
    fn drop(&mut self) {
        // SAFETY: WebKit's view and AppKit's monitor, let go of on the main thread.
        unsafe {
            if let Some(monitor) = self.monitor.take() {
                NSEvent::removeMonitor(&monitor);
            }
            self.web.configuration().userContentController().removeScriptMessageHandlerForName(&NSString::from_str(HANDLER));
            self.web.stopLoading();
            self.web.removeFromSuperview();
        }
    }
}
