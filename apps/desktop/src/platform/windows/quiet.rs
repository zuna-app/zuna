//! Whether Windows wants quiet right now. The app draws its notifications itself, so
//! they don't get the rules the system's own do. These are the questions Telegram asks,
//! as the Electron app's native program asked them: what the shell says about the screen, and which
//! Focus Assist profile is on, which has no public interface.

use std::sync::mpsc::Sender;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::System::Com::{CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, PWSTR, interface};

/// The name the app gives itself to Windows, which a profile's priority list goes by.
use super::AUMID as APP_ID;
const QUIET_HOURS_SETTINGS: GUID = GUID::from_u128(0xf53321fa_34f8_4b7f_b9a3_361877cb94cf);

// Only the methods used here have their real signatures. The others hold their place in the table.

#[interface("e813fe81-62b6-417d-b951-9d2e08486ac1")]
unsafe trait IQuietHoursProfile: IUnknown {
    unsafe fn display_name(&self) -> HRESULT;
    unsafe fn profile_id(&self) -> HRESULT;
    unsafe fn get_setting(&self) -> HRESULT;
    unsafe fn put_setting(&self) -> HRESULT;
    unsafe fn is_customizable(&self) -> HRESULT;
    unsafe fn get_allowed_contacts(&self) -> HRESULT;
    unsafe fn add_allowed_contact(&self) -> HRESULT;
    unsafe fn remove_allowed_contact(&self) -> HRESULT;
    unsafe fn get_allowed_apps(&self, count: *mut u32, apps: *mut *mut PWSTR) -> HRESULT;
}

#[interface("b0217783-87b7-422c-b902-5c148c14f150")]
unsafe trait IQuietMomentsManager: IUnknown {
    unsafe fn get_all_quiet_moment_modes(&self) -> HRESULT;
    unsafe fn get_quiet_moment(&self) -> HRESULT;
    unsafe fn turn_off_currently_active_quiet_moment(&self) -> HRESULT;
    unsafe fn get_active_quiet_moment(&self, id: *mut u32) -> HRESULT;
}

#[interface("6bff4732-81ec-4ffb-ae67-b6c1bc29631f")]
unsafe trait IQuietHoursSettings: IUnknown {
    unsafe fn get_user_selected_profile(&self, id: *mut PWSTR) -> HRESULT;
    unsafe fn put_user_selected_profile(&self) -> HRESULT;
    unsafe fn get_profile(&self, id: PWSTR, profile: *mut Option<IQuietHoursProfile>) -> HRESULT;
    unsafe fn get_all_profile_data(&self) -> HRESULT;
    unsafe fn get_display_name_for_profile(&self) -> HRESULT;
    unsafe fn get_quiet_moments_manager(&self, manager: *mut Option<IQuietMomentsManager>) -> HRESULT;
    unsafe fn get_off_profile_id(&self) -> HRESULT;
    unsafe fn get_active_quiet_moment_profile(&self, id: *mut PWSTR) -> HRESULT;
    unsafe fn put_active_quiet_moment_profile(&self) -> HRESULT;
    unsafe fn get_active_profile(&self, id: *mut PWSTR) -> HRESULT;
}

fn read(id: PWSTR) -> Option<String> {
    if id.is_null() {
        return None;
    }
    unsafe { id.to_string() }.ok().filter(|text| !text.is_empty())
}

/// How much a profile holds back, by the end of its name.
fn restrictiveness(profile: &str) -> u8 {
    let name = profile.to_ascii_lowercase();
    if name.ends_with(".alarmsonly") {
        2
    } else if name.ends_with(".priorityonly") {
        1
    } else {
        0
    }
}

