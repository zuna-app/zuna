import SwiftUI
import ZunaModels

/// Writing a message, laid out like Telegram's: attach, the text growing up to
/// six lines with the emoji button inside, and send. Above it: the message
/// being answered or edited, files to send, and suggestions for `@` and `:`.
struct Composer: View {
    let serverId: String
    let conversation: ConversationView
    let server: AppModel.ServerState

    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var selection: TextSelection?
    @State private var attaching = false
    @State private var picking = false
    /// The highlighted suggestion, moved with a hardware keyboard's arrows.
    @State private var selectedSuggestion = 0
    @State private var recorder = VoiceRecorder()
    /// Made when a video message is first recorded here. SwiftUI works out a @State's first value
    /// each time the composer is made, every redraw of the chat, and keeps only the first, and each
    /// RoundRecorder made makes a capture session, a movie output and a queue.
    @State private var round: RoundRecorder?
    /// The button records video messages rather than voice ones, as it was last left, as in Telegram.
    @AppStorage("zuna-records-video") private var recordsVideo = false
    /// The finger is on the microphone; how far it slid to the left, toward cancelling.
    @State private var holding = false
    @State private var slide: CGFloat = 0
    /// When the message just sent from here lets the next one go in slow mode (ms), until the core says.
    @State private var sentUntil: Double = 0
    /// Moves on while slow mode holds back the next message, for its countdown.
    @State private var now = Date.now

    private var isRecording: Bool { recorder.isRecording || round?.isRecording == true }

    private var slowUntil: Double { conversation.slowMode > 0 ? max(conversation.slowUntil, sentUntil) : 0 }
    /// How many seconds until the channel's slow mode lets the next message go, or 0.
    private var slowWait: Int { max(0, Int((slowUntil - now.timeIntervalSince1970 * 1000) / 1000 + 0.999)) }
    /// Slow mode holds back a new message, and a voice or video message with it, while what's written waits. An edit isn't held back.
    private var waiting: Bool { slowWait > 0 && state.editing == nil }

    private static let maxSuggestions = 8

    private var state: ComposerState { model.composer(serverId, conversation.key) }

