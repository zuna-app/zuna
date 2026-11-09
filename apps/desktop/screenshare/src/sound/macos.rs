//! The computer's sound on macOS, through Core Audio's process taps, which need macOS
//! 14.2 or later: everything but the app's own processes, or one app's. An app is the
//! process macOS holds responsible for another, so a browser's sound, which plays from a
//! helper, goes with it. The first capture asks the person to let the app record the
//! computer's sound (`NSAudioCaptureUsageDescription`).
//!
//! A tap is read through a private aggregate device clocked by the output, at the
//! output's rate, which Apple's converter takes to 48 kHz where it differs.

use std::{
    collections::BTreeSet,
    ffi::{c_void, CStr},
    ptr::{self, NonNull},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use objc2::{rc::Retained, runtime::AnyObject, AllocAnyThread};
use objc2_audio_toolbox::{
    kAudioConverterQuality_Max, kAudioConverterSampleRateConverterQuality, AudioConverterDispose, AudioConverterFillComplexBuffer, AudioConverterNew, AudioConverterRef,
    AudioConverterSetProperty,
};
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey, kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey, kAudioAggregateDeviceSubDeviceListKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultSystemOutputDevice,
    kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioProcessPropertyIsRunningOutput,
    kAudioProcessPropertyPID, kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, kAudioTapPropertyFormat, AudioDeviceCreateIOProcID,
    AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertySelector,
    CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM, AudioBuffer, AudioBufferList, AudioStreamBasicDescription,
    AudioStreamPacketDescription, AudioTimeStamp,
};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString};
use objc2_foundation::{NSArray, NSDictionary, NSMutableDictionary, NSNumber, NSString, NSUUID};

use super::{App, Source, WindowApp, Wanted, RATE};
use crate::encoder::Result;

/// About two seconds of what the tap hands over at a time, which is plenty to fall behind by.
const QUEUED_CHUNKS: usize = 100;
/// How often the processes to take, and the output, are looked at again.
const REFRESH: Duration = Duration::from_millis(500);
/// What the converter's input says when it has nothing more for now.
const NO_MORE: i32 = i32::from_be_bytes(*b"zmor");

/// A Core Audio status as its four characters where it has them, as macOS's are.
fn status(code: i32) -> String {
    let bytes = code.to_be_bytes();
    if bytes.iter().all(|byte| byte.is_ascii_graphic() || *byte == b' ') {
        format!("'{}'", String::from_utf8_lossy(&bytes))
    } else {
        code.to_string()
    }
}

fn address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain }
}

/// A property that's one plain value.
fn property<T: Copy>(object: AudioObjectID, selector: AudioObjectPropertySelector) -> std::result::Result<T, i32> {
    let mut address = address(selector);
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut size = size_of::<T>() as u32;
    let code = unsafe { AudioObjectGetPropertyData(object, NonNull::from(&mut address), 0, ptr::null(), NonNull::from(&mut size), NonNull::new_unchecked(value.as_mut_ptr().cast())) };
    if code == 0 {
        Ok(unsafe { value.assume_init() })
    } else {
        Err(code)
    }
}

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

/// Core Audio's objects for the processes that use sound.
fn process_objects() -> Vec<AudioObjectID> {
    let mut address = address(kAudioHardwarePropertyProcessObjectList);
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM, NonNull::from(&mut address), 0, ptr::null(), NonNull::from(&mut size)) } != 0 {
        return Vec::new();
    }
    let mut objects = vec![0 as AudioObjectID; size as usize / size_of::<AudioObjectID>()];
    if objects.is_empty() {
        return objects;
    }
    if unsafe { AudioObjectGetPropertyData(SYSTEM, NonNull::from(&mut address), 0, ptr::null(), NonNull::from(&mut size), NonNull::new_unchecked(objects.as_mut_ptr().cast())) } != 0 {
        return Vec::new();
    }
    objects.truncate(size as usize / size_of::<AudioObjectID>());
    objects
}

struct Process {
    object: AudioObjectID,
    pid: i32,
    playing: bool,
}

