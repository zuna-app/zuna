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

    var body: some View {
        let server = model.servers[serverId]
        List {
            if let server {
                Section {
                    HStack(spacing: 14) {
                        PhotosPicker(selection: $icon, matching: .images) {
                            AvatarView(name: server.entry.name, seed: server.entry.url, source: .serverIcon(server.entry), size: 64, rounded: true)
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
                    LabeledContent("Address") { Text(server.entry.url).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                    LabeledContent("Version") { Text(server.info?.version ?? "").font(.system(.footnote, design: .monospaced)) }
                } header: {
                    Text("Server")
                } footer: {
                    Text("The name and picture are public: they appear on invite pages before anyone signs in.")
                }

                Section {
                    Button("Invite people", systemImage: "link") { inviting = true }
                    Toggle("Let members create invite links", isOn: Binding(get: { server.info?.allowMemberInvites ?? false }, set: { value in
                        run { try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(allowMemberInvites: value)) }
                    }))
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.memberInvites)
                    Toggle("Open sign-ups", isOn: Binding(get: { server.info?.registration == "open" }, set: { value in
                        run { try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(registration: value ? "open" : "invite")) }
                    }))
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.openSignUps)
                } header: {
                    Text("Invites")
                } footer: {
                    Text("Invite links are the safest way for people to join. Open sign-ups let anyone who knows the address join, and give the server the key that protects profiles, so it can read display names and pictures. Messages stay encrypted.")
                }

                Section("Members") {
                    NavigationLink("\(server.users.count) members") { ServerMembersView(serverId: serverId) }
                }
                if (server.info?.channels ?? 0) > 0 {
                    Section("Channels") {
                        NavigationLink(server.channels.count == 1 ? "1 channel" : "\(server.channels.count) channels") { ChannelsSettingsView(serverId: serverId) }
                    }
                }
                // Only a server that has rules for sharing says what they are.
                if server.info?.screenShare != nil {
                    Section("Voice") {
                        NavigationLink("Screen sharing") { ScreenRulesView(serverId: serverId) }
                            .accessibilityIdentifier(A11y.Settings.screenRules)
                    }
                }
                Section("Emotes") {
                    NavigationLink { EmoteSetView(serverId: serverId) } label: {
                        LabeledContent(server.emotes.setName.isEmpty ? "No emote set" : server.emotes.setName, value: "\(server.emotes.emotes.count) emotes")
                    }
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
            run {
                guard let media = try await item.loadTransferable(type: PickedMedia.self) else { return }
                try await model.core.session(serverId).updateServerIcon(try OutgoingFiles.avatar(from: media.url))
                images.forgetServerIcon(server.entry)
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(OnboardingText.describe(error), .error) }
        }
    }
}

/// Everyone on the server, with roles, and banning for admins, as on the desktop.
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
        let users = (server?.users.values.map { $0 } ?? [])
            .filter { needle.isEmpty || $0.displayName.lowercased().contains(needle) || $0.username.lowercased().contains(needle) }
            .sorted { ($0.banned ? 1 : 0, $0.displayName.lowercased()) < ($1.banned ? 1 : 0, $1.displayName.lowercased()) }
        List(users) { user in
            Button {
                // The owner manages admins; admins manage members. Nobody acts on the owner or themselves.
                let canAct = user.id != server?.me?.userId && user.role != .owner && (selfRole == .owner || user.role == .member)
                if canAct { target = user }
            } label: {
                HStack(spacing: 12) {
                    AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36, online: user.online)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(user.displayName).foregroundStyle(Theme.text1)
                        Text("@\(user.username)").font(.caption).foregroundStyle(Theme.text3)
                    }
                    Spacer()
                    if user.banned {
                        Text("Banned").font(.caption.weight(.semibold)).foregroundStyle(Theme.red)
                    }
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
        .searchable(text: $query, prompt: "Search \(server?.users.count ?? 0) members")
        .navigationTitle("Members")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(target?.displayName ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), presenting: target) { user in
            if selfRole == .owner {
                Button(user.role == .admin ? "Remove admin" : "Make admin") {
                    run { try await model.core.session(serverId).setServerRole(user.id, role: user.role == .admin ? .member : .admin) }
                }
            }
            if user.banned {
                Button("Unban") { run { try await model.core.session(serverId).unbanUser(user.id) } }
            } else {
                Button("Ban from server", role: .destructive) { banning = user }
            }
        }
        .confirmationDialog("Ban \(banning?.displayName ?? "them")? They're signed out everywhere and removed from every group.", isPresented: Binding(get: { banning != nil }, set: { if !$0 { banning = nil } }), titleVisibility: .visible, presenting: banning) { user in
            Button("Ban from server", role: .destructive) { run { try await model.core.session(serverId).banUser(user.id) } }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(OnboardingText.describe(error), .error) }
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
            Section {
                TextField("https://7tv.app/emote-sets/…", text: $link)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier(A11y.Settings.emoteLink)
                Button("Use this set") {
                    let value = link.trimmingCharacters(in: .whitespaces)
                    busy = true
                    Task {
                        do {
                            let result = try await model.core.session(serverId).setEmoteSet(value)
                            link = ""
                            model.toast("Now using \(result.setName) (\(result.count) emotes)")
                        } catch {
                            model.toast(OnboardingText.describe(error), .error)
                        }
                        busy = false
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
                            model.toast(OnboardingText.describe(error), .error)
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
                model.toast(OnboardingText.describe(error), .error)
            }
        }
    }
}
