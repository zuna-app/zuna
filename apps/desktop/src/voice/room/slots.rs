//! Which epoch's key each slot of the key ring holds, and when one that's been replaced is retired,
//! as `VoiceKeySlots` in packages/core/src/voice.ts keeps them for the web. An epoch's slot is given
//! a random key once, `OLD_KEY_KEPT` after the epoch after it came, unless by then it holds another
//! epoch's key, as it does when the ring has gone round, or it's the current one.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use super::key_index;

/// How long a key goes on opening what others send once a newer epoch's has come (VOICE_OLD_KEY_MS).
/// Someone who hears of the new epoch late, or is a few behind for a moment, sends under the old one
/// meanwhile. After it, someone removed who kept the old one can't be played to the others, even
/// with the media server's help.
pub const OLD_KEY_KEPT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct KeySlots {
    /// The epoch whose key each slot holds.
    held: HashMap<i32, u64>,
    /// The slots to retire, with the epoch each held and when.
    retiring: HashMap<i32, (u64, Instant)>,
    current: Option<u64>,
}

impl KeySlots {
    /// The newest epoch's key goes in its slot, which takes it off any list to be retired, and the
    /// epoch it replaces starts its time. Says which slot, and when the replaced one is due, if it is.
    pub fn take(&mut self, epoch: u64, now: Instant) -> (i32, Option<Instant>) {
        let index = key_index(epoch);
        let previous = self.current.replace(epoch);
        self.retiring.remove(&index);
        self.held.insert(index, epoch);
        let Some(previous) = previous.filter(|previous| *previous != epoch) else { return (index, None) };
        let old = key_index(previous);
        if old == index || self.held.get(&old) != Some(&previous) {
            return (index, None);
        }
        let at = now + OLD_KEY_KEPT;
        self.retiring.insert(old, (previous, at));
        (index, Some(at))
    }

    /// The slots due by `now`, each to be given a random key: they hold nothing from here on.
    pub fn due(&mut self, now: Instant) -> Vec<(i32, u64)> {
        let ready: Vec<(i32, u64)> = self.retiring.iter().filter(|(_, (_, at))| *at <= now).map(|(index, (epoch, _))| (*index, *epoch)).collect();
        let current = self.current.map(key_index);
        let mut out = Vec::new();
        for (index, epoch) in ready {
            self.retiring.remove(&index);
            if self.held.get(&index) != Some(&epoch) || current == Some(index) {
                continue;
            }
            self.held.remove(&index);
            out.push((index, epoch));
        }
        out.sort();
        out
    }

    /// Whether a slot still holds an epoch's key, so that it may be set for someone.
    pub fn holds(&self, index: i32, epoch: u64) -> bool {
        self.held.get(&index) == Some(&epoch)
    }
}

/// The timers retiring slots, which leaving the room stops, and which take no more after that.
#[derive(Default)]
pub struct Timers {
    running: parking_lot::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    stopped: std::sync::atomic::AtomicBool,
}

impl Timers {
    /// Does `then` at `at`, unless stopped first.
    pub fn at(&self, at: Instant, then: impl FnOnce() + Send + 'static) {
        let mut running = self.running.lock();
        if self.stopped.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        running.retain(|timer| !timer.is_finished());
        running.push(crate::host::tokio().spawn(async move {
            tokio::time::sleep_until(at.into()).await;
            then();
        }));
    }

    pub fn stop(&self) {
        let mut running = self.running.lock();
        self.stopped.store(true, std::sync::atomic::Ordering::Relaxed);
        for timer in running.drain(..) {
            timer.abort();
        }
    }
}