fn processes() -> Vec<Process> {
    process_objects()
        .into_iter()
        .filter_map(|object| {
            let pid = property::<i32>(object, kAudioProcessPropertyPID).ok()?;
            let playing = property::<u32>(object, kAudioProcessPropertyIsRunningOutput).is_ok_and(|running| running != 0);
            Some(Process { object, pid, playing })
        })
        .collect()
}

/// The process macOS holds responsible for another, which for a browser's helpers is the
/// browser. It's private to macOS, so where it's missing a process stands for itself.
fn responsible(pid: i32) -> i32 {
    type Find = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static FIND: OnceLock<Option<Find>> = OnceLock::new();
    let find = FIND.get_or_init(|| {
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        (!symbol.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, Find>(symbol) })
    });
    match find.map(|find| unsafe { find(pid) }) {
        Some(found) if found > 0 => found,
        _ => pid,
    }
}

fn parent(pid: i32) -> Option<i32> {
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    (unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) } == size).then_some(info.pbi_ppid as i32)
}

/// Whether a process is `root`'s: one macOS holds it responsible for, or one it started.
fn belongs(pid: i32, root: i32) -> bool {
    if responsible(pid) == root {
        return true;
    }
    let mut at = pid;
    for _ in 0..64 {
        if at == root {
            return true;
        }
        match parent(at) {
            Some(up) if up > 0 && up != at => at = up,
            _ => return false,
        }
    }
    false
}

/// What an app is called: its bundle's name, or else its program's.
fn name_from_path(path: &str) -> String {
    path.split('/').find_map(|part| part.strip_suffix(".app")).or_else(|| path.rsplit('/').next()).unwrap_or(path).to_owned()
}

fn app_name(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (length > 0).then(|| name_from_path(&String::from_utf8_lossy(&buffer[..length as usize])))
}

pub fn apps(exclude: Option<u32>) -> Result<Vec<App>> {
    let mut apps = Vec::new();
    for process in processes() {
        if !process.playing || exclude.is_some_and(|root| belongs(process.pid, root as i32)) {
            continue;
        }
        let root = responsible(process.pid);
        if let Some(name) = app_name(root) {
            apps.push(App { id: format!("pid:{root}"), name });
        }
    }
    Ok(apps)
}

/// Windows are chosen in macOS's own picker, which doesn't say which, so there's none to look up.
pub fn window_app(_window: u64, _exclude: Option<u32>) -> Result<Option<WindowApp>> {
    Ok(None)
}

/// The processes a tap is of, or leaves out when it takes everything.
#[derive(Clone, PartialEq)]
struct Chosen {
    everything: bool,
    objects: BTreeSet<AudioObjectID>,
}

fn choose(wanted: &Wanted, exclude: Option<u32>) -> Chosen {
    let (everything, root) = match wanted {
        Wanted::Everything => (true, exclude.unwrap_or(0) as i32),
        Wanted::Tree(pid) => (false, *pid as i32),
        Wanted::Program(_) => unreachable!("taken apart in open"),
    };
    let objects = processes().into_iter().filter(|process| belongs(process.pid, root)).map(|process| process.object).collect();
    Chosen { everything, objects }
}

fn numbers(objects: &BTreeSet<AudioObjectID>) -> Retained<NSArray<NSNumber>> {
    let numbers: Vec<Retained<NSNumber>> = objects.iter().map(|&object| NSNumber::new_u32(object)).collect();
    NSArray::from_retained_slice(&numbers)
}

fn describe(chosen: &Chosen) -> Retained<CATapDescription> {
    let processes = numbers(&chosen.objects);
    unsafe {
        let description = if chosen.everything {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &processes)
        } else {
            CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(), &processes)
        };
        description.setName(&NSString::from_str("Zuna"));
        description.setPrivate(true);
        description.setMuteBehavior(CATapMuteBehavior::Unmuted);
        description
    }
}

/// Where the tap's samples go: stereo at the tap's rate, for the converter.
struct Shared {
    out: SyncSender<(f64, Vec<u8>)>,
    rate: f64,
    interleaved: bool,
    channels: usize,
}

