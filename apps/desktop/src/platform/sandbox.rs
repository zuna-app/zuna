//! The box a linked Telegram account's engine runs in (docs/TELEGRAM_PLAN.md, A process of its
//! own, in a box): whatever breaks in TDLib lands in a process that can reach nothing but its own
//! folder and its pipes to the app, through which the door is its one way out.
//!
//! On Windows that's an AppContainer of its own with no capabilities, which the system keeps from
//! the network, the person's files, the keychain and other processes, given its folder alone, and
//! started with only its three pipes inherited, unable to start a program, and in a job object
//! that ends it with the app.
//!
//! On Linux it's made of what the kernel gives any program, in two halves. The app's, between
//! fork and exec (`linux_box`): namespaces of its own for a user, the network and System V IPC, so
//! that the only network it sees is its own loopback, where the door is, and it sees none of other
//! programs' shared memory or abstract sockets; Landlock, which lets it open its folder and its own
//! program and nothing else, and from kernel 6.12 keeps its signals and abstract sockets inside;
//! no new privileges, no core dump, a limit on its memory, nothing the app has open but its
//! three pipes, and an end when the app's comes, as Windows' job object gives it. The engine's, before it runs a line of TDLib's (`telegram/src/lockdown.rs`):
//! seccomp, and Landlock again for TCP, which holds it to the door's port where a distribution
//! keeps namespaces from programs. Its program is linked whole, so it needs no file of the
//! system's.
//!
//! On macOS it's Seatbelt, the kernel's sandbox, with a profile of the engine's own, which it
//! closes behind itself before it runs a line of TDLib's (`telegram/src/seatbelt.rs`): its folder,
//! its own loopback at the door's port, and nothing else. The app's half (`macos_box`) starts it
//! with its three pipes alone, as Windows' handle list and Linux's `close_range` do, and nothing
//! of its environment, then asks the system from outside whether the box holds before it lets the
//! broker send a thing: that the engine is boxed, may not read the app's data folder, and may not
//! make a process. The engine's own half ends it with the app.
//!
//! `plain` is only for the broker's tests, and building elsewhere.

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

#[cfg(all(unix, not(target_os = "macos")))]
pub use plain::Process;
#[cfg(target_os = "linux")]
pub use linux_box::{spawn, supported};
#[cfg(target_os = "macos")]
pub use macos_box::{Process, spawn, supported};
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub use plain::spawn;

