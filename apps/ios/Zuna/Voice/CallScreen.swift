import LiveKit
import SwiftUI
import ZunaModels

/// A voice channel or a conversation's call, open: everyone in it, what they're sending, and
/// the controls. Over the whole app, as calls are on iOS, and down into the bar at the top to
/// look elsewhere. The desktop's VoiceStage.
struct CallScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var member: VoiceMember?
    @State private var watching: String?
    @State private var explaining = false
    @State private var showingStats = false

    private var server: AppModel.ServerState? { voice.serverId.flatMap { model.servers[$0] } }
    private var channel: ChannelView? { server?.channels.first { $0.id == voice.channelId } }
    /// The conversation whose call it is.
    private var conversation: ConversationView? { voice.isCall ? voice.channelId.flatMap { server?.conversation(groupId: $0) } : nil }
    private var title: String { voice.isCall ? conversation?.title ?? "Call" : channel?.title ?? "Voice channel" }

    var body: some View {
        VStack(spacing: 0) {
            header
            if voice.status == .connecting {
                VStack(spacing: 14) {
                    ProgressView().controlSize(.large)
                    Text(voice.isCall ? "Connecting the call…" : "Coming into \(channel?.title ?? "the channel")…")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier(A11y.Voice.connecting)
            } else {
                if voice.status == .reconnecting {
                    Text("Reconnecting…")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.text1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Theme.amber.opacity(0.25))
                }
                stage
            }
            CallControls(chat: voice.isCall ? conversation : channel?.conversation, chatKey: voice.isCall ? conversation?.key : channel?.key)
        }
        .overlay(alignment: .top) { IncomingCallOverlay() }
        .background(Theme.bg0.ignoresSafeArea())
        .sheet(item: $member) { member in
            if let server {
                MemberSheet(server: server, member: member)
            }
        }
        .sheet(isPresented: $showingStats) {
            StreamStatsSheet()
        }
        .fullScreenCover(item: Binding(get: { watching.map(Watching.init) }, set: { watching = $0?.id })) { item in
            VideoViewer(tileId: item.id)
        }
        .alert("End-to-end encrypted", isPresented: $explaining) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(voice.isCall ? "With keys from this conversation's members. The server and the media server can't listen in or watch." : "With keys from this channel's members. The server and the media server can't listen in or watch.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.stage)
    }

    private struct Watching: Identifiable { let id: String }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                voice.stageShown = false
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(Theme.bg3, in: .circle)
            }
            .accessibilityLabel("Minimize")
            .accessibilityIdentifier(A11y.Voice.minimize)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: voice.isCall ? "phone.fill" : ChannelType.voice.symbol)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                }
                Button {
                    explaining = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "lock.fill").font(.system(size: 10))
                        Text(subtitle).lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.text2)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(A11y.Voice.encrypted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if canRingAgain {
                Button {
                    voice.ringAgain()
                } label: {
                    Image(systemName: "bell.and.waves.left.and.right")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 40, height: 40)
                        .background(Theme.bg3, in: .circle)
                }
                .accessibilityLabel("Ring everyone who isn't here")
                .accessibilityIdentifier(A11y.Voice.ringAgain)
            }
            Button {
                showingStats = true
            } label: {
                QualityIcon()
                    .frame(width: 40, height: 40)
                    .background(Theme.bg3, in: .circle)
            }
            .accessibilityLabel("Stream stats")
            .accessibilityValue(QualityIcon.describe(voice.quality).words)
            .accessibilityIdentifier(A11y.Voice.stats)
        }
        .foregroundStyle(Theme.text1)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    /// In a group's call, someone who isn't here and isn't being rung can be rung again.
    private var canRingAgain: Bool {
        guard voice.isCall, voice.status == .connected, let conversation, conversation.kind == .group, let server, let channelId = voice.channelId else { return false }
        let here = Set(server.inRoom(channelId)), ringing = Set(voice.ringingOthers)
        return conversation.members.contains { !here.contains($0.userId) && !ringing.contains($0.userId) }
    }

    private var subtitle: String {
        if voice.isCall { return "Encrypted · \(server?.entry.name ?? "")" }
        let topic = channel?.topic ?? ""
        return topic.isEmpty ? "Encrypted · \(server?.entry.name ?? "")" : "Encrypted · \(topic)"
    }

    // MARK: The stage

    /// Who's in the channel, in the order they came.
    private var members: [VoiceMember] {
        guard let server, let channelId = voice.channelId else { return [] }
        return server.voice.values.filter { $0.channelId == channelId }.sorted { $0.since < $1.since }
    }

    @ViewBuilder
    private var stage: some View {
        let cameras = Dictionary(voice.videos.filter { $0.source == .camera }.map { ($0.userId, $0) }, uniquingKeysWith: { first, _ in first })
        let screens = voice.videos.filter { $0.source == .screen }
        let focused = voice.focus.flatMap { key in voice.videos.first { $0.id == key } }
        let tiles: [StageTile] = screens.filter { $0.id != focused?.id }.map(StageTile.screen)
            + members.map { StageTile.person($0, cameras[$0.userId].flatMap { $0.id == focused?.id ? nil : $0 }) }
            + voice.ringingOthers.map(StageTile.ringing)
        if let focused {
            VStack(spacing: 8) {
                tile(focused.source == .screen ? .screen(focused) : .person(members.first { $0.userId == focused.userId } ?? placeholder(focused.userId), focused), focusedTile: true)
                    .frame(maxHeight: .infinity)
                    .padding(.horizontal, 8)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 8) {
                        ForEach(tiles) { item in
                            tile(item, focusedTile: false)
                                .frame(width: 150, height: 100)
                        }
                    }
                    .padding(.horizontal, 8)
                }
                .frame(height: 100)
            }
            .padding(.vertical, 8)
        } else {
            grid(tiles)
        }
    }

    private func placeholder(_ userId: String) -> VoiceMember {
        VoiceMember(channelId: voice.channelId ?? "", userId: userId, deviceId: "", muted: false, deafened: false, serverMuted: false, camera: true, screen: false, since: 0)
    }

    /// Everyone at a size that fills the screen, as FaceTime's grid does, scrolling only once they can't fit.
    private func grid(_ tiles: [StageTile]) -> some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 8
            let layout = Self.gridLayout(count: max(1, tiles.count), in: proxy.size, most: sizeClass == .regular ? 4 : 2, spacing: spacing)
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: spacing), count: layout.columns), spacing: spacing) {
                    ForEach(tiles) { item in
                        tile(item, focusedTile: false)
                            .frame(width: layout.tile.width, height: layout.tile.height)
                    }
                }
                .padding(spacing)
                .frame(minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    /// The number of columns that gives the biggest tiles, each between a little taller than wide and 16:9, so two
    /// people on an upright phone stand one above the other instead of leaving the bottom of the screen empty.
    private static func gridLayout(count: Int, in size: CGSize, most: Int, spacing: CGFloat) -> (columns: Int, tile: CGSize) {
        var best = (columns: 1, tile: CGSize.zero)
        for columns in 1...max(1, min(most, count)) {
            let rows = (count + columns - 1) / columns
            let cellWidth = (size.width - spacing * CGFloat(columns + 1)) / CGFloat(columns)
            let cellHeight = max(130, (size.height - spacing * CGFloat(rows + 1)) / CGFloat(rows))
            let height = min(cellHeight, cellWidth * 1.4)
            let width = min(cellWidth, height * 16 / 9)
            if width * height > best.tile.width * best.tile.height {
                best = (columns, CGSize(width: max(0, width), height: max(0, height)))
            }
        }
        return best
    }

    private enum StageTile: Identifiable {
        case person(VoiceMember, CallVideo?)
        case screen(CallVideo)
        /// Someone the call is ringing.
        case ringing(String)

        var id: String {
            switch self {
            case let .person(member, _): "person/\(member.deviceId)"
            case let .screen(tile): tile.id
            case let .ringing(userId): "ringing/\(userId)"
            }
        }
    }

    @ViewBuilder
    private func tile(_ item: StageTile, focusedTile: Bool) -> some View {
        switch item {
        case let .person(member, camera):
            PersonTile(server: server, member: member, camera: camera)
                .onTapGesture {
                    if focusedTile { voice.focus = nil } else if let camera { voice.focus = camera.id }
                }
                .onLongPressGesture { openMember(member) }
                .accessibilityAction(named: "Options") { openMember(member) }
                .overlay(alignment: .topTrailing) {
                    // On the picture it turns, as FaceTime's is, which leaves the controls room on a phone.
                    if camera?.local == true {
                        Button {
                            Task { await voice.flipCamera() }
                        } label: {
                            Image(systemName: "arrow.triangle.2.circlepath.camera.fill")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(.black.opacity(0.45), in: .circle)
                        }
                        .padding(8)
                        .accessibilityLabel("Switch camera")
                        .accessibilityIdentifier(A11y.Voice.flip)
                    }
                }
        case let .ringing(userId):
            RingingTile(server: server, userId: userId)
        case let .screen(video):
            ScreenTile(name: name(of: video.userId), video: video, focused: focusedTile, watch: { watching = video.id })
                .onTapGesture { voice.focus = focusedTile ? nil : video.id }
                .onLongPressGesture {
                    if let member = members.first(where: { $0.userId == video.userId }) { openMember(member) }
                }
        }
    }

    private func name(of userId: String) -> String {
        server?.users[userId]?.displayName ?? "Someone"
    }

    /// Only others have anything to choose: how loud they are, and what an admin can do.
    private func openMember(_ target: VoiceMember) {
        guard target.userId != server?.me?.userId else { return }
        member = target
    }
}