/// Interleaved stereo from what a tap hands over: one buffer of interleaved channels, or one
/// buffer a channel. One channel is heard on both sides, and past two only the first two count.
fn stereo(buffers: &[&[f32]], interleaved: bool, channels: usize) -> Vec<u8> {
    let mut out = Vec::new();
    if interleaved {
        let Some(samples) = buffers.first() else { return out };
        let channels = channels.max(1);
        out.reserve(samples.len() / channels * 8);
        for frame in samples.chunks_exact(channels) {
            let (left, right) = (frame[0], frame[if channels > 1 { 1 } else { 0 }]);
            out.extend_from_slice(&left.to_le_bytes());
            out.extend_from_slice(&right.to_le_bytes());
        }
    } else {
        let Some(left) = buffers.first() else { return out };
        let right = buffers.get(1).unwrap_or(left);
        out.reserve(left.len() * 8);
        for (left, right) in left.iter().zip(right.iter()) {
            out.extend_from_slice(&left.to_le_bytes());
            out.extend_from_slice(&right.to_le_bytes());
        }
    }
    out
}

/// Called on Core Audio's own thread with what the tap heard.
unsafe extern "C-unwind" fn heard(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    let shared = unsafe { &*client.cast::<Shared>() };
    let list = input.as_ptr();
    let count = unsafe { (*list).mNumberBuffers } as usize;
    let buffers: Vec<&[f32]> = unsafe { std::slice::from_raw_parts((*list).mBuffers.as_ptr(), count) }
        .iter()
        .filter(|buffer| !buffer.mData.is_null())
        .map(|buffer| unsafe { std::slice::from_raw_parts(buffer.mData.cast::<f32>(), buffer.mDataByteSize as usize / size_of::<f32>()) })
        .collect();
    let chunk = stereo(&buffers, shared.interleaved, shared.channels);
    // Falling behind loses sound rather than holding Core Audio up.
    if !chunk.is_empty() {
        let _ = shared.out.try_send((shared.rate, chunk));
    }
    0
}

/// The tap read through an aggregate device of the output it's clocked by.
struct Reading {
    device: AudioObjectID,
    output: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    shared: *mut Shared,
}

impl Drop for Reading {
    fn drop(&mut self) {
        unsafe {
            AudioDeviceStop(self.device, self.proc_id);
            AudioDeviceDestroyIOProcID(self.device, self.proc_id);
            AudioHardwareDestroyAggregateDevice(self.device);
            // Core Audio no longer calls in once the proc is gone.
            drop(Box::from_raw(self.shared));
        }
    }
}

fn key(key: &CStr) -> Retained<NSString> {
    NSString::from_str(key.to_str().unwrap_or_default())
}

/// The computer's output now, with its id for an aggregate device.
fn output() -> Result<(AudioObjectID, CFRetained<CFString>)> {
    let device: AudioObjectID = property(SYSTEM, kAudioHardwarePropertyDefaultSystemOutputDevice).map_err(|code| format!("Finding the computer's output: {}", status(code)))?;
    let uid: *const CFString = property(device, kAudioDevicePropertyDeviceUID).map_err(|code| format!("Naming the computer's output: {}", status(code)))?;
    let uid = NonNull::new(uid.cast_mut()).ok_or("The computer's output has no id")?;
    Ok((device, unsafe { CFRetained::from_raw(uid) }))
}

