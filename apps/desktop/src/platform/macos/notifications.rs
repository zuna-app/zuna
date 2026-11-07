//! Notifications on macOS are the system's, as the Electron app shows them there, through
//! `UNUserNotificationCenter`, with the same calls as the cards Windows gets in
//! `ui/notifications.rs`: a click opens the chat, and one is taken back when its chat is read
//! or its message deleted. Focus and the person's own settings for Zuna are macOS's to apply,
//! to the banner and to its sound, which goes with it for that reason.
//!
//! GPUI has notifications of its own (`system_notifications.rs`), with only a title, a body
//! and buttons, which are left unused, so that this is the center's delegate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use block2::RcBlock;
use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{App, AppContext, Context, Entity, WeakEntity};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAttachment, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use crate::state::AppState;

pub use crate::platform::notification::{Payload, Picture};

/// The sound the bundle carries, written from `notification_tones` as it's built.
pub const SOUND_FILE: &str = "notification.wav";

/// Whether the next notification carries the sound, as the app asked for it just before.
static SOUND_NEXT: AtomicBool = AtomicBool::new(false);

pub fn sound_next() {
    SOUND_NEXT.store(true, Ordering::Relaxed);
}

pub struct NotificationCenter {
    state: WeakEntity<AppState>,
    /// Shown, by the identifier each was asked for with.
    shown: HashMap<String, Payload>,
    center: Option<Center>,
}

/// The system's center, and its delegate, which it only holds weakly.
struct Center {
    center: Retained<UNUserNotificationCenter>,
    _delegate: Retained<Delegate>,
}

#[derive(Clone)]
struct CenterGlobal(Entity<NotificationCenter>);

impl gpui::Global for CenterGlobal {}

pub fn center(cx: &App) -> Option<Entity<NotificationCenter>> {
    cx.try_global::<CenterGlobal>().map(|global| global.0.clone())
}

pub fn install(state: WeakEntity<AppState>, cx: &mut App) {
    let (clicked, mut clicks) = unbounded::<String>();
    let center = system_center(clicked);
    let entity = cx.new(|_| NotificationCenter { state, shown: HashMap::new(), center });
    cx.set_global(CenterGlobal(entity.clone()));
    cx.spawn(async move |cx| {
        while let Some(id) = clicks.next().await {
            entity.update(cx, |center, cx| center.clicked(&id, cx));
        }
    })
    .detach();
}

/// The center, asked once whether Zuna may show notifications. The center stops a program
/// that isn't in a bundle, as a start from a terminal isn't, so there there's none.
fn system_center(clicked: UnboundedSender<String>) -> Option<Center> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        log::info!("no notifications outside an app bundle");
        return None;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = Delegate::new(clicked);
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    let answered = RcBlock::new(|granted: Bool, error: *mut NSError| {
        // SAFETY: when it isn't null, the error is valid for the call.
        if let Some(error) = unsafe { error.as_ref() } {
            log::warn!("asking to show notifications failed: {}", error.localizedDescription());
        } else {
            log::info!("notifications are {}", if granted.as_bool() { "allowed" } else { "turned off" });
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &answered);
    Some(Center { center, _delegate: delegate })
}

impl NotificationCenter {
    /// Shows one.
    pub fn show(&mut self, payload: Payload, _reduce_motion: bool, _cx: &mut Context<Self>) {
        let sound = SOUND_NEXT.swap(false, Ordering::Relaxed);
        let Some(center) = &self.center else { return };
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = format!("zuna-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&payload.title));
        content.setBody(&NSString::from_str(&payload.body));
        // Grouped by chat in Notification Center.
        content.setThreadIdentifier(&NSString::from_str(&format!("{}/{}", payload.server_id, payload.key)));
        if sound {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(SOUND_FILE))));
        }
        if let Some(attachment) = picture_attachment(&id, payload.picture.as_ref()) {
            content.setAttachments(&NSArray::from_retained_slice(&[attachment]));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let done = RcBlock::new(|error: *mut NSError| {
            // SAFETY: when it isn't null, the error is valid for the call.
            if let Some(error) = unsafe { error.as_ref() } {
                log::warn!("the notification wasn't shown: {}", error.localizedDescription());
            }
        });
        center.center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
        self.shown.insert(id, payload);
    }

    /// Takes back notifications matching everything given: a server's, read chats', or one message's.
    pub fn clear(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, _cx: &mut Context<Self>) {
        let matches = |payload: &Payload| {
            server_id.is_none_or(|id| payload.server_id == id) && keys.is_none_or(|keys| keys.contains(&payload.key)) && message_id.is_none_or(|id| payload.message_id == id)
        };
        let gone: Vec<String> = self.shown.iter().filter(|(_, payload)| matches(payload)).map(|(id, _)| id.clone()).collect();
        if gone.is_empty() {
            return;
        }
        for id in &gone {
            self.shown.remove(id);
        }
        if let Some(center) = &self.center {
            let ids: Vec<Retained<NSString>> = gone.iter().map(|id| NSString::from_str(id)).collect();
            center.center.removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&ids));
        }
    }

    /// What a click opens: the chat, in front, as a click on Windows's card does.
    fn clicked(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(payload) = self.shown.remove(id) else { return };
        crate::platform::later(cx, crate::platform::show_main);
        if let Some(state) = self.state.upgrade() {
            state.update(cx, |state, cx| {
                state.select_server(&payload.server_id, cx);
                state.select_conversation(Some(payload.key.clone()), cx);
            });
        }
    }

    /// How many are shown, for the checks.
    #[cfg(feature = "test-control")]
    pub fn shown_count(&self) -> usize {
        self.shown.len()
    }
}

/// The chat's picture, written where the center can take it from, which it moves into its own store.
fn picture_attachment(id: &str, picture: Option<&Picture>) -> Option<Retained<UNNotificationAttachment>> {
    let image = crate::platform::notification::drawn(picture)?;
    let dir: PathBuf = std::env::temp_dir().join("Zuna").join("notifications");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{id}.png"));
    image.save(&path).ok()?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let options = NSDictionary::new();
    // SAFETY: the options are an empty dictionary of the type the method takes.
    unsafe { UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&NSString::from_str("picture"), &url, Some(&options)) }
        .inspect_err(|error| log::warn!("the notification's picture wasn't attached: {}", error.localizedDescription()))
        .ok()
}

struct DelegateIvars {
    clicked: UnboundedSender<String>,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // A click on a notification, perhaps on another thread, handed on to the app's.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, completion: &block2::DynBlock<dyn Fn()>) {
            let id = response.notification().request().identifier().to_string();
            self.ivars().clicked.unbounded_send(id).ok();
            completion.call(());
        }

        // macOS keeps a notification out of sight while its app is in front unless it's told
        // otherwise. The app only asks for one when the chat isn't in front of the person.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
        }
    }
);

impl Delegate {
    fn new(clicked: UnboundedSender<String>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { clicked });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
