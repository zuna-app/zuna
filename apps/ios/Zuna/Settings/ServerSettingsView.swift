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
                        .accessibilityLabel(t("serverSettings.changePicture"))
                        TextField(t("serverSettings.overview.name"), text: $name)
                            .font(.headline)
                            .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                            .accessibilityIdentifier(A11y.Settings.serverName)
                    }
                    Button(t("serverSettings.saveName")) {
                        let value = name.trimmingCharacters(in: .whitespaces)
                        run {
                            try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(name: value))
                            model.toast(t("common.saved"))
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name == server.entry.name)
                    .accessibilityIdentifier(A11y.Settings.save)
                    LabeledContent(t("serverSettings.overview.address")) { Text(server.entry.address).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                    LabeledContent(t("serverSettings.overview.version")) { Text(server.info?.version ?? "").font(.system(.footnote, design: .monospaced)) }
                } header: {
                    Text(t("serverSettings.overview.title"))
                } footer: {
                    Text(t("serverSettings.overview.lead"))
                }

                Section {
                    Button(t("invites.title"), systemImage: "link") { inviting = true }
                    SavingToggle(t("serverSettings.invites.memberInvites"), value: server.info?.allowMemberInvites ?? false) { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(allowMemberInvites: value))
                    }
                    .accessibilityIdentifier(A11y.Settings.memberInvites)
                    SavingToggle(t("serverSettings.invites.openSignUps"), value: server.info?.registration == "open") { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(registration: value ? "open" : "invite"))
                    }
                    .accessibilityIdentifier(A11y.Settings.openSignUps)
                } header: {
                    Text(t("serverSettings.sections.invites"))
                } footer: {
                    Text(t("serverSettings.invitesHint"))
                }

                Section(t("serverSettings.sections.members")) {
                    NavigationLink(t("serverSettings.members.count", ["count": server.users.values.filter { !$0.deleted && !$0.banned }.count])) { ServerMembersView(serverId: serverId) }
                }
                Section(t("serverSettings.channels.title")) {
                    NavigationLink(t("serverSettings.channels.count", ["count": server.channels.count])) { ChannelsSettingsView(serverId: serverId) }
                }
                Section(t("serverSettings.sections.emotes")) {
                    NavigationLink { EmoteSetView(serverId: serverId) } label: {
                        LabeledContent(server.emotes.setName.isEmpty ? t("serverSettings.emotes.noSet") : server.emotes.setName, value: t("serverSettings.emotes.count", ["count": server.emotes.emotes.count]))
                    }
                    .accessibilityIdentifier(A11y.Settings.emotes)
                }
                Section(t("serverSettings.voice")) {
                    NavigationLink { SoundboardSettingsView(serverId: serverId) } label: {
                        LabeledContent(t("serverSettings.sections.soundboard"), value: t("serverSettings.sounds", ["count": server.sounds.count]))
                    }
                    .accessibilityIdentifier(A11y.Settings.soundboard)
                    // The rules come with what a member is told about the server.
                    if server.info?.screenShare != nil {
                        NavigationLink(t("serverSettings.sections.screen")) { ScreenRulesView(serverId: serverId) }
                            .accessibilityIdentifier(A11y.Settings.screenRules)
                    }
                }
                Section(t("serverSettings.sections.storage")) {
                    NavigationLink(t("serverSettings.storage.filesAndRetention")) { StorageView(serverId: serverId) }
                }
                Section(t("serverSettings.sections.bots")) {
                    NavigationLink(t("serverSettings.sections.bots")) { BotsSettingsView(serverId: serverId) }
                }
                // What admins answer for comes last, as on the desktop.
                Section {
                    NavigationLink(t("serverSettings.sections.reports")) { ReportsView(serverId: serverId) }
                        .accessibilityIdentifier(A11y.Settings.reports)
                    NavigationLink { BansView(serverId: serverId) } label: {
                        LabeledContent(t("serverSettings.sections.bans"), value: "\(server.users.values.filter { $0.banned && !$0.deleted }.count)")
                    }
                    .accessibilityIdentifier(A11y.Settings.bans)
                }
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(server?.entry.name ?? t("serverSettings.overview.title"))
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
                    model.toast(user.role == .owner ? t("serverSettings.members.ownerFixed") : t("serverSettings.members.onlyOwnerAdmins"))
                }
            } label: {
                HStack(spacing: 12) {
                    WithPresence(serverId: serverId, user: user) { online in
                        AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36, online: online)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            Text(user.displayName).foregroundStyle(Theme.text1)
                            if user.bot != nil { BotBadge() }
                        }
                        Text("@\(user.username)").font(.caption).foregroundStyle(Theme.text3)
                    }
                    Spacer()
                    if user.role != .member {
                        Label(user.role == .owner ? t("serverSettings.members.owner") : t("serverSettings.members.admin"), systemImage: "crown.fill").font(.caption).foregroundStyle(Theme.text2)
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
        .searchable(text: $query, prompt: t("serverSettings.members.search", ["count": members.count]))
        .navigationTitle(t("serverSettings.sections.members"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(target?.displayName ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), presenting: target) { user in
            // A bot is never one of the server's admins.
            if selfRole == .owner, user.bot == nil {
                Button(user.role == .admin ? t("serverSettings.members.removeAdmin") : t("serverSettings.members.makeAdmin")) {
                    run { try await model.core.session(serverId).setServerRole(user.id, role: user.role == .admin ? .member : .admin) }
                }
            }
            Button(t("serverSettings.ban.action"), role: .destructive) { banning = user }
        }
        .confirmationDialog(ServerMembersView.banWarning(banning), isPresented: Binding(get: { banning != nil }, set: { if !$0 { banning = nil } }), titleVisibility: .visible, presenting: banning) { user in
            Button(t("serverSettings.ban.action"), role: .destructive) { run { try await model.core.session(serverId).banUser(user.id) } }
        }
    }

    /// What banning someone does, asked before it's done.
    static func banWarning(_ user: UserView?) -> String {
        user.map { t("serverSettings.members.banConfirm", ["name": $0.displayName]) } ?? t("serverSettings.members.banConfirmUnnamed")
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
                    Text(t("serverSettings.reports.empty")).foregroundStyle(Theme.text2)
                }
                ForEach(reports ?? []) { report in
                    let user = server?.users[report.userId]
                    let name = user?.displayName ?? t("chat.unknown")
                    let canBan = user.map { !$0.banned && !$0.deleted && $0.role != .owner && (selfRole == .owner || $0.role == .member) } ?? false
                    HStack(spacing: 12) {
                        AvatarView(name: name, seed: report.userId, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name).foregroundStyle(Theme.text1)
                            Text(t("serverSettings.reports.summary", ["count": report.count, "reasons": report.reasons.map(\.label).joined(separator: ", ")]))
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .swipeActions {
                        Button(t("serverSettings.reports.dismiss")) { run { try await model.core.session(serverId).dismissReports(report.userId) } }
                        if canBan, let user {
                            Button(t("serverSettings.reports.ban"), role: .destructive) { banning = user }
                        }
                    }
                }
            } footer: {
                Text(t("serverSettings.reports.hint"))
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("serverSettings.sections.reports"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog(ServerMembersView.banWarning(banning), isPresented: Binding(get: { banning != nil }, set: { if !$0 { banning = nil } }), titleVisibility: .visible, presenting: banning) { user in
            Button(t("serverSettings.ban.action"), role: .destructive) { run { try await model.core.session(serverId).banUser(user.id) } }
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
                    Text(t("serverSettings.bans.empty")).foregroundStyle(Theme.text2)
                }
                ForEach(shown) { ban in
                    let user = server?.users[ban.userId]
                    let name = user?.displayName ?? t("chat.unknown")
                    let banned = bannedText(ban, server)
                    Button {
                        if canUnban(ban) {
                            target = ban
                        } else {
                            model.toast(t("serverSettings.bans.ownerOnly"))
                        }
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(name: name, seed: ban.userId, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).foregroundStyle(Theme.text1)
                                Text(user.map { "@\($0.username) · \(banned)" } ?? banned)
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
                            Button(t("serverSettings.bans.unban")) { unban(ban) }.tint(Theme.green)
                        }
                    }
                    .accessibilityIdentifier(A11y.Settings.ban(user?.username ?? ban.userId))
                }
            } footer: {
                Text(t("serverSettings.bans.hint"))
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("serverSettings.sections.bans"))
        .navigationBarTitleDisplayMode(.inline)
        // Read again whenever someone is banned or unbanned, from here or anywhere else.
        .task(id: (server?.users.values.filter { $0.banned && !$0.deleted }.map(\.id) ?? []).sorted()) { await load() }
        .confirmationDialog(target.flatMap { server?.users[$0.userId]?.displayName } ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), presenting: target) { ban in
            Button(t("serverSettings.bans.unban")) { unban(ban) }
        }
    }

    /// When someone was banned, and by whom, where that's known.
    private func bannedText(_ ban: BanView, _ server: AppModel.ServerState?) -> String {
        let date = Format.full(ban.bannedAt)
        if ban.bannedBy == server?.me?.userId { return t("serverSettings.bans.bannedByYou", ["date": date]) }
        if let by = server?.users[ban.bannedBy]?.displayName { return t("serverSettings.bans.bannedBy", ["name": by, "date": date]) }
        return t("serverSettings.bans.bannedOn", ["date": date])
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
        case .spam: t("serverSettings.reports.reasonSpam")
        case .harassment: t("serverSettings.reports.reasonHarassment")
        case .inappropriate: t("serverSettings.reports.reasonInappropriate")
        case .other: t("serverSettings.reports.reasonOther")
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
                    Button(t("serverSettings.emotes.refresh"), systemImage: "arrow.clockwise") {
                        use(server.emotes.setId) { t("serverSettings.emotes.updated", ["name": $0.setName, "count": $0.count]) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier(A11y.Settings.refreshEmotes)
                } footer: {
                    Text(t("serverSettings.emotes.refreshHint"))
                }
                .listRowBackground(Theme.bg2)
            }
            Section {
                TextField("https://7tv.app/emote-sets/…", text: $link)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier(A11y.Settings.emoteLink)
                Button(t("serverSettings.emotes.useSet")) {
                    use(link.trimmingCharacters(in: .whitespaces)) {
                        link = ""
                        return t("serverSettings.emotes.nowUsing", ["name": $0.setName, "count": $0.count])
                    }
                }
                .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                .accessibilityIdentifier(A11y.Settings.useEmotes)
            } header: {
                Text(t("serverSettings.emotes.useDifferent"))
            } footer: {
                Text(t("serverSettings.emotes.differentHint"))
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
        .navigationTitle(t("serverSettings.sections.emotes"))
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
                    Text(t("serverSettings.storage.megabytes")).foregroundStyle(Theme.text2)
                }
            } header: {
                Text(t("serverSettings.storage.maxUpload"))
            }
            Section {
                HStack {
                    TextField("0", text: $retention).keyboardType(.numberPad).accessibilityIdentifier(A11y.Settings.retention)
                    Text(t("serverSettings.storage.days")).foregroundStyle(Theme.text2)
                }
            } header: {
                Text(t("serverSettings.storage.retention"))
            } footer: {
                Text(t("serverSettings.storage.retentionHint"))
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("serverSettings.sections.storage"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(t("common.save")) {
                    Task {
                        do {
                            try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(maxUploadMb: upload, retentionDays: days))
                            model.toast(t("common.saved"))
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
/// desktop's ServerScreenSection: who, with audio, how many at once, and the quality limits.
struct ScreenRulesView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var rules = ScreenRules.defaults
    @State private var loaded = false
    @State private var busy = false

    // As the desktop offers them (packages/ui/src/voice/settings.ts).
    private static let heights = [2160, 1440, 1080, 720, 480]
    private static let rates = [15, 30, 60, 90, 120, 144, 165, 240]

    private static func rateName(_ fps: Int) -> String { t("serverSettings.screen.fps", ["fps": fps]) }

    var body: some View {
        let voice = (model.servers[serverId]?.info?.voice ?? 0) > 0
        Form {
            Section {
                Picker(t("serverSettings.screen.whoCanShare"), selection: $rules.who) {
                    Text(t("serverSettings.screen.everyone")).tag("everyone")
                    Text(t("serverSettings.screen.admins")).tag("admins")
                    Text(t("serverSettings.screen.nobody")).tag("nobody")
                }
                .pickerStyle(.segmented)
                Toggle(t("serverSettings.screen.allowAudio"), isOn: $rules.sound)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.screenSound)
                Stepper(value: $rules.maxPerChannel, in: 0...99) {
                    LabeledContent(t("serverSettings.screen.maxPerChannel"), value: Self.count(rules.maxPerChannel))
                }
                Stepper(value: $rules.maxPerServer, in: 0...1000) {
                    LabeledContent(t("serverSettings.screen.maxPerServer"), value: Self.count(rules.maxPerServer))
                }
            } header: {
                Text(t("serverSettings.screen.permissions"))
            } footer: {
                Text(t("serverSettings.screen.permissionsHint"))
            }
            Section {
                limit(t("serverSettings.screen.maxResolution"), $rules.maxHeight, Self.heights, name: VoiceSettingsView.heightName)
                limit(t("serverSettings.screen.maxFrameRate"), $rules.maxFps, Self.rates, name: Self.rateName)
                limit(t("serverSettings.screen.maxBitrate"), $rules.maxKbps, VoiceSettingsView.limitBitrates, name: VoiceSettingsView.bitrateName)
                    .accessibilityIdentifier(A11y.Settings.screenMaxKbps)
                Toggle(t("serverSettings.screen.adminsBypass"), isOn: $rules.adminsExempt)
                    .tint(model.settings.accent.switchTint)
            } header: {
                Text(t("serverSettings.screen.qualityLimits"))
            } footer: {
                Text(voice ? t("serverSettings.screen.qualityHint") : t("serverSettings.screen.qualityHintNoVoice"))
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("serverSettings.sections.screen"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button(t("common.save"), action: save)
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

    private static func count(_ value: Int) -> String { value == 0 ? t("serverSettings.screen.noLimit") : "\(value)" }

    /// The most a share may use, or no limit.
    private func limit(_ title: String, _ value: Binding<Int>, _ options: [Int], name: @escaping (Int) -> String) -> some View {
        Picker(title, selection: value) {
            Text(t("serverSettings.screen.noLimit")).tag(0)
            ForEach(options.contains(value.wrappedValue) || value.wrappedValue == 0 ? options : options + [value.wrappedValue], id: \.self) { option in
                Text(name(option)).tag(option)
            }
        }
    }

    private func save() {
        let changes = ServerSettingsChanges(screenShare: rules)
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.core.session(serverId).updateServerSettings(changes)
                model.toast(t("common.saved"))
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }
}
