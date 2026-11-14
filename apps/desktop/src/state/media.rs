//! Pictures, sounds, videos and files: fetched and decoded once, and the longest unused let go.

use super::*;

/// A download from the linked Telegram account is read only from inside its engine's folder, where
/// TDLib keeps what it downloads (`telegram::inside_engine_folder`), whatever the engine says.
pub fn checked_download(server_id: &str, value: serde_json::Value) -> Result<serde_json::Value, String> {
    if server_id != crate::telegram::SERVER_ID {
        return Ok(value);
    }
    let path = value.get("$file").and_then(|file| file.get("path")).and_then(serde_json::Value::as_str).ok_or("Telegram sent no file")?;
    if crate::telegram::inside_engine_folder(std::path::Path::new(path), &crate::telegram::folder(&host::data_dir())) {
        Ok(value)
    } else {
        Err("That file isn't one of Telegram's.".into())
    }
}

impl AppState {
    pub(super) fn store_picture(&mut self, key: String, result: Result<(Vec<u8>, String), String>, cx: &mut Context<Self>) {
        let picture = match result {
            Ok((bytes, mime)) if !bytes.is_empty() => Picture::Ready(Arc::new(Image::from_bytes(image_format(&mime, &bytes), bytes))),
            _ => Picture::Failed(std::time::Instant::now()),
        };
        self.touch_media(&key);
        self.pictures.insert(key, picture);
        self.trim_media();
        self.show_waiting(cx);
        cx.notify();
    }

    /// Something a server serves openly, such as its icon or an emote, by address.
    pub fn remote_picture(&mut self, url: &str, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        match self.pictures.get(url) {
            Some(Picture::Ready(image)) => {
                let image = image.clone();
                self.touch_media(url);
                return Some(image);
            }
            Some(Picture::Failed(at)) if at.elapsed() >= PICTURE_RETRY => {}
            Some(_) => return None,
            None => {}
        }
        self.pictures.insert(url.to_string(), Picture::Loading);
        let key = url.to_string();
        let fetching = host::fetch(url.to_string());
        cx.spawn(async move |this, cx| {
            let result = fetching.await.map(|bytes| (bytes, String::new()));
            this.update(cx, |state, cx| state.store_picture(key, result, cx)).ok();
        })
        .detach();
        None
    }

    /// An encrypted picture, such as a profile picture, decrypted by the core.
    pub fn decrypted_picture(&mut self, server_id: &str, avatar: &AvatarRef, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        let key = format!("file:{}", avatar.cache_id());
        match self.pictures.get(&key) {
            Some(Picture::Ready(image)) => {
                let image = image.clone();
                self.touch_media(&key);
                return Some(image);
            }
            Some(Picture::Failed(at)) if at.elapsed() >= PICTURE_RETRY => {}
            Some(_) => return None,
            None => {}
        }
        self.pictures.insert(key.clone(), Picture::Loading);
        let reference = serde_json::to_value(avatar).unwrap_or_default();
        let mime = avatar.mime.clone();
        let server = server_id.to_string();
        self.call(Some(server_id), "downloadFile", vec![reference], cx, move |state, result, cx| {
            let bytes = result.map_err(|error| error.message).and_then(|value| checked_download(&server, value)).and_then(|value| host::value_bytes(&value).ok_or_else(|| "no picture".to_string()));
            state.store_picture(key, bytes.map(|bytes| (bytes, mime)), cx);
        });
        None
    }

    // --- Sound and video ---

    /// A media file decrypted to disk, with the extension Media Foundation needs, asked for once.
    pub fn media_file(&mut self, server_id: &str, attachment: &crate::models::Attachment, cx: &mut Context<Self>) -> MediaFile {
        // Kept by the key it opens with too, so a message elsewhere naming the same file is never shown this copy.
        let id = attachment.cache_id();
        if let Some(file) = self.media_files.get(&id) {
            return file.clone();
        }
        self.media_files.insert(id.clone(), MediaFile::Loading);
        let reference = serde_json::json!({ "fileId": attachment.file_id, "key": attachment.key, "prefix": attachment.prefix, "chunks": attachment.chunks, "mime": attachment.mime });
        let extension = media_extension(&attachment.mime, &attachment.name);
        let server = server_id.to_string();
        self.call(Some(server_id), "downloadFile", vec![reference], cx, move |state, result, cx| {
            let target = host::cache_dir().join("media").join(format!("{id}.{extension}"));
            let written = result.map_err(|error| error.message).and_then(|value| {
                std::fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
                // Moved rather than copied, so there's one decrypted copy, under the name Media Foundation
                // needs; but a Telegram file is copied, as it's the engine's, which keeps it.
                let telegram = server == crate::telegram::SERVER_ID;
                let value = checked_download(&server, value)?;
                host::save_value(&value, &target, !telegram)
            });
            let ready = written.is_ok();
            state.touch_media(&id);
            state.media_files.insert(id.clone(), if ready { MediaFile::Ready(target) } else { MediaFile::Failed });
            if ready {
                state.media_arrived(&id, cx);
            } else if matches!(state.clips.get(&id), Some(ClipState::Loading)) {
                // Its sound won't come either, so it shows as failed rather than loading for good.
                state.clips.insert(id.clone(), ClipState::Failed);
            }
            state.trim_media();
            cx.notify();
        });
        MediaFile::Loading
    }