fn read(tap_uid: &NSString, out: &SyncSender<(f64, Vec<u8>)>, format: &AudioStreamBasicDescription) -> Result<Reading> {
    let (output, output_uid) = output()?;
    // A CFString is an NSString.
    let output_uid: &NSString = unsafe { &*CFRetained::as_ptr(&output_uid).as_ptr().cast::<NSString>() };
    let object = |object: &AnyObject| -> Retained<AnyObject> { unsafe { Retained::retain(object as *const AnyObject as *mut AnyObject) }.expect("an object") };

    let sub_device = NSDictionary::<NSString, AnyObject>::from_retained_objects(&[&*key(kAudioSubDeviceUIDKey)], &[object(output_uid)]);
    let tap = NSDictionary::<NSString, AnyObject>::from_retained_objects(
        &[&*key(kAudioSubTapUIDKey), &*key(kAudioSubTapDriftCompensationKey)],
        &[object(tap_uid), object(&NSNumber::new_bool(true))],
    );
    let description = NSMutableDictionary::<NSString, AnyObject>::new();
    description.insert(&*key(kAudioAggregateDeviceNameKey), &*object(&NSString::from_str("Zuna share sound")));
    description.insert(&*key(kAudioAggregateDeviceUIDKey), &*object(&NSUUID::new().UUIDString()));
    description.insert(&*key(kAudioAggregateDeviceMainSubDeviceKey), &*object(output_uid));
    description.insert(&*key(kAudioAggregateDeviceIsPrivateKey), &*object(&NSNumber::new_bool(true)));
    description.insert(&*key(kAudioAggregateDeviceIsStackedKey), &*object(&NSNumber::new_bool(false)));
    description.insert(&*key(kAudioAggregateDeviceTapAutoStartKey), &*object(&NSNumber::new_bool(true)));
    description.insert(&*key(kAudioAggregateDeviceSubDeviceListKey), &*object(&NSArray::from_retained_slice(&[sub_device])));
    description.insert(&*key(kAudioAggregateDeviceTapListKey), &*object(&NSArray::from_retained_slice(&[tap])));

    let mut device: AudioObjectID = 0;
    // An NSDictionary is a CFDictionary.
    let cf: &CFDictionary = unsafe { &*Retained::as_ptr(&description).cast::<CFDictionary>() };
    let code = unsafe { AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut device)) };
    if code != 0 {
        return Err(format!("Making a device to read the computer's sound from: {}", status(code)));
    }

    let shared = Box::into_raw(Box::new(Shared {
        out: out.clone(),
        rate: format.mSampleRate,
        interleaved: format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0,
        channels: format.mChannelsPerFrame as usize,
    }));
    let mut proc_id: AudioDeviceIOProcID = None;
    let code = unsafe { AudioDeviceCreateIOProcID(device, Some(heard), shared.cast(), NonNull::from(&mut proc_id)) };
    if code != 0 {
        unsafe {
            AudioHardwareDestroyAggregateDevice(device);
            drop(Box::from_raw(shared));
        }
        return Err(format!("Reading the computer's sound: {}", status(code)));
    }
    let reading = Reading { device, output, proc_id, shared };
    let code = unsafe { AudioDeviceStart(device, proc_id) };
    if code != 0 {
        return Err(format!("Starting to read the computer's sound: {}", status(code)));
    }
    Ok(reading)
}

/// A tap, and how it's read, all of which stay on the thread that made them.
struct Tap {
    tap: AudioObjectID,
    chosen: Chosen,
    reading: Option<Reading>,
}

impl Tap {
    fn open(chosen: Chosen, out: &SyncSender<(f64, Vec<u8>)>) -> Result<Self> {
        let description = describe(&chosen);
        let mut tap: AudioObjectID = 0;
        let code = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap) };
        if code != 0 {
            return Err(format!("macOS wouldn't tap the computer's sound ({}). It needs macOS 14.2 or later", status(code)));
        }
        let mut opened = Tap { tap, chosen, reading: None };
        let format: AudioStreamBasicDescription = property(tap, kAudioTapPropertyFormat).map_err(|code| format!("Reading the sound's format: {}", status(code)))?;
        if format.mFormatID != kAudioFormatLinearPCM || format.mFormatFlags & kAudioFormatFlagIsFloat == 0 || format.mBitsPerChannel != 32 {
            return Err("The computer's sound came in a format that isn't 32-bit floats".into());
        }
        opened.reading = Some(read(&unsafe { description.UUID() }.UUIDString(), out, &format)?);
        Ok(opened)
    }

    /// Whether it still takes what's wanted from the output there is now. A process that starts
    /// later isn't in it, and macOS won't change a tap that's being read, so a new one is made.
    fn current(&self, chosen: &Chosen) -> bool {
        let output: AudioObjectID = property(SYSTEM, kAudioHardwarePropertyDefaultSystemOutputDevice).unwrap_or(0);
        *chosen == self.chosen && self.reading.as_ref().is_some_and(|reading| output == 0 || reading.output == output)
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.reading = None;
        unsafe { AudioHardwareDestroyProcessTap(self.tap) };
    }
}