extension VoiceMember: @retroactive Identifiable {
    public var id: String { deviceId }
}

/// How well this device is connected to the media server.
struct QualityIcon: View {
    @Environment(VoiceModel.self) private var voice

    static func describe(_ quality: ConnectionQuality) -> (value: Double, words: String) {
        switch quality {
        case .excellent: (1, "Great connection")
        case .good: (0.66, "Good connection")
        case .poor: (0.33, "Weak connection")
        case .lost: (0, "Connection lost")
        default: (1, "Connected")
        }
    }

    var body: some View {
        let (value, words) = Self.describe(voice.quality)
        Image(systemName: "cellularbars", variableValue: value)
            .font(.footnote)
            .foregroundStyle(voice.quality == .poor || voice.quality == .lost ? Theme.red : Theme.green)
            .accessibilityLabel(words)
    }
}

/// Someone the call is ringing, faded until they answer.
private struct RingingTile: View {
    let server: AppModel.ServerState?
    let userId: String
    @State private var pulsing = false

    var body: some View {
        let user = server?.users[userId]
        let name = user?.displayName ?? "Someone"
        ZStack(alignment: .bottomLeading) {
            Theme.avatarColor(userId).opacity(0.12)
            AvatarView(name: name, seed: userId, source: user?.avatar.map { .avatar($0, serverId: server?.entry.id ?? "") } ?? .none, size: 72)
                .scaleEffect(pulsing ? 0.94 : 1)
                .opacity(pulsing ? 0.7 : 1)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 4) {
                Text(name).lineLimit(1)
                Text("Calling…").foregroundStyle(.white.opacity(0.7))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.black.opacity(0.55), in: .rect(cornerRadius: 6))
            .padding(8)
        }
        .clipShape(.rect(cornerRadius: 16))
        .onAppear {
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { pulsing = true }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), calling")
        .accessibilityIdentifier(A11y.Voice.ringing(userId))
    }
}