    private var text: Binding<String> {
        Binding(
            get: { model.composer(serverId, conversation.key).text },
            set: { value in
                model.updateComposer(serverId, conversation.key) { $0.text = value }
                if let groupId = conversation.groupId, !value.isEmpty {
                    Task { try? await model.core.session(serverId).sendTyping(groupId) }
                }
            }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            suggestionsList
            if let context = state.editing ?? state.replyTo {
                contextBar(context, editing: state.editing != nil)
            }
            if let link = state.link, link.loading || link.preview != nil {
                linkBar(link)
            }
            // Files wait out an edit, which can't take them, and come back after it.
            if !state.files.isEmpty, state.editing == nil {
                filesBar
            }
            HStack(alignment: .bottom, spacing: 8) {
                if state.editing == nil && !isRecording {
                    Button {
                        focused = false
                        attaching = true
                    } label: {
                        if conversation.kind == .channel {
                            // A round "+", as in a Discord channel.
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Theme.text2)
                                .frame(width: 36, height: 36)
                                .background(Theme.bg3, in: .circle)
                                .padding(.bottom, 1)
                        } else {
                            Image(systemName: "paperclip")
                                .font(.system(size: 21))
                                .foregroundStyle(Theme.text2)
                                .frame(width: 36, height: 38)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Attach files")
                    .accessibilityIdentifier(A11y.Composer.attach)
                }
                if isRecording {
                    recordingBar
                } else {
                    HStack(alignment: .bottom, spacing: 4) {
                        TextField(placeholder, text: text, selection: $selection, axis: .vertical)
                            .lineLimit(1...6)
                            .font(.body)
                            .foregroundStyle(Theme.text1)
                            .focused($focused)
                            .padding(.vertical, 8)
                            .onKeyPress(phases: .down) { press in handleKey(press) }
                            .accessibilityLabel("Message")
                            .accessibilityIdentifier(A11y.Composer.input)
                        Button {
                            picking = true
                        } label: {
                            Image(systemName: "face.smiling")
                                .font(.system(size: 20))
                                .foregroundStyle(Theme.text2)
                                .frame(width: 30, height: 36)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Emoji and emotes")
                        .accessibilityIdentifier(A11y.Composer.emoji)
                    }
                    .padding(.leading, 14)
                    .padding(.trailing, 6)
                    .background(Theme.bg2, in: .rect(cornerRadius: 19, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(Theme.line))
                }
                if waiting {
                    Text(Format.wait(slowWait))
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.text2)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 36, minHeight: 36)
                        .background(Theme.bg3, in: .capsule)
                        .padding(.bottom, 1)
                        .accessibilityLabel("Slow mode: you can send again in \(Format.wait(slowWait))")
                        .accessibilityIdentifier(A11y.Composer.slowWait)
                } else if !state.canSend && state.editing == nil {
                    microphone
                } else {
                    Button(action: send) {
                        Image(systemName: state.editing != nil ? "checkmark" : "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(state.canSend ? model.settings.accent.onAccent : Theme.text3)
                            .frame(width: 36, height: 36)
                            .background(state.canSend ? model.settings.accent.color : Theme.bg3, in: .circle)
                    }
                    .buttonStyle(.plain)
                    .disabled(!state.canSend)
                    .padding(.bottom, 1)
                    .accessibilityLabel(state.editing != nil ? "Save edit" : "Send")
                    .accessibilityIdentifier(A11y.Composer.send)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .task(id: slowUntil) {
            now = .now
            while slowUntil > Date.now.timeIntervalSince1970 * 1000 {
                try? await Task.sleep(for: .milliseconds(250))
                now = .now
            }
        }
        .background(Theme.bg0)
        .overlay(alignment: .top) { Divider().overlay(Theme.line) }
        .overlay(alignment: .top) {
            // What the camera sees while a video message is recorded, above the message box, with the minute going round.
            if let round, round.isPreviewing {
                ZStack {
                    CameraPreview(preview: round.preview)
                    Circle()
                        .trim(from: 0, to: min(1, round.elapsed / RoundRecorder.limit))
                        .stroke(model.settings.accent.color, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .padding(2)
                }
                .frame(width: 240, height: 240)
                .background(.black)
                .clipShape(.circle)
                .shadow(radius: 12)
                // Wholly above the message box, which an overlay of it would otherwise start at.
                .offset(y: -(240 + 16))
                .transition(.scale(scale: 0.6).combined(with: .opacity))
                .accessibilityIdentifier(A11y.Composer.roundPreview)
            }
        }
        .animation(.spring(duration: 0.3), value: round?.isPreviewing ?? false)
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: RoundRecorder.control)) { note in
            // As holding the button in video mode and letting go do.
            if note.object as? String == "start" {
                recordsVideo = true
                holding = true
                Task { await startRecording() }
            } else {
                holding = false
                finishRecording()
            }
        }
        #endif
        .sheet(isPresented: $attaching) {
            AttachSheet(
                serverId: serverId,
                conversation: conversation,
                caption: text,
                room: OutgoingFiles.limit - state.files.count,
                send: { urls in
                    await stageFiles(urls, scoped: false)
                    send()
                },
                stage: { urls, scoped in await stageFiles(urls, scoped: scoped) },
                paste: pasteImage
            )
        }
        .sheet(isPresented: $picking) {
            EmojiPicker(server: server) { pick in
                insert(pick)
                if case .emote = pick { picking = false }
            }
            .presentationDetents([.medium, .large])
        }
        .onChange(of: trigger?.query) { selectedSuggestion = tentative ? -1 : 0 }
        .task(id: "\(model.settings.linkPreviews)|\(state.editing?.id ?? "")|\(state.text)") {
            await model.updateLinkPreview(serverId, conversation.key, text: state.text)
        }
        .onChange(of: state.editing?.id) { _, id in
            // The caret at the end of what's now in the box, the message or the draft back from before,
            // rather than where it was in the text this replaced.
            let text = model.composer(serverId, conversation.key).text
            selection = TextSelection(insertionPoint: text.endIndex)
            if id != nil { focused = true }
        }
        .onChange(of: state.replyTo?.id) { _, id in
            if id != nil { focused = true }
        }
        .onChange(of: model.pendingAttachments) {
            // All that's waiting now, not as it was when this was called: emptying the list
            // would lose a file added in between.
            let urls = model.pendingAttachments
            guard !urls.isEmpty else { return }
            model.pendingAttachments = []
            Task { await stageFiles(urls, scoped: false) }
        }
    }

    /// A hardware keyboard, as on the desktop: Return sends (Shift-Return makes a new
    /// line), Command- or Control-Return always sends, Escape cancels an edit or reply,
    /// Up in an empty message edits your last one, and the arrows and Tab pick a suggestion.
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        let shown = suggestions
        if !shown.isEmpty {
            switch press.key {
            case .downArrow:
                selectedSuggestion = (selectedSuggestion + 1) % shown.count
                return .handled
            case .upArrow:
                selectedSuggestion = selectedSuggestion < 0 ? shown.count - 1 : (selectedSuggestion - 1 + shown.count) % shown.count
                return .handled
            case .tab:
                apply(shown[min(max(0, selectedSuggestion), shown.count - 1)])
                return .handled
            case .return where selectedSuggestion >= 0:
                apply(shown[min(selectedSuggestion, shown.count - 1)])
                return .handled
            default:
                break
            }
        }
        switch press.key {
        case .return:
            if press.modifiers.contains(.shift) { return .ignored }
            if model.settings.enterToSend || press.modifiers.contains(.command) || press.modifiers.contains(.control) {
                send()
                return .handled
            }
            return .ignored
        case .escape:
            if state.editing != nil {
                model.edit(serverId, conversation.key, nil)
            } else if state.replyTo != nil {
                model.reply(serverId, conversation.key, to: nil)
            } else {
                return .ignored
            }
            return .handled
        case .upArrow:
            guard state.text.isEmpty, let last = lastOwnMessage else { return .ignored }
            if conversation.kind == .channel {
                model.editInPlace(serverId, last, in: last.groupId)
            } else {
                model.edit(serverId, conversation.key, last)
            }
            return .handled
        default:
            return .ignored
        }
    }

    /// Your newest text message here, for Up to edit it.
    private var lastOwnMessage: MessageView? {
        let selfId = server.me?.userId
        return model.list(serverId, AppModel.listId(for: conversation))?.items.last {
            $0.senderId == selfId && !$0.text.isEmpty && $0.seq != nil && $0.deletedAt == nil && $0.system == nil && $0.forwarded == nil
        }
    }

    private var placeholder: String {
        // As Telegram says it, while the countdown is where the send button was.
        if conversation.slowMode > 0 { return "Slow mode: \(Format.timer(conversation.slowMode))" }
        if conversation.kind == .channel { return "Message #\(conversation.title)" }
        return conversation.peerId != nil && conversation.peerId == server.me?.userId ? "Write a note to yourself" : "Message \(conversation.title)"
    }

    private func send() {
        // What's written stays until it may go.
        guard !waiting else { return }
        let sending = state.canSend && state.editing == nil
        model.sendComposer(serverId, conversation)
        if sending { startSlowWait() }
        selection = nil
    }

    /// A message is on its way, so in slow mode the next one waits from now, unless you're an admin.
    private func startSlowWait() {
        let admin = conversation.members.contains { $0.userId == server.me?.userId && $0.role == .admin }
        if conversation.slowMode > 0 && !admin { sentUntil = Date.now.timeIntervalSince1970 * 1000 + Double(conversation.slowMode) * 1000 }
    }

    // MARK: Reply and edit

    private func contextBar(_ message: MessageView, editing: Bool) -> some View {
        let sender = message.senderId == server.me?.userId ? "yourself" : server.users[message.senderId]?.displayName ?? "Unknown"
        return HStack(spacing: 10) {
            Image(systemName: editing ? "pencil" : "arrowshape.turn.up.left.fill")
                .foregroundStyle(model.settings.accent.text)
                .frame(width: 24)
            Rectangle().fill(model.settings.accent.text).frame(width: 2, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(editing ? "Editing message" : "Replying to \(sender)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(model.settings.accent.text)
                Text(plainText(message.text).isEmpty ? message.attachments.first?.name ?? "Attachment" : plainText(message.text))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                if editing {
                    model.edit(serverId, conversation.key, nil)
                } else {
                    model.reply(serverId, conversation.key, to: nil)
                }
            } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text2).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel")
            .accessibilityIdentifier(A11y.Composer.cancelContext)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Composer.context)
    }

    // MARK: Voice messages

    /// Hold to record and let go to send, as in Telegram; sliding left throws it away. A tap switches
    /// between voice messages and video messages.
    private var microphone: some View {
        Image(systemName: recordsVideo ? "video.fill" : "mic.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(isRecording ? Color.white : Theme.text2)
            .frame(width: 36, height: 36)
            .background(isRecording ? Theme.red : Theme.bg3, in: .circle)
            .scaleEffect(isRecording ? 1.35 : 1)
            .animation(.spring(duration: 0.25), value: isRecording)
            .contentTransition(.symbolEffect(.replace))
            .padding(.bottom, 1)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if !holding {
                            holding = true
                            Task { await startRecording() }
                        }
                        slide = min(0, value.translation.width)
                    }
                    .onEnded { _ in
                        holding = false
                        if slide < -90 { cancelRecording() } else { finishRecording() }
                        slide = 0
                    }
            )
            .accessibilityLabel(recordsVideo ? "Record a video message" : "Record a voice message")
            .accessibilityHint("Hold to record, and let go to send. Tap to switch between voice and video.")
            .accessibilityAction(named: recordsVideo ? "Switch to voice messages" : "Switch to video messages") { recordsVideo.toggle() }
            .accessibilityIdentifier(A11y.Composer.microphone)
    }

    /// How long a hold has to last before it records, so that a tap switches between voice and video instead.
    private static let holdDelay: Duration = .milliseconds(250)

    private var recordingBar: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.red).frame(width: 9, height: 9)
                .phaseAnimator([1, 0.3]) { dot, opacity in dot.opacity(opacity) } animation: { _ in .easeInOut(duration: 0.6) }
            Text(Format.duration(round?.isRecording == true ? (round?.elapsed ?? 0) : recorder.elapsed))
                .font(.body.monospacedDigit())
                .foregroundStyle(Theme.text1)
            Spacer(minLength: 0)
            Label("Slide to cancel", systemImage: "chevron.left")
                .font(.subheadline)
                .foregroundStyle(slide < -90 ? Theme.red : Theme.text2)
                .offset(x: slide / 2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .frame(height: 38)
        .onChange(of: recorder.elapsed >= VoiceRecorder.limit || (round?.elapsed ?? 0) >= RoundRecorder.limit) { _, over in
            if over { finishRecording() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Composer.recording)
    }

    private func startRecording() async {
        try? await Task.sleep(for: Self.holdDelay)
        // A tap: it switches between voice messages and video messages, as in Telegram.
        guard holding else {
            recordsVideo.toggle()
            model.toast(recordsVideo ? "Hold to record a video message. Tap for voice." : "Hold to record a voice message. Tap for video.")
            return
        }
        // A call has the camera and the microphone, as it does in Telegram.
        if recordsVideo, model.voice.inCall {
            holding = false
            model.toast("You can't record a video message during a call.")
            return
        }
        do {
            if recordsVideo {
                let video = round ?? RoundRecorder()
                round = video
                try await video.start()
            } else {
                try await recorder.start()
            }
            // The finger came off while the app asked for the camera or the microphone.
            if !holding { cancelRecording() }
        } catch {
            holding = false
            model.toast(error.localizedDescription, .error)
        }
    }

    private func cancelRecording() {
        recorder.cancel()
        round?.cancel()
    }

    private func finishRecording() {
        if let round, round.isRecording {
            Task {
                do {
                    guard let recording = try await round.stop() else { return }
                    if recording.duration < 0.5 {
                        try? FileManager.default.removeItem(at: recording.url)
                        return
                    }
                    model.sendRound(serverId, conversation, recording)
                    startSlowWait()
                } catch {
                    model.toast(ErrorText.describe(error), .error)
                }
            }
            return
        }
        guard recorder.isRecording else { return }
        do {
            guard let recording = try recorder.stop() else { return }
            if recording.duration < 0.5 {
                try? FileManager.default.removeItem(at: recording.url)
                model.toast("Hold to record, and let go to send.")
                return
            }
            model.sendVoice(serverId, conversation, recording)
            startSlowWait()
        } catch {
            model.toast(ErrorText.describe(error), .error)
        }
    }

    // MARK: Link previews

    private func linkBar(_ link: LinkDraft) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "link")
                .foregroundStyle(model.settings.accent.text)
                .frame(width: 24)
            Rectangle().fill(model.settings.accent.text).frame(width: 2, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(link.preview?.title ?? link.preview?.siteName ?? "Loading the link's preview…")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(model.settings.accent.text)
                    .lineLimit(1)
                Text(link.preview?.description ?? link.url)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let picture = link.preview?.image.flatMap(PreviewImages.image) {
                Image(uiImage: picture).resizable().scaledToFill().frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 6))
            }
            Button {
                model.updateComposer(serverId, conversation.key) {
                    $0.dismissedLink = link.url
                    $0.link = nil
                }
            } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text2).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove the link's preview")
            .accessibilityIdentifier(A11y.Composer.removeLinkPreview)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Composer.linkPreview)
    }

    // MARK: Files

    private var filesBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(state.files) { staged in
                    HStack(spacing: 8) {
                        Group {
                            if let preview = staged.preview {
                                Image(uiImage: preview).resizable().scaledToFill()
                            } else {
                                Image(systemName: "doc.fill").foregroundStyle(Theme.text2)
                            }
                        }
                        .frame(width: 36, height: 36)
                        .background(Theme.bg3)
                        .clipShape(.rect(cornerRadius: 6))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(staged.file.name).font(.caption.weight(.medium)).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                            Text(Format.bytes(staged.size)).font(.caption2).foregroundStyle(Theme.text3)
                        }
                        Button {
                            OutgoingFiles.discard(staged)
                            model.updateComposer(serverId, conversation.key) { $0.files.removeAll { $0.id == staged.id } }
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.text3)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(staged.file.name)")
                    }
                    .foregroundStyle(Theme.text1)
                    .padding(6)
                    .background(Theme.bg2, in: .rect(cornerRadius: 10))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(A11y.Composer.file(staged.file.name))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }

    /// A picture copied elsewhere, sent like a picked one.
    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.pngData() else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("Pasted image.png")
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            Task { await stageFiles([url], scoped: false) }
        } catch {
            model.toast("Couldn't paste the image: \(error.localizedDescription)", .error)
        }
    }

    private func stageFiles(_ urls: [URL], scoped: Bool = true) async {
        for url in urls {
            let accessing = scoped && url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                // Copying a video, or turning a 48 MP HEIC into JPEG, takes a while, and mustn't hold up the screen.
                let copied = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.stage(url) }.value
                let staged = await OutgoingFiles.withDuration(copied)
                model.updateComposer(serverId, conversation.key) { state in
                    if state.files.count < OutgoingFiles.limit { state.files.append(staged) }
                }
            } catch {
                model.toast("Couldn't add \(url.lastPathComponent): \(error.localizedDescription)", .error)
            }
        }
    }

    // MARK: Emoji, emotes and suggestions

    private func insert(_ pick: EmojiPick) {
        let current = state.text
        let caret = caretOffset ?? current.utf16.count
        let before = String(current.utf16.prefix(caret)) ?? current
        let after = String(current.utf16.dropFirst(caret)) ?? ""
        var addition: String
        switch pick {
        case let .emoji(value): addition = value
        case let .emote(emote):
            addition = "\(emote.name) "
            if !before.isEmpty, before.last?.isWhitespace == false { addition = " " + addition }
        }
        let next = before + addition + after
        model.updateComposer(serverId, conversation.key) { $0.text = next }
        selection = TextSelection(insertionPoint: next.index(next.startIndex, offsetBy: (before + addition).count))
    }

    private struct Suggestion: Identifiable {
        let id: String
        let label: String
        let hint: String?
        let insert: String
        let emote: Emote?
        let user: UserView?
    }

    /// The caret, as an offset in UTF-16 code units like the desktop's selectionStart.
    private var caretOffset: Int? {
        guard let selection, case let .selection(range) = selection.indices else { return nil }
        let current = state.text
        guard range.upperBound <= current.endIndex else { return nil }
        return current.utf16.distance(from: current.startIndex, to: range.upperBound)
    }

    /// Compiled once: `trigger` is read several times for each key typed.
    private static let triggerPattern = try! NSRegularExpression(pattern: #"(?:^|\s)([:@])([\p{L}\p{N}_.-]{0,32})$"#)

    /// `:name` for emotes, from the `:` on, and `@name` for people, just before the caret.
    private var trigger: (kind: Character, query: String, start: Int, end: Int)? {
        let current = state.text
        let end = caretOffset ?? current.utf16.count
        let before = String(current.utf16.prefix(end)) ?? current
        let ns = before as NSString
        guard let match = Self.triggerPattern.firstMatch(in: before, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let kind = Character(ns.substring(with: match.range(at: 1)))
        let query = ns.substring(with: match.range(at: 2))
        if kind == "@" && query.isEmpty { return nil }
        return (kind, query.lowercased(), match.range(at: 1).location, end)
    }

    /// Until two letters are typed, as in ":D", Return sends what's written, and only the
    /// arrows or Tab pick an emote, so nothing is picked to begin with.
    private var tentative: Bool {
        guard let trigger else { return false }
        return trigger.kind == ":" && trigger.query.count < 2
    }

    private var suggestions: [Suggestion] {
        guard let trigger else { return [] }
        if trigger.kind == ":" {
            let all = server.emotes.emotes
            if trigger.query.isEmpty {
                return all.prefix(Self.maxSuggestions).map {
                    Suggestion(id: $0.id, label: $0.name, hint: $0.owner.isEmpty ? nil : "by \($0.owner)", insert: "\($0.name) ", emote: $0, user: nil)
                }
            }
            let starts = all.filter { $0.name.lowercased().hasPrefix(trigger.query) }
            let contains = all.filter { !$0.name.lowercased().hasPrefix(trigger.query) && $0.name.lowercased().contains(trigger.query) }
            return (starts + contains).prefix(Self.maxSuggestions).map {
                Suggestion(id: $0.id, label: $0.name, hint: $0.owner.isEmpty ? nil : "by \($0.owner)", insert: "\($0.name) ", emote: $0, user: nil)
            }
        }
        let ids = conversation.kind == .group ? conversation.members.map(\.userId) : Array(server.users.keys)
        return ids.compactMap { server.users[$0] }
            .filter { !$0.banned && !$0.deleted && ($0.username.lowercased().contains(trigger.query) || $0.displayName.lowercased().contains(trigger.query)) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .prefix(Self.maxSuggestions)
            .map { Suggestion(id: $0.id, label: $0.displayName, hint: "@\($0.username)", insert: "@\($0.username) ", emote: nil, user: $0) }
    }

    @ViewBuilder
    private var suggestionsList: some View {
        let shown = suggestions
        if !shown.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, suggestion in
                    Button {
                        apply(suggestion)
                    } label: {
                        HStack(spacing: 10) {
                            if let emote = suggestion.emote {
                                EmoteView(name: emote.name, id: emote.id, size: .small, serverUrl: server.entry.url).frame(width: 26, height: 26)
                            } else if let user = suggestion.user {
                                AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 26)
                            }
                            Text(suggestion.label).foregroundStyle(Theme.text1).lineLimit(1)
                            if let hint = suggestion.hint {
                                Text(hint).foregroundStyle(Theme.text3).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 14)
                        .frame(height: 40)
                        .background(index == min(selectedSuggestion, shown.count - 1) ? Theme.bg3 : .clear)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(A11y.Composer.suggestion(suggestion.label))
                }
            }
            .padding(.vertical, 4)
            .background(Theme.bg2)
        }
    }

    private func apply(_ suggestion: Suggestion) {
        guard let trigger else { return }
        let current = state.text
        let before = String(current.utf16.prefix(trigger.start)) ?? ""
        let after = String(current.utf16.dropFirst(trigger.end)) ?? ""
        let next = before + suggestion.insert + after
        model.updateComposer(serverId, conversation.key) { $0.text = next }
        selection = TextSelection(insertionPoint: next.index(next.startIndex, offsetBy: (before + suggestion.insert).count))
    }
}
