import SwiftUI
import ZunaModels

/// The keyboard, whichever field it's typing into.
@MainActor
enum Keyboard {
    /// Put away by hand, as with a tap on the chat, for what stands in its place to go with it.
    static let dismissed = Notification.Name("zuna.keyboard.dismissed")

    /// As the system's own comes and goes, for what moves the chat as it does: the spring the chat
    /// follows a keyboard with, measured in a simulator's recording.
    static let animation = Animation.spring(response: 0.344, dampingFraction: 1)

    /// The screen's bottom safe area, under the home indicator, which no keyboard counts in.
    static var bottomInset: CGFloat { window?.safeAreaInsets.bottom ?? 0 }

    fileprivate static var window: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    }

    static func dismiss() {
        resign()
        NotificationCenter.default.post(name: dismissed, object: nil)
    }

    /// Only the keyboard, leaving what stands in its place.
    static func resign() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Where the on-screen keyboard is, for the emoji panel that takes its place under a phone's message box.
@MainActor
@Observable
final class KeyboardWatch {
    static let shared = KeyboardWatch()

    /// On its way up or up, until it starts to go.
    private(set) var up = false
    /// Up, and done coming.
    private(set) var settled = false
    /// How far the last one reached above the screen's bottom safe area, which the panel reaches too.
    private(set) var height: CGFloat

    private static let heightKey = "zuna-keyboard-height"
    /// Less than this is no keyboard, as the bar a hardware one leaves.
    private static let least: CGFloat = 150

    private init() {
        // Until one has been seen: about an iPhone's, with a home indicator under it or without.
        let saved = UserDefaults.standard.double(forKey: Self.heightKey)
        height = saved >= Self.least ? saved : Keyboard.bottomInset > 0 ? 294 : 260
        let center = NotificationCenter.default
        center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { note in
            let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            MainActor.assumeIsolated { KeyboardWatch.shared.coming(frame) }
        }
        center.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { if KeyboardWatch.shared.up { KeyboardWatch.shared.settled = true } }
        }
        center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { KeyboardWatch.shared.going() }
        }
    }

    private func coming(_ frame: CGRect?) {
        guard let frame, let window = Keyboard.window else { return }
        let reach = window.bounds.maxY - window.convert(frame, from: nil).minY - window.safeAreaInsets.bottom
        guard reach >= Self.least else { return going() }
        // In the transaction the system moves the chat in, so what follows this moves with it.
        withAnimation(Keyboard.animation) {
            up = true
            height = reach
        }
        if window.windowScene?.interfaceOrientation.isPortrait == true { UserDefaults.standard.set(Double(reach), forKey: Self.heightKey) }
    }

    private func going() {
        guard up else { return }
        withAnimation(Keyboard.animation) {
            up = false
            settled = false
        }
    }
}

/// The emoji panel a phone's chat opens under its message box, where the keyboard goes, moving
/// the chat up as the keyboard does. Kept by the chat's screen, which makes room for it.
@MainActor
@Observable
final class ComposerPanel {
    /// Open: in the keyboard's place, or under one that's coming up or going.
    var open = false
    /// Its search is being typed in.
    var searching = false

    /// Its search has the keyboard, so it stands above it, shorter.
    var raised: Bool { open && searching && KeyboardWatch.shared.up }
    /// It stands where the keyboard does, so the chat keeps out of its way and not the keyboard's.
    var inKeyboardsPlace: Bool { open && !raised }

    func close() {
        open = false
        searching = false
    }
}

/// Writing a message, laid out like Telegram's: attach, the text growing up to
/// six lines with the emoji button inside, and send. Above it: the message
/// being answered or edited, files to send, and suggestions for `@`, `:` and the `/` commands of the chat's bots.
struct Composer: View {
    let serverId: String
    let conversation: ConversationView
    let server: AppModel.ServerState
    /// The emoji panel under the message box, on a phone.
    let panel: ComposerPanel

    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var selection: TextSelection?
    @State private var attaching = false
    /// The emoji picker as a sheet, on an iPad.
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
    /// The finger is on the microphone; how far it slid to the left, toward cancelling, and up, toward locking.
    @State private var holding = false
    @State private var slide: CGFloat = 0
    @State private var rise: CGFloat = 0
    /// Slid up, it records on with the finger off, as in Telegram, until Send or Cancel.
    @State private var locked = false
    /// The touch that locked it is still on the button, and its end isn't a press of Send.
    @State private var lockedNow = false
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

