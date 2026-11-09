//! What the room's tasks share: the sound and pictures arriving from others, and following what
//! the room says until it's closed.

use super::*;

impl Shared {
    /// The keys a participant may be sending under: the older first, so the newer ends up current.
    pub(super) fn install_for(&self, identity: &str) {
        if identity == self.identity {
            return;
        }
        for (index, key, _) in self.keys.lock().iter().rev() {
            self.provider.set_key(&ParticipantIdentity(identity.to_string()), *index, sender_key(key, identity));
        }
    }

    /// Points what this device sends at its current key.
    pub(super) fn apply_sending_index(&self, room: &Room) {
        let index = *self.sending.lock();
        for ((identity, _), cryptor) in room.e2ee_manager().frame_cryptors() {
            if identity.0 == self.identity {
                cryptor.set_key_index(index);
            }
        }
    }

    pub(super) fn apply_volumes(&self) {
        let volumes = self.volumes.lock().clone();
        for audio in self.audio.lock().values() {
            self.mixer.set_volume(audio.mixer_id, volumes(&audio.user_id, audio.screen));
        }
    }

    pub(super) fn subscribed(&self, room: &Room, track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
        let identity = participant.identity().0;
        // A share from this device's native process, which there's no need to send back to it.
        if identity == format!("{}.screen", self.identity) {
            publication.set_subscribed(false);
            return;
        }
        let _ = room;
        let Some(user) = user_of(&identity) else { return };
        let sid = publication.sid();
        match track {
            RemoteTrack::Audio(audio) => {
                if self.audio.lock().contains_key(&sid) {
                    return;
                }
                let screen = publication.source() == TrackSource::ScreenshareAudio;
                let volume = (self.volumes.lock())(&user, screen);
                let channels = if screen { 2 } else { 1 };
                let mixer_id = self.mixer.live(volume);
                let mut stream = NativeAudioStream::new(audio.rtc_track(), RATE as i32, channels);
                let mixer = self.mixer.clone();
                let heard = identity.clone();
                let task = crate::host::tokio().spawn(async move {
                    // How loud what decodes is, a second at a time, for checking voice from the log.
                    let (mut peak, mut frames) = (0i16, 0u32);
                    while let Some(frame) = stream.next().await {
                        peak = peak.max(frame.data.iter().map(|sample| sample.saturating_abs()).max().unwrap_or(0));
                        frames += 1;
                        if frames == 100 {
                            log::debug!("voice: {heard} peaks at {:.3}", peak as f32 / 32768.);
                            (peak, frames) = (0, 0);
                        }
                        mixer.push(mixer_id, &frame.data, frame.num_channels);
                    }
                });
                self.audio.lock().insert(sid, RemoteAudio { user_id: user, screen, mixer_id, task: task.abort_handle() });
            }
            RemoteTrack::Video(video) => {
                if self.videos.lock().contains_key(&sid) {
                    return;
                }
                let feed: Feed = Arc::new(Mutex::new(None));
                let mut stream = NativeVideoStream::new(video.rtc_track());
                let writing = feed.clone();
                let task = crate::host::tokio().spawn(async move {
                    let mut serial = 0u64;
                    while let Some(frame) = stream.next().await {
                        #[cfg(target_os = "macos")]
                        if let Some((width, height, picture)) = crate::platform::screen_capture::decoded(frame.buffer.as_ref()) {
                            if serial == 0 {
                                log::debug!("video: decoded on the GPU at {width}×{height}, drawn from there");
                            }
                            serial += 1;
                            show(&writing, Frame { width, height, bgra: Arc::new(Vec::new()), serial, surface: Some(picture) });
                            continue;
                        }
                        let i420 = frame.buffer.to_i420();
                        let (width, height) = (i420.width(), i420.height());
                        let (stride_y, stride_u, stride_v) = i420.strides();
                        let (y, u, v) = i420.data();
                        let mut bgra = vec![0u8; (width * height * 4) as usize];
                        // libyuv's ARGB is BGRA in memory, which is what GPUI draws.
                        livekit::webrtc::native::yuv_helper::i420_to_argb(y, stride_y, u, stride_u, v, stride_v, &mut bgra, width * 4, width as i32, height as i32);
                        serial += 1;
                        show(&writing, Frame { width, height, bgra: Arc::new(bgra), serial, #[cfg(target_os = "macos")] surface: None });
                    }
                });
                self.videos.lock().insert(sid, RemoteVideo { feed, task: task.abort_handle() });
            }
        }
    }

    pub(super) fn unsubscribed(&self, sid: &TrackSid) {
        if let Some(audio) = self.audio.lock().remove(sid) {
            self.mixer.remove(audio.mixer_id);
        }
        self.videos.lock().remove(sid);
    }
}

/// Follows what the room says, until it's closed.
pub(super) async fn watch(room: Arc<Room>, shared: Arc<Shared>, mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>, out: UnboundedSender<Event>) {
    let send = |event: Event| {
        out.unbounded_send(event).ok();
    };
    while let Some(event) = events.recv().await {
        if shared.closed.load(Ordering::Relaxed) {
            break;
        }
        match event {
            RoomEvent::Connected { .. } | RoomEvent::Reconnected => send(Event::Status(Status::Connected)),
            RoomEvent::Reconnecting => send(Event::Status(Status::Reconnecting)),
            RoomEvent::Disconnected { reason } => {
                send(Event::Closed(Some(reason)));
                break;
            }
            RoomEvent::ParticipantConnected(participant) => {
                let identity = participant.identity().0;
                shared.install_for(&identity);
                if let Some((user, _, false)) = parse_identity(&identity) {
                    send(Event::Participants(Some(user), None));
                }
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                let identity = participant.identity().0;
                for sid in participant.track_publications().keys() {
                    shared.unsubscribed(sid);
                }
                if let Some((user, _, false)) = parse_identity(&identity) {
                    send(Event::Participants(None, Some(user)));
                }
                send(Event::Media);
            }
            RoomEvent::TrackSubscribed { track, publication, participant } => {
                shared.subscribed(&room, track, publication, participant);
                send(Event::Media);
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                shared.unsubscribed(&publication.sid());
                send(Event::Media);
            }
            RoomEvent::TrackMuted { .. } | RoomEvent::TrackUnmuted { .. } | RoomEvent::TrackPublished { .. } | RoomEvent::TrackUnpublished { .. } | RoomEvent::LocalTrackPublished { .. } | RoomEvent::LocalTrackUnpublished { .. } => send(Event::Media),
            RoomEvent::ActiveSpeakersChanged { speakers } => {
                let users = speakers
                    .iter()
                    .filter_map(|speaker| {
                        let identity = speaker.identity().0;
                        match parse_identity(&identity) {
                            Some((user, _, false)) if identity != shared.identity => Some(user),
                            _ => None,
                        }
                    })
                    .collect();
                send(Event::Speaking(users));
            }
            RoomEvent::ConnectionQualityChanged { quality, participant } => {
                if participant.identity().0 == shared.identity {
                    send(Event::Quality(match quality {
                        ConnectionQuality::Excellent => Quality::Excellent,
                        ConnectionQuality::Good => Quality::Good,
                        ConnectionQuality::Poor => Quality::Poor,
                        ConnectionQuality::Lost => Quality::Lost,
                    }));
                }
            }
            RoomEvent::ParticipantPermissionChanged { participant, .. } => {
                if participant.identity().0 == shared.identity {
                    send(Event::Permissions);
                }
            }
            _ => {}
        }
    }
}
