//! The computer's sound on Windows, through process loopback: one process and those it
//! started, or everything but such a tree. An app is known by the first process of its
//! program, so a browser's sound, which comes from a process it started, goes with it.
//! Process loopback needs Windows 10 version 2004 or later.

use std::{
    collections::HashMap,
    ffi::c_void,
    mem::ManuallyDrop,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use windows::{
    core::{implement, Interface, Ref, HRESULT},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0},
        Media::Audio::{
            eRender, ActivateAudioInterfaceAsync, AudioSessionStateExpired, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
            IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        },
        System::{
            Com::{CoCreateInstance, CoInitializeEx, IAgileObject, IAgileObject_Impl, StructuredStorage::PROPVARIANT, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED},
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            Threading::{CreateEventW, SetEvent, WaitForSingleObject},
            Variant::VT_BLOB,
        },
        UI::WindowsAndMessaging::GetWindowThreadProcessId,
    },
};

use super::{App, Source, WindowApp, Wanted, RATE};
use crate::encoder::Result;

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// Two 32-bit floats.
const FRAME_BYTES: usize = 8;
/// What the system buffers, in 100 ns: 20 ms.
const BUFFER: i64 = 200_000;

fn failed(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |error| format!("{what}: {error}")
}

struct Process {
    parent: u32,
    exe: String,
}

/// Every process now, with its parent and its program's file name.
fn processes() -> HashMap<u32, Process> {
    let mut found = HashMap::new();
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return found };
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    while next.is_ok() {
        let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        found.insert(entry.th32ProcessID, Process { parent: entry.th32ParentProcessID, exe: String::from_utf16_lossy(&entry.szExeFile[..length]) });
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

/// The first process of a program, walking up while the parent is the same program, which
/// is how a browser's processes for sound and pages are told to belong to it.
fn root(pid: u32, processes: &HashMap<u32, Process>) -> u32 {
    let mut at = pid;
    for _ in 0..64 {
        let (Some(process), Some(parent)) = (processes.get(&at), processes.get(&at).and_then(|process| processes.get(&process.parent))) else { break };
        if process.parent == at || !parent.exe.eq_ignore_ascii_case(&process.exe) {
            break;
        }
        at = process.parent;
    }
    at
}

fn descends(pid: u32, ancestor: u32, processes: &HashMap<u32, Process>) -> bool {
    let mut at = pid;
    for _ in 0..64 {
        if at == ancestor {
            return true;
        }
        match processes.get(&at) {
            Some(process) if process.parent != 0 && process.parent != at => at = process.parent,
            _ => return false,
        }
    }
    false
}

/// What an app is called: its program's file name, without ".exe".
fn app_name(exe: &str) -> String {
    exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe).to_owned()
}

fn com() {
    // Already set up on this thread is fine too.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// The processes with sound of their own on any output, apart from the system's sounds.
fn sessions() -> Result<Vec<u32>> {
    com();
    let mut pids = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(failed("Asking for the outputs"))?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(failed("Listing the outputs"))?;
        for index in 0..devices.GetCount().unwrap_or(0) {
            let Ok(device) = devices.Item(index) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = manager.GetSessionEnumerator() else { continue };
            for session in 0..list.GetCount().unwrap_or(0) {
                let Ok(control) = list.GetSession(session) else { continue };
                if control.GetState().is_ok_and(|state| state == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(control) = control.cast::<IAudioSessionControl2>() else { continue };
                // S_OK, which is zero, says it's the system's sounds.
                if control.IsSystemSoundsSession() == HRESULT(0) {
                    continue;
                }
                if let Ok(pid) = control.GetProcessId() {
                    if pid != 0 {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    Ok(pids)
}

pub fn apps(exclude: Option<u32>) -> Result<Vec<App>> {
    let processes = processes();
    let mut apps = Vec::new();
    for pid in sessions()? {
        if exclude.is_some_and(|root| descends(pid, root, &processes)) {
            continue;
        }
        let first = root(pid, &processes);
        let Some(process) = processes.get(&first) else { continue };
        apps.push(App { id: format!("pid:{first}"), name: app_name(&process.exe) });
    }
    Ok(apps)
}

pub fn window_app(window: u64, exclude: Option<u32>) -> Result<Option<WindowApp>> {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(HWND(window as usize as *mut c_void), Some(&mut pid)) };
    let processes = processes();
    if pid == 0 || exclude.is_some_and(|root| descends(pid, root, &processes)) {
        return Ok(None);
    }
    let first = root(pid, &processes);
    let Some(process) = processes.get(&first) else { return Ok(None) };
    let id = format!("pid:{first}");
    let playing = apps(exclude)?.iter().any(|app| app.id == id);
    Ok(Some(WindowApp { name: app_name(&process.exe), playing, covers: vec![id.clone()], id }))
}

/// Says when Windows has made the client asked for. It's called on a thread of the system's
/// choosing, so it has to be agile.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(HANDLE);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        unsafe { SetEvent(self.0) }
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// A client that hears one process tree, or everything else.
fn loopback_client(pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 { ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: mode } },
    };
    // Never dropped, since dropping clears it, which frees the blob, and that's `params` on the stack.
    let mut variant = ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB { cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 };
    }
    let done = unsafe { CreateEventW(None, false, false, None) }.map_err(failed("Creating an event"))?;
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(done).into();
    let result = (|| unsafe {
        let operation = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*variant), &handler)
            .map_err(failed("Windows can't capture one app's sound before Windows 10 version 2004"))?;
        if WaitForSingleObject(done, 5000) != WAIT_OBJECT_0 {
            return Err("Windows didn't make the loopback client within 5 seconds".to_owned());
        }
        let mut activated = HRESULT(0);
        let mut interface = None;
        operation.GetActivateResult(&mut activated, &mut interface).map_err(failed("Making the loopback client"))?;
        activated.ok().map_err(failed("Making the loopback client"))?;
        interface.ok_or("Windows made no loopback client")?.cast::<IAudioClient>().map_err(failed("Making the loopback client"))
    })();
    let _ = unsafe { CloseHandle(done) };
    result
}