    /// How tall the panel is above the keyboard, while its search is typed in.
    private static let searchingHeight: CGFloat = 248

    private var state: ComposerState { model.composer(serverId, conversation.key) }

    private var keyboard: KeyboardWatch { .shared }

    /// A phone's emoji picker is a panel in the keyboard's place, as Telegram's, and an iPad's a sheet.
    private var picksInPanel: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    /// The panel is where the keyboard goes, so the emoji button brings the keyboard back.
    private var offersKeyboard: Bool { panel.open && !keyboard.settled }

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
                        withAnimation(Keyboard.animation) { panel.close() }
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
                    .accessibilityLabel(t("composer.attach.files"))
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
                            .accessibilityLabel(t("composer.label"))
                            .accessibilityIdentifier(A11y.Composer.input)
                        Button {
                            if picksInPanel { togglePanel() } else { picking = true }
                        } label: {
                            // The way back to the keyboard while the panel is in its place, as in Telegram. Both
                            // are there and one shows: a picture that changes as the message box moves stays behind.
                            ZStack {
                                Image(systemName: "face.smiling").opacity(offersKeyboard ? 0 : 1)
                                Image(systemName: "keyboard").opacity(offersKeyboard ? 1 : 0)
                            }
                            .font(.system(size: 20))
                            .foregroundStyle(Theme.text2)
                            .frame(width: 30, height: 36)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(offersKeyboard ? t("composer.keyboard") : t("composer.emoji"))
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
                        .accessibilityLabel(t("composer.slowWait", ["time": Format.wait(slowWait)]))
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
                    .accessibilityLabel(state.editing != nil ? t("composer.saveEdit") : t("common.send"))
                    .accessibilityIdentifier(A11y.Composer.send)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            if panel.open {
                // As tall as the keyboard it stands in for, so one taking the other's place moves nothing.
                let height = panel.raised ? Self.searchingHeight : keyboard.height
                EmojiPicker(server: server, panel: panel, onPick: pick)
                    .frame(height: height)
                    // From under the screen's edge and back, past the safe area its background reaches into.
                    .transition(.offset(y: height + Keyboard.bottomInset))
                    // Here, not on the composer: with the panel shut nothing here hears the keyboard, which
                    // a test's typing puts away and brings back, and a character typed as the composer was
                    // drawn again for it went missing.
                    .onChange(of: keyboard.settled) { _, settled in
                        // A keyboard that came up over the panel, for the message box or a message edited where
                        // it is, has taken its place, and the chat is where the panel had it.
                        if settled, !panel.searching { panel.close() }
                    }
                    .onChange(of: focused) { _, focused in
                        // From the panel's search to the message box, with the keyboard up already.
                        if focused, keyboard.settled { withAnimation(Keyboard.animation) { panel.close() } }
                    }
            }
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
            EmojiPicker(server: server, onPick: pick)
                .presentationDetents([.medium, .large])
        }
        .onReceive(NotificationCenter.default.publisher(for: Keyboard.dismissed)) { _ in
            // A tap on the chat puts the panel away as it does the keyboard.
            if panel.open { withAnimation(Keyboard.animation) { panel.close() } }
        }
        .onDisappear { panel.close() }
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
            // would lose a file added in between. Only for the chat on show, as a phone's other
            // tab may have a chat open under it too.
            let urls = model.pendingAttachments
            guard !urls.isEmpty, model.chatPath.last == .chat(conversation.key) else { return }
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
        // As Telegram says it, while the countdown is where the send button was. Admins aren't held back.
        if conversation.slowMode > 0, !exemptFromSlowMode { return t("composer.placeholderSlowMode", ["time": Format.timer(conversation.slowMode)]) }
        if conversation.kind == .channel { return t("composer.placeholderChannel", ["name": conversation.title]) }
        // Never taken for one of Zuna's encrypted chats (docs/TELEGRAM_PLAN.md).
        if server.entry.isTelegram { return t("composer.placeholderTelegram") }
        return conversation.peerId != nil && conversation.peerId == server.me?.userId ? t("composer.placeholderSaved") : t("composer.placeholder", ["name": conversation.title])
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
        if conversation.slowMode > 0 && !exemptFromSlowMode { sentUntil = Date.now.timeIntervalSince1970 * 1000 + Double(conversation.slowMode) * 1000 }
    }

    /// An admin here, whom slow mode doesn't hold back, as the core and the server count them.
    private var exemptFromSlowMode: Bool {
        conversation.members.contains { $0.userId == server.me?.userId && $0.role == .admin }
    }

    // MARK: Reply and edit

    private func contextBar(_ message: MessageView, editing: Bool) -> some View {
        let own = message.senderId == server.me?.userId
        let sender = server.users[message.senderId]?.displayName ?? t("chat.unknown")
        return HStack(spacing: 10) {
            Image(systemName: editing ? "pencil" : "arrowshape.turn.up.left.fill")
                .foregroundStyle(model.settings.accent.text)
                .frame(width: 24)
            Rectangle().fill(model.settings.accent.text).frame(width: 2, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(editing ? t("composer.editing") : own ? t("composer.replyingToYourself") : t("composer.replyingTo", ["name": sender]))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(model.settings.accent.text)
                Text(plainText(message.text).isEmpty ? message.attachments.first?.name ?? t("message.reply.attachment") : plainText(message.text))
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
            .accessibilityLabel(t("common.cancel"))
            .accessibilityIdentifier(A11y.Composer.cancelContext)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Composer.context)
    }

    // MARK: Voice messages

    /// Hold to record and let go to send, as in Telegram; sliding left throws it away, and sliding up
    /// locks it, recording on with the finger off, when the button sends it. A tap switches between
    /// voice messages and video messages.
    private var microphone: some View {
        let accent = model.settings.accent
        return Image(systemName: locked ? "arrow.up" : recordsVideo ? "video.fill" : "mic.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(locked ? accent.onAccent : isRecording ? Color.white : Theme.text2)
            .frame(width: 36, height: 36)
            .background(locked ? accent.color : isRecording ? Theme.red : Theme.bg3, in: .circle)
            .scaleEffect(isRecording && !locked ? 1.35 : 1)
            .animation(.spring(duration: 0.25), value: isRecording)
            .animation(.spring(duration: 0.25), value: locked)
            .contentTransition(.symbolEffect(.replace))
            .padding(.bottom, 1)
            .overlay(alignment: .bottom) {
                // The lock to slide up to, which comes up with the finger.
                if isRecording, holding, !locked {
                    VStack(spacing: 3) {
                        Image(systemName: "lock.fill")
                        Image(systemName: "chevron.up")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(rise < -Self.lockRise * 0.6 ? Theme.text1 : Theme.text2)
                    .frame(width: 36)
                    .padding(.vertical, 10)
                    .background(Theme.bg2, in: .capsule)
                    .overlay(Capsule().stroke(Theme.line))
                    .offset(y: -66 + max(rise, -Self.lockRise) * 0.5)
                    .transition(.opacity.combined(with: .offset(y: 12)))
                    .accessibilityHidden(true)
                }
            }
            .animation(.easeOut(duration: 0.2), value: isRecording && holding && !locked)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if !holding {
                            holding = true
                            // Locked, a touch on it sends, once it's let go.
                            if !locked { Task { await startRecording() } }
                        }
                        guard !locked else { return }
                        slide = min(0, value.translation.width)
                        rise = min(0, value.translation.height)
                        if isRecording, rise < -Self.lockRise, slide > -40 {
                            locked = true
                            lockedNow = true
                            slide = 0
                            rise = 0
                        }
                    }
                    .onEnded { _ in
                        holding = false
                        defer {
                            slide = 0
                            rise = 0
                        }
                        if lockedNow {
                            lockedNow = false
                        } else if locked || slide >= -90 {
                            finishRecording()
                        } else {
                            cancelRecording()
                        }
                    }
            )
            .accessibilityLabel(locked ? (recordsVideo ? t("composer.sendRound") : t("composer.sendVoice")) : recordsVideo ? t("composer.recordRound") : t("composer.recordVoice"))
            .accessibilityHint(locked ? "" : t("composer.record.hint"))
            .accessibilityAction(named: recordsVideo ? t("composer.record.switchToVoice") : t("composer.record.switchToVideo")) { recordsVideo.toggle() }
            .accessibilityIdentifier(A11y.Composer.microphone)
    }

    /// How long a hold has to last before it records, so that a tap switches between voice and video instead.
    private static let holdDelay: Duration = .milliseconds(250)
    /// How far up the finger slides to lock it.
    private static let lockRise: CGFloat = 80

    private var recordingBar: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.red).frame(width: 9, height: 9)
                .phaseAnimator([1, 0.3]) { dot, opacity in dot.opacity(opacity) } animation: { _ in .easeInOut(duration: 0.6) }
            Text(Format.duration(round?.isRecording == true ? (round?.elapsed ?? 0) : recorder.elapsed))
                .font(.body.monospacedDigit())
                .foregroundStyle(Theme.text1)
            Spacer(minLength: 0)
            if locked {
                Button(t("common.cancel"), action: cancelRecording)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.red)
                    .buttonStyle(.plain)
            } else {
                Label(t("composer.record.slideToCancel"), systemImage: "chevron.left")
                    .font(.subheadline)
                    .foregroundStyle(slide < -90 ? Theme.red : Theme.text2)
                    .offset(x: slide / 2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .frame(height: 38)
        .onChange(of: recorder.elapsed >= VoiceRecorder.limit || (round?.elapsed ?? 0) >= RoundRecorder.limit) { _, over in
            if over { finishRecording() }
        }
        // Leaving the chat while it records on lets it go, rather than recording for no one.
        .onDisappear { if isRecording { cancelRecording() } }
        .accessibilityElement(children: locked ? .contain : .combine)
        .accessibilityIdentifier(A11y.Composer.recording)
    }

    private func startRecording() async {
        try? await Task.sleep(for: Self.holdDelay)
        // A tap: it switches between voice messages and video messages, as in Telegram.
        guard holding else {
            recordsVideo.toggle()
            model.toast(recordsVideo ? t("composer.record.videoTip") : t("composer.record.voiceTip"))
            return
        }
        // A call has the camera and the microphone, as it does in Telegram.
        if recordsVideo, model.voice.inCall {
            holding = false
            model.toast(t("composer.record.videoInCall"))
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
            if !holding, !locked { cancelRecording() }
        } catch {
            holding = false
            model.toast(error.localizedDescription, .error)
        }
    }

    private func cancelRecording() {
        locked = false
        recorder.cancel()
        round?.cancel()
    }

    private func finishRecording() {
        locked = false
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
                model.toast(t("composer.record.tooShort"))
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
                Text(link.preview?.title ?? link.preview?.siteName ?? t("composer.linkLoading"))
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
            .accessibilityLabel(t("composer.linkRemove"))
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
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Theme.text3)
                                // A finger's width to hit, though it's drawn small.
                                .frame(width: 32, height: 36)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, -6)
                        .accessibilityLabel(t("composer.removeFile", ["name": staged.file.name]))
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
            model.toast(t("composer.files.pasteFailed", ["error": error.localizedDescription]), .error)
        }
    }

    private func stageFiles(_ urls: [URL], scoped: Bool = true) async {
        var leftOut = 0
        defer {
            if leftOut == 1 {
                model.toast(t("composer.files.leftOutOne", ["limit": OutgoingFiles.limit]))
            } else if leftOut > 1 {
                model.toast(t("composer.files.leftOutMany", ["limit": OutgoingFiles.limit, "count": leftOut]))
            }
        }
        for url in urls {
            let accessing = scoped && url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                // Copying a video, or turning a 48 MP HEIC into JPEG, takes a while, and mustn't hold up the screen.
                let copied = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.stage(url) }.value
                let staged = await OutgoingFiles.withDuration(copied)
                var added = false
                model.updateComposer(serverId, conversation.key) { state in
                    if state.files.count < OutgoingFiles.limit {
                        state.files.append(staged)
                        added = true
                    }
                }
                if !added {
                    leftOut += 1
                    OutgoingFiles.discard(staged)
                }
            } catch {
                model.toast(t("composer.files.addFailed", ["name": url.lastPathComponent, "error": error.localizedDescription]), .error)
            }
        }
    }

    // MARK: Emoji, emotes and suggestions

    /// The emoji button on a phone: the panel in the keyboard's place, or the keyboard back in the panel's.
    private func togglePanel() {
        if offersKeyboard {
            if focused { return withAnimation(Keyboard.animation) { panel.close() } }
            focused = true
            // A hardware keyboard brings none up to take the panel's place, so it just goes.
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                if panel.open, !keyboard.up { withAnimation(Keyboard.animation) { panel.close() } }
            }
        } else if keyboard.up {
            // Under the keyboard, which then goes and leaves the panel there: the chat stays where it is.
            // From its own search, it comes back down to there.
            if panel.open { withAnimation(Keyboard.animation) { panel.searching = false } } else { panel.open = true }
            // Once the panel is drawn: laid out as the keyboard starts to go, its parts grow into place with it.
            Task {
                try? await Task.sleep(for: .milliseconds(50))
                Keyboard.resign()
            }
        } else {
            withAnimation(Keyboard.animation) { panel.open = true }
        }
    }

    private func pick(_ pick: EmojiPick) {
        if case let .sticker(sticker) = pick {
            // Sent at once, as Telegram's apps send a sticker.
            picking = false
            let key = conversation.key
            Task {
                do { try await model.core.session(serverId).sendSticker(key, sticker) } catch { model.toast(ErrorText.describe(error), .error) }
            }
            return
        }
        insert(pick)
        // The sheet is over the message box, so it goes to show the emote there. The panel is under it.
        if case .emote = pick { picking = false }
    }

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
        case .sticker:
            return
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
        /// Someone on Telegram, mentioned by the name it puts in: its length in UTF-16 code units, and their user ID.
        var named: (length: Int, userId: String)? = nil
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

    /// Compiled once, as `triggerPattern` is.
    private static let commandPattern = try! NSRegularExpression(pattern: #"^/([A-Za-z0-9_]{0,32})$"#)

    /// `:name` for emotes, from the `:` on, and `@name` for people, just before the caret, or the
    /// `/` at the very start, for the commands of the bots in this chat.
    private var trigger: (kind: Character, query: String, start: Int, end: Int)? {
        let current = state.text
        let end = caretOffset ?? current.utf16.count
        let before = String(current.utf16.prefix(end)) ?? current
        let ns = before as NSString
        if let command = Self.commandPattern.firstMatch(in: before, range: NSRange(location: 0, length: ns.length)) {
            return (Character("/"), ns.substring(with: command.range(at: 1)).lowercased(), 0, end)
        }
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
        if trigger.kind == "/" {
            // Whose a command is shows by its picture, and is written after it where more than one bot could answer.
            return Bots.commands(in: conversation, server, typed: trigger.query).prefix(Self.maxSuggestions).map {
                Suggestion(id: $0.id, label: "/" + $0.command.command, hint: $0.command.description, insert: $0.insert, emote: nil, user: $0.bot)
            }
        }
        if trigger.kind == ":" {
            let all = server.emotes.emotes
            if trigger.query.isEmpty {
                return all.prefix(Self.maxSuggestions).map {
                    Suggestion(id: $0.id, label: $0.name, hint: $0.owner.isEmpty ? nil : t("message.emote.by", ["name": $0.owner]), insert: "\($0.name) ", emote: $0, user: nil)
                }
            }
            let starts = all.filter { $0.name.lowercased().hasPrefix(trigger.query) }
            let contains = all.filter { !$0.name.lowercased().hasPrefix(trigger.query) && $0.name.lowercased().contains(trigger.query) }
            return (starts + contains).prefix(Self.maxSuggestions).map {
                Suggestion(id: $0.id, label: $0.name, hint: $0.owner.isEmpty ? nil : t("message.emote.by", ["name": $0.owner]), insert: "\($0.name) ", emote: $0, user: nil)
            }
        }
        // On Telegram someone is mentioned by name, as Telegram's apps do, whether or not they have
        // a username, and anywhere else by their username.
        let telegram = server.entry.isTelegram
        let ids = conversation.kind == .group ? conversation.members.map(\.userId) : Array(server.users.keys)
        return ids.compactMap { server.users[$0] }
            .filter { user in
                let reachable = telegram ? NamedMentions.name(for: user) != nil : !user.username.isEmpty
                return !user.banned && !user.deleted && reachable && (user.username.lowercased().contains(trigger.query) || user.displayName.lowercased().contains(trigger.query))
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .prefix(Self.maxSuggestions)
            .map { user in
                let hint = user.username.isEmpty ? nil : "@\(user.username)"
                if telegram, let name = NamedMentions.name(for: user) {
                    return Suggestion(id: user.id, label: user.displayName, hint: hint, insert: name + " ", emote: nil, user: user, named: (name.utf16.count, user.id))
                }
                return Suggestion(id: user.id, label: user.displayName, hint: hint, insert: "@\(user.username) ", emote: nil, user: user)
            }
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
        model.updateComposer(serverId, conversation.key) { state in
            state.text = next
            if let named = suggestion.named {
                state.named.append(NamedMention(location: trigger.start, length: named.length, userId: named.userId))
            }
        }
        selection = TextSelection(insertionPoint: next.index(next.startIndex, offsetBy: (before + suggestion.insert).count))
    }
}
