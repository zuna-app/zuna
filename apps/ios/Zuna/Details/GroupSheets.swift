import SwiftUI
import ZunaModels

/// People to choose, with search, as the desktop's picker for groups.
struct PeoplePicker: View {
    let users: [UserView]
    let serverId: String
    @Binding var selected: Set<String>
    @State private var query = ""

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = users.filter { needle.isEmpty || $0.displayName.lowercased().contains(needle) || $0.username.lowercased().contains(needle) }
        Section {
            TextField("Search people", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier(A11y.Groups.search)
            if shown.isEmpty {
                Text("Nobody matches that search.").foregroundStyle(Theme.text2)
            }
            ForEach(shown) { user in
                Button {
                    if selected.contains(user.id) { selected.remove(user.id) } else { selected.insert(user.id) }
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
                        Image(systemName: selected.contains(user.id) ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selected.contains(user.id) ? Theme.green : Theme.text3)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected.contains(user.id) ? .isSelected : [])
                .accessibilityIdentifier(A11y.Groups.person(user.username))
            }
        }
        .listRowBackground(Theme.bg2)
    }
}

/// A new group: its name, people, and whether newcomers see history.
struct NewGroupSheet: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var selected: Set<String> = []
    @State private var history = false
    @State private var busy = false
    /// Asking what adding the bots picked means, before the group is made.
    @State private var asking = false

    var body: some View {
        let server = model.servers[serverId]
        let users = (server?.users.values.map { $0 } ?? [])
            .filter { $0.id != server?.me?.userId && !$0.banned && !$0.deleted }
            // Of the bots, only the ones this person may add.
            .filter { user in server.map { Bots.mayAdd(user, in: $0) } ?? false }
            .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        let bots = users.filter { $0.bot != nil && selected.contains($0.id) }
        let question = Bots.question(bots)
        NavigationStack {
            List {
                Section("Group name") {
                    TextField("Weekend trip", text: $name)
                        .onChange(of: name) { if name.count > 80 { name = String(name.prefix(80)) } }
                        .accessibilityIdentifier(A11y.Groups.name)
                }
                .listRowBackground(Theme.bg2)
                PeoplePicker(users: users, serverId: serverId, selected: $selected)
                Section {
                    Toggle(isOn: $history) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("New members can read earlier messages")
                            Text("If off, people only see what's sent after they join.").font(.caption).foregroundStyle(Theme.text3)
                        }
                    }
                    .tint(model.settings.accent.switchTint)
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        // A bot among them is asked about first, each time.
                        Button(selected.isEmpty ? "Create" : "Create with \(selected.count + 1) people") { if bots.isEmpty { create() } else { asking = true } }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier(A11y.Groups.create)
                    }
                }
            }
        }
        .confirmationDialog(question.title, isPresented: $asking, titleVisibility: .visible) {
            Button(question.action) { create() }
        } message: {
            Text(Bots.reads)
        }
    }

    private func create() {
        busy = true
        Task {
            do {
                let groupId = try await model.core.session(serverId).createGroup(name.trimmingCharacters(in: .whitespaces), memberIds: Array(selected), historyVisible: history)
                dismiss()
                model.openChat("group:\(groupId)")
            } catch {
                model.toast(ErrorText.describe(error), .error)
                busy = false
            }
        }
    }
}

/// More people for a group; they see its history when the group shares it.
struct AddMembersSheet: View {
    let serverId: String
    let conversation: ConversationView

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var busy = false
    /// Asking what adding the bots picked means, before they're added.
    @State private var asking = false

    var body: some View {
        let server = model.servers[serverId]
        let memberIds = Set(conversation.members.map(\.userId))
        let users = (server?.users.values.map { $0 } ?? [])
            .filter { !memberIds.contains($0.id) && !$0.banned && !$0.deleted }
            // Of the bots, only the ones this person may add.
            .filter { user in server.map { Bots.mayAdd(user, in: $0) } ?? false }
            .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        let bots = users.filter { $0.bot != nil && selected.contains($0.id) }
        let question = Bots.question(bots)
        NavigationStack {
            List {
                if conversation.historyVisible {
                    Section {
                        Label("This group shares its history, so they'll be able to read earlier messages.", systemImage: "person.2")
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                    }
                    .listRowBackground(Theme.bg2)
                }
                if users.isEmpty {
                    Text("Everyone on this server is already here.").foregroundStyle(Theme.text2).listRowBackground(Color.clear)
                } else {
                    PeoplePicker(users: users, serverId: serverId, selected: $selected)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("Add people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        // A bot among them is asked about first, each time.
                        Button("Add") { if bots.isEmpty { add() } else { asking = true } }
                            .disabled(selected.isEmpty)
                            .accessibilityIdentifier(A11y.Groups.add)
                    }
                }
            }
        }
        .confirmationDialog(question.title, isPresented: $asking, titleVisibility: .visible) {
            Button(question.action) { add() }
        } message: {
            Text(Bots.reads)
        }
    }

    private func add() {
        guard let groupId = conversation.groupId else { return }
        busy = true
        Task {
            do {
                try await model.core.session(serverId).addMembers(groupId, userIds: Array(selected))
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
                busy = false
            }
        }
    }
}

/// A group's name and description, for its admins.
struct EditGroupSheet: View {
    let serverId: String
    let conversation: ConversationView

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section("Name") {
                    TextField("Name", text: $name)
                        .onChange(of: name) { if name.count > 80 { name = String(name.prefix(80)) } }
                        .accessibilityIdentifier(A11y.Groups.name)
                }
                Section("Description") {
                    TextField("Description", text: $description, axis: .vertical)
                        .lineLimit(2...6)
                        .onChange(of: description) { if description.count > 300 { description = String(description.prefix(300)) } }
                        .accessibilityIdentifier(A11y.Groups.description)
                }
            }
            .listRowBackground(Theme.bg2)
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("Edit group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(name.trimmingCharacters(in: .whitespaces) == conversation.title && description == conversation.description)
                            .accessibilityIdentifier(A11y.Groups.save)
                    }
                }
            }
            .onAppear {
                name = conversation.title
                description = conversation.description
            }
        }
        // Taller once the keyboard and a long description want the room.
        .presentationDetents([.medium, .large])
    }

    private func save() {
        guard let groupId = conversation.groupId else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let changes = GroupMetaChanges(name: trimmed.isEmpty ? conversation.title : trimmed, description: description)
        busy = true
        Task {
            do {
                try await model.core.session(serverId).updateGroupMeta(groupId, changes)
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
                busy = false
            }
        }
    }
}