    /// A file's sound, decoded away from the window once the file is here.
    pub fn clip(&mut self, server_id: &str, attachment: &crate::models::Attachment, cx: &mut Context<Self>) -> ClipState {
        let id = attachment.cache_id();
        if let Some(clip) = self.clips.get(&id) {
            if !matches!(clip, ClipState::Loading) || self.media_files.contains_key(&id) {
                return clip.clone();
            }
        }
        self.clips.insert(id.clone(), ClipState::Loading);
        match self.media_file(server_id, attachment, cx) {
            MediaFile::Ready(path) => self.decode_clip(id.clone(), path, cx),
            MediaFile::Failed => {
                self.clips.insert(id.clone(), ClipState::Failed);
            }
            MediaFile::Loading => {}
        }
        self.clips.get(&id).cloned().unwrap_or(ClipState::Loading)
    }

    pub(super) fn decode_clip(&mut self, id: String, path: std::path::PathBuf, cx: &mut Context<Self>) {
        self.clips.insert(id.clone(), ClipState::Loading);
        cx.spawn(async move |state, cx| {
            let decoded = cx
                .background_executor()
                .spawn(async move {
                    crate::media::mf::decode_audio(&path)
                        .inspect_err(|error| log::warn!("a sound couldn't be decoded: {error}"))
                        .ok()
                        .map(|(samples, rate)| crate::media::player::Clip::from_floats(&samples, rate))
                })
                .await;
            state
                .update(cx, |state, cx| {
                    match decoded {
                        Some(clip) => {
                            state.touch_media(&id);
                            state.clips.insert(id.clone(), ClipState::Ready(clip.clone()));
                            state.trim_media();
                            // Pressed before it was ready: it starts now.
                            if let Some((key, from, speed)) = state.play_when_ready.clone().filter(|(key, _, _)| *key == id) {
                                state.play_when_ready = None;
                                crate::media::player::play(&key, &clip, from, speed);
                                state.tick_media(cx);
                            }
                            if let Some(player) = state.videos.get(&id).cloned() {
                                player.update(cx, |player, cx| player.set_clip(clip, cx));
                            }
                        }
                        None => {
                            state.clips.insert(id.clone(), ClipState::Failed);
                        }
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    /// What waits on a media file once it's on disk: its sound, or its player.
    pub(super) fn media_arrived(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(MediaFile::Ready(path)) = self.media_files.get(id).cloned() else { return };
        if matches!(self.clips.get(id), Some(ClipState::Loading)) {
            self.decode_clip(id.to_string(), path.clone(), cx);
        }
        if let Some((round, duration, source)) = self.videos_wanted.remove(id) {
            let clip = match self.clips.get(id) {
                Some(ClipState::Ready(clip)) => Some(clip.clone()),
                _ => None,
            };
            let key = id.to_string();
            let player = cx.new(|cx| crate::ui::media_views::VideoPlayer::new(key, path.clone(), round, duration, clip, source, cx));
            self.touch_media(id);
            self.videos.insert(id.to_string(), player);
            self.trim_media();
            if !matches!(self.clips.get(id), Some(ClipState::Ready(_))) {
                self.decode_clip(id.to_string(), path, cx);
            }
        }
    }

    /// Starts a video where it's shown, once its file is here. It remembers the chat it's in
    /// (`list_id`), so it can open in the viewer among that chat's pictures and videos.
    pub fn open_video(&mut self, server_id: &str, list_id: &str, attachment: &crate::models::Attachment, round: bool, cx: &mut Context<Self>) {
        let id = attachment.cache_id();
        if self.videos.contains_key(&id) {
            return;
        }
        let source = crate::ui::media_views::VideoSource { server_id: server_id.to_string(), list_id: list_id.to_string(), attachment: attachment.clone() };
        self.videos_wanted.insert(id.clone(), (round, attachment.duration.unwrap_or(0.), source));
        if let MediaFile::Ready(_) = self.media_file(server_id, attachment, cx) {
            self.media_arrived(&id, cx);
        }
    }

    /// No longer starts a video once its file is here, as when the viewer went on from it first.
    pub fn unwant_video(&mut self, key: &str) {
        self.videos_wanted.remove(key);
    }

    #[cfg(test)]
    pub fn wants_video(&self, key: &str) -> bool {
        self.videos_wanted.contains_key(key)
    }

    /// Draws the chat again while something plays, so its time and waveform move. It ticks
    /// `media_clock`, which only the chat watches, rather than waking every view of the app.
    pub fn tick_media(&mut self, cx: &mut Context<Self>) {
        if self.media_tick.is_some() {
            return;
        }
        self.media_tick = Some(cx.spawn(async move |state, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let going = state
                .update(cx, |state, cx| {
                    state.media_clock.update(cx, |_, cx| cx.notify());
                    let going = crate::media::player::current().is_some();
                    if !going {
                        state.media_tick = None;
                    }
                    going
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    /// Notes that a picture, sound, video or media file is being shown, so it's the last to go.
    pub fn touch_media(&self, key: &str) {
        let count = self.media_count.get() + 1;
        self.media_count.set(count);
        let mut used = self.media_used.borrow_mut();
        match used.get_mut(key) {
            Some(at) => *at = count,
            None => {
                used.insert(key.to_string(), count);
            }
        }
    }

    /// Lets the least recently shown pictures, sounds, video players and media files go while
    /// their caches are over the limits, down to three quarters of each, so it isn't done again
    /// at once. Whatever is playing stays, as does a media file with a player, and anything
    /// still loading.
    pub(super) fn trim_media(&mut self) {
        let playing = crate::media::player::current();
        let used = self.media_used.borrow().clone();
        let last_shown = |key: &str| used.get(key).copied().unwrap_or(0);
        let oldest_first = |mut keys: Vec<(String, usize)>| {
            keys.sort_by_key(|(key, _)| last_shown(key));
            keys
        };

        let pictures: Vec<(String, usize)> = self
            .pictures
            .iter()
            .filter_map(|(key, picture)| match picture {
                Picture::Ready(image) => Some((key.clone(), image.bytes().len())),
                _ => None,
            })
            .collect();
        let mut total: usize = pictures.iter().map(|(_, size)| size).sum();
        if total > PICTURE_BYTES {
            for (key, size) in oldest_first(pictures) {
                if total <= PICTURE_BYTES / 4 * 3 {
                    break;
                }
                self.pictures.remove(&key);
                total -= size;
            }
        }

        let clips: Vec<(String, usize)> = self
            .clips
            .iter()
            .filter_map(|(key, clip)| match clip {
                ClipState::Ready(clip) if playing.as_deref() != Some(key.as_str()) => Some((key.clone(), clip.samples.len() * 2)),
                _ => None,
            })
            .collect();
        let mut total: usize = clips.iter().map(|(_, size)| size).sum();
        if total > CLIP_BYTES {
            for (key, size) in oldest_first(clips) {
                if total <= CLIP_BYTES / 4 * 3 {
                    break;
                }
                self.clips.remove(&key);
                total -= size;
            }
        }

        if self.videos.len() > VIDEOS_KEPT {
            let videos: Vec<(String, usize)> = self.videos.keys().filter(|key| playing.as_deref() != Some(key.as_str())).map(|key| (key.clone(), 1)).collect();
            let excess = self.videos.len() - VIDEOS_KEPT / 4 * 3;
            for (key, _) in oldest_first(videos).into_iter().take(excess) {
                self.videos.remove(&key);
            }
        }

        if self.media_files.len() > MEDIA_FILES_KEPT {
            let files: Vec<(String, usize)> = self
                .media_files
                .iter()
                .filter(|(key, file)| !matches!(file, MediaFile::Loading) && playing.as_deref() != Some(key.as_str()) && !self.videos.contains_key(*key))
                .map(|(key, _)| (key.clone(), 1))
                .collect();
            let excess = self.media_files.len() - MEDIA_FILES_KEPT / 4 * 3;
            for (key, _) in oldest_first(files).into_iter().take(excess) {
                // The decrypted copy on disk goes with it.
                if let Some(MediaFile::Ready(path)) = self.media_files.remove(&key) {
                    std::fs::remove_file(path).ok();
                }
            }
        }

        let mut used = self.media_used.borrow_mut();
        used.retain(|key, _| self.pictures.contains_key(key) || self.clips.contains_key(key) || self.videos.contains_key(key) || self.media_files.contains_key(key));
    }
}

/// The extension a media file needs for Windows to read it.
pub(super) fn media_extension(mime: &str, name: &str) -> String {
    let known = match mime {
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => "m4a",
        "video/mp4" => "mp4",
        "audio/webm" | "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" => "flac",
        "video/quicktime" => "mov",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    std::path::Path::new(name).extension().map(|extension| extension.to_string_lossy().to_lowercase()).filter(|extension| extension.len() <= 5).unwrap_or_else(|| "bin".into())
}
