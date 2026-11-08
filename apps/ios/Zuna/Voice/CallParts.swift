import LiveKit
import SwiftUI
import UIKit
import ZunaModels

/// Someone in the call, from a long press on them: how loud they and their shared
/// screen are for this device, muting them for yourself, checking their keys, and
/// what a server admin can do. The desktop's MemberMenu.
struct MemberSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    let server: AppModel.ServerState
    let member: VoiceMember
    @State private var verifying = false

    var body: some View {
        let user = server.users[member.userId]
        let name = user?.displayName ?? "Someone"
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        AvatarView(name: name, seed: member.userId, source: user?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 48)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name).font(.headline)
                            if let username = user?.username { Text("@\(username)").font(.subheadline).foregroundStyle(Theme.text2) }
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                Section {
                    slider("Volume", value: voice.volumes[member.userId] ?? 1, id: A11y.Voice.volume) { voice.setVolume($0, for: member.userId) }
                    if streamSound {
                        slider("Stream volume", value: voice.streamVolumes[member.userId] ?? 1, id: A11y.Voice.streamVolume) { voice.setStreamVolume($0, for: member.userId) }
                    }
                    Toggle("Mute for me", isOn: Binding(get: { voice.localMutes.contains(member.userId) }, set: { _ in voice.toggleLocalMute(member.userId) }))
                        .accessibilityIdentifier(A11y.Voice.muteForMe)
                    Button("Verify with emoji", systemImage: "lock") { verifying = true }
                }
                if canModerate {
                    Section {
                        Button(member.serverMuted ? "Let them talk" : "Mute for everyone", systemImage: "mic.slash") {
                            moderate { try await $0.voiceMute($1, userId: member.userId, muted: !member.serverMuted) }
                        }
                        .accessibilityIdentifier(A11y.Voice.muteForEveryone)
                        if member.screen {
                            Button("Stop their screen share", systemImage: "rectangle.slash") {
                                moderate { try await $0.voiceScreenStopOf($1, userId: member.userId) }
                            }
                        }
                        Button("Disconnect", systemImage: "person.fill.xmark", role: .destructive) {
                            moderate { try await $0.voiceDisconnect($1, userId: member.userId) }
                        }
                        .accessibilityIdentifier(A11y.Voice.disconnect)
                    }
                }
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // A sheet of its own: VerifyView has its own navigation stack, which one pushed here would nest.
            .sheet(isPresented: $verifying) {
                VerifyView(serverId: server.entry.id, userId: member.userId)
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.memberSheet)
    }

    /// They're sharing their screen with its sound, which has a level of its own.
    private var streamSound: Bool { voice.videos.contains { $0.userId == member.userId && $0.sound } }

    private func slider(_ title: String, value: Double, id: String, set: @escaping @MainActor (Double) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text("\(Int((value * 100).rounded()))%").foregroundStyle(Theme.text2).monospacedDigit()
            }
            Slider(value: Binding(get: { value }, set: { set($0) }), in: 0...2)
                .accessibilityLabel(title)
                .accessibilityIdentifier(id)
        }
    }

    /// Owners over anyone else, admins over members, as the server allows.
    private var canModerate: Bool {
        // A call is between the people in it.
        guard member.userId != server.me?.userId, !voice.isCall else { return false }
        let role = server.me?.role
        return role == .owner || (role == .admin && server.users[member.userId]?.role == .member)
    }

    private func moderate(_ action: @escaping (SessionCalls, String) async throws -> Void) {
        let session = model.core.session(server.entry.id)
        let channelId = member.channelId
        dismiss()
        Task {
            do { try await action(session, channelId) } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// Silences a share's sound, or brings it back, over the share as a video player has it.
/// How loud exactly is in the sharer's sheet.
struct StreamSoundButton: View {
    @Environment(VoiceModel.self) private var voice
    let userId: String

    var body: some View {
        let silent = voice.streamVolumes[userId] == 0
        Button {
            voice.toggleStreamMute(userId)
        } label: {
            Image(systemName: silent ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(.black.opacity(0.45), in: .circle)
        }
        .accessibilityLabel(silent ? "Unmute stream" : "Mute stream")
    }
}

/// A video over everything, turned sideways if the phone is, and zoomed with two fingers.
struct VideoViewer: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    let tileId: String

    var body: some View {
        let video = voice.videos.first { $0.id == tileId }
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let video {
                SwiftUIVideoView(video.track, layoutMode: .fit, pinchToZoomOptions: [.zoomIn, .resetOnRelease])
                    .ignoresSafeArea()
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.5), in: .circle)
            }
            .padding(16)
            .accessibilityLabel("Close")
            .accessibilityIdentifier(A11y.Voice.closeViewer)
        }
        .overlay(alignment: .bottomTrailing) {
            if let video, video.sound {
                StreamSoundButton(userId: video.userId).padding(16)
            }
        }
        .onAppear {
            Orientation.allowRotation(true)
            ScreenAwake.hold(.viewer, true)
        }
        .onDisappear {
            Orientation.allowRotation(false)
            ScreenAwake.hold(.viewer, false)
        }
        // Nothing to watch once they've stopped.
        .onChange(of: video == nil) { _, gone in if gone { dismiss() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.viewer)
    }
}

