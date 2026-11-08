import PhotosUI
import SwiftUI
import ZunaModels

/// A chat's details, laid out like Telegram's profile pages, with what the
/// desktop's side panel shows: for a person, their profile, encryption and the
/// chat's settings; for a group, its picture and name, members and admin tools.
/// Under the name, a row for calls, notifications, search and pins.
struct ConversationDetails: View {
    let conversationKey: String

    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @State private var sheet: DetailsSheet?
    @State private var memberMenu: String?
    @State private var choosingMute = false
    @State private var confirming: Confirmation?
    @State private var reporting: UserView?
    @State private var photo: PhotosPickerItem?
    @State private var choosingPhoto = false
    @State private var mediaCounts: MediaCounts?

    enum DetailsSheet: Identifiable {
        case verify(String), edit, addMembers, search

        var id: String {
            switch self {
            case let .verify(userId): "verify-\(userId)"
            case .edit: "edit"
            case .addMembers: "add"
            case .search: "search"
            }
        }
    }

    enum Confirmation: Identifiable {
        case leave, delete, remove(String)

        var id: String {
            switch self {
            case .leave: "leave"
            case .delete: "delete"
            case let .remove(userId): "remove-\(userId)"
            }
        }
    }

    var body: some View {
        Group {
            if let server = model.activeServer, let conversation = server.conversations.first(where: { $0.key == conversationKey }) {
                content(server, conversation)
            } else {
                ContentUnavailableView("This chat isn't available", systemImage: "person.crop.circle.badge.questionmark")
            }
        }
        .background(Theme.bg0)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
    }

