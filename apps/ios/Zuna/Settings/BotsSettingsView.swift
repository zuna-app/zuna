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
                    Button("New bot", systemImage: "plus") { creating = true }
                        .disabled(full)
                } else {
                    Label("On this server, only admins can create bots.", systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
            } footer: {
                Text(full ? "You've reached this server's limit of bots per person." : "A bot is an account run by a program, on a computer its owner chooses. It can read everything said in its chats after it's added, and always shows a bot badge next to its name.")
            }
            .listRowBackground(Theme.bg2)
            Section {
                if bots == nil {
                    ProgressView()
                } else if (bots ?? []).isEmpty {
                    Text("No bots yet.").foregroundStyle(Theme.text2)
                }
                ForEach(bots ?? []) { bot in
                    let user = server?.users[bot.id]
                    let name = user?.displayName ?? bot.username
                    // Whose it is, for a bot that isn't this person's own.
                    let owner = bot.ownerId == selfId ? nil : server?.users[bot.ownerId]?.displayName
                    let whose = owner.map { " · \($0)'s" } ?? ""
                    NavigationLink {
                        BotDetailView(serverId: serverId, botId: bot.id)
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(name: name, seed: bot.id, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).foregroundStyle(Theme.text1)
                                Text("@\(bot.username)\(whose)")
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                            Text(!bot.setUp ? "Waiting to be set up" : bot.listed ? "Listed" : "Private")
                                .font(.caption)
                                .foregroundStyle(Theme.text2)
                        }
                    }
                }
            }
            .listRowBackground(Theme.bg2)
            if isAdmin {
                Section {
                    SavingToggle("Let members create private bots", value: server?.info?.allowMemberBots ?? false) { value in
                        try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(allowMemberBots: value))
                    }
                    Picker("Bots per person", selection: Binding(get: { most }, set: { value in
                        run { try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(maxBots: value)) }
                    })) {
                        ForEach(Self.limits.contains(most) ? Self.limits : (Self.limits + [most]).sorted(), id: \.self) { value in
                            Text("\(value)").tag(value)
                        }
                    }
                } footer: {
                    Text("If off, only admins can create bots. Listed bots can only ever be created by admins.")
                }
                .listRowBackground(Theme.bg2)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Bots")
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
            Button("Copy the command", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = command
                model.toast("Command copied")
            }
            Button("Done") { done() }
        } header: {
            Text("Set it up")
        } footer: {
            Text("Set up the bot on the computer that will run it within the next hour, then start it with zuna-bot run. Its keys are created there, so not even you have them. This link works once and won't be shown again. Whoever controls the computer running a bot can read its chats.")
        }
        .listRowBackground(Theme.bg2)
    }
}

/// Who can add a bot to groups, among the three.
struct BotAddPicker: View {
    @Binding var add: BotAdd