/// Gives each slot due by `at` a random key from the system's generator for everyone in `keyed`,
/// through `set`, and says which were retired.
pub fn retire(slots: &mut KeySlots, at: Instant, keyed: &HashSet<String>, mut set: impl FnMut(&str, i32, Vec<u8>)) -> Vec<(i32, u64)> {
    let mut out = Vec::new();
    for (index, epoch) in slots.due(at) {
        match zuna_crypto::primitives::random_bytes(32) {
            Ok(key) => {
                for identity in keyed {
                    set(identity, index, key.clone());
                }
                out.push((index, epoch));
            }
            Err(error) => log::warn!("voice: no random key to retire slot {index} with: {error}"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RING: u64 = super::super::KEY_RING as u64;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn retires_a_replaced_slot_once_after_its_time_and_never_the_current_one() {
        let start = Instant::now();
        let mut slots = KeySlots::default();
        assert_eq!(slots.take(5, start), (5, None));
        let (index, due) = slots.take(6, at(start, 1000));
        assert_eq!((index, due), (6, Some(at(start, 1000) + OLD_KEY_KEPT)));
        assert!(slots.due(at(start, 999) + OLD_KEY_KEPT).is_empty());
        assert!(slots.holds(5, 5));
        assert_eq!(slots.due(due.unwrap()), vec![(5, 5)]);
        assert!(!slots.holds(5, 5));
        assert!(slots.due(at(start, 1_000_000)).is_empty());
        assert!(slots.holds(6, 6));
        assert_eq!(slots.take(6, at(start, 2000)), (6, None));
    }

    #[test]
    fn retires_each_of_several_quick_epochs_in_turn() {
        let start = Instant::now();
        let mut slots = KeySlots::default();
        slots.take(1, start);
        slots.take(2, at(start, 100));
        slots.take(3, at(start, 200));
        assert!(slots.due(at(start, 99) + OLD_KEY_KEPT).is_empty());
        assert_eq!(slots.due(at(start, 100) + OLD_KEY_KEPT), vec![(1, 1)]);
        assert_eq!(slots.due(at(start, 200) + OLD_KEY_KEPT), vec![(2, 2)]);
        assert!(slots.holds(3, 3));
        // A device that skipped epochs retires the last it held.
        assert_eq!(slots.take(9, at(start, 300)), (9, Some(at(start, 300) + OLD_KEY_KEPT)));
        assert_eq!(slots.due(at(start, 300) + OLD_KEY_KEPT), vec![(3, 3)]);
    }

    #[test]
    fn leaves_a_slot_the_ring_came_round_to() {
        let start = Instant::now();
        let mut slots = KeySlots::default();
        // A whole ring's worth of joins and leaves within the time: epoch 0's slot is epoch 16's by then.
        for epoch in 0..=RING {
            slots.take(epoch, at(start, epoch));
        }
        let due = slots.due(at(start, RING) + OLD_KEY_KEPT);
        assert_eq!(due, (1..RING).map(|epoch| (epoch as i32, epoch)).collect::<Vec<_>>());
        assert!(slots.holds(0, RING));
        // When epoch 16 is replaced in turn, its slot is retired after its own time.
        assert_eq!(slots.take(RING + 1, at(start, 100)), (1, Some(at(start, 100) + OLD_KEY_KEPT)));
        assert_eq!(slots.due(at(start, 100) + OLD_KEY_KEPT), vec![(0, RING)]);
        // Straight from epoch 3 to 19, the same slot: nothing older is left in it to retire.
        let mut skipping = KeySlots::default();
        skipping.take(3, start);
        assert_eq!(skipping.take(3 + RING, at(start, 1)), (3, None));
        assert!(skipping.due(at(start, 1_000_000)).is_empty());
        assert!(skipping.holds(3, 3 + RING));
    }

    #[test]
    fn keeps_an_epoch_a_group_was_taken_back_to() {
        let start = Instant::now();
        let mut slots = KeySlots::default();
        slots.take(4, start);
        slots.take(5, at(start, 10));
        // A commit nobody could apply is undone, and the group is back at 4.
        assert_eq!(slots.take(4, at(start, 20)), (4, Some(at(start, 20) + OLD_KEY_KEPT)));
        assert_eq!(slots.due(at(start, 1_000_000)), vec![(5, 5)]);
        assert!(slots.holds(4, 4));
    }

    #[test]
    fn timers_go_off_at_their_time_unless_the_room_is_left() {
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = |fired: &std::sync::Arc<std::sync::atomic::AtomicUsize>| {
            let fired = fired.clone();
            move || {
                fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        };
        let kept = Timers::default();
        kept.at(Instant::now() + Duration::from_millis(100), count(&fired));
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 0);
        let left = Timers::default();
        left.at(Instant::now() + Duration::from_millis(50), count(&fired));
        left.stop();
        left.at(Instant::now(), count(&fired));
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Through LiveKit's own cryptor, whose packets are sealed under the same ring as its frames, with
    /// the ring set up as `key_options` sets it: what's under a retired slot opens nothing, however
    /// often it's tried, and what's under the current one still opens, and so does what comes later.
    #[test]
    fn a_retired_slot_opens_nothing_and_the_current_one_still_does() {
        use livekit::webrtc::native::frame_cryptor::{DataPacketCryptor, EncryptionAlgorithm, KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions};
        let ring = || {
            KeyProvider::new(KeyProviderOptions {
                shared_key: false,
                ratchet_window_size: 0,
                ratchet_salt: b"LKFrameEncryptionKey".to_vec(),
                failure_tolerance: -1,
                key_ring_size: super::super::KEY_RING,
                key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
            })
        };
        let (sending, receiving) = (ring(), ring());
        let sealer = DataPacketCryptor::new(EncryptionAlgorithm::AesGcm, sending.clone());
        let opener = DataPacketCryptor::new(EncryptionAlgorithm::AesGcm, receiving.clone());
        let someone = "0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef";
        let room_key = |epoch: u64| [epoch as u8; 32].to_vec();
        let start = Instant::now();
        let mut slots = KeySlots::default();
        let keyed = HashSet::from([someone.to_string()]);
        for (epoch, now) in [(5, start), (6, at(start, 10))] {
            let (index, _) = slots.take(epoch, now);
            let key = super::super::sender_key(&room_key(epoch), someone);
            sending.set_key(someone.into(), index, key.clone());
            receiving.set_key(someone.into(), index, key);
        }
        let seal = |epoch: u64| sealer.encrypt(someone, key_index(epoch) as u32, b"a frame").unwrap();
        assert_eq!(opener.decrypt(someone, &seal(5)).unwrap(), b"a frame");
        assert_eq!(opener.decrypt(someone, &seal(6)).unwrap(), b"a frame");
        // Not yet.
        assert!(retire(&mut slots, at(start, 9) + OLD_KEY_KEPT, &keyed, |identity, index, key| {
            receiving.set_key(identity.into(), index, key);
        })
        .is_empty());
        assert_eq!(opener.decrypt(someone, &seal(5)).unwrap(), b"a frame");
        let retired = retire(&mut slots, at(start, 10) + OLD_KEY_KEPT, &keyed, |identity, index, key| {
            receiving.set_key(identity.into(), index, key);
        });
        assert_eq!(retired, vec![(5, 5)]);
        for _ in 0..50 {
            assert!(opener.decrypt(someone, &seal(5)).is_err());
        }
        assert_eq!(opener.decrypt(someone, &seal(6)).unwrap(), b"a frame");
        // The next epoch, set as `update_keys` sets it, opens as well.
        let (index, _) = slots.take(7, at(start, 20));
        let key = super::super::sender_key(&room_key(7), someone);
        sending.set_key(someone.into(), index, key.clone());
        receiving.set_key(someone.into(), index, key);
        assert_eq!(opener.decrypt(someone, &seal(7)).unwrap(), b"a frame");
        assert_eq!(opener.decrypt(someone, &seal(6)).unwrap(), b"a frame");
    }
}
