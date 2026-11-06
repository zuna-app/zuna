//! Whether Windows wants quiet right now, for the app's notifications. It draws them
//! itself, so they don't get the rules the system's own do, and Node can't ask. These
//! are the questions Telegram asks: what the shell says about the screen, and which
//! Focus Assist profile is on, which has no public interface.

use windows::{
    core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, PWSTR},
    Win32::{
        System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED},
        UI::Shell::SHQueryUserNotificationState,
    },
};

/// The name the app gives itself to Windows, which a profile's priority list goes by.
const APP_ID: &str = "chat.zuna.app";
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

/// The Focus Assist profile in force, and whether it holds this app back. Telegram found that
/// on Windows 11 the selected profile stays open during Do Not Disturb or a Focus session, so
/// this takes the strictest of the three places a profile can be, and anything that can't be
/// read counts as no.
fn focus_assist() -> (Option<String>, bool) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(settings) = CoCreateInstance::<_, IQuietHoursSettings>(&QUIET_HOURS_SETTINGS, None, CLSCTX_LOCAL_SERVER) else {
            return (None, false);
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
            return (None, false);
        };
        let blocks = match restrictiveness(&strictest) {
            0 => false,
            2 => true,
            _ => !on_priority_list(&settings, &strictest),
        };
        (Some(strictest), blocks)
    }
}

unsafe fn on_priority_list(settings: &IQuietHoursSettings, profile_id: &str) -> bool {
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

/// One line of JSON: `state` is the shell's QUERY_USER_NOTIFICATION_STATE, or 0 if it wouldn't say.
pub fn print() {
    let state = unsafe { SHQueryUserNotificationState() }.map_or(0, |state| state.0);
    let (profile, blocks) = focus_assist();
    println!("{}", serde_json::json!({ "state": state, "focusAssist": blocks, "profile": profile }));
}
