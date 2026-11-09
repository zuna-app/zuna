//! What the message box does: typing, suggestions, link previews, files, sending, and
//! editing a message in place.

use super::*;

/// A file to go with the next message, with its size and, for a picture, a small preview for its chip.
pub(super) fn stage_file(path: &std::path::Path) -> StagedFile {
    let file = file_for_sending(path);
    let name = file["name"].as_str().unwrap_or("file").to_string();
    let mime = file["mime"].as_str().unwrap_or("").to_string();
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let preview = (mime.starts_with("image/") && mime != "image/svg+xml")
        .then(|| std::fs::read(path).ok())
        .flatten()
        .and_then(|bytes| image::load_from_memory(&bytes).ok())
        .and_then(|picture| {
            let mut png = Vec::new();
            picture.thumbnail(72, 72).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
            Some(Arc::new(Image::from_bytes(gpui::ImageFormat::Png, png)))
        });
    StagedFile { file, name, size, preview }
}

/// A file picked to send, by path, which the core reads a chunk at a time.
fn file_for_sending(path: &std::path::Path) -> serde_json::Value {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    let path_text = path.to_string_lossy().into_owned();
    let mut file = json!({ "blob": crate::host::file(&path_text, mime), "name": name, "mime": mime });
    // Dimensions and a tiny blurred preview, as the web's prepareFile makes them.
    if mime.starts_with("image/") {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(image) = image::load_from_memory(&bytes) {
                file["width"] = json!(image.width());
                file["height"] = json!(image.height());
                if let Some((thumb, _, _)) = crate::host::shrink_image(&bytes, 48) {
                    file["thumb"] = json!(thumb);
                }
            }
        }
    } else if mime.starts_with("video/") || mime.starts_with("audio/") {
        // A video's length and size, and its picture from a moment in, at most 22 KB of it.
        if let Some(details) = crate::media::mf::details(path) {
            if let Some(duration) = details.duration {
                file["duration"] = json!(duration);
            }
            if let (Some(width), Some(height)) = (details.width, details.height) {
                file["width"] = json!(width);
                file["height"] = json!(height);
                let moment = (details.duration.unwrap_or(0.) / 3.).min(0.5);
                for (size, quality) in [(320, 65), (240, 55), (160, 50)] {
                    if let Some((jpeg, _, _)) = crate::media::mf::poster(path, moment, size, quality) {
                        use base64::Engine;
                        let data = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg));
                        if data.len() <= 22 << 10 {
                            file["thumb"] = json!(data);
                            break;
                        }
                    }
                }
            }
        }
    }
    file
}