/// One person in the call: their camera, or their picture, ringed while they talk.
private struct PersonTile: View {
    @Environment(VoiceModel.self) private var voice
    let server: AppModel.ServerState?
    let member: VoiceMember
    let camera: CallVideo?

    var body: some View {
        let isSelf = member.userId == server?.me?.userId
        let speaking = isSelf ? voice.speaking.contains(member.userId) && !voice.micOff : voice.speaking.contains(member.userId)
        let user = server?.users[member.userId]
        let name = user?.displayName ?? "Someone"
        ZStack(alignment: .bottomLeading) {
            if let camera {
                SwiftUIVideoView(camera.track, layoutMode: .fill, mirrorMode: camera.local && voice.cameraFront ? .mirror : .off)
            } else {
                Theme.avatarColor(member.userId).opacity(0.16)
                    .background(Theme.bg2)
                AvatarView(name: name, seed: member.userId, source: user?.avatar.map { .avatar($0, serverId: server?.entry.id ?? "") } ?? .none, size: 72)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 5) {
                if member.serverMuted {
                    Image(systemName: "mic.slash.fill").foregroundStyle(Theme.red)
                } else if member.muted {
                    Image(systemName: "mic.slash.fill")
                }
                if member.deafened { Image(systemName: "speaker.slash.fill") }
                if voice.localMutes.contains(member.userId) { Image(systemName: "speaker.zzz.fill") }
                Text(isSelf ? "\(name) (you)" : name).lineLimit(1)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.black.opacity(0.45), in: .capsule)
            .padding(8)
        }
        .clipShape(.rect(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(speaking ? Theme.green : .clear, lineWidth: 3)
        }
        .contentShape(.rect(cornerRadius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(name: name, isSelf: isSelf, speaking: speaking))
        .accessibilityIdentifier(A11y.Voice.person(member.deviceId))
    }

    private func accessibilityText(name: String, isSelf: Bool, speaking: Bool) -> String {
        var parts = [isSelf ? "\(name) (you)" : name]
        if member.serverMuted { parts.append("muted by an admin") } else if member.muted { parts.append("muted") }
        if member.deafened { parts.append("deafened") }
        if voice.localMutes.contains(member.userId) { parts.append("muted for you") }
        if camera != nil { parts.append("camera on") }
        if speaking { parts.append("speaking") }
        return parts.joined(separator: ", ")
    }
}

/// A shared screen. A tap fills the stage with it.
private struct ScreenTile: View {
    let name: String
    let video: CallVideo
    let focused: Bool
    let watch: () -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black
            SwiftUIVideoView(video.track, layoutMode: .fit)
            HStack(spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: "display")
                    Text(video.local ? "Your screen" : "\(name)'s screen").lineLimit(1)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.black.opacity(0.45), in: .capsule)
                Spacer(minLength: 0)
                // At the bottom right, as a video player has it.
                if video.sound {
                    StreamSoundButton(userId: video.userId)
                        .accessibilityIdentifier(A11y.Voice.streamSound(video.id))
                }
            }
            .padding(8)
        }
        .overlay(alignment: .topTrailing) {
            Button(action: watch) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(.black.opacity(0.45), in: .circle)
            }
            .padding(8)
            .accessibilityLabel("Full screen")
            .accessibilityIdentifier(A11y.Voice.fullScreen(video.id))
        }
        .clipShape(.rect(cornerRadius: 16, style: .continuous))
        .contentShape(.rect(cornerRadius: 16))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(video.local ? "Your screen" : "\(name)'s screen")
        .accessibilityHint(focused ? "Goes back to everyone" : "Fills the stage")
        .accessibilityIdentifier(A11y.Voice.screen(video.id))
    }
}

