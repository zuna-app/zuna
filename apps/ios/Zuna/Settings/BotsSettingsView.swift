import PhotosUI
import SwiftUI
import ZunaModels

/// A server's bots, in its settings: making one, the link its program is set up with, what it
/// may do, the channels it's given, and taking it away (the web's `BotsSection`). A bot is its
/// owner's, and a listed one is also the server's admins' to give channels to or delete.
struct BotsSettingsView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    /// The bots this person may manage, or nil while they're read.
    @State private var bots: [BotView]?
    @State private var creating = false
    /// A setup link just made, which is shown this once.
    @State private var link: String?

    /// How many bots one person may have, for an admin to pick from.
    private static let limits = [1, 3, 5, 10, 25]

    /// Whether Bots is there for someone: for admins, for members where the server lets them make
    /// bots, and for whoever has one.
    static func shows(_ server: AppModel.ServerState) -> Bool {
        if server.isAdmin || server.info?.allowMemberBots == true { return true }
        guard let selfId = server.me?.userId else { return false }
        return server.users.values.contains { !$0.deleted && $0.bot?.ownerId == selfId }
    }

    var body: some View {
        let server = model.servers[serverId]
        let selfId = server?.me?.userId
        let isAdmin = server?.isAdmin ?? false
        let mayMake = isAdmin || server?.info?.allowMemberBots == true
        let most = server?.info?.maxBots ?? 5
        let mine = (bots ?? []).filter { $0.ownerId == selfId }.count
        let full = mayMake && mine >= most
        List {
            if let command = link {
                BotSetupCommand(link: command) { link = nil }
            }
            Section {
                if mayMake {
                    Button(t("serverSettings.bots.new"), systemImage: "plus") { creating = true }
                        .disabled(full)
                } else {
                    Label(t("serverSettings.bots.onlyAdmins"), systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
            } footer: {
                Text(full ? t("serverSettings.bots.limitReached") : t("serverSettings.bots.about"))
            }
            .listRowBackground(Theme.bg2)
            Section {
                if bots == nil {
                    ProgressView()
                } else if (bots ?? []).isEmpty {
                    Text(t("serverSettings.bots.empty")).foregroundStyle(Theme.text2)
                }
                ForEach(bots ?? []) { bot in
                    let user = server?.users[bot.id]
                    let name = user?.displayName ?? bot.username
                    // Whose it is, for a bot that isn't this person's own.
                    let owner = bot.ownerId == selfId ? nil : server?.users[bot.ownerId]?.displayName
                    let handle = "@\(bot.username)"
                    NavigationLink {
                        BotDetailView(serverId: serverId, botId: bot.id)
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(name: name, seed: bot.id, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).foregroundStyle(Theme.text1)
                                Text(owner.map { t("serverSettings.bots.usernameAndOwner", ["username": handle, "owner": $0]) } ?? handle)
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                            Text(!bot.setUp ? t("serverSettings.bots.waitingSetup") : bot.listed ? t("serverSettings.bots.listed") : t("serverSettings.bots.private"))
                                .font(.caption)
                                .foregroundStyle(Theme.text2)
                        }
                    }
                }
            }
            .listRowBackground(Theme.bg2)
            if isAdmin {
                Section {
                    SavingToggle(t("serverSettings.bots.letMembersCreate"), value: server?.info?.allowMemberBots ?? false) { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(allowMemberBots: value))
                    }
                    Picker(t("serverSettings.bots.perPerson"), selection: Binding(get: { most }, set: { value in
                        run { try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(maxBots: value)) }
                    })) {
                        ForEach(Self.limits.contains(most) ? Self.limits : (Self.limits + [most]).sorted(), id: \.self) { value in
                            Text("\(value)").tag(value)
                        }
                    }
                } footer: {
                    Text(t("serverSettings.bots.letMembersCreateHint"))
                }
                .listRowBackground(Theme.bg2)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("serverSettings.sections.bots"))
        .navigationBarTitleDisplayMode(.inline)
        // Read again whenever a bot is set up, changed or gone, from here or anywhere else.
        .task(id: known(server)) { await load() }
        .sheet(isPresented: $creating) {
            NewBotSheet(serverId: serverId, canList: isAdmin) { made in
                link = made
                Task { await load() }
            }
        }
    }

    /// What the server's people say of its bots, which reading them again follows.
    private func known(_ server: AppModel.ServerState?) -> [String] {
        var rows: [String] = []
        for user in server?.users.values.map({ $0 }) ?? [] {
            if let bot = user.bot { rows.append("\(user.id):\(user.deleted):\(bot.listed):\(bot.add.rawValue)") }
        }
        return rows.sorted()
    }

    private func load() async {
        bots = (try? await model.core.session(serverId).getBots()) ?? []
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// The link a bot's program is set up with, shown once, as the command to run with it.
struct BotSetupCommand: View {
    @Environment(AppModel.self) private var model
    let link: String
    let done: () -> Void

    var body: some View {
        let command = "zuna-bot init \"\(link)\""
        Section {
            Text(command)
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(3)
                .textSelection(.enabled)
            Button(t("serverSettings.bots.copyCommand"), systemImage: "doc.on.doc") {
                UIPasteboard.general.string = command
                model.toast(t("serverSettings.bots.commandCopied"))
            }
            Button(t("common.done")) { done() }
        } header: {
            Text(t("serverSettings.bots.setUp"))
        } footer: {
            Text(t("serverSettings.bots.setUpHint"))
        }
        .listRowBackground(Theme.bg2)
    }
}

/// Who can add a bot to groups, among the three.
struct BotAddPicker: View {
    @Binding var add: BotAdd

    var body: some View {
        Picker(t("serverSettings.bots.whoCanAdd"), selection: $add) {
            Text(t("serverSettings.bots.addOwner")).tag(BotAdd.owner)
            Text(t("serverSettings.bots.addAdmins")).tag(BotAdd.admins)
            Text(t("serverSettings.bots.addAnyone")).tag(BotAdd.anyone)
        }
    }
}

/// A new bot: its name and username, whether everyone sees it, who may add it, and whether it
/// may send files.
struct NewBotSheet: View {
    let serverId: String
    /// Only a server's admins make listed bots.
    let canList: Bool
    /// Hands back the link the bot's program is set up with.
    let made: (String) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var username = ""
    @State private var listed = false
    @State private var add = BotAdd.owner
    @State private var files = true
    @State private var busy = false

    /// Whether a bot may have this username, as the server checks it.
    static func usernameOK(_ name: String) -> Bool {
        guard (2...32).contains(name.count), let first = name.unicodeScalars.first else { return false }
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
        let rest = plain.union(CharacterSet(charactersIn: ".-"))
        return plain.contains(first) && name.unicodeScalars.allSatisfy { rest.contains($0) }
    }

    var body: some View {
        let valid = !name.trimmingCharacters(in: .whitespaces).isEmpty && Self.usernameOK(username)
        NavigationStack {
            List {
                Section {
                    TextField(t("common.name"), text: $name)
                        .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                    TextField(t("common.username"), text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: username) { if username.count > 32 { username = String(username.prefix(32)) } }
                } footer: {
                    if !username.isEmpty, !Self.usernameOK(username) {
                        Text(t("serverSettings.bots.usernameRule")).foregroundStyle(Theme.red)
                    }
                }
                .listRowBackground(Theme.bg2)
                Section {
                    if canList {
                        Toggle(t("serverSettings.bots.listForEveryone"), isOn: $listed)
                            .tint(model.settings.accent.switchTint)
                    }
                    if listed {
                        BotAddPicker(add: $add)
                    }
                    Toggle(t("serverSettings.bots.letSendFiles"), isOn: $files)
                        .tint(model.settings.accent.switchTint)
                } footer: {
                    Text(canList ? t("serverSettings.bots.newListHint") : t("serverSettings.bots.newPrivateHint"))
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle(t("serverSettings.bots.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(t("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(t("serverSettings.bots.make")) { create() }
                            .disabled(!valid)
                    }
                }
            }
        }
    }

    private func create() {
        busy = true
        // Who may add it is only a listed bot's to say. A private one is its owner's alone.
        let bot = NewBot(username: username, name: name.trimmingCharacters(in: .whitespaces), listed: listed, add: listed ? add : .owner, files: files)
        Task {
            do {
                let created = try await model.core.session(serverId).createBot(bot)
                made(created.link)
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
                busy = false
            }
        }
    }
}

/// One bot's settings: its name, description and picture, which the bot sets when its owner
/// asks, who sees it and may add it, its channels for a server admin, and deleting it.
struct BotDetailView: View {
    let serverId: String
    let botId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var bot: BotView?
    @State private var name = ""
    @State private var about = ""
    @State private var loaded = false
    @State private var picture: PhotosPickerItem?
    /// A new setup link, which is shown this once.
    @State private var link: String?
    @State private var confirmingDelete = false

    /// What an owner is told once a change to a bot's profile is on its way.
    private static let sent = mark("serverSettings.bots.sentToBot")

    var body: some View {
        let server = model.servers[serverId]
        let user = server?.users[botId]
        let isAdmin = server?.isAdmin ?? false
        let warning = Self.deleteWarning(user?.displayName ?? bot?.username, setUp: bot?.setUp == true)
        List {
            if let command = link {
                BotSetupCommand(link: command) { link = nil }
            }
            if let bot {
                let own = bot.ownerId == server?.me?.userId
                if !bot.setUp {
                    Section {
                        Button(t("serverSettings.bots.newSetupLink"), systemImage: "arrow.clockwise") {
                            run { link = try await model.core.session(serverId).newBotLink(bot.id) }
                        }
                        .disabled(!own)
                    } footer: {
                        Text(t("serverSettings.bots.notSetUpHint"))
                    }
                    .listRowBackground(Theme.bg2)
                } else if own {
                    profile(bot, user)
                    rules(bot, isAdmin: isAdmin)
                }
                // A listed bot joins the channels a server admin gives it, and no others.
                if bot.setUp, bot.listed, isAdmin {
                    channels(bot, server)
                }
                Section {
                    Button(t("serverSettings.bots.delete"), role: .destructive) { confirmingDelete = true }
                }
                .listRowBackground(Theme.bg2)
            } else {
                ProgressView()
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(user?.displayName ?? bot?.username ?? t("serverSettings.bots.bot"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: user) { _, user in
            // What the bot set, once it has, unless something else is being typed.
            guard let user, !loaded else { return }
            loaded = true
            name = user.displayName
            about = user.bio
        }
        .onChange(of: picture) { _, item in
            guard let item else { return }
            picture = nil
            run {
                guard let media = try await item.loadTransferable(type: PickedMedia.self) else { return }
                let url = media.url
                let file = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.avatar(from: url) }.value
                try await model.core.session(serverId).updateBotProfile(botId, ProfileChanges(), avatar: .set(file))
                model.toast(t(Self.sent))
            }
        }
        .confirmationDialog(warning, isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(t("serverSettings.bots.delete"), role: .destructive) {
                run {
                    try await model.core.session(serverId).deleteBot(botId)
                    dismiss()
                }
            }
        }
    }

    /// What deleting a bot does, asked before it's done: one that's set up leaves its chats, and one
    /// that isn't only loses its setup link.
    private static func deleteWarning(_ name: String?, setUp: Bool) -> String {
        if let name {
            return setUp ? t("serverSettings.bots.deleteConfirm", ["bot": name]) : t("serverSettings.bots.deleteConfirmNotSetUp", ["bot": name])
        }
        return setUp ? t("serverSettings.bots.deleteThisConfirm") : t("serverSettings.bots.deleteThisConfirmNotSetUp")
    }

    private func profile(_ bot: BotView, _ user: UserView?) -> some View {
        Section {
            HStack(spacing: 14) {
                // Made here, as the picker's label isn't on the main actor.
                let face = AvatarView(name: user?.displayName ?? bot.username, seed: bot.id, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 56)
                PhotosPicker(selection: $picture, matching: .images) { face }
                    .accessibilityLabel(t("serverSettings.bots.changePicture"))
                VStack(spacing: 8) {
                    TextField(t("common.name"), text: $name)
                        .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                    TextField(t("serverSettings.bots.whatItDoes"), text: $about, axis: .vertical)
                        .lineLimit(1...4)
                        .onChange(of: about) { if about.count > 300 { about = String(about.prefix(300)) } }
                }
            }
            Button(t("common.save")) {
                let changes = ProfileChanges(displayName: name.trimmingCharacters(in: .whitespaces), bio: about.trimmingCharacters(in: .whitespaces))
                run {
                    try await model.core.session(serverId).updateBotProfile(bot.id, changes)
                    model.toast(t(Self.sent))
                }
            }
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || (name == user?.displayName && about == user?.bio))
            Button(t("serverSettings.bots.message"), systemImage: "bubble.left") { model.openChat("user:\(bot.id)") }
        } footer: {
            Text(t("serverSettings.bots.profileHint"))
        }
        .listRowBackground(Theme.bg2)
    }

    private func rules(_ bot: BotView, isAdmin: Bool) -> some View {
        // Only a server's admins list a bot. Anyone may take their own off the list.
        let mayList = isAdmin || bot.listed
        return Section {
            if mayList {
                SavingToggle(t("serverSettings.bots.listForEveryone"), value: bot.listed) { value in
                    try await change(BotChanges(listed: value))
                }
            }
            if bot.listed {
                BotAddPicker(add: Binding(get: { bot.add }, set: { value in run { try await change(BotChanges(add: value)) } }))
            }
            SavingToggle(t("serverSettings.bots.letSendFiles"), value: bot.files) { value in
                try await change(BotChanges(files: value))
            }
        } footer: {
            Text(mayList ? t("serverSettings.bots.listHint") : t("serverSettings.bots.privateHint"))
        }
        .listRowBackground(Theme.bg2)
    }

    @ViewBuilder
    private func channels(_ bot: BotView, _ server: AppModel.ServerState?) -> some View {
        // A bot is never one of the server's admins, so admin-only channels aren't for it.
        let text = (server?.channels ?? []).filter { $0.type == .text && !$0.unreadable && !$0.adminOnly }
        if !text.isEmpty {
            Section {
                ForEach(text) { channel in
                    let given = bot.channels.contains(channel.id)
                    Button {
                        let next = given ? bot.channels.filter { $0 != channel.id } : bot.channels + [channel.id]
                        run {
                            try await model.core.session(serverId).setBotChannels(bot.id, channelIds: next)
                            await load()
                        }
                    } label: {
                        HStack {
                            Text("# \(channel.name)").foregroundStyle(Theme.text1)
                            Spacer()
                            Image(systemName: given ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(given ? Theme.green : Theme.text3)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text(t("serverSettings.channels.title"))
            } footer: {
                Text(t("serverSettings.bots.channelsHint"))
            }
            .listRowBackground(Theme.bg2)
        }
    }

    /// Changes what the bot may do, and reads it again.
    private func change(_ changes: BotChanges) async throws {
        try await model.core.session(serverId).updateBot(botId, changes)
        await load()
    }

    private func load() async {
        let all = (try? await model.core.session(serverId).getBots()) ?? []
        bot = all.first { $0.id == botId }
        if !loaded, let user = model.servers[serverId]?.users[botId] {
            loaded = true
            name = user.displayName
            about = user.bio
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}
