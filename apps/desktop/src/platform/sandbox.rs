//! The box a linked Telegram account's engine runs in (docs/TELEGRAM_PLAN.md, A process of its
//! own, in a box): whatever breaks in TDLib lands in a process that can reach nothing but its own
//! folder and its pipes to the app, through which the door is its one way out.
//!
//! On Windows that's an AppContainer of its own with no capabilities, which the system keeps from
//! the network, the person's files, the keychain and other processes, given its folder alone, and
//! started with only its three pipes inherited, unable to start a program, and in a job object
//! that ends it with the app. Linux and macOS have no box yet (step 3's Known gap), so the app
//! offers no Telegram there (`telegram::available`), and `plain` is only for building.

use std::fs::File;
use std::path::Path;

/// The engine's process, boxed where this system has the box.
pub struct Spawned {
    pub stdin: File,
    pub stdout: File,
    pub stderr: File,
    pub process: Process,
}

#[cfg(windows)]
pub use windows_box::{Process, forget, spawn};

#[cfg(not(windows))]
pub use plain::{Process, spawn};

/// Forgets the box made for a folder, as the account it held is erased.
#[cfg(not(windows))]
pub fn forget(_folder: &Path) {}

#[cfg(not(windows))]
mod plain {
    use super::*;
    use std::os::fd::OwnedFd;
    use std::process::{Child, Command, Stdio};

    pub struct Process(Child);

