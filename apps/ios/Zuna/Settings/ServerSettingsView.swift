import PhotosUI
import SwiftUI
import ZunaModels

/// The server, for its owner and admins, with the desktop's sections:
/// overview, invites, members, channels, screen sharing, emotes and storage.
struct ServerSettingsView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    @State private var name = ""
    @State private var loaded = false
    @State private var icon: PhotosPickerItem?
    @State private var inviting = false
    /// A new picture on its way up.
    @State private var uploadingIcon = false

    var body: some View {
        let server = model.servers[serverId]
        List {
            if let server {
                Section {
                    HStack(spacing: 14) {
                        // Made here, as the picker's label isn't on the main actor.
                        let picture = AvatarView(name: server.entry.name, seed: server.entry.url, source: .serverIcon(server.entry), size: 64, rounded: true)
                        let uploading = uploadingIcon
                        PhotosPicker(selection: $icon, matching: .images) {
                            picture
                                .overlay {
                                    if uploading {
                                        RoundedRectangle(cornerRadius: 64 * 0.28, style: .continuous).fill(.black.opacity(0.45))
                                        ProgressView().tint(.white)
                                    }
                                }
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "photo").font(.caption).foregroundStyle(Theme.text1)
                                        .frame(width: 24, height: 24).background(Theme.bg4, in: .circle)
                                }
                        }
                        .accessibilityLabel("Change server picture")
                        TextField("Server name", text: $name)
                            .font(.headline)
                            .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                            .accessibilityIdentifier(A11y.Settings.serverName)
                    }
                    Button("Save name") {
                        let value = name.trimmingCharacters(in: .whitespaces)
                        run {
                            try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(name: value))
                            model.toast("Saved")
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name == server.entry.name)
                    .accessibilityIdentifier(A11y.Settings.save)
                    LabeledContent("Address") { Text(server.entry.address).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                    LabeledContent("Version") { Text(server.info?.version ?? "").font(.system(.footnote, design: .monospaced)) }
                } header: {
                    Text("Server")
                } footer: {
                    Text("The name and picture are public: they appear on invite pages before anyone signs in.")
                }

                Section {
                    Button("Invite people", systemImage: "link") { inviting = true }
                    SavingToggle("Let members create invite links", value: server.info?.allowMemberInvites ?? false) { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(allowMemberInvites: value))
                    }
                    .accessibilityIdentifier(A11y.Settings.memberInvites)
                    SavingToggle("Open sign-ups", value: server.info?.registration == "open") { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(registration: value ? "open" : "invite"))
                    }
                    .accessibilityIdentifier(A11y.Settings.openSignUps)
                } header: {
                    Text("Invites")
                } footer: {
                    Text("Invite links are the safest way for people to join. Open sign-ups let anyone who knows the address join, and give the server the key that protects profiles, so it can read display names and pictures. Messages stay encrypted.")
                }

                Section("Members") {
                    NavigationLink("\(server.users.values.filter { !$0.deleted && !$0.banned }.count) members") { ServerMembersView(serverId: serverId) }
                    NavigationLink("Reports") { ReportsView(serverId: serverId) }
                        .accessibilityIdentifier(A11y.Settings.reports)
                    NavigationLink { BansView(serverId: serverId) } label: {
                        LabeledContent("Bans", value: "\(server.users.values.filter { $0.banned && !$0.deleted }.count)")
                    }
                    .accessibilityIdentifier(A11y.Settings.bans)
                }
                Section("Channels") {
                    NavigationLink(server.channels.count == 1 ? "1 channel" : "\(server.channels.count) channels") { ChannelsSettingsView(serverId: serverId) }
                }
                Section("Voice") {
                    // The rules come with what a member is told about the server.
                    if server.info?.screenShare != nil {
                        NavigationLink("Screen sharing") { ScreenRulesView(serverId: serverId) }
                            .accessibilityIdentifier(A11y.Settings.screenRules)
                    }
                    NavigationLink { SoundboardSettingsView(serverId: serverId) } label: {
                        LabeledContent("Soundboard", value: server.sounds.count == 1 ? "1 sound" : "\(server.sounds.count) sounds")
                    }
                    .accessibilityIdentifier(A11y.Settings.soundboard)
                }
                Section("Emotes") {
                    NavigationLink { EmoteSetView(serverId: serverId) } label: {
                        LabeledContent(server.emotes.setName.isEmpty ? "No emote set" : server.emotes.setName, value: "\(server.emotes.emotes.count) emotes")
                    }
                    .accessibilityIdentifier(A11y.Settings.emotes)
                }
                Section("Storage") {
                    NavigationLink("Files and retention") { StorageView(serverId: serverId) }
                }
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(server?.entry.name ?? "Server")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $inviting) { InviteSheet(serverId: serverId) }
        .onAppear {
            guard !loaded, let server else { return }
            loaded = true
            name = server.entry.name
        }
        .onChange(of: icon) { _, item in
            guard let item, let server else { return }
            icon = nil
            uploadingIcon = true
            run {
                defer { uploadingIcon = false }
                guard let media = try await item.loadTransferable(type: PickedMedia.self) else { return }
                let url = media.url
                let file = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.avatar(from: url) }.value
                try await model.core.session(serverId).updateServerIcon(file)
                images.forgetServerIcon(server.entry)
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// Everyone on the server, with roles, and banning for admins, as on the desktop. Someone
/// banned is in Bans.
struct ServerMembersView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var target: UserView?
    @State private var banning: UserView?

    var body: some View {
        let server = model.servers[serverId]
        let selfRole = server?.me?.role
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        // Nothing can be done about an account that's gone.
        let members = (server?.users.values.map { $0 } ?? []).filter { !$0.deleted && !$0.banned }
        let users = members
            .filter { needle.isEmpty || $0.displayName.lowercased().contains(needle) || $0.username.lowercased().contains(needle) }
            .sorted { $0.displayName.lowercased() < $1.displayName.lowercased() }
        List(users) { user in
            Button {
                // The owner manages admins; admins manage members. Nobody acts on the owner or themselves.
                let canAct = user.id != server?.me?.userId && user.role != .owner && (selfRole == .owner || user.role == .member)
                if canAct {
                    target = user
                } else if user.id != server?.me?.userId {
                    model.toast(user.role == .owner ? "Nobody can change the server's owner." : "Only the server's owner can change its admins.")
                }
            } label: {
                HStack(spacing: 12) {
                    WithPresence(serverId: serverId, user: user) { online in
                        AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36, online: online)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(user.displayName).foregroundStyle(Theme.text1)
                        Text("@\(user.username)").font(.caption).foregroundStyle(Theme.text3)
                    }
                    Spacer()
                    if user.role != .member {
                        Label(user.role == .owner ? "Owner" : "Admin", systemImage: "crown.fill").font(.caption).foregroundStyle(Theme.text2)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .listRowBackground(Theme.bg2)
            .accessibilityIdentifier(A11y.Settings.member(user.username))
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .searchable(text: $query, prompt: "Search \(members.count) members")
        .navigationTitle("Members")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(target?.displayName ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), presenting: target) { user in
            if selfRole == .owner {
                Button(user.role == .admin ? "Remove admin" : "Make admin") {
                    run { try await model.core.session(serverId).setServerRole(user.id, role: user.role == .admin ? .member : .admin) }
                }
            }
            Button("Ban from server", role: .destructive) { banning = user }
        }
        .confirmationDialog("Ban \(banning?.displayName ?? "them")? They're signed out everywhere and removed from every group.", isPresented: Binding(get: { banning != nil }, set: { if !$0 { banning = nil } }), titleVisibility: .visible, presenting: banning) { user in
            Button("Ban from server", role: .destructive) { run { try await model.core.session(serverId).banUser(user.id) } }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// Who was reported, how often and why, as on the desktop: never what was said, which
/// nobody here can read, nor who reported them.
struct ReportsView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var reports: [ReportView]?
    @State private var banning: UserView?

    var body: some View {
        let server = model.servers[serverId]
        let selfRole = server?.me?.role
        List {
            Section {
                if let reports, reports.isEmpty {
                    Text("Nobody has been reported.").foregroundStyle(Theme.text2)
                }
                ForEach(reports ?? []) { report in
                    let user = server?.users[report.userId]
                    let name = user?.displayName ?? "Unknown"
                    let canBan = user.map { !$0.banned && !$0.deleted && $0.role != .owner && (selfRole == .owner || $0.role == .member) } ?? false
                    HStack(spacing: 12) {
                        AvatarView(name: name, seed: report.userId, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name).foregroundStyle(Theme.text1)
                            Text("\(report.count == 1 ? "1 report" : "\(report.count) reports") · \(report.reasons.map(\.label).joined(separator: ", "))")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .swipeActions {
                        Button("Dismiss") { run { try await model.core.session(serverId).dismissReports(report.userId) } }
                        if canBan, let user {
                            Button("Ban", role: .destructive) { banning = user }
                        }
                    }
                }
            } footer: {
                Text("Swipe to dismiss a report, or to ban. Messages are encrypted, so nobody here sees what was said, and who reported them isn't kept.")
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Reports")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog("Ban \(banning?.displayName ?? "them")? They're signed out everywhere and removed from every group.", isPresented: Binding(get: { banning != nil }, set: { if !$0 { banning = nil } }), titleVisibility: .visible, presenting: banning) { user in
            Button("Ban from server", role: .destructive) { run { try await model.core.session(serverId).banUser(user.id) } }
        }
    }

    private func load() async {
        reports = (try? await model.core.session(serverId).getReports()) ?? []
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
                await load()
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }
}

/// Who is banned, when and by whom, as on the desktop, to let them back in.
struct BansView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var bans: [BanView]?
    @State private var target: BanView?

    var body: some View {
        let server = model.servers[serverId]
        // Someone unbanned anywhere else is off it at once, before it's read again.
        let shown = (bans ?? []).filter { server?.users[$0.userId]?.banned != false }
        List {
            Section {
                if bans != nil, shown.isEmpty {
                    Text("Nobody is banned.").foregroundStyle(Theme.text2)
                }
                ForEach(shown) { ban in
                    let user = server?.users[ban.userId]
                    let name = user?.displayName ?? "Unknown"
                    let by = ban.bannedBy == server?.me?.userId ? "you" : server?.users[ban.bannedBy]?.displayName
                    Button {
                        if canUnban(ban) {
                            target = ban
                        } else {
                            model.toast("Only the server's owner can unban an admin.")
                        }
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(name: name, seed: ban.userId, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).foregroundStyle(Theme.text1)
                                Text("\(user.map { "@\($0.username) · " } ?? "")Banned \(by.map { "by \($0) " } ?? "")on \(Format.full(ban.bannedAt))")
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        if canUnban(ban) {
                            Button("Unban") { unban(ban) }.tint(Theme.green)
                        }
                    }
                    .accessibilityIdentifier(A11y.Settings.ban(user?.username ?? ban.userId))
                }
            } footer: {
                Text("Unbanned, people can sign in again, and they're back in their direct messages and channels. Groups have to add them again.")
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Bans")
        .navigationBarTitleDisplayMode(.inline)
        // Read again whenever someone is banned or unbanned, from here or anywhere else.
        .task(id: (server?.users.values.filter { $0.banned && !$0.deleted }.map(\.id) ?? []).sorted()) { await load() }
        .confirmationDialog(target.flatMap { server?.users[$0.userId]?.displayName } ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), presenting: target) { ban in
            Button("Unban") { unban(ban) }
        }
    }

    /// The owner can unban anyone, and admins only members, as with banning.
    private func canUnban(_ ban: BanView) -> Bool {
        let server = model.servers[serverId]
        guard let user = server?.users[ban.userId] else { return false }
        return server?.me?.role == .owner || user.role == .member
    }

    private func unban(_ ban: BanView) {
        Task {
            do {
                try await model.core.session(serverId).unbanUser(ban.userId)
                await load()
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }

    private func load() async {
        bans = (try? await model.core.session(serverId).getBans()) ?? []
    }
}

extension ReportReason {
    /// What the reason is called, as on the desktop.
    var label: String {
        switch self {
        case .spam: "Spam"
        case .harassment: "Harassment"
        case .inappropriate: "Inappropriate content"
        case .other: "Something else"
        }
    }
}

/// The server's 7TV emote set, with a preview, as on the desktop.
struct EmoteSetView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var busy = false

    var body: some View {
        let server = model.servers[serverId]
        List {
            if let server, !server.emotes.setId.isEmpty {
                Section {
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        use(server.emotes.setId) { "Updated \($0.setName) (\($0.count) emotes)" }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier(A11y.Settings.refreshEmotes)
                } footer: {
                    Text("Your server checks 7TV for changes to the set every few hours.")
                }
                .listRowBackground(Theme.bg2)
            }
            Section {
                TextField("https://7tv.app/emote-sets/…", text: $link)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier(A11y.Settings.emoteLink)
                Button("Use this set") {
                    use(link.trimmingCharacters(in: .whitespaces)) {
                        link = ""
                        return "Now using \($0.setName) (\($0.count) emotes)"
                    }
                }
                .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                .accessibilityIdentifier(A11y.Settings.useEmotes)
            } header: {
                Text("Use a different set")
            } footer: {
                Text("Everyone on this server shares one 7TV emote set. Your server downloads and caches the images, so 7TV never sees your members' addresses. Paste a link to any emote set on 7TV.")
            }
            .listRowBackground(Theme.bg2)
            if let server, !server.emotes.emotes.isEmpty {
                Section(server.emotes.setName) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 6) {
                        ForEach(server.emotes.emotes.prefix(80)) { emote in
                            EmoteView(name: emote.name, id: emote.id, size: .inline, serverUrl: server.entry.url)
                                .frame(width: 40, height: 40)
                                .accessibilityLabel(emote.name)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .listRowBackground(Theme.bg2)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Emotes")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Makes `set` the server's set, or fetches it again from 7TV if it already is.
    private func use(_ set: String, done: @escaping (EmoteSetChange) -> String) {
        busy = true
        Task {
            do {
                let result = try await model.core.session(serverId).setEmoteSet(set)
                model.toast(done(result))
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }
}

/// The upload limit and message retention, as on the desktop.
struct StorageView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var maxUpload = ""
    @State private var retention = ""

    var body: some View {
        let upload = Int(maxUpload) ?? 0, days = Int(retention) ?? -1
        List {
            Section {
                HStack {
                    TextField("100", text: $maxUpload).keyboardType(.numberPad).accessibilityIdentifier(A11y.Settings.maxUpload)
                    Text("MB").foregroundStyle(Theme.text2)
                }
            } header: {
                Text("Largest file members can send")
            }
            Section {
                HStack {
                    TextField("0", text: $retention).keyboardType(.numberPad).accessibilityIdentifier(A11y.Settings.retention)
                    Text("days").foregroundStyle(Theme.text2)
                }
            } header: {
                Text("Delete messages after")
            } footer: {
                Text("0 keeps messages forever. Pinned messages are kept. This is enforced by the server, so it only removes the server's copy.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Storage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        do {
                            try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(maxUploadMb: upload, retentionDays: days))
                            model.toast("Saved")
                        } catch {
                            model.toast(ErrorText.describe(error), .error)
                        }
                    }
                }
                .disabled(upload < 1 || days < 0)
                .accessibilityIdentifier(A11y.Settings.save)
            }
        }
        .onAppear {
            let info = model.servers[serverId]?.info
            maxUpload = String(info?.maxUploadMb ?? 100)
            retention = String(info?.retentionDays ?? 0)
        }
    }
}

/// What people on the server can share from their screens, for its admins, as the
/// desktop's ServerScreenSection: who, with sound, how many at once, the limits on
/// each share, and what a share uses until someone chooses.
struct ScreenRulesView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var rules = ScreenRules.defaults
    @State private var loaded = false
    @State private var busy = false

    // As the desktop offers them (packages/ui/src/voice/settings.ts).
    private static let heights = [2160, 1440, 1080, 720, 480, 360]
    private static let rates = [5, 10, 15, 24, 30, 45, 60, 75, 90, 120, 144, 165, 240]
    private static let soundBitrates = [64, 96, 128, 160, 192, 256, 320]

    private static func heightName(_ height: Int) -> String {
        height == 0 ? "The screen's own" : height == 2160 ? "4K (2160p)" : "\(height)p"
    }

    private static func rateName(_ fps: Int) -> String { "\(fps) fps" }

    var body: some View {
        let voice = (model.servers[serverId]?.info?.voice ?? 0) > 0
        Form {
            Section {
                Picker("Who can share", selection: $rules.who) {
                    Text("Everyone").tag("everyone")
                    Text("Admins").tag("admins")
                    Text("Nobody").tag("nobody")
                }
                .pickerStyle(.segmented)
                Toggle("Let sound go with a share", isOn: $rules.sound)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.screenSound)
                Stepper(value: $rules.maxPerChannel, in: 0...99) {
                    LabeledContent("Shares at once in a voice channel", value: Self.count(rules.maxPerChannel))
                }
                Stepper(value: $rules.maxPerServer, in: 0...1000) {
                    LabeledContent("Shares at once on this server", value: Self.count(rules.maxPerServer))
                }
            } header: {
                Text("Who and how many")
            } footer: {
                Text("Changing who can share, or turning sound off, stops any share it no longer allows. Each voice channel can allow fewer at once when you edit it. The media server enforces all of these, whichever app someone uses.")
            }
            Section {
                limit("Largest picture", $rules.maxHeight, Self.heights, name: Self.heightName)
                limit("Highest frame rate", $rules.maxFps, Self.rates, name: Self.rateName)
                limit("Most a share may send", $rules.maxKbps, VoiceSettingsView.bitrates, name: VoiceSettingsView.bitrateName)
                    .accessibilityIdentifier(A11y.Settings.screenMaxKbps)
                limit("Most a share's sound may send", $rules.maxSoundKbps, Self.soundBitrates, name: VoiceSettingsView.bitrateName)
                Toggle("Admins aren't held to the limits", isOn: $rules.adminsExempt)
                    .tint(model.settings.accent.switchTint)
            } header: {
                Text("Limits")
            } footer: {
                Text("What a share may send is what each person watching it costs your media server. Admins who aren't held to the limits can go past these and past how many can share at once, though sharing being off still goes for them. Zuna's apps keep to these, and a share already going keeps what it started with. The picture is encrypted, so the media server can't check it, and a modified app could send more.")
            }
            Section {
                suggestion("Size", $rules.defaultHeight, [0] + Self.heights, limit: rules.maxHeight, name: Self.heightName)
                suggestion("Frame rate", $rules.defaultFps, Self.rates, limit: rules.maxFps, name: Self.rateName)
                suggestion("Most it may send", $rules.defaultKbps, VoiceSettingsView.bitrates, limit: rules.maxKbps, name: VoiceSettingsView.bitrateName)
            } header: {
                Text("Suggested")
            } footer: {
                Text(voice
                    ? "What a share uses until someone chooses for themselves."
                    : "What a share uses until someone chooses for themselves. This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Screen sharing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button("Save", action: save)
                        .accessibilityIdentifier(A11y.Settings.save)
                }
            }
        }
        .onAppear {
            guard !loaded, let current = model.servers[serverId]?.info?.screenShare else { return }
            loaded = true
            rules = current
        }
    }

    private static func count(_ value: Int) -> String { value == 0 ? "No limit" : "\(value)" }

    /// The most a share may use, or no limit.
    private func limit(_ title: String, _ value: Binding<Int>, _ options: [Int], name: @escaping (Int) -> String) -> some View {
        Picker(title, selection: value) {
            Text("No limit").tag(0)
            ForEach(options.contains(value.wrappedValue) || value.wrappedValue == 0 ? options : options + [value.wrappedValue], id: \.self) { option in
                Text(name(option)).tag(option)
            }
        }
    }

    /// What a share uses until someone chooses, which can't be more than what's allowed.
    private func suggestion(_ title: String, _ value: Binding<Int>, _ options: [Int], limit: Int, name: @escaping (Int) -> String) -> some View {
        let allowed = options.filter { limit <= 0 || $0 <= limit }
        return Picker(title, selection: value) {
            ForEach(allowed.contains(value.wrappedValue) ? allowed : allowed + [value.wrappedValue], id: \.self) { option in
                Text(name(option)).tag(option)
            }
        }
    }

    /// What's suggested can't be more than what's allowed, as the desktop saves it.
    private var fitted: ScreenRules {
        var fitted = rules
        if rules.maxHeight > 0, rules.defaultHeight > rules.maxHeight { fitted.defaultHeight = rules.maxHeight }
        if rules.maxFps > 0 { fitted.defaultFps = min(rules.defaultFps, rules.maxFps) }
        if rules.maxKbps > 0 { fitted.defaultKbps = min(rules.defaultKbps, rules.maxKbps) }
        return fitted
    }

    private func save() {
        let changes = ServerSettingsChanges(screenShare: fitted)
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.core.session(serverId).updateServerSettings(changes)
                model.toast("Saved")
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }
}
