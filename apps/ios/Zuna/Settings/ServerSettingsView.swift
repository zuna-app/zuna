import PhotosUI
import SwiftUI
import ZunaModels

/// The server, for its owner and admins, with the desktop's sections:
/// overview, invites, members, emotes and storage.
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