/// Apple's converter, from stereo at the tap's rate to 48 kHz.
struct Resampler {
    converter: AudioConverterRef,
    rate: f64,
    pending: Vec<f32>,
    taken: usize,
}

fn stereo_format(rate: f64) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 8,
        mFramesPerPacket: 1,
        mBytesPerFrame: 8,
        mChannelsPerFrame: 2,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

impl Resampler {
    fn new(rate: f64) -> Result<Self> {
        let (mut from, mut to) = (stereo_format(rate), stereo_format(RATE as f64));
        let mut converter: AudioConverterRef = ptr::null_mut();
        let code = unsafe { AudioConverterNew(NonNull::from(&mut from), NonNull::from(&mut to), NonNull::from(&mut converter)) };
        if code != 0 {
            return Err(format!("Converting the computer's sound from {rate} Hz: {}", status(code)));
        }
        let mut quality = kAudioConverterQuality_Max;
        unsafe { AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterQuality, size_of::<u32>() as u32, NonNull::from(&mut quality).cast()) };
        Ok(Resampler { converter, rate, pending: Vec::new(), taken: 0 })
    }

    fn convert(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend(chunk.chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])));
        // A little room over, as the converter holds some back and lets it out later.
        let mut frames = ((self.pending.len() / 2) as f64 * RATE as f64 / self.rate).ceil() as u32 + 64;
        let mut out = vec![0f32; frames as usize * 2];
        let mut list = AudioBufferList { mNumberBuffers: 1, mBuffers: [AudioBuffer { mNumberChannels: 2, mDataByteSize: (out.len() * size_of::<f32>()) as u32, mData: out.as_mut_ptr().cast() }] };
        let code = unsafe {
            AudioConverterFillComplexBuffer(self.converter, Some(supply), (self as *mut Self).cast(), NonNull::from(&mut frames), NonNull::from(&mut list), ptr::null_mut())
        };
        if code != 0 && code != NO_MORE {
            log::warn!("converting the computer's sound: {}", status(code));
        }
        self.pending.drain(..self.taken);
        self.taken = 0;
        out.truncate(frames as usize * 2);
        out.iter().flat_map(|sample| sample.to_le_bytes()).collect()
    }
}

impl Drop for Resampler {
    fn drop(&mut self) {
        unsafe { AudioConverterDispose(self.converter) };
    }
}

/// Hands the converter what's come in, and says when that's all for now.
unsafe extern "C-unwind" fn supply(
    _converter: AudioConverterRef,
    packets: NonNull<u32>,
    data: NonNull<AudioBufferList>,
    _descriptions: *mut *mut AudioStreamPacketDescription,
    user: *mut c_void,
) -> i32 {
    let resampler = unsafe { &mut *user.cast::<Resampler>() };
    let available = (resampler.pending.len() - resampler.taken) / 2;
    if available == 0 {
        unsafe { *packets.as_ptr() = 0 };
        return NO_MORE;
    }
    let frames = available.min(unsafe { *packets.as_ptr() } as usize);
    unsafe {
        let list = data.as_ptr();
        (*list).mNumberBuffers = 1;
        (*list).mBuffers[0] = AudioBuffer { mNumberChannels: 2, mDataByteSize: (frames * 8) as u32, mData: resampler.pending.as_mut_ptr().add(resampler.taken).cast() };
        *packets.as_ptr() = frames as u32;
    }
    resampler.taken += frames * 2;
    0
}