/// Copies what the client hears into `samples` until `stop`, from a thread of its own.
fn run(client: IAudioClient, samples: SyncSender<Vec<u8>>, stop: &AtomicBool) -> Result<()> {
    unsafe {
        let ready = CreateEventW(None, false, false, None).map_err(failed("Creating an event"))?;
        let result = (|| {
            client.SetEventHandle(ready).map_err(failed("Waiting for sound"))?;
            let capture: IAudioCaptureClient = client.GetService().map_err(failed("Reading sound"))?;
            client.Start().map_err(failed("Starting to capture sound"))?;
            while !stop.load(Ordering::Relaxed) {
                let _ = WaitForSingleObject(ready, 100);
                loop {
                    let frames = capture.GetNextPacketSize().map_err(failed("Reading sound"))?;
                    if frames == 0 {
                        break;
                    }
                    let (mut data, mut count, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                    capture.GetBuffer(&mut data, &mut count, &mut flags, None, None).map_err(failed("Reading sound"))?;
                    let bytes = count as usize * FRAME_BYTES;
                    let chunk = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() { vec![0; bytes] } else { std::slice::from_raw_parts(data, bytes).to_vec() };
                    capture.ReleaseBuffer(count).map_err(failed("Reading sound"))?;
                    // An app that falls behind loses sound rather than holding this up.
                    if let Err(TrySendError::Disconnected(_)) = samples.try_send(chunk) {
                        return Ok(());
                    }
                }
            }
            Ok(())
        })();
        let _ = client.Stop();
        let _ = CloseHandle(ready);
        result
    }
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl Source for Capture {
    fn failure(&mut self) -> Option<String> {
        self.failure.lock().ok()?.take()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn open(wanted: Wanted, exclude: Option<u32>, samples: SyncSender<Vec<u8>>) -> Result<Capture> {
    let (pid, mode) = match wanted {
        Wanted::Tree(pid) => (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        Wanted::Everything => (exclude.ok_or("Everything but the app needs --exclude-pid")?, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE),
        Wanted::Program(id) => return Err(format!("On Windows an app's sound is taken by its process, as pid:N, not {id}")),
    };
    let stop = Arc::new(AtomicBool::new(false));
    let failure = Arc::new(Mutex::new(None));
    let (started, starting) = mpsc::channel();
    let thread = {
        let (stop, failure) = (stop.clone(), failure.clone());
        thread::spawn(move || {
            com();
            let client = loopback_client(pid, mode).and_then(|client| {
                let format = WAVEFORMATEX {
                    wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                    nChannels: 2,
                    nSamplesPerSec: RATE,
                    nAvgBytesPerSec: RATE * FRAME_BYTES as u32,
                    nBlockAlign: FRAME_BYTES as u16,
                    wBitsPerSample: 32,
                    cbSize: 0,
                };
                let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
                unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER, 0, &format, None) }.map_err(failed("Setting up the loopback client"))?;
                Ok(client)
            });
            let client = match client {
                Ok(client) => {
                    let _ = started.send(Ok(()));
                    client
                }
                Err(message) => {
                    let _ = started.send(Err(message));
                    return;
                }
            };
            if let Err(message) = run(client, samples, &stop) {
                if let Ok(mut failure) = failure.lock() {
                    *failure = Some(message);
                }
            }
        })
    };
    match starting.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(Capture { stop, failure, thread: Some(thread) }),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(message)
        }
        Err(_) => Err("Windows didn't start capturing within 10 seconds".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> HashMap<u32, Process> {
        [(1, 0, "explorer.exe"), (10, 1, "chrome.exe"), (11, 10, "chrome.exe"), (12, 11, "chrome.exe"), (20, 1, "game.exe"), (21, 20, "helper.exe")]
            .into_iter()
            .map(|(pid, parent, exe)| (pid, Process { parent, exe: exe.into() }))
            .collect()
    }

    #[test]
    fn an_app_is_known_by_the_first_process_of_its_program() {
        let processes = tree();
        assert_eq!(root(12, &processes), 10);
        assert_eq!(root(10, &processes), 10);
        assert_eq!(root(21, &processes), 21);
    }

    #[test]
    fn a_process_descends_from_those_above_it() {
        let processes = tree();
        assert!(descends(12, 10, &processes));
        assert!(descends(21, 1, &processes));
        assert!(!descends(21, 10, &processes));
    }
}