    private func content(_ server: AppModel.ServerState, _ conversation: ConversationView) -> some View {
        let serverId = server.entry.id
        let selfId = server.me?.userId ?? ""
        let peer = conversation.peerId.flatMap { server.users[$0] }
        let isSelf = conversation.peerId == selfId
        let isAdmin = conversation.members.first { $0.userId == selfId }?.role == .admin
        return List {
            Section {
                header(server, conversation, peer: peer, isSelf: isSelf, isAdmin: isAdmin)
                    // The buttons as wide as the cards under them.
                    .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
            }
            .listRowBackground(Color.clear)
            about(conversation, peer: peer, isSelf: isSelf)

            if conversation.kind == .group {
                Section {
                    Label("The server can see who is in this group, but not its name, picture or messages.", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                .listRowBackground(Theme.bg2)
                sharedMedia(server, conversation)
                members(server, conversation, selfId: selfId, isAdmin: isAdmin)
                if isAdmin {
                    Section {
                        Toggle(isOn: Binding(get: { conversation.historyVisible }, set: { value in
                            run { try await model.core.session(serverId).updateGroupMeta(conversation.groupId ?? "", GroupMetaChanges(), historyVisible: value) }
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("New members can read earlier messages")
                                Text("Applies to people added after this is turned on.").font(.caption).foregroundStyle(Theme.text3)
                            }
                        }
                        .tint(model.settings.accent.switchTint)
                        .accessibilityIdentifier(A11y.Details.history)
                    }
                    .listRowBackground(Theme.bg2)
                }
            } else if let peer, !isSelf {
                Section("Encryption") {
                    Button {
                        sheet = .verify(peer.id)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: peer.trust == .verified ? "checkmark.shield.fill" : peer.trust == .changed ? "exclamationmark.shield.fill" : "shield")
                                .font(.title2)
                                .foregroundStyle(peer.trust == .verified ? Theme.green : peer.trust == .changed ? Theme.amber : Theme.text2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(peer.trust == .verified ? "Verified" : peer.trust == .changed ? "Security key changed" : "Not verified yet")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Theme.text1)
                                Text(peer.trust == .verified ? "You've confirmed this is really them." : "Compare emoji to make sure nobody is in between.")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.text2)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.text3)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(A11y.Details.trust)
                }
                .listRowBackground(Theme.bg2)
            }
            if conversation.kind != .group {
                sharedMedia(server, conversation)
            }
            disappearing(server, conversation, canChange: conversation.kind != .group || isAdmin)

            Section {
                // Turning them off asks for how long.
                Toggle(isOn: Binding(get: { !conversation.muted }, set: { on in
                    if on { model.unmute(conversation.key, on: serverId) } else { choosingMute = true }
                })) {
                    Label {
                        Text("Notifications")
                        if let until = conversation.mutedUntil { Text(Format.mutedUntil(until)) }
                    } icon: {
                        Image(systemName: conversation.muted ? "bell.slash" : "bell")
                    }
                }
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Details.notifications)
                if conversation.kind == .group {
                    Toggle(isOn: Binding(get: { conversation.mentionsOnly }, set: { model.setMentionsOnly(conversation.key, $0, on: serverId) })) {
                        Label {
                            Text("Only mentions")
                            Text("Notify only when someone mentions you or replies to you")
                        } icon: {
                            Image(systemName: "at")
                        }
                    }
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Details.mentionsOnly)
                }
                Button {
                    model.toggle(.pinned, conversation.key, on: serverId)
                } label: {
                    Label(conversation.pinned ? "Unpin from top" : "Pin to top", systemImage: conversation.pinned ? "pin.slash" : "pin")
                }
                Button {
                    model.toggle(.hidden, conversation.key, on: serverId)
                } label: {
                    Label(conversation.hidden ? "Show in list" : "Hide from list", systemImage: conversation.hidden ? "eye" : "eye.slash")
                }
            }
            .foregroundStyle(Theme.text1)
            .listRowBackground(Theme.bg2)

            // Nobody is told, so it needs no warning.
            if let peer, !isSelf, !peer.deleted {
                Section {
                    if server.isBlocked(peer.id) {
                        Button { model.setBlocked(peer.id, false, on: serverId) } label: {
                            Label("Unblock \(peer.displayName)", systemImage: "nosign")
                        }
                        .foregroundStyle(Theme.text1)
                    } else {
                        Button(role: .destructive) { model.setBlocked(peer.id, true, on: serverId) } label: {
                            Label("Block \(peer.displayName)", systemImage: "nosign")
                        }
                    }
                } footer: {
                    if !server.isBlocked(peer.id) {
                        Text("You won't see their messages or hear about them. They aren't told.")
                    }
                }
                .listRowBackground(Theme.bg2)
                .accessibilityIdentifier(A11y.Details.block)
            }

            if let peer, !isSelf, !peer.deleted, !peer.banned {
                Section {
                    if server.prefs.reported?.contains(peer.id) == true {
                        Label("Reported to the server's admins", systemImage: "flag")
                            .foregroundStyle(Theme.text3)
                    } else {
                        Button { reporting = peer } label: {
                            Label("Report \(peer.displayName)", systemImage: "flag")
                        }
                        .foregroundStyle(Theme.text1)
                    }
                } footer: {
                    Text("The server's admins see whom and why, never what was said or who reported.")
                }
                .listRowBackground(Theme.bg2)
                .accessibilityIdentifier(A11y.Details.report)
            }

            if conversation.kind == .group {
                Section {
                    Button(role: .destructive) { confirming = .leave } label: {
                        Label("Leave group", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .accessibilityIdentifier(A11y.Details.leave)
                    if isAdmin {
                        Button(role: .destructive) { confirming = .delete } label: {
                            Label("Delete group for everyone", systemImage: "trash")
                        }
                    }
                }
                .listRowBackground(Theme.bg2)
            }
        }
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier(A11y.Details.screen)
        .task(id: model.chatChange(serverId, conversation)) {
            guard let groupId = conversation.groupId else {
                mediaCounts = nil
                return
            }
            // New messages come in bursts as history arrives, so counting again waits for a quiet moment.
            if mediaCounts != nil { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled, let counts = try? await model.core.session(serverId).mediaCounts(groupId), !Task.isCancelled else { return }
            mediaCounts = counts
        }
        // On the list, not the switch: a list leaves out rows off screen, and the row under the name asks too.
        .confirmationDialog("Mute notifications", isPresented: $choosingMute, titleVisibility: .visible) {
            MuteButtons(conversationKey: conversation.key, serverId: serverId)
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case let .verify(userId):
                VerifyView(serverId: serverId, userId: userId)
            case .edit:
                EditGroupSheet(serverId: serverId, conversation: conversation)
            case .addMembers:
                AddMembersSheet(serverId: serverId, conversation: conversation)
            case .search:
                ChatSearchSheet(serverId: serverId, conversation: conversation, server: server)
            }
        }
        .confirmationDialog(confirmTitle(conversation), isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { confirmation in
            Button(confirmAction(confirmation), role: .destructive) { perform(confirmation, serverId, conversation) }
        }
        .confirmationDialog("Report \(reporting?.displayName ?? "them") for", isPresented: Binding(get: { reporting != nil }, set: { if !$0 { reporting = nil } }), titleVisibility: .visible, presenting: reporting) { user in
            ForEach(ReportReason.allCases, id: \.self) { reason in
                Button(reason.label) {
                    run {
                        try await model.core.session(serverId).reportUser(user.id, reason: reason)
                        model.toast("Reported to the server's admins")
                    }
                }
            }
        }
        .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
        .onChange(of: photo) { _, item in
            guard let item, let groupId = conversation.groupId else { return }
            photo = nil
            run {
                guard let media = try await item.loadTransferable(type: PickedMedia.self) else { return }
                let url = media.url
                let file = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.avatar(from: url) }.value
                try await model.core.session(serverId).updateGroupMeta(groupId, GroupMetaChanges(), avatar: .set(file))
            }
        }
    }

    // MARK: Header

    private func header(_ server: AppModel.ServerState, _ conversation: ConversationView, peer: UserView?, isSelf: Bool, isAdmin: Bool) -> some View {
        VStack(spacing: 6) {
            AvatarView(
                name: conversation.title,
                seed: conversation.peerId ?? conversation.groupId ?? conversation.key,
                source: conversation.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                size: 96,
                online: peer?.online ?? false
            )
            .overlay(alignment: .bottomTrailing) {
                if conversation.kind == .group, isAdmin {
                    Button {
                        choosingPhoto = true
                    } label: {
                        Image(systemName: "camera.fill")
                            .font(.footnote)
                            .foregroundStyle(Theme.text1)
                            .frame(width: 30, height: 30)
                            .background(Theme.bg4, in: .circle)
                            .overlay(Circle().stroke(Theme.bg0, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Change group picture")
                }
            }
            .padding(.bottom, 6)
            HStack(spacing: 6) {
                Text(isSelf ? peer?.displayName ?? conversation.title : conversation.title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                if conversation.kind == .group, isAdmin {
                    Button {
                        sheet = .edit
                    } label: {
                        Image(systemName: "pencil").foregroundStyle(Theme.text2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit group details")
                    .accessibilityIdentifier(A11y.Details.edit)
                }
            }
            if let peer, !isSelf {
                Text(peer.online ? "online" : Format.lastSeen(peer.lastSeenAt, hidden: peer.hidesLastSeen))
                    .font(.footnote)
                    .foregroundStyle(peer.online ? Theme.green : Theme.text3)
            }
            DetailsActions(actions: actions(server, conversation, peer: peer, isSelf: isSelf))
                .padding(.top, 22)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Details.header)
    }

    // MARK: About

    /// Who they are, in a card of labelled rows under the buttons, as Telegram's
    /// profile pages have it: a person's bio and username, or a group's description.
    @ViewBuilder
    private func about(_ conversation: ConversationView, peer: UserView?, isSelf: Bool) -> some View {
        if let peer, !isSelf, !peer.deleted {
            Section {
                if !peer.bio.isEmpty {
                    aboutRow("bio", peer.bio).accessibilityIdentifier(A11y.Details.bio)
                }
                aboutRow("username", "@\(peer.username)", color: Theme.link).accessibilityIdentifier(A11y.Details.username)
            }
            .listRowBackground(Theme.bg2)
        } else if conversation.kind == .group, !conversation.description.isEmpty {
            Section {
                aboutRow("description", conversation.description).accessibilityIdentifier(A11y.Details.description)
            }
            .listRowBackground(Theme.bg2)
        }
    }

    private func aboutRow(_ label: String, _ value: String, color: Color = Theme.text1) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(Theme.channelMuted)
            Text(value)
                .foregroundStyle(color)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    // MARK: Actions

    /// What the chat's bar had: a call, or the one going on, then mute, search and pins.
    private func actions(_ server: AppModel.ServerState, _ conversation: ConversationView, peer: UserView?, isSelf: Bool) -> [DetailsActions.Action] {
        let serverId = server.entry.id, key = conversation.key
        var actions: [DetailsActions.Action] = []
        if ChatScreen.canCall(server, conversation, peer: peer, isSaved: isSelf) {
            if let groupId = conversation.groupId, voice.inCall, voice.serverId == serverId, voice.channelId == groupId {
                actions.append(.init(id: "call", title: "In call", icon: "phone.fill", tint: Theme.green) { voice.stageShown = true })
            } else if let groupId = conversation.groupId, !server.inRoom(groupId).isEmpty {
                actions.append(.init(id: "join", title: "Join", icon: "phone.fill", tint: Theme.green) {
                    Task { await voice.join(serverId: serverId, channelId: groupId) }
                })
            } else {
                actions.append(.init(id: "call", title: "Call", icon: "phone.fill") {
                    Task { await voice.startCall(serverId: serverId, key: key, camera: false) }
                })
                actions.append(.init(id: "video", title: "Video", icon: "video.fill") {
                    Task { await voice.startCall(serverId: serverId, key: key, camera: true) }
                })
            }
        }
        if !isSelf {
            actions.append(.init(id: "mute", title: conversation.muted ? "Unmute" : "Mute", icon: conversation.muted ? "bell.slash.fill" : "bell.fill") {
                if conversation.muted { model.unmute(key, on: serverId) } else { choosingMute = true }
            })
        }
        actions.append(.init(id: "search", title: "Search", icon: "magnifyingglass", disabled: conversation.groupId == nil) { sheet = .search })
        actions.append(.init(id: "pins", title: "Pins", icon: "pin.fill", disabled: conversation.groupId == nil) {
            model.chatPath.append(.pins(key))
        })
        return actions
    }

    // MARK: Shared media

    /// How many photos, files, links and so on are in the chat, one row each, as in Telegram's details.
    @ViewBuilder
    private func sharedMedia(_ server: AppModel.ServerState, _ conversation: ConversationView) -> some View {
        let groups = conversation.kind == .group ? [] : server.groupsInCommon(with: conversation.peerId)
        let rows = SharedKind.allCases.map { ($0, $0.count(in: mediaCounts, groups: groups.count)) }.filter { $0.1 > 0 }
        // All the rows at once, rather than the groups in common before the counts.
        if conversation.groupId == nil || mediaCounts != nil, !rows.isEmpty {
            Section {
                ForEach(rows, id: \.0) { kind, count in
                    NavigationLink(value: ChatRoute.media(conversation.key, kind)) {
                        Label(kind.counted(count), systemImage: kind.icon)
                    }
                    .accessibilityIdentifier(A11y.Details.shared(kind.rawValue))
                }
            }
            .foregroundStyle(Theme.text1)
            .listRowBackground(Theme.bg2)
        }
    }

    // MARK: Members

    private func members(_ server: AppModel.ServerState, _ conversation: ConversationView, selfId: String, isAdmin: Bool) -> some View {
        let sorted = conversation.members.sorted { a, b in
            if a.role != b.role { return a.role == .admin }
            return (server.users[a.userId]?.displayName ?? "").localizedCompare(server.users[b.userId]?.displayName ?? "") == .orderedAscending
        }
        return Section {
            ForEach(sorted, id: \.userId) { member in
                let user = server.users[member.userId]
                Button {
                    if member.userId != selfId { memberMenu = member.userId }
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(name: user?.displayName ?? "?", seed: member.userId, source: user?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 40, online: user?.online ?? false)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(user?.displayName ?? "Unknown").foregroundStyle(Theme.text1)
                                if member.userId == selfId { Text("(you)").foregroundStyle(Theme.text3) }
                            }
                            Text(member.notOnRoster == true ? "Has this chat's keys, but isn't listed as a member" : member.noKeys == true ? "No device in this chat yet" : "@\(user?.username ?? "")")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        if member.notOnRoster == true {
                            Image(systemName: "exclamationmark.shield").font(.caption).foregroundStyle(Color(hex: 0xF4BCBE)).accessibilityLabel("Not listed as a member")
                        }
                        if member.role == .admin {
                            Image(systemName: "crown.fill").font(.caption).foregroundStyle(Theme.text3).accessibilityLabel("Admin")
                        }
                        if user?.trust == .verified {
                            Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(Theme.text2).accessibilityLabel("Verified")
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(A11y.Details.member(member.userId))
                .confirmationDialog(user?.displayName ?? "Member", isPresented: Binding(get: { memberMenu == member.userId }, set: { if !$0 { memberMenu = nil } })) {
                    memberActions(server, conversation, member: member, isAdmin: isAdmin)
                }
            }
        } header: {
            HStack {
                Text("\(conversation.members.count) \(conversation.members.count == 1 ? "member" : "members")")
                Spacer()
                if isAdmin {
                    Button {
                        sheet = .addMembers
                    } label: {
                        Label("Add people", systemImage: "person.badge.plus")
                    }
                    .font(.footnote)
                    .accessibilityIdentifier(A11y.Details.addMembers)
                }
            }
        }
        .listRowBackground(Theme.bg2)
    }

    @ViewBuilder
    private func memberActions(_ server: AppModel.ServerState, _ conversation: ConversationView, member: GroupMemberView, isAdmin: Bool) -> some View {
        let serverId = server.entry.id
        Button("Message") { model.openChat("user:\(member.userId)") }
        Button("Verify security key") { sheet = .verify(member.userId) }
        if server.isBlocked(member.userId) {
            Button("Unblock") { model.setBlocked(member.userId, false, on: serverId) }
        } else {
            Button("Block") { model.setBlocked(member.userId, true, on: serverId) }
        }
        if isAdmin, let groupId = conversation.groupId {
            Button(member.role == .admin ? "Remove admin" : "Make admin") {
                run { try await model.core.session(serverId).setGroupRole(groupId, userId: member.userId, role: member.role == .admin ? .member : .admin) }
            }
            Button("Remove from group", role: .destructive) {
                // A second dialog can't open while this one is still closing.
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    confirming = .remove(member.userId)
                }
            }
        }
    }

    // MARK: Confirmations

    private func confirmTitle(_ conversation: ConversationView) -> String {
        switch confirming {
        case .leave: "Leave \(conversation.title)? You won't see new messages unless someone adds you again."
        case .delete: "Delete \(conversation.title) for everyone? Its messages go for all members."
        case let .remove(userId): "Remove \(model.activeServer?.users[userId]?.displayName ?? "them") from \(conversation.title)?"
        case nil: ""
        }
    }

    private func confirmAction(_ confirmation: Confirmation) -> String {
        switch confirmation {
        case .leave: "Leave group"
        case .delete: "Delete group for everyone"
        case .remove: "Remove from group"
        }
    }

    private func perform(_ confirmation: Confirmation, _ serverId: String, _ conversation: ConversationView) {
        guard let groupId = conversation.groupId else { return }
        let session = model.core.session(serverId)
        switch confirmation {
        case .leave:
            run {
                try await session.leaveGroup(groupId)
                model.chatPath = []
            }
        case .delete:
            run {
                try await session.deleteGroup(groupId)
                model.chatPath = []
            }
        case let .remove(userId):
            run { try await session.removeMember(groupId, userId: userId) }
        }
    }

    /// How long messages sent here last, as the desktop's side panel shows it: in a
    /// direct message either person may change it, in a group its admins. Shown once
    /// the chat has started.
    @ViewBuilder
    private func disappearing(_ server: AppModel.ServerState, _ conversation: ConversationView, canChange: Bool) -> some View {
        if let groupId = conversation.groupId, conversation.ready {
            let current = conversation.disappearAfter
            Section {
                if canChange {
                    Picker(selection: Binding(get: { current }, set: { seconds in
                        run { try await model.core.session(server.entry.id).setDisappearing(groupId, seconds: seconds) }
                    })) {
                        ForEach([0] + Format.disappearingTimes, id: \.self) { seconds in
                            Text(Format.timer(seconds)).tag(seconds)
                        }
                    } label: {
                        Label("Disappearing messages", systemImage: "timer")
                    }
                    .pickerStyle(.menu)
                    .tint(Theme.text2)
                    .accessibilityIdentifier(A11y.Details.disappearing)
                } else {
                    LabeledContent {
                        Text(Format.timer(current))
                    } label: {
                        Label("Disappearing messages", systemImage: "timer")
                    }
                    .accessibilityIdentifier(A11y.Details.disappearing)
                }
            } footer: {
                Text(current > 0 ? "New messages disappear \(Format.timer(current)) after they're sent." : "New messages stay until they're deleted.")
            }
            .listRowBackground(Theme.bg2)
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
            } catch {
                model.toast(OnboardingText.describe(error), .error)
            }
        }
    }
}