/// Takes the tap's stereo to 48 kHz where it isn't, and on to the app.
fn convert(heard: Receiver<(f64, Vec<u8>)>, samples: SyncSender<Vec<u8>>) {
    let mut resampler: Option<Resampler> = None;
    while let Ok((rate, chunk)) = heard.recv() {
        let chunk = if rate == RATE as f64 {
            resampler = None;
            chunk
        } else {
            if resampler.as_ref().is_none_or(|resampler| resampler.rate != rate) {
                resampler = match Resampler::new(rate) {
                    Ok(resampler) => Some(resampler),
                    Err(message) => {
                        log::warn!("{message}");
                        continue;
                    }
                };
            }
            resampler.as_mut().map(|resampler| resampler.convert(&chunk)).unwrap_or_default()
        };
        if !chunk.is_empty() {
            if let Err(TrySendError::Disconnected(_)) = samples.try_send(chunk) {
                return;
            }
        }
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
    match &wanted {
        Wanted::Program(id) => return Err(format!("On macOS an app's sound is taken by its process, as pid:N, not {id}")),
        Wanted::Everything if exclude.is_none() => return Err("Everything but the app needs --exclude-pid".into()),
        _ => {}
    }
    let stop = Arc::new(AtomicBool::new(false));
    let failure = Arc::new(Mutex::new(None));
    let (started, starting) = mpsc::channel();
    let thread = {
        let (stop, failure) = (stop.clone(), failure.clone());
        thread::spawn(move || {
            let (out, heard) = mpsc::sync_channel(QUEUED_CHUNKS);
            let converter = thread::spawn(move || convert(heard, samples));
            let tap = Tap::open(choose(&wanted, exclude), &out);
            let mut tap = match tap {
                Ok(tap) => {
                    let _ = started.send(Ok(()));
                    tap
                }
                Err(message) => {
                    let _ = started.send(Err(message));
                    drop(out);
                    let _ = converter.join();
                    return;
                }
            };
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(REFRESH);
                let chosen = choose(&wanted, exclude);
                if tap.current(&chosen) {
                    continue;
                }
                // The new one first, so that as little as possible is missed.
                match Tap::open(chosen, &out) {
                    Ok(fresh) => tap = fresh,
                    Err(message) => {
                        if let Ok(mut failure) = failure.lock() {
                            *failure = Some(message);
                        }
                        break;
                    }
                }
            }
            // The reading's sender goes with the tap, and this one after it, which ends the converter.
            drop(tap);
            drop(out);
            let _ = converter.join();
        })
    };
    // The first time, macOS asks the person whether the app may record the computer's sound, and waits for them.
    match starting.recv_timeout(Duration::from_secs(120)) {
        Ok(Ok(())) => Ok(Capture { stop, failure, thread: Some(thread) }),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(message)
        }
        Err(_) => Err("macOS didn't start tapping the computer's sound within 2 minutes".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn floats(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
    }

    #[test]
    fn an_app_is_named_for_its_bundle() {
        assert_eq!(name_from_path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "Google Chrome");
        assert_eq!(name_from_path("/System/Applications/Music.app/Contents/MacOS/Music"), "Music");
        assert_eq!(name_from_path("/usr/bin/afplay"), "afplay");
    }

    #[test]
    fn sound_comes_out_as_interleaved_stereo() {
        assert_eq!(floats(&stereo(&[&[1.0, 2.0, 3.0, 4.0]], true, 2)), [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(floats(&stereo(&[&[1.0, 2.0]], true, 1)), [1.0, 1.0, 2.0, 2.0]);
        assert_eq!(floats(&stereo(&[&[1.0, 2.0, 9.0, 3.0, 4.0, 9.0]], true, 3)), [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(floats(&stereo(&[&[1.0, 3.0], &[2.0, 4.0]], false, 2)), [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(floats(&stereo(&[&[1.0, 3.0]], false, 1)), [1.0, 1.0, 3.0, 3.0]);
    }

    #[test]
    fn statuses_read_as_their_four_characters() {
        assert_eq!(status(i32::from_be_bytes(*b"nope")), "'nope'");
        assert_eq!(status(-50), "-50");
    }

    #[test]
    fn a_rate_other_than_48_khz_is_converted_to_it() {
        let mut resampler = Resampler::new(44_100.0).expect("a converter");
        let second: Vec<u8> = (0..44_100).flat_map(|i| {
            let sample = (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5;
            [sample.to_le_bytes(), sample.to_le_bytes()].concat()
        }).collect();
        let mut frames = 0;
        for chunk in second.chunks(512 * 8) {
            frames += resampler.convert(chunk).len() / 8;
        }
        // The converter holds a little back.
        assert!((47_000..=48_000).contains(&frames), "{frames} frames for a second");
    }
}