/// Mute, deafen, the camera, sharing the screen, where sound plays, the chat beside the call, and
/// leaving. Smaller where they wouldn't fit, as on the smallest phones and in Slide Over on an iPad.
private struct CallControls: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    /// The chat that goes with it: a voice channel's, or the conversation whose call it is.
    let chat: ConversationView?
    let chatKey: String?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            buttons(size: 52, spacing: 10)
            buttons(size: 44, spacing: 8)
            buttons(size: 40, spacing: 6)
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Theme.bg1.ignoresSafeArea(edges: .bottom))
    }

    private func buttons(size: CGFloat, spacing: CGFloat) -> some View {
        HStack(spacing: spacing) {
            control(
                voice.micOff ? "mic.slash.fill" : "mic.fill",
                label: voice.serverMuted ? "An admin muted you" : voice.noMic ? "No microphone" : voice.micOff ? "Unmute" : "Mute",
                off: voice.micOff,
                size: size,
                id: A11y.Voice.mute
            ) { voice.toggleMute() }
                .disabled(voice.serverMuted || voice.noMic)
            control(voice.deafened ? "speaker.slash.fill" : "speaker.wave.2.fill", label: voice.deafened ? "Undeafen" : "Deafen", off: voice.deafened, size: size, id: A11y.Voice.deafen) {
                voice.toggleDeafen()
            }
            control(voice.camera ? "video.fill" : "video.slash.fill", label: voice.camera ? "Turn off camera" : "Turn on camera", on: voice.camera, size: size, id: A11y.Voice.camera) {
                Task { await voice.toggleCamera() }
            }
            if voice.canShareScreen {
                let sharing = voice.screen || voice.screenStarting
                // Tapping it while the server says no says why, as the desktop's tooltip does.
                control(sharing ? "rectangle.fill.on.rectangle.fill" : "rectangle.on.rectangle", label: sharing ? "Stop sharing" : "Share your screen", on: sharing, size: size, id: A11y.Voice.shareScreen) {
                    Task { await voice.toggleScreen() }
                }
                .opacity(!sharing && voice.shareRefusal != nil ? 0.45 : 1)
                .accessibilityHint(sharing ? "" : voice.shareRefusal ?? "")
            }
            SwiftUIAudioRoutePickerButton()
                .frame(width: size, height: size)
                .background(Theme.bg3, in: .circle)
                .accessibilityLabel("Where sound plays")
            control("bubble.left.fill", label: "Show chat", dot: (chat?.unread ?? 0) > 0, size: size, id: A11y.Voice.chat) {
                guard let chatKey, let serverId = voice.serverId else { return }
                voice.stageShown = false
                model.selectServer(serverId)
                model.openChat(chatKey)
            }
            Button {
                voice.leave()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: size * 0.37, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(Theme.red, in: .circle)
            }
            .accessibilityLabel("Disconnect")
            .accessibilityIdentifier(A11y.Voice.leave)
        }
        .padding(.horizontal, 12)
    }

    private func control(_ symbol: String, label: String, off: Bool = false, on: Bool = false, dot: Bool = false, size: CGFloat, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.37, weight: .semibold))
                .foregroundStyle(off ? Theme.red : on ? Theme.bg0 : Theme.text1)
                .frame(width: size, height: size)
                .background(on ? Theme.text1 : off ? Theme.red.opacity(0.18) : Theme.bg3, in: .circle)
                .overlay(alignment: .topTrailing) {
                    if dot {
                        Circle().fill(Theme.red).frame(width: 10, height: 10).offset(x: -4, y: 4)
                    }
                }
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}