/// Whether Focus Assist holds this app back, taking the strictest of the three places a
/// profile can be, as Telegram found Windows 11 needs. Anything unreadable counts as no.
fn focus_assist() -> bool {
    unsafe {
        let Ok(settings) = CoCreateInstance::<_, IQuietHoursSettings>(&QUIET_HOURS_SETTINGS, None, CLSCTX_LOCAL_SERVER) else {
            return false;
        };
        let mut profiles = Vec::new();
        let mut active = PWSTR::null();
        if settings.get_active_profile(&mut active).is_ok() {
            profiles.extend(read(active));
        }
        let mut manager = None;
        if settings.get_quiet_moments_manager(&mut manager).is_ok() {
            let mut moment = 0;
            if manager.is_some_and(|manager: IQuietMomentsManager| manager.get_active_quiet_moment(&mut moment).is_ok()) && moment != 0 {
                let mut profile = PWSTR::null();
                if settings.get_active_quiet_moment_profile(&mut profile).is_ok() {
                    profiles.extend(read(profile));
                }
            }
        }
        let mut selected = PWSTR::null();
        if settings.get_user_selected_profile(&mut selected).is_ok() {
            profiles.extend(read(selected));
        }
        let Some(strictest) = profiles.into_iter().max_by_key(|profile| restrictiveness(profile)) else {
            return false;
        };
        match restrictiveness(&strictest) {
            0 => false,
            2 => true,
            _ => !on_priority_list(&settings, &strictest),
        }
    }
}

unsafe fn on_priority_list(settings: &IQuietHoursSettings, profile_id: &str) -> bool {
    unsafe {
        let mut wide: Vec<u16> = profile_id.encode_utf16().chain([0]).collect();
        let mut profile = None;
        if settings.get_profile(PWSTR(wide.as_mut_ptr()), &mut profile).is_err() {
            return false;
        }
        let Some(profile) = profile else {
            return false;
        };
        let (mut count, mut apps) = (0, std::ptr::null_mut());
        if profile.get_allowed_apps(&mut count, &mut apps).is_err() || apps.is_null() {
            return false;
        }
        std::slice::from_raw_parts(apps, count as usize).iter().filter_map(|app| read(*app)).any(|app| app.eq_ignore_ascii_case(APP_ID))
    }
}

use crate::platform::NotificationState;

// Windows's QUERY_USER_NOTIFICATION_STATE.
const NOT_PRESENT: i32 = 1;
const BUSY: i32 = 2;
const FULL_SCREEN_D3D: i32 = 3;
const PRESENTATION: i32 = 4;

/// What Windows last said it wants, and when, kept by the thread that asks it.
static LAST: Mutex<Option<(Instant, NotificationState)>> = Mutex::new(None);
static ANSWERED: Condvar = Condvar::new();

fn ask_windows() -> NotificationState {
    let shell = unsafe { SHQueryUserNotificationState() }.map_or(0, |state| state.0);
    let focus = focus_assist();
    // The same rules as Telegram's, and the Electron app's.
    NotificationState {
        show: shell != PRESENTATION && shell != FULL_SCREEN_D3D && !focus,
        sound: shell != NOT_PRESENT && shell != PRESENTATION && !focus,
        wait_for_input: shell != BUSY,
    }
}

/// A thread of its own that asks Windows when told to. Focus Assist is asked through a COM
/// server in another process, which can take a while, or not answer, and the window's thread
/// mustn't wait on it.
fn asker() -> &'static Sender<()> {
    static ASKER: OnceLock<Sender<()>> = OnceLock::new();
    ASKER.get_or_init(|| {
        let (send, asked) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("zuna-quiet".into())
            .spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                while asked.recv().is_ok() {
                    // A burst of messages asks once.
                    while asked.try_recv().is_ok() {}
                    let state = ask_windows();
                    *LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), state));
                    ANSWERED.notify_all();
                }
            })
            .ok();
        send
    })
}

/// What Windows wants now: the last answer straight away, asked again in the background when
/// it's more than a second old. Only the first time is an answer waited for, briefly, and
/// anything unanswered counts as no quiet.
pub fn notification_state() -> NotificationState {
    // Tests show every notification, whatever Focus or a full-screen app on this computer says.
    if cfg!(test) {
        return NotificationState { show: true, sound: true, wait_for_input: true };
    }
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if last.is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(1)) {
        asker().send(()).ok();
    }
    if last.is_none() {
        last = ANSWERED.wait_timeout_while(last, Duration::from_millis(300), |last| last.is_none()).map(|(last, _)| last).unwrap_or_else(|poisoned| poisoned.into_inner().0);
    }
    last.map_or(NotificationState { show: true, sound: true, wait_for_input: true }, |(_, state)| state)
}