    var body: some View {
        Picker("Who can add it to groups", selection: $add) {
            Text("Only its owner").tag(BotAdd.owner)
            Text("Its owner and the server's admins").tag(BotAdd.admins)
            Text("Anyone on the server").tag(BotAdd.anyone)
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
                    TextField("Name", text: $name)
                        .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: username) { if username.count > 32 { username = String(username.prefix(32)) } }
                } footer: {
                    if !username.isEmpty, !Self.usernameOK(username) {
                        Text("2 to 32 letters, numbers, dots, dashes and underscores.").foregroundStyle(Theme.red)
                    }
                }
                .listRowBackground(Theme.bg2)
                Section {
                    if canList {
                        Toggle("List it for everyone", isOn: $listed)
                            .tint(model.settings.accent.switchTint)
                    }
                    if listed {
                        BotAddPicker(add: $add)
                    }
                    Toggle("Let it send files", isOn: $files)
                        .tint(model.settings.accent.switchTint)
                } footer: {
                    Text(canList ? "If it isn't listed, the bot is private: only you and people in chats with it can see it. Other admins can't." : "It's private: only you and people in chats with it can see it.")
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Make") { create() }
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
    private static let sent = "Sent to the bot. It'll update the next time it's running"

    var body: some View {
        let server = model.servers[serverId]
        let user = server?.users[botId]
        let isAdmin = server?.isAdmin ?? false
        let title = user?.displayName ?? bot?.username ?? "this bot"
        let warning = bot?.setUp == true ? "It'll be signed out and removed from all its chats. Messages it sent will stay. This can't be undone." : "Its setup link will stop working."
        List {
            if let command = link {
                BotSetupCommand(link: command) { link = nil }
            }
            if let bot {
                let own = bot.ownerId == server?.me?.userId
                if !bot.setUp {
                    Section {
                        Button("New setup link", systemImage: "arrow.clockwise") {
                            run { link = try await model.core.session(serverId).newBotLink(bot.id) }
                        }
                        .disabled(!own)
                    } footer: {
                        Text("The bot hasn't been set up yet. If the link expired or got lost, make a new one. The old link will stop working.")
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
                    Button("Delete bot", role: .destructive) { confirmingDelete = true }
                }
                .listRowBackground(Theme.bg2)
            } else {
                ProgressView()
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(user?.displayName ?? bot?.username ?? "Bot")
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
                model.toast(Self.sent)
            }
        }
        .confirmationDialog("Delete \(title)? \(warning)", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete bot", role: .destructive) {
                run {
                    try await model.core.session(serverId).deleteBot(botId)
                    dismiss()
                }
            }
        }
    }

    private func profile(_ bot: BotView, _ user: UserView?) -> some View {
        Section {
            HStack(spacing: 14) {
                // Made here, as the picker's label isn't on the main actor.
                let face = AvatarView(name: user?.displayName ?? bot.username, seed: bot.id, source: user?.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 56)
                PhotosPicker(selection: $picture, matching: .images) { face }
                    .accessibilityLabel("Change the bot's picture")
                VStack(spacing: 8) {
                    TextField("Name", text: $name)
                        .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                    TextField("What it does", text: $about, axis: .vertical)
                        .lineLimit(1...4)
                        .onChange(of: about) { if about.count > 300 { about = String(about.prefix(300)) } }
                }
            }
            Button("Save") {
                let changes = ProfileChanges(displayName: name.trimmingCharacters(in: .whitespaces), bio: about.trimmingCharacters(in: .whitespaces))
                run {
                    try await model.core.session(serverId).updateBotProfile(bot.id, changes)
                    model.toast(Self.sent)
                }
            }
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || (name == user?.displayName && about == user?.bio))
            Button("Message", systemImage: "bubble.left") { model.openChat("user:\(bot.id)") }
        } footer: {
            Text("A bot sets its own profile, so this sends it a request in your chat with it. It'll update the next time it's running.")
        }
        .listRowBackground(Theme.bg2)
    }

    private func rules(_ bot: BotView, isAdmin: Bool) -> some View {
        // Only a server's admins list a bot. Anyone may take their own off the list.
        let mayList = isAdmin || bot.listed
        return Section {
            if mayList {
                SavingToggle("List it for everyone", value: bot.listed) { value in
                    try await change(BotChanges(listed: value))
                }
            }
            if bot.listed {
                BotAddPicker(add: Binding(get: { bot.add }, set: { value in run { try await change(BotChanges(add: value)) } }))
            }
            SavingToggle("Let it send files", value: bot.files) { value in
                try await change(BotChanges(files: value))
            }
        } footer: {
            Text(mayList ? "If it isn't listed, the bot is private: only you and people in chats with it can see it. It will leave its channels." : "It's private: only you and people in chats with it can see it. Only the server's admins can list a bot.")
        }
        .listRowBackground(Theme.bg2)
    }

    @ViewBuilder
    private func channels(_ bot: BotView, _ server: AppModel.ServerState?) -> some View {
        let text = (server?.channels ?? []).filter { $0.type == .text && !$0.unreadable }
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
                Text("Channels")
            } footer: {
                Text("It joins the channels you pick and reads what's said there from then on.")
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