/// The app stays upright on a phone, except to watch a video sideways.
@MainActor
enum Orientation {
    private(set) static var mask: UIInterfaceOrientationMask = .portrait

    static func allowRotation(_ allowed: Bool) {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }
        mask = allowed ? .allButUpsideDown : .portrait
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            if !allowed { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) }
        }
    }
}

/// The screen stays on while a camera or a screen is on it, or this device's camera or screen is
/// going out, as the desktop's does, and otherwise dims and locks as Auto-Lock says, during a call
/// that's only heard too.
@MainActor
enum ScreenAwake {
    enum Reason { case call, viewer, sending, testing }

    private static var reasons: Set<Reason> = []

    static func hold(_ reason: Reason, _ held: Bool) {
        if held { reasons.insert(reason) } else { reasons.remove(reason) }
        UIApplication.shared.isIdleTimerDisabled = !reasons.isEmpty
    }
}

/// The call while looking elsewhere: across the top of the app, as a phone call's
/// bar is, with mute and leave at hand. A tap opens it again. The desktop's VoicePanel.
struct CallBar: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice

    var body: some View {
        let server = voice.serverId.flatMap { model.servers[$0] }
        let channel = server?.channels.first { $0.id == voice.channelId }
        let title = voice.isCall ? voice.channelId.flatMap { server?.conversation(groupId: $0)?.title } ?? "Call" : channel?.title ?? "Voice channel"
        HStack(spacing: 10) {
            Button {
                voice.stageShown = true
            } label: {
                HStack(spacing: 8) {
                    if voice.status == .connected {
                        QualityIcon()
                    } else {
                        ProgressView().controlSize(.mini).tint(Theme.text1)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(voice.status == .connected ? (voice.isCall ? "Call connected" : "Voice connected") : voice.status == .reconnecting ? "Reconnecting" : "Connecting")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(voice.status == .connected ? Theme.green : Theme.text2)
                        Text("\(title) / \(server?.entry.name ?? "")")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the call")
            .accessibilityIdentifier(A11y.Voice.bar)
            Button {
                voice.toggleMute()
            } label: {
                Image(systemName: voice.micOff ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(voice.micOff ? Theme.red : Theme.text1)
                    .frame(width: 36, height: 36)
                    .background(Theme.bg4, in: .circle)
            }
            .disabled(voice.serverMuted || voice.noMic)
            .accessibilityLabel(voice.micOff ? "Unmute" : "Mute")
            .accessibilityIdentifier(A11y.Voice.barMute)
            Button {
                voice.leave()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Theme.red, in: .circle)
            }
            .accessibilityLabel("Disconnect from voice")
            .accessibilityIdentifier(A11y.Voice.barLeave)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.bg3.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Theme.line.frame(height: 1) }
    }
}

/// Voice settings that belong to this device. The desktop also chooses
/// microphones and speakers, filters and a gate, which iOS does for itself.
struct VoiceSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice

    /// What the desktop offers, in kbit/s (SCREEN_BITRATES in packages/ui/src/voice/settings.ts).
    static let bitrates = [1_000, 2_000, 3_000, 4_500, 6_000, 8_000, 10_000, 12_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 60_000, 80_000, 100_000]

    static func bitrateName(_ kbps: Int) -> String {
        kbps < 1000 ? "\(kbps) kbit/s" : "\((Double(kbps) / 1000).formatted(.number.locale(Locale(identifier: "en_US")))) Mbit/s"
    }

    var body: some View {
        @Bindable var voice = voice
        List {
            Section {
                Toggle("Come in muted", isOn: $voice.settings.startMuted)
                    .tint(model.settings.accent.switchTint)
            } footer: {
                Text("Starts every voice channel with your microphone off.")
            }
            Section {
                Toggle("Sounds", isOn: $voice.settings.sounds)
                    .tint(model.settings.accent.switchTint)
            } footer: {
                Text("When people come and go, and when you mute.")
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Soundboard volume")
                        Spacer()
                        Text(voice.settings.soundboardVolume == 0 ? "Off" : "\(Int((voice.settings.soundboardVolume * 100).rounded()))%").foregroundStyle(Theme.text2).monospacedDigit()
                    }
                    Slider(value: $voice.settings.soundboardVolume, in: 0...1)
                        .accessibilityLabel("Soundboard volume")
                }
            } footer: {
                Text("All the way down, no sounds from the soundboard play for you.")
            }
            Section {
                Toggle("Open a share when it starts", isOn: $voice.settings.screenFocus)
                    .tint(model.settings.accent.switchTint)
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("How loud shares are")
                        Spacer()
                        Text("\(Int((voice.settings.screenVolume * 100).rounded()))%").foregroundStyle(Theme.text2).monospacedDigit()
                    }
                    Slider(value: $voice.settings.screenVolume, in: 0...2)
                        .accessibilityLabel("How loud shares are")
                }
            } header: {
                Text("Screens")
            } footer: {
                Text("A screen someone starts sharing fills the call, unless you're already looking at something.")
            }
            if voice.canShareScreen {
                sharing($voice.settings.screenBitrate)
            }
            Section {
            } footer: {
                Text("The iPhone cancels echo and noise itself. For even less noise, choose Voice Isolation under Mic Mode in Control Center during a call.")
            }
        }
        // As the other settings look.
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Voice and video")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The most a share from this phone may send, as it would go out on the server open now.
    private func sharing(_ bitrate: Binding<Int?>) -> some View {
        let server = model.activeServerId.flatMap { model.servers[$0] }
        let terms = VoiceModel.shareTerms(voice.settings, server: server)
        var suggestion = voice.settings
        suggestion.screenBitrate = nil
        let suggested = VoiceModel.shareTerms(suggestion, server: server).kbps
        let size = terms.held.contains(.height) ? "This server holds shares to \(terms.height)p across." : "Your screen goes out at its own size."
        let rate = terms.held.contains(.kbps) ? "It's sent at up to \(Self.bitrateName(terms.kbps)), which is this server's limit." : "It sends less when your connection or the screen doesn't need that much."
        return Section {
            Picker("Most it may send", selection: bitrate) {
                Text("Server's choice (\(Self.bitrateName(suggested)))").tag(Int?.none)
                ForEach(Self.bitrates, id: \.self) { kbps in
                    Text(Self.bitrateName(kbps)).tag(Int?.some(kbps))
                }
            }
            .accessibilityIdentifier(A11y.Settings.screenBitrate)
        } header: {
            Text("Sharing your screen")
        } footer: {
            Text("\(rate) \(size)")
        }
    }
}