impl ChatView {
    pub(super) fn on_composer(&mut self, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Submit if self.recording.is_some() => self.send_recording(cx),
            InputEvent::Escape if self.recording.is_some() => self.cancel_recording(window, cx),
            InputEvent::Submit => {
                if let Some(index) = self.selected.filter(|_| !self.suggestions.is_empty()) {
                    self.apply_suggestion(index, cx);
                } else if !self.suggestions.is_empty() && !self.state.read(cx).settings.enter_to_send {
                    // Suggestions take Enter, but with none picked it still makes a new line.
                    self.composer.update(cx, |input, cx| input.insert("\n", window, cx));
                } else {
                    self.send(window, cx);
                }
            }
            InputEvent::Changed => {
                let Some(conversation) = self.conversation(cx) else { return };
                let text = self.composer.read(cx).text().to_string();
                let key = conversation.key.clone();
                self.state.update(cx, |state, _| {
                    if text.is_empty() {
                        state.drafts.remove(&key);
                    } else {
                        state.drafts.insert(key, text.clone());
                    }
                });
                if let Some(group) = conversation.group_id.clone() {
                    let now = now_ms();
                    if !text.is_empty() && now - self.last_typing > 3000. {
                        self.last_typing = now;
                        self.state.update(cx, |state, cx| state.act("sendTyping", vec![json!(group)], cx));
                    }
                }
                self.update_suggestions(&conversation, cx);
                self.update_link(&text, cx);
                cx.notify();
            }
            // Moving out of a ":" or "@" closes its suggestions, and moving into one opens them.
            InputEvent::CaretMoved if self.current_trigger(cx) != self.trigger => {
                let Some(conversation) = self.conversation(cx) else { return };
                self.update_suggestions(&conversation, cx);
                cx.notify();
            }
            InputEvent::Escape => {
                let list_id = self.last_list_id.clone();
                let editing = self.state.read(cx).editing.contains_key(&list_id);
                self.state.update(cx, |state, cx| {
                    if editing {
                        state.set_editing(&list_id, None, cx);
                    } else if state.reply_to.contains_key(&list_id) {
                        state.set_reply(&list_id, None, cx);
                    } else if state.panel.is_some() {
                        state.panel = None;
                        cx.notify();
                    }
                });
                if editing {
                    self.composer.update(cx, |input, cx| input.set_text("", cx));
                }
            }
            InputEvent::Tab if !self.suggestions.is_empty() => {
                self.apply_suggestion(self.selected.unwrap_or(0), cx);
            }
            InputEvent::Down if !self.suggestions.is_empty() => {
                let count = self.suggestions.len();
                self.selected = Some(self.selected.map_or(0, |index| (index + 1) % count));
                cx.notify();
            }
            InputEvent::Up if !self.suggestions.is_empty() => {
                let count = self.suggestions.len();
                self.selected = Some(self.selected.map_or(count - 1, |index| (index + count - 1) % count));
                cx.notify();
            }
            InputEvent::Files(paths) => self.add_files(paths.clone(), cx),
            InputEvent::Up => {
                // Up in an empty box edits your last message, as in Telegram.
                if !self.composer.read(cx).text().is_empty() {
                    return;
                }
                let list_id = self.last_list_id.clone();
                let state = self.state.read(cx);
                let self_id = state.servers.get(&self.server_id).map(|s| s.self_id().to_string()).unwrap_or_default();
                let last = state.lists.get(&list_id).and_then(|list| {
                    list.items.iter().rev().find(|item| item.sender_id == self_id && !item.text.is_empty() && item.deleted_at.is_none() && item.seq.is_some() && item.forwarded.is_none()).cloned()
                });
                if let Some(message) = last {
                    self.state.update(cx, |state, cx| state.set_editing(&list_id, Some(message), cx));
                }
            }
            InputEvent::Focused => {
                self.composer_focused = true;
                cx.notify();
            }
            InputEvent::Blurred => {
                self.composer_focused = false;
                cx.notify();
            }
            _ => {}
        }
    }

    // --- Voice and video messages ---

    /// The ":" or "@" just before the caret, what follows it, and where it starts, or the "/" at
    /// the very start, for the commands of the bots in this chat.
    pub(super) fn current_trigger(&self, cx: &gpui::App) -> Option<(char, String, usize)> {
        static TRIGGER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s)([:@])([\p{L}\p{N}_.-]{0,32})$").unwrap());
        static COMMAND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/([A-Za-z0-9_]{0,32})$").unwrap());
        let input = self.composer.read(cx);
        let text = input.text();
        let caret = input.cursor().min(text.len());
        if let Some(found) = COMMAND.captures(text.get(..caret)?) {
            return Some(('/', found[1].to_lowercase(), 0));
        }
        let found = TRIGGER.captures(text.get(..caret)?)?;
        let kind = found[1].chars().next()?;
        let query = found[2].to_lowercase();
        (kind == ':' || !query.is_empty()).then(|| (kind, query, caret - found[2].len() - 1))
    }

    /// What ":" or "@" just before the caret asks to complete, and what fits it.
    pub(super) fn update_suggestions(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let trigger = self.current_trigger(cx);
        let changed = trigger.as_ref().map(|(kind, query, _)| (*kind, query.clone())) != self.trigger.as_ref().map(|(kind, query, _)| (*kind, query.clone()));
        self.trigger = trigger.clone();
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return };
        self.suggestions = match &trigger {
            None => Vec::new(),
            Some((':', query, _)) => {
                let emotes = &server.emotes.emotes;
                let picked: Vec<&Emote> = if query.is_empty() {
                    emotes.iter().take(MAX_SUGGESTIONS).collect()
                } else {
                    let mut starts = Vec::new();
                    let mut contains = Vec::new();
                    for emote in emotes {
                        let lower = emote.name.to_lowercase();
                        if lower.starts_with(query.as_str()) {
                            starts.push(emote);
                        } else if lower.contains(query.as_str()) {
                            contains.push(emote);
                        }
                        if starts.len() >= MAX_SUGGESTIONS {
                            break;
                        }
                    }
                    starts.into_iter().chain(contains).take(MAX_SUGGESTIONS).collect()
                };
                picked
                    .into_iter()
                    .map(|emote| Suggestion {
                        key: emote.id.clone(),
                        label: emote.name.clone(),
                        hint: (!emote.owner.is_empty()).then(|| format!("by {}", emote.owner)),
                        insert: format!("{} ", emote.name),
                        what: Suggested::Emote(emote.clone()),
                    })
                    .collect()
            }
            Some(('/', query, _)) => {
                // The bots in this chat: the one a direct message is with, or the ones among its members.
                let ids: Vec<&String> = if conversation.kind == "dm" { conversation.peer_id.iter().collect() } else { conversation.members.iter().map(|member| &member.user_id).collect() };
                let bots: Vec<&UserView> = ids.into_iter().filter_map(|id| server.users.get(id)).filter(|user| user.bot.is_some() && !user.deleted && !user.banned).collect();
                let several = bots.len() > 1;
                bots.iter()
                    .flat_map(|bot| bot.commands.iter().map(move |command| (*bot, command)))
                    .filter(|(_, command)| command.command.starts_with(query.as_str()))
                    .take(MAX_SUGGESTIONS)
                    .map(|(bot, command)| Suggestion {
                        key: format!("{}/{}", bot.id, command.command),
                        label: format!("/{}", command.command),
                        hint: Some(command.description.clone()),
                        // Whose it is, where more than one bot could answer.
                        insert: if several { format!("/{}@{} ", command.command, bot.username) } else { format!("/{} ", command.command) },
                        what: Suggested::Person(bot.clone()),
                    })
                    .collect()
            }
            Some((_, query, _)) => {
                // Anyone on the server can be mentioned in a channel, even someone whose device hasn't come in yet.
                let mut people: Vec<&UserView> = if conversation.kind == "group" {
                    conversation.members.iter().filter_map(|member| server.users.get(&member.user_id)).collect()
                } else {
                    let mut all: Vec<&UserView> = server.users.values().collect();
                    all.sort_by_cached_key(|user| user.display_name.to_lowercase());
                    all
                };
                people.retain(|user| !user.banned && !user.deleted && (user.username.to_lowercase().contains(query.as_str()) || user.display_name.to_lowercase().contains(query.as_str())));
                people
                    .into_iter()
                    .take(MAX_SUGGESTIONS)
                    .map(|user| Suggestion {
                        key: user.id.clone(),
                        label: user.display_name.clone(),
                        hint: Some(format!("@{}", user.username)),
                        insert: format!("@{} ", user.username),
                        what: Suggested::Person(user.clone()),
                    })
                    .collect()
            }
        };
        if changed {
            let tentative = matches!(&self.trigger, Some((':', query, _)) if query.chars().count() < 2);
            self.selected = if tentative { None } else { Some(0) };
        }
        let suggesting = !self.suggestions.is_empty();
        self.composer.update(cx, |input, _| input.set_suggesting(suggesting));
    }

    pub(super) fn apply_suggestion(&mut self, index: usize, cx: &mut Context<Self>) {
        // Only while the caret is still in the ":" or "@" the suggestions were made for.
        let trigger = self.current_trigger(cx).filter(|trigger| Some(trigger) == self.trigger.as_ref());
        let (Some((_, _, start)), Some(suggestion)) = (trigger, self.suggestions.get(index).cloned()) else { return };
        let caret = self.composer.read(cx).cursor();
        self.composer.update(cx, |input, cx| input.replace_range(start..caret, &suggestion.insert, cx));
    }

    /// Makes the first link's preview once typing pauses, unless it was taken away.
    pub(super) fn update_link(&mut self, text: &str, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let editing = state.editing.contains_key(&self.last_list_id);
        let link = if state.settings.link_previews && !editing { find_link(text) } else { None };
        let link = link.filter(|link| Some(link) != self.dismissed_link.as_ref());
        if link == self.link_wanted {
            return;
        }
        self.link_wanted = link.clone();
        self.link_draft = None;
        self.link_task = None;
        let Some(url) = link else { return };
        let core = self.state.read(cx).core.clone();
        self.link_task = Some(cx.spawn(async move |view, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(PREVIEW_DELAY_MS)).await;
            view.update(cx, |view, cx| {
                view.link_draft = Some(LinkDraft { url: url.clone(), preview: None, loading: true });
                cx.notify();
            })
            .ok();
            let result = core.call(None, "linkPreview", vec![json!(url)]).await;
            view.update(cx, |view, cx| {
                if view.link_wanted.as_ref() != Some(&url) {
                    return;
                }
                view.link_draft = match result {
                    Ok(value) => Some(LinkDraft { url: url.clone(), preview: serde_json::from_value(value).ok(), loading: false }),
                    Err(_) => None,
                };
                cx.notify();
            })
            .ok();
        }));
    }

    /// Adds files to go with the next message, up to ten, read for their chips away from the window.
    pub(super) fn add_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let room = MAX_FILES.saturating_sub(self.files.len());
        let paths: Vec<PathBuf> = paths.into_iter().filter(|path| path.is_file()).take(room).collect();
        if paths.is_empty() {
            return;
        }
        cx.spawn(async move |view, cx| {
            let staged = cx.background_executor().spawn(async move { paths.iter().map(|path| stage_file(path)).collect::<Vec<_>>() }).await;
            view.update(cx, |view, cx| {
                view.files.extend(staged);
                view.files.truncate(MAX_FILES);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Seconds until slow mode lets a new message go here, counting down while it holds.
    pub(super) fn slow_wait(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> u64 {
        if conversation.slow_mode <= 0. {
            return 0;
        }
        let until = conversation.slow_until.max(self.sent_until);
        let left = ((until - now_ms()) / 1000.).ceil().max(0.) as u64;
        if left > 0 && self.slow_tick.is_none() {
            self.slow_tick = Some(cx.spawn(async move |view, cx| {
                loop {
                    cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
                    let done = view
                        .update(cx, |view, cx| {
                            cx.notify();
                            let until = view.conversation(cx).map(|c| c.slow_until).unwrap_or(0.).max(view.sent_until);
                            until <= now_ms()
                        })
                        .unwrap_or(true);
                    if done {
                        break;
                    }
                }
                view.update(cx, |view, _| view.slow_tick = None).ok();
            }));
        }
        left
    }

    pub(super) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let value = self.composer.read(cx).text().trim().to_string();
        let list_id = conversation.list_id();
        let waiting = self.slow_wait(&conversation, cx) > 0;
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return };
        let editing = if conversation.kind == "channel" { None } else { state.editing.get(&list_id).cloned() };
        let reply = state.reply_to.get(&list_id).cloned();
        if value.is_empty() && (self.files.is_empty() || editing.is_some()) {
            return;
        }
        if value.chars().count() > MAX_TEXT_LENGTH {
            self.state.update(cx, |state, cx| state.toast("That message is too long. Try sending it as a file.", ToastKind::Error, cx));
            return;
        }
        let mentions = mentions_in(&value, &server.mentionable);
        let emotes = server.emotes.refs_in(&value);
        if let Some(editing) = editing {
            if value != editing.text {
                let args = vec![json!(editing.group_id), json!(editing.id), json!(value), json!(emotes), json!(mentions)];
                self.state.update(cx, |state, cx| state.act("editMessage", args, cx));
            }
            self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx));
            self.composer.update(cx, |input, cx| input.set_text("", cx));
            return;
        }
        // What's written stays until it may go.
        if waiting {
            return;
        }
        let mut body = json!({ "emotes": emotes, "mentions": mentions });
        if !value.is_empty() {
            body["text"] = json!(value);
        }
        if let Some(reply) = reply {
            body["replyTo"] = json!(reply.id);
        }
        // A preview that isn't ready yet, as when a link is pasted and sent at once, goes with
        // the message if it's ready within a few seconds; the message shows straight away.
        let link = self.link_wanted.clone();
        let ready = self.link_draft.as_ref().filter(|draft| Some(&draft.url) == link.as_ref());
        if let Some(preview) = ready.and_then(|draft| draft.preview.as_ref()).filter(|preview| value.contains(&preview.url)) {
            body["preview"] = serde_json::to_value(preview).unwrap_or_default();
        }
        let settled = ready.is_some_and(|draft| !draft.loading);
        let mut options = json!({});
        if let (Some(link), true, false) = (&link, body.get("preview").is_none(), settled) {
            options["previewUrl"] = json!(link);
        }
        let key = conversation.key.clone();
        let files: Vec<serde_json::Value> = std::mem::take(&mut self.files).into_iter().map(|staged| staged.file).collect();
        let keep_metadata = !state.settings.remove_metadata;
        let is_admin = conversation.is_admin(&server.self_id());
        let server_id = self.server_id.clone();
        self.state.update(cx, |state, cx| {
            if files.is_empty() {
                state.act("sendMessage", vec![json!(key), body, options], cx);
            } else {
                options["keepMetadata"] = json!(keep_metadata);
                state.call(Some(&server_id), "sendWithAttachments", vec![json!(key), json!(files), body, options], cx, |state, result, cx| {
                    if let Err(error) = result {
                        state.toast(error.message, ToastKind::Error, cx);
                    }
                });
            }
            state.set_reply(&list_id, None, cx);
            state.drafts.remove(&key);
            // A window that has read on to the newest is already there.
            if state.lists.get(&list_id).is_some_and(|list| list.detached && list.has_newer) {
                state.return_to_latest(&list_id, cx);
            }
        });
        // In slow mode the next one waits from now, unless you're an admin.
        if conversation.slow_mode > 0. && !is_admin {
            self.sent_until = now_ms() + conversation.slow_mode * 1000.;
        }
        self.link_wanted = None;
        self.link_draft = None;
        self.link_task = None;
        self.dismissed_link = None;
        self.composer.update(cx, |input, cx| input.set_text("", cx));
        // At the newest, where a glide still going would pull it back from, and where the
        // message sent glides in as it does when the list was already there.
        self.glide = None;
        self.to_newest(cx);
        self.composer.focus_handle(cx).focus(window, cx);
    }

    /// What the attach button offers: a photo or file, or where this device is.
    pub(super) fn attach_menu(&mut self, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let view = cx.entity().downgrade();
        let state = self.state.clone();
        let key = conversation.key.clone();
        let entries = vec![
            crate::ui::menu::MenuEntry::new("Photo or file", "file", move |window, cx| {
                view.update(cx, |view, cx| view.attach(window, cx)).ok();
            }),
            crate::ui::menu::MenuEntry::new("Location", "map-pin", move |_, cx| {
                state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::ShareLocation { conversation_key: key.clone() }), cx))
            }),
        ];
        crate::ui::menu::open_menu(gpui::point(position.x - px(10.), position.y - px(96.)), entries, false, cx);
    }

    /// Picks files to go with the next message, as the web's attach button does.
    pub(super) fn attach(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            view.update(cx, |view, cx| view.add_files(paths, cx)).ok();
        })
        .detach();
    }

    /// Editing a channel message where it is: the field, focused, holding its text.
    pub(super) fn sync_inline_editor(&mut self, conversation: &ConversationView, window: &mut Window, cx: &mut Context<Self>) {
        let editing = if conversation.kind == "channel" { self.state.read(cx).editing.get(&conversation.list_id()).cloned() } else { None };
        match editing {
            Some(message) if self.inline_editing.as_deref() != Some(message.id.as_str()) => {
                self.inline_editing = Some(message.id.clone());
                let text = message.text.clone();
                let editor = self.inline_editor.clone();
                editor.update(cx, |input, cx| input.set_text(text, cx));
                editor.focus_handle(cx).focus(window, cx);
            }
            None if self.inline_editing.is_some() => {
                self.inline_editing = None;
                self.composer.focus_handle(cx).focus(window, cx);
            }
            _ => {}
        }
    }

    /// Editing a message anywhere else, which goes through the message box: it takes the
    /// message's text, with the caret at its end, and focus, however the editing began.
    pub(super) fn sync_composer_editing(&mut self, conversation: &ConversationView, window: &mut Window, cx: &mut Context<Self>) {
        let editing = if conversation.kind == "channel" { None } else { self.state.read(cx).editing.get(&conversation.list_id()).cloned() };
        match editing {
            Some(message) if self.composer_editing.as_deref() != Some(message.id.as_str()) => {
                self.composer_editing = Some(message.id.clone());
                let text = message.text.clone();
                let composer = self.composer.clone();
                composer.update(cx, |input, cx| input.set_text(text, cx));
                composer.focus_handle(cx).focus(window, cx);
            }
            None if self.composer_editing.is_some() => self.composer_editing = None,
            _ => {}
        }
    }

    pub(super) fn on_inline_editor(&mut self, event: &InputEvent, cx: &mut Context<Self>) {
        let list_id = self.last_list_id.clone();
        match event {
            InputEvent::Submit => {
                let Some(message) = self.state.read(cx).editing.get(&list_id).cloned() else { return };
                let value = self.inline_editor.read(cx).text().trim().to_string();
                if !value.is_empty() && value != message.text {
                    let state = self.state.read(cx);
                    let Some(server) = state.servers.get(&self.server_id) else { return };
                    let mentions = mentions_in(&value, &server.mentionable);
                    let emotes = server.emotes.refs_in(&value);
                    let args = vec![json!(message.group_id), json!(message.id), json!(value), json!(emotes), json!(mentions)];
                    self.state.update(cx, |state, cx| state.act("editMessage", args, cx));
                }
                self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx));
            }
            InputEvent::Escape => self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx)),
            _ => {}
        }
    }
}