    impl Process {
        pub fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
            Ok(self.0.try_wait()?.map(|status| status.code().unwrap_or(-1)))
        }
        pub fn kill(&mut self) {
            self.0.kill().ok();
        }
        pub fn wait(&mut self) {
            self.0.wait().ok();
        }
    }

    /// Not boxed yet on this system: started with nothing of the app's environment.
    pub fn spawn(program: &Path, args: &[&str], folder: &Path) -> std::io::Result<Spawned> {
        let mut child = Command::new(program).args(args).current_dir(folder).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let stdin = File::from(OwnedFd::from(child.stdin.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        let stdout = File::from(OwnedFd::from(child.stdout.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        let stderr = File::from(OwnedFd::from(child.stderr.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        Ok(Spawned { stdin, stdout, stderr, process: Process(child) })
    }
}

#[cfg(windows)]
mod windows_box {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};

    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, LocalFree, SetHandleInformation, WAIT_OBJECT_0};
    use windows::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
    use windows::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, FreeSid, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT};
    use windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT_DESKTOP, JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS, JOB_OBJECT_UILIMIT_GLOBALATOMS,
        JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD, JOBOBJECT_BASIC_UI_RESTRICTIONS,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
        WaitForSingleObject,
    };
    use windows::core::{HSTRING, PCWSTR, PWSTR};

    /// No program may be started from inside (winbase.h).
    const PROCESS_CREATION_CHILD_PROCESS_RESTRICTED: u32 = 0x01;
    // Mitigations it's started under (winnt.h): handles checked strictly, no extension points
    // such as AppInit DLLs, no fonts but the system's, and no image loaded from a share or of
    // low integrity. Its calls into win32k, the system's graphics, stay: OpenSSL links user32.
    const MITIGATIONS: u64 = (1 << 24) | (1 << 32) | (1 << 48) | (1 << 52) | (1 << 56);
    /// The most memory the engine may hold, past which the system ends it, and the broker starts it again.
    const MEMORY_LIMIT: usize = 4 << 30;

    pub struct Process {
        process: OwnedHandle,
        /// Closing it ends the engine, as the app does by going.
        _job: OwnedHandle,
    }

    impl Process {
        pub fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
            let handle = HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&self.process));
            if unsafe { WaitForSingleObject(handle, 0) } != WAIT_OBJECT_0 {
                return Ok(None);
            }
            let mut code = 0u32;
            unsafe { GetExitCodeProcess(handle, &mut code) }.map_err(std::io::Error::other)?;
            Ok(Some(code as i32))
        }

        pub fn kill(&mut self) {
            let handle = HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&self.process));
            unsafe { TerminateProcess(handle, 1) }.ok();
        }

        pub fn wait(&mut self) {
            let handle = HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&self.process));
            unsafe { WaitForSingleObject(handle, INFINITE) };
        }
    }

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// The container for one data folder: each copy of the app, as a development build beside the
    /// installed one, has its own, and so its folder only.
    fn container_name(folder: &Path) -> String {
        use sha2::Digest;
        let hash = sha2::Sha256::digest(folder.to_string_lossy().to_lowercase().as_bytes());
        format!("Zuna.Telegram.{}", hash[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>())
    }

    /// The container's SID, made the first time.
    fn container(name: &str) -> std::io::Result<PSID> {
        let name = HSTRING::from(name);
        match unsafe { CreateAppContainerProfile(&name, &HSTRING::from("Zuna's Telegram engine"), &HSTRING::from("TDLib, kept apart from the rest of Zuna"), None) } {
            Ok(sid) => Ok(sid),
            Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => unsafe { DeriveAppContainerSidFromAppContainerName(&name) }.map_err(std::io::Error::other),
            Err(error) => Err(std::io::Error::other(error)),
        }
    }

    /// Lets the container into one file or folder, and what's under it.
    fn grant(path: &Path, sid: PSID, access: u32) -> std::io::Result<()> {
        let name = HSTRING::from(path.as_os_str());
        let mut old: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let found = unsafe { GetNamedSecurityInfoW(&name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(&mut old), None, &mut descriptor) };
        if found.is_err() {
            return Err(std::io::Error::other(format!("couldn't read who may open {}: {found:?}", path.display())));
        }
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W { TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP, ptstrName: PWSTR(sid.0 as *mut u16), ..Default::default() },
        };
        let mut new: *mut ACL = std::ptr::null_mut();
        let made = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old), &mut new) };
        let result = if made.is_err() {
            Err(std::io::Error::other(format!("couldn't add to who may open {}: {made:?}", path.display())))
        } else {
            let set = unsafe { SetNamedSecurityInfoW(&name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(new), None) };
            if set.is_err() { Err(std::io::Error::other(format!("couldn't let the engine into {}: {set:?}", path.display()))) } else { Ok(()) }
        };
        unsafe {
            if !new.is_null() {
                LocalFree(Some(HLOCAL(new as *mut c_void)));
            }
            if !descriptor.0.is_null() {
                LocalFree(Some(HLOCAL(descriptor.0)));
            }
        }
        result
    }

    /// A pipe whose one end the engine inherits: (the app's end, the engine's end).
    fn pipe(engine_reads: bool) -> std::io::Result<(OwnedHandle, OwnedHandle)> {
        let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() };
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        unsafe { CreatePipe(&mut read, &mut write, Some(&attributes), 0) }.map_err(std::io::Error::other)?;
        let (read, write) = unsafe { (OwnedHandle::from_raw_handle(read.0), OwnedHandle::from_raw_handle(write.0)) };
        let (app, engine) = if engine_reads { (write, read) } else { (read, write) };
        // Only the engine's end is inherited, and only by the engine (the handle list below).
        unsafe { SetHandleInformation(HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&app)), HANDLE_FLAG_INHERIT.0, Default::default()) }.map_err(std::io::Error::other)?;
        Ok((app, engine))
    }

    fn raw(handle: &OwnedHandle) -> HANDLE {
        HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(handle))
    }

    /// Deletes the container made for a folder, whose account has been erased with the folder.
    pub fn forget(folder: &Path) {
        let name = HSTRING::from(container_name(folder));
        unsafe { DeleteAppContainerProfile(&name) }.ok();
    }

    /// Starts `program` in its box, able to read and write `folder` and nothing else of the person's.
    pub fn spawn(program: &Path, args: &[&str], folder: &Path) -> std::io::Result<Spawned> {
        let name = container_name(folder);
        let sid = container(&name)?;
        let started = start(program, args, folder, sid);
        unsafe { FreeSid(sid) };
        started
    }

    fn start(program: &Path, args: &[&str], folder: &Path, sid: PSID) -> std::io::Result<Spawned> {
        grant(folder, sid, FILE_ALL_ACCESS.0)?;

        let (stdin, child_stdin) = pipe(true)?;
        let (stdout, child_stdout) = pipe(false)?;
        let (stderr, child_stderr) = pipe(false)?;
        let inherited = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];

        let capabilities = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
        let child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
        let mitigations = MITIGATIONS;
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(None, 4, None, &mut size) }.ok();
        let mut storage = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr() as *mut c_void);
        unsafe { InitializeProcThreadAttributeList(Some(list), 4, None, &mut size) }.map_err(std::io::Error::other)?;
        let attributes = (|| -> windows::core::Result<()> {
            unsafe {
                UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, Some(&capabilities as *const _ as *const c_void), std::mem::size_of::<SECURITY_CAPABILITIES>(), None, None)?;
                UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, Some(inherited.as_ptr() as *const c_void), std::mem::size_of_val(&inherited), None, None)?;
                UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize, Some(&child_policy as *const _ as *const c_void), std::mem::size_of::<u32>(), None, None)?;
                UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize, Some(&mitigations as *const _ as *const c_void), std::mem::size_of::<u64>(), None, None)?;
            }
            Ok(())
        })();
        if let Err(error) = attributes {
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(std::io::Error::other(error));
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = list;

        // Nothing of the app's environment, but what the system needs to start a program, and the
        // folders it points at the container's own as it starts one in it, which it fails without.
        let mut environment: Vec<u16> = Vec::new();
        for key in ["SystemRoot", "windir", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"] {
            if let Some(value) = std::env::var_os(key) {
                environment.extend(std::ffi::OsString::from(format!("{key}=")).encode_wide());
                environment.extend(value.encode_wide());
                environment.push(0);
            }
        }
        environment.push(0);

        let mut command_line: Vec<u16> = Vec::new();
        for (index, part) in std::iter::once(program.as_os_str().to_owned()).chain(args.iter().map(|arg| std::ffi::OsString::from(arg))).enumerate() {
            if index > 0 {
                command_line.push(' ' as u16);
            }
            command_line.push('"' as u16);
            command_line.extend(part.encode_wide());
            command_line.push('"' as u16);
        }
        command_line.push(0);
        let program_wide = wide(program.as_os_str());
        let folder_wide = wide(folder.as_os_str());

        let mut information = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                PCWSTR(program_wide.as_ptr()),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                true,
                // With no console: a console's host would be a program of its own, which the box doesn't start.
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
                Some(environment.as_ptr() as *const c_void),
                PCWSTR(folder_wide.as_ptr()),
                &startup.StartupInfo,
                &mut information,
            )
        };
        unsafe { DeleteProcThreadAttributeList(list) };
        created.map_err(|error| std::io::Error::other(format!("the engine couldn't start in its box: {error}")))?;
        let process = unsafe { OwnedHandle::from_raw_handle(information.hProcess.0) };
        let thread = unsafe { OwnedHandle::from_raw_handle(information.hThread.0) };

        // In its job before it runs a line: ended with the app, alone in it, and held to a limit.
        let job = (|| -> windows::core::Result<OwnedHandle> {
            let job = unsafe { OwnedHandle::from_raw_handle(CreateJobObjectW(None, PCWSTR::null())?.0) };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            limits.ProcessMemoryLimit = MEMORY_LIMIT;
            unsafe { SetInformationJobObject(raw(&job), JobObjectExtendedLimitInformation, &limits as *const _ as *const c_void, std::mem::size_of_val(&limits) as u32)? };
            let interface = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                    | JOB_OBJECT_UILIMIT_EXITWINDOWS
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS
                    | JOB_OBJECT_UILIMIT_HANDLES
                    | JOB_OBJECT_UILIMIT_READCLIPBOARD
                    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
            };
            unsafe { SetInformationJobObject(raw(&job), JobObjectBasicUIRestrictions, &interface as *const _ as *const c_void, std::mem::size_of_val(&interface) as u32)? };
            unsafe { AssignProcessToJobObject(raw(&job), raw(&process))? };
            Ok(job)
        })();
        let job = match job {
            Ok(job) => job,
            Err(error) => {
                unsafe { TerminateProcess(raw(&process), 1) }.ok();
                return Err(std::io::Error::other(format!("the engine's job couldn't be made: {error}")));
            }
        };
        if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
            unsafe { TerminateProcess(raw(&process), 1) }.ok();
            return Err(std::io::Error::other(format!("the engine couldn't be started: {:?}", unsafe { GetLastError() })));
        }
        drop(thread);
        // The engine's ends are its own now.
        drop((child_stdin, child_stdout, child_stderr));
        Ok(Spawned { stdin: File::from(stdin), stdout: File::from(stdout), stderr: File::from(stderr), process: Process { process, _job: job } })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// What the box allows and refuses, as `zuna-telegram --probe` finds it from inside: run with
    /// `ZUNA_TELEGRAM_PROBE` naming an engine built with `--features probe`, and skipped without.
    #[test]
    fn the_box_holds() {
        let Some(engine) = std::env::var_os("ZUNA_TELEGRAM_PROBE") else {
            eprintln!("ZUNA_TELEGRAM_PROBE isn't set, so the box isn't tried");
            return;
        };
        let base = std::env::temp_dir().join(format!("zuna-box-{}", std::process::id()));
        let own = base.join("telegram");
        std::fs::create_dir_all(&own).unwrap();
        let secret = base.join("device-key.sealed");
        std::fs::write(&secret, b"secret").unwrap();
        let elsewhere = dirs::home_dir().unwrap();
        let args = ["--probe", own.to_str().unwrap(), secret.to_str().unwrap(), elsewhere.to_str().unwrap()];
        let mut spawned = spawn(Path::new(&engine), &args, &own).expect("the engine starts in its box");
        drop(spawned.stdin);
        let mut out = String::new();
        std::io::Read::read_to_string(&mut spawned.stdout, &mut out).unwrap();
        let mut errors = String::new();
        std::io::Read::read_to_string(&mut spawned.stderr, &mut errors).ok();
        spawned.process.wait();
        let code = spawned.process.try_wait().ok().flatten();
        std::fs::remove_dir_all(&base).ok();
        eprintln!("the probe said: {}", out.trim());
        let found: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("the probe said {out:?}, exited {code:?}, and wrote {errors:?}"));
        let said = |key: &str| found[key].as_str().unwrap_or("").to_string();
        for key in ["ownFolder", "loopback"] {
            assert!(said(key).starts_with("allowed"), "{key} is {}", said(key));
        }
        for key in ["readSecret", "listElsewhere", "connectOut", "telegramDirect", "resolve", "startProgram"] {
            assert!(said(key).starts_with("denied"), "{key} is {}", said(key));
        }
    }
}