/// Whether this system can box the engine at all.
#[cfg(windows)]
pub fn supported() -> bool {
    true
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn supported() -> bool {
    false
}

/// Forgets the box made for a folder, as the account it held is erased.
#[cfg(not(windows))]
pub fn forget(_folder: &Path) {}

/// Starts the engine without a box, as the broker's tests do with a stand-in for it.
#[cfg(all(test, unix, not(target_os = "macos")))]
pub fn spawn_unboxed(program: &Path, args: &[&str], folder: &Path) -> std::io::Result<Spawned> {
    plain::spawned(plain::command(program, args, folder).spawn()?)
}
#[cfg(all(test, target_os = "macos"))]
pub fn spawn_unboxed(program: &Path, args: &[&str], folder: &Path) -> std::io::Result<Spawned> {
    macos_box::start(program, args, folder, false)
}

#[cfg(all(unix, not(target_os = "macos")))]
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

    /// The engine's command: in its folder, with its three pipes and nothing of the app's environment.
    pub fn command(program: &Path, args: &[&str], folder: &Path) -> Command {
        let mut command = Command::new(program);
        command.args(args).current_dir(folder).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    pub fn spawned(mut child: Child) -> std::io::Result<Spawned> {
        let stdin = File::from(OwnedFd::from(child.stdin.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        let stdout = File::from(OwnedFd::from(child.stdout.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        let stderr = File::from(OwnedFd::from(child.stderr.take().ok_or_else(|| std::io::Error::other("no pipe"))?));
        Ok(Spawned { stdin, stdout, stderr, process: Process(child) })
    }

    /// Not boxed on this system.
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn spawn(program: &Path, args: &[&str], folder: &Path) -> std::io::Result<Spawned> {
        spawned(command(program, args, folder).spawn()?)
    }
}

#[cfg(target_os = "linux")]
#[path = "../../telegram/src/confine.rs"]
mod confine;

#[cfg(target_os = "linux")]
mod linux_box {
    use super::*;
    use std::io::{Error, Result};
    use std::os::fd::RawFd;
    use std::os::unix::process::CommandExt;
    use std::sync::OnceLock;

    use super::confine;

    /// A user, a network and System V IPC of its own.
    const NAMESPACES: libc::c_int = libc::CLONE_NEWUSER | libc::CLONE_NEWNET | libc::CLONE_NEWIPC;
    /// The most memory the engine may write to, past which it gets none, as Windows' job holds it.
    const MEMORY_LIMIT: libc::rlim_t = 4 << 30;

    /// Brings up the loopback of a network namespace just made, which starts down, and where the
    /// door is. Only plain system calls, as it runs between fork and exec.
    fn loopback_up() -> bool {
        unsafe {
            let socket = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
            if socket < 0 {
                return false;
            }
            let mut request: libc::ifreq = std::mem::zeroed();
            request.ifr_name[0] = b'l' as libc::c_char;
            request.ifr_name[1] = b'o' as libc::c_char;
            let mut up = libc::ioctl(socket, libc::SIOCGIFFLAGS, &mut request) == 0;
            if up {
                request.ifr_ifru.ifru_flags |= libc::IFF_UP as libc::c_short;
                up = libc::ioctl(socket, libc::SIOCSIFFLAGS, &request) == 0;
            }
            libc::close(socket);
            up
        }
    }

    /// Whether a program may have namespaces of its own here, as most distributions let it and
    /// some don't, tried once in a child that does nothing else.
    fn namespaces_work() -> bool {
        static WORKS: OnceLock<bool> = OnceLock::new();
        *WORKS.get_or_init(|| unsafe {
            match libc::fork() {
                0 => libc::_exit(if libc::unshare(NAMESPACES) == 0 && loopback_up() { 0 } else { 1 }),
                -1 => false,
                child => {
                    let mut status = 0;
                    libc::waitpid(child, &mut status, 0) == child && libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
                }
            }
        })
    }

    /// Whether the engine can be boxed here: Landlock for its files, and for its network either a
    /// namespace of its own or, from kernel 6.7, Landlock for TCP.
    pub fn supported() -> bool {
        let abi = confine::abi();
        abi >= 4 || (abi >= 1 && namespaces_work())
    }

    /// Starts `program` in its box, able to read and write `folder` and nothing else of the person's.
    pub fn spawn(program: &Path, args: &[&str], folder: &Path) -> Result<Spawned> {
        let abi = confine::abi();
        if abi == 0 {
            return Err(Error::other("this system has no Landlock, which the engine's box is made of"));
        }
        let namespaces = namespaces_work();
        if !namespaces && abi < 4 {
            return Err(Error::other("this system lets a program have no network of its own, and is too old to hold one to a port"));
        }
        if !namespaces {
            log::info!(target: "telegram", "no namespaces for the engine here, so Landlock alone holds it to its port");
        }
        // Made here, as nothing may be allocated in the child.
        let ruleset = confine::Ruleset::new(confine::files(abi), 0, confine::scopes(abi))?;
        ruleset.allow_path(program, confine::READ_FILE | confine::EXECUTE)?;
        ruleset.allow_path(folder, confine::files(abi))?;
        let rules = ruleset.raw();
        let app = std::process::id() as libc::pid_t;
        let mut command = plain::command(program, args, folder);
        unsafe { command.pre_exec(move || enter(rules, namespaces, app)) };
        let child = on_spawner(move || command.spawn())?;
        drop(ruleset);
        plain::spawned(child)
    }

    /// Runs `work` on one thread that lasts as long as the app, which starts every engine: the
    /// signal that ends the engine with the app is sent when the thread that started it goes,
    /// and the broker starts one again from threads that end.
    fn on_spawner<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
        type Work = Box<dyn FnOnce() + Send>;
        static SPAWNER: OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Work>>> = OnceLock::new();
        let spawner = SPAWNER.get_or_init(|| {
            let (sender, works) = std::sync::mpsc::channel::<Work>();
            std::thread::Builder::new()
                .name("telegram-spawner".into())
                .spawn(move || {
                    for work in works {
                        work();
                    }
                })
                .expect("a thread");
            std::sync::Mutex::new(sender)
        });
        let (done, result) = std::sync::mpsc::sync_channel(1);
        let work: Work = Box::new(move || {
            done.send(work()).ok();
        });
        spawner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).send(work).expect("the spawner runs");
        result.recv().expect("the spawner answers")
    }

    /// In the engine's process, between fork and exec: only plain system calls, and an error
    /// made from a number, as nothing may be allocated here.
    fn enter(rules: RawFd, namespaces: bool, app: libc::pid_t) -> Result<()> {
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(Error::last_os_error());
            }
            if namespaces {
                if libc::unshare(NAMESPACES) != 0 {
                    return Err(Error::last_os_error());
                }
                if !loopback_up() {
                    return Err(Error::from_raw_os_error(libc::ENETDOWN));
                }
            }
            // Ended with the app, as Windows' job ends it, so that a copy left running never
            // holds TDLib's database from the next: set after the namespaces, whose new
            // credentials would clear it, and with the app checked for after, if it went before.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                return Err(Error::last_os_error());
            }
            if libc::getppid() != app {
                return Err(Error::from_raw_os_error(libc::ESRCH));
            }
            // No core dump, which would hold the session's keys, and a limit on its memory.
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            let memory = libc::rlimit { rlim_cur: MEMORY_LIMIT, rlim_max: MEMORY_LIMIT };
            if libc::setrlimit(libc::RLIMIT_CORE, &none) != 0 || libc::setrlimit(libc::RLIMIT_DATA, &memory) != 0 {
                return Err(Error::last_os_error());
            }
            confine::restrict(rules)?;
            // Whatever else the app has open, as a library's socket left open across exec would
            // be, stays with the app: the engine keeps its three pipes alone.
            if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, libc::CLOSE_RANGE_CLOEXEC) != 0 {
                return Err(Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos_box {
    use super::*;
    use std::ffi::{CString, c_char, c_int, c_void};
    use std::io::{Error, Result};
    use std::os::fd::{FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::time::{Duration, Instant};

    /// How long the engine has to close its box behind it, which takes it a few milliseconds,
    /// and longer the first time macOS sees a new build of it.
    const BOXING: Duration = Duration::from_secs(15);

    /// libsystem_sandbox's, which says whether a process may do something, or is boxed at all.
    /// Looked up as the app runs, so that a macOS without it has no Telegram rather than no app.
    type SandboxCheck = unsafe extern "C" fn(libc::pid_t, *const c_char, c_int, ...) -> c_int;
    const SANDBOX_FILTER_NONE: c_int = 0;
    const SANDBOX_FILTER_PATH: c_int = 1;

    unsafe extern "C" {
        // macOS 10.15's, which the libc crate doesn't have.
        fn posix_spawn_file_actions_addchdir_np(actions: *mut libc::posix_spawn_file_actions_t, path: *const c_char) -> c_int;
    }

    fn symbol(name: &std::ffi::CStr) -> *mut c_void {
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }
    }

    fn sandbox_check() -> Option<SandboxCheck> {
        let found = symbol(c"sandbox_check");
        (!found.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, SandboxCheck>(found) })
    }

    /// Whether this macOS has Seatbelt as the engine and the app use it.
    pub fn supported() -> bool {
        sandbox_check().is_some() && !symbol(c"sandbox_init_with_parameters").is_null()
    }

    pub struct Process {
        pid: libc::pid_t,
        /// How it ended, once it's been waited for, after which its ID may be another's.
        ended: Option<i32>,
    }

    fn code(status: c_int) -> i32 {
        if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 }
    }

    impl Process {
        pub fn try_wait(&mut self) -> Result<Option<i32>> {
            if self.ended.is_none() {
                let mut status = 0;
                match unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) } {
                    0 => {}
                    -1 => return Err(Error::last_os_error()),
                    _ => self.ended = Some(code(status)),
                }
            }
            Ok(self.ended)
        }

        pub fn kill(&mut self) {
            if self.ended.is_none() {
                unsafe { libc::kill(self.pid, libc::SIGKILL) };
            }
        }

        pub fn wait(&mut self) {
            while self.ended.is_none() {
                let mut status = 0;
                match unsafe { libc::waitpid(self.pid, &mut status, 0) } {
                    -1 if Error::last_os_error().kind() == std::io::ErrorKind::Interrupted => {}
                    -1 => self.ended = Some(-1),
                    _ => self.ended = Some(code(status)),
                }
            }
        }
    }

    /// A pipe, both ends closed on exec, so that no other program the app starts takes either:
    /// (read, write).
    fn pipe() -> Result<(OwnedFd, OwnedFd)> {
        let mut ends: [RawFd; 2] = [0; 2];
        if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
            return Err(Error::last_os_error());
        }
        let ends = unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        for end in [&ends.0, &ends.1] {
            if unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(end), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                return Err(Error::last_os_error());
            }
        }
        Ok(ends)
    }

    fn c_path(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(Error::other)
    }

    /// Starts `program` in its box, able to read and write `folder` and nothing else of the person's.
    pub fn spawn(program: &Path, args: &[&str], folder: &Path) -> Result<Spawned> {
        start(program, args, folder, true)
    }

    /// Starts `program` in `folder` with its three pipes alone and an empty environment, and with
    /// `boxed` waits until the system says its box holds.
    pub fn start(program: &Path, args: &[&str], folder: &Path, boxed: bool) -> Result<Spawned> {
        use std::os::fd::AsRawFd;
        let (stdin, child_stdin) = {
            let (read, write) = pipe()?;
            (write, read)
        };
        let (stdout, child_stdout) = pipe()?;
        let (stderr, child_stderr) = pipe()?;

        let program_c = c_path(program)?;
        let folder_c = c_path(folder)?;
        let owned: Vec<CString> = std::iter::once(Ok(program_c.clone())).chain(args.iter().map(|arg| CString::new(*arg).map_err(Error::other))).collect::<Result<_>>()?;
        let argv: Vec<*mut c_char> = owned.iter().map(|arg| arg.as_ptr() as *mut c_char).chain(std::iter::once(std::ptr::null_mut())).collect();
        let envp: [*mut c_char; 1] = [std::ptr::null_mut()];

        let mut pid: libc::pid_t = 0;
        let spawned = unsafe {
            let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
            let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
            let mut result = libc::posix_spawn_file_actions_init(&mut actions);
            if result == 0 {
                result = libc::posix_spawnattr_init(&mut attributes);
            }
            if result == 0 {
                for (from, to) in [(&child_stdin, 0), (&child_stdout, 1), (&child_stderr, 2)] {
                    if result == 0 {
                        result = libc::posix_spawn_file_actions_adddup2(&mut actions, from.as_raw_fd(), to);
                    }
                }
            }
            if result == 0 {
                result = posix_spawn_file_actions_addchdir_np(&mut actions, folder_c.as_ptr());
            }
            if result == 0 {
                // Every descriptor of the app's but the three closed, its signals as a new
                // program's, and none held back.
                let flags = libc::POSIX_SPAWN_CLOEXEC_DEFAULT | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_SETSIGMASK;
                result = libc::posix_spawnattr_setflags(&mut attributes, flags as libc::c_short);
            }
            if result == 0 {
                let mut every: libc::sigset_t = std::mem::zeroed();
                libc::sigfillset(&mut every);
                result = libc::posix_spawnattr_setsigdefault(&mut attributes, &every);
            }
            if result == 0 {
                let mut none: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut none);
                result = libc::posix_spawnattr_setsigmask(&mut attributes, &none);
            }
            if result == 0 {
                result = libc::posix_spawn(&mut pid, program_c.as_ptr(), &actions, &attributes, argv.as_ptr(), envp.as_ptr());
            }
            if !actions.is_null() {
                libc::posix_spawn_file_actions_destroy(&mut actions);
            }
            if !attributes.is_null() {
                libc::posix_spawnattr_destroy(&mut attributes);
            }
            result
        };
        if spawned != 0 {
            return Err(Error::from_raw_os_error(spawned));
        }
        // The engine's ends are its own now.
        drop((child_stdin, child_stdout, child_stderr));
        let mut process = Process { pid, ended: None };
        if boxed {
            if let Err(error) = holds(&mut process, folder) {
                process.kill();
                process.wait();
                return Err(error);
            }
        }
        Ok(Spawned { stdin: File::from(stdin), stdout: File::from(stdout), stderr: File::from(stderr), process })
    }

    /// Waits for the engine to close its box behind it, and asks the system whether it holds:
    /// that it's boxed, may not read the folder beside its own, where the app keeps its sealed
    /// keys, and may not make a process. Until then nothing is sent to it.
    fn holds(process: &mut Process, folder: &Path) -> Result<()> {
        let check = sandbox_check().ok_or_else(|| Error::other("this macOS can't say whether a program is boxed"))?;
        let beside = folder.canonicalize()?.parent().map(Path::to_path_buf).ok_or_else(|| Error::other("the engine's folder has none around it"))?;
        let beside = c_path(&beside)?;
        let deadline = Instant::now() + BOXING;
        loop {
            if unsafe { check(process.pid, std::ptr::null(), SANDBOX_FILTER_NONE) } == 1 {
                // 1 is refused, and anything else, an error included, isn't.
                let refused_data = unsafe { check(process.pid, c"file-read-data".as_ptr(), SANDBOX_FILTER_PATH, beside.as_ptr()) } == 1;
                let refused_fork = unsafe { check(process.pid, c"process-fork".as_ptr(), SANDBOX_FILTER_NONE) } == 1;
                if !refused_data || !refused_fork {
                    return Err(Error::other("the engine's box doesn't hold: it may read the app's data or make a process"));
                }
                return Ok(());
            }
            if let Some(code) = process.try_wait()? {
                return Err(Error::other(format!("it ended before it was boxed, with {code}")));
            }
            if Instant::now() >= deadline {
                return Err(Error::other("it didn't close its box in time"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
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

#[cfg(all(test, any(windows, target_os = "linux", target_os = "macos")))]
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
        std::fs::create_dir_all(&base).unwrap();
        // By the name the system gives it, as the broker names it (`telegram::Engine::launch`).
        #[cfg(target_os = "macos")]
        let base = base.canonicalize().unwrap();
        let own = base.join("telegram");
        std::fs::create_dir_all(&own).unwrap();
        let secret = base.join("device-key.sealed");
        std::fs::write(&secret, b"secret").unwrap();
        let elsewhere = dirs::home_dir().unwrap();
        // A program's local socket outside the box, as the session's bus is.
        #[cfg(unix)]
        let socket = base.join("bus");
        #[cfg(unix)]
        let _listening = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        #[cfg(unix)]
        let args = ["--probe", own.to_str().unwrap(), secret.to_str().unwrap(), elsewhere.to_str().unwrap(), socket.to_str().unwrap()];
        #[cfg(windows)]
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
        for key in ["ownFolder", "moveFile", "loopback", "random"] {
            assert!(said(key).starts_with("allowed"), "{key} is {}", said(key));
        }
        for key in ["readSecret", "listElsewhere", "connectOut", "telegramDirect", "resolve", "startProgram"] {
            assert!(said(key).starts_with("denied"), "{key} is {}", said(key));
        }
        #[cfg(target_os = "linux")]
        {
            for key in ["udp", "localSocket", "signal", "ptrace", "namespace", "fork"] {
                assert!(said(key).starts_with("denied"), "{key} is {}", said(key));
            }
            // Another port of its own is harmless in a network of its own, and refused by
            // Landlock where it has none, from kernel 6.7.
            if confine::abi() >= 4 {
                assert!(said("bindOther").starts_with("denied"), "bindOther is {}", said("bindOther"));
            }
            assert_eq!(found["dumpable"], 0, "it can't be dumped or attached to");
        }
        #[cfg(target_os = "macos")]
        for key in ["bindOther", "udp", "localSocket", "signal", "ptrace", "fork", "services"] {
            assert!(said(key).starts_with("denied"), "{key} is {}", said(key));
        }
    }
}
