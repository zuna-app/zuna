//! Notifications on macOS are the system's, as the Electron app shows them there, through
//! `UNUserNotificationCenter`, with the same calls as the cards Windows gets in
//! `ui/notifications.rs`: a click opens the chat, and one is taken back when its chat is read
//! or its message deleted. Focus and the person's own settings for Zuna are macOS's to apply,
//! to the banner and to its sound, which goes with it for that reason.
//!
//! Notification Center keeps them after the app quits, so each carries its server, chat and
//! message, and a click on one from before, or a chat read since, finds it by those.
//!
//! GPUI has notifications of its own (`system_notifications.rs`), with only a title, a body
//! and buttons, which are left unused, so that this is the center's delegate.

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
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAttachment, UNNotificationContent, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
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
    center: Option<Center>,
}

/// What a notification says it's about, from what it carries.
#[derive(Clone, Debug)]
struct About {
    server_id: String,
    key: String,
    message_id: String,
}

impl About {
    fn carried(content: &UNNotificationContent) -> Option<About> {
        let info = content.userInfo();
        let read = |name: &str| info.objectForKey(&NSString::from_str(name))?.downcast::<NSString>().ok().map(|text| text.to_string());
        Some(About { server_id: read("server")?, key: read("key")?, message_id: read("message")? })
    }

    fn info(payload: &Payload) -> Retained<NSDictionary> {
        let keys = [NSString::from_str("server"), NSString::from_str("key"), NSString::from_str("message")];
        let values = [NSString::from_str(&payload.server_id), NSString::from_str(&payload.key), NSString::from_str(&payload.message_id)];
        let info: Retained<NSDictionary<NSString, NSString>> = NSDictionary::from_retained_objects(&keys.each_ref().map(|key| &**key), &values);
        // SAFETY: a dictionary of strings is a dictionary of objects, which is all userInfo asks.
        unsafe { Retained::cast_unchecked(info) }
    }
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
    let (clicked, mut clicks) = unbounded::<About>();
    let center = system_center(clicked);
    // What an earlier run left shown is taken back as this run's is, once its chat is read.
    if let Some(center) = &center {
        let (found, earlier) = futures::channel::oneshot::channel::<Vec<(String, String)>>();
        list_delivered(&center.center, move |requests| {
            let chats = requests.iter().filter_map(|request| About::carried(&request.content())).map(|about| (about.server_id, about.key)).collect();
            found.send(chats).ok();
        });
        let state = state.clone();
        cx.spawn(async move |cx| {
            if let Ok(chats) = earlier.await {
                state.update(cx, |state, cx| state.notified_earlier(chats, cx)).ok();
            }
        })
        .detach();
    }
    let entity = cx.new(|_| NotificationCenter { state, center });
    cx.set_global(CenterGlobal(entity.clone()));
    cx.spawn(async move |cx| {
        while let Some(about) = clicks.next().await {
            // A click may be what started the app, when its chats aren't there yet. One that
            // came while starting failed has nothing to open.
            while entity.read_with(cx, |center, cx| center.state.upgrade().is_some_and(|state| matches!(state.read(cx).phase, crate::state::Phase::Booting))) {
                cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
            }
            if entity.read_with(cx, |center, cx| center.state.upgrade().is_some_and(|state| matches!(state.read(cx).phase, crate::state::Phase::Ready))) {
                entity.update(cx, |center, cx| center.clicked(about, cx));
            }
        }
    })
    .detach();
}

/// The center, asked once whether Zuna may show notifications. The center stops a program
/// that isn't in a bundle, as a start from a terminal isn't, so there there's none.
fn system_center(clicked: UnboundedSender<About>) -> Option<Center> {
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
        // SAFETY: the dictionary holds only strings, which a notification can keep.
        unsafe { content.setUserInfo(&About::info(&payload)) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let done = RcBlock::new(|error: *mut NSError| {
            // SAFETY: when it isn't null, the error is valid for the call.
            if let Some(error) = unsafe { error.as_ref() } {
                log::warn!("the notification wasn't shown: {}", error.localizedDescription());
            }
        });
        center.center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
    }

    /// Takes back notifications matching everything given: a server's, read chats', or one
    /// message's, from among all Notification Center shows, this run's or an earlier one's.
    pub fn clear(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, _cx: &mut Context<Self>) {
        let Some(center) = &self.center else { return };
        let (server_id, keys, message_id) = (server_id.map(str::to_string), keys.map(<[String]>::to_vec), message_id.map(str::to_string));
        let matches = move |about: &About| {
            server_id.as_ref().is_none_or(|id| &about.server_id == id) && keys.as_ref().is_none_or(|keys| keys.contains(&about.key)) && message_id.as_ref().is_none_or(|id| &about.message_id == id)
        };
        let system = center.center.clone();
        list_delivered(&center.center, move |requests| {
            let gone: Vec<Retained<NSString>> =
                requests.iter().filter(|request| About::carried(&request.content()).is_some_and(|about| matches(&about))).map(|request| request.identifier()).collect();
            if !gone.is_empty() {
                system.removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&gone));
            }
        });
    }

    /// What a click opens: the chat, in front, as a click on Windows's card does, if its
    /// server is still there.
    fn clicked(&mut self, about: About, cx: &mut Context<Self>) {
        crate::platform::later(cx, crate::platform::show_main);
        if let Some(state) = self.state.upgrade() {
            state.update(cx, |state, cx| {
                if !state.servers.contains_key(&about.server_id) {
                    return;
                }
                state.select_server(&about.server_id, cx);
                state.select_conversation(Some(about.key.clone()), cx);
            });
        }
    }

    /// What macOS says it shows, by title and body, for the checks: an empty list where there's
    /// no center, as outside a bundle.
    #[cfg(feature = "test-control")]
    pub fn delivered(&self) -> futures::channel::oneshot::Receiver<Vec<(String, String)>> {
        let (answer, answered) = futures::channel::oneshot::channel();
        let Some(center) = &self.center else {
            answer.send(Vec::new()).ok();
            return answered;
        };
        list_delivered(&center.center, move |requests| {
            let found = requests
                .iter()
                .map(|request| {
                    let content = request.content();
                    (content.title().to_string(), content.body().to_string())
                })
                .collect();
            answer.send(found).ok();
        });
        answered
    }
}

/// What Notification Center shows of Zuna's, told to `then` on a thread of the center's.
fn list_delivered(center: &UNUserNotificationCenter, then: impl FnOnce(Vec<Retained<UNNotificationRequest>>) + 'static) {
    let then = std::cell::Cell::new(Some(then));
    let listed = RcBlock::new(move |notifications: std::ptr::NonNull<NSArray<UNNotification>>| {
        // SAFETY: the list is valid for the call.
        let notifications = unsafe { notifications.as_ref() };
        if let Some(then) = then.take() {
            then(notifications.iter().map(|notification| notification.request()).collect());
        }
    });
    center.getDeliveredNotificationsWithCompletionHandler(&listed);
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
    clicked: UnboundedSender<About>,
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
            match About::carried(&response.notification().request().content()) {
                Some(about) => drop(self.ivars().clicked.unbounded_send(about)),
                None => log::debug!("a notification without a chat was clicked"),
            }
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
    fn new(clicked: UnboundedSender<About>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { clicked });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
