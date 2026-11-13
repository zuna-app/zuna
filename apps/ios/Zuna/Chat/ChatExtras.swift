import SwiftUI
import ZunaModels

/// A message found by search or pinned: sender, time and text; a tap shows it in the chat.
private struct ResultRow<Action: View>: View {
    let message: MessageView
    let server: AppModel.ServerState
    @ViewBuilder var action: Action

    var body: some View {
        let sender = server.users[message.senderId]
        HStack(spacing: 10) {
            AvatarView(name: sender?.displayName ?? "?", seed: message.senderId, source: sender?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(sender?.displayName ?? "Unknown").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.nameColor(message.senderId))
                    Text(Format.listTime(message.createdAt)).font(.caption).foregroundStyle(Theme.text3)
                }
                Text(plainText(message.text).isEmpty ? message.attachments.first?.name ?? "Attachment" : plainText(message.text))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
            action
        }
        .contentShape(.rect)
    }
}

/// Searching one chat, in the index on this device, as the desktop's side panel does.
struct ChatSearchSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let serverId: String
    let conversation: ConversationView
    let server: AppModel.ServerState

    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var coverage: SearchCoverage?
    /// From a key press until its results are in, so "No messages found." waits for them.
    @State private var searching = false

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces)
        NavigationStack {
            List {
                if let coverage, coverage.total > 0, coverage.done < coverage.total {
                    Text("Still downloading your history. Older messages will appear in results soon.")
                        .font(.footnote).foregroundStyle(Theme.text3).listRowBackground(Color.clear)
                }
                if needle.count < 2 {
                    Text("Search happens on this device. The server never sees what you search for.")
                        .font(.footnote).foregroundStyle(Theme.text3).frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if results.isEmpty, !searching {
                    Text("No messages found.").foregroundStyle(Theme.text2).frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
                ForEach(results, id: \.message.id) { result in
                    Button {
                        open(result.message)
                    } label: {
                        ResultRow(message: result.message, server: server) { EmptyView() }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Theme.bg2)
                    .accessibilityIdentifier(A11y.Chat.result(result.message.id))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search messages")
            .navigationTitle("Search this chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task(id: needle) {
                guard needle.count >= 2, let groupId = conversation.groupId else {
                    results = []
                    searching = false
                    return
                }
                searching = true
                try? await Task.sleep(for: .milliseconds(140))
                guard !Task.isCancelled else { return }
                let session = model.core.session(serverId)
                results = (try? await session.search(needle, groupId: groupId)) ?? []
                coverage = try? await session.searchCoverage()
                searching = false
            }
        }
    }

    /// Back to the chat, at the message, also from the details, where the search is too.
    private func open(_ message: MessageView) {
        dismiss()
        if let index = model.chatPath.firstIndex(of: .chat(conversation.key)) {
            model.chatPath = Array(model.chatPath.prefix(through: index))
        }
        Task { await model.jumpToMessage(serverId, groupId: message.groupId, messageId: message.id, seq: message.seq) }
    }
}

/// Every pinned message on a screen of its own, with Unpin, as the desktop's
/// side panel lists them. A tap goes back to the chat and shows the message.
struct PinnedMessagesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let conversationKey: String

    @State private var pins: [MessageView]?
    /// Why the pins couldn't be loaded, rather than saying there are none.
    @State private var failed: String?
    @State private var attempt = 0

    var body: some View {
        ZStack {
            if let server = model.activeServer, let conversation = server.conversation(conversationKey) {
                list(server, conversation)
            } else {
                ContentUnavailableView("This chat isn't available", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            }
        }
        .background(Theme.bg0)
        .navigationTitle("Pinned messages")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg0, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.pinsScreen)
    }

    private func list(_ server: AppModel.ServerState, _ conversation: ConversationView) -> some View {
        let serverId = server.entry.id
        // Pinning or unpinning in the chat, here or elsewhere, shows up straight away.
        let signature = conversation.groupId.flatMap { model.list(serverId, $0)?.items.filter { $0.pinnedAt != nil }.map(\.id).joined(separator: ",") } ?? ""
        return List {
            if let failed {
                ContentUnavailableView {
                    Label("Couldn't load the pins", systemImage: "pin.slash")
                } description: {
                    Text(failed)
                } actions: {
                    Button("Try again") { attempt += 1 }
                }
                .listRowBackground(Color.clear)
            } else if pins == nil {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            } else if pins?.isEmpty == true {
                ContentUnavailableView("Nothing is pinned yet.", systemImage: "pin", description: Text("Press and hold a message to pin it."))
                    .listRowBackground(Color.clear)
            }
            ForEach(pins ?? []) { message in
                Button {
                    // Back to the chat itself, past the details this was opened from.
                    if let index = model.chatPath.firstIndex(of: .chat(conversationKey)) {
                        model.chatPath = Array(model.chatPath.prefix(through: index))
                    } else {
                        dismiss()
                    }
                    Task { await model.jumpToMessage(serverId, groupId: message.groupId, messageId: message.id, seq: message.seq) }
                } label: {
                    ResultRow(message: message, server: server) {
                        Button {
                            Task {
                                do {
                                    try await model.core.session(serverId).setPinned(message.groupId, id: message.id, pinned: false)
                                    pins?.removeAll { $0.id == message.id }
                                } catch {
                                    model.toast(ErrorText.describe(error), .error)
                                }
                            }
                        } label: {
                            Image(systemName: "pin.slash").foregroundStyle(Theme.text2).frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Unpin")
                    }
                }
                .buttonStyle(.plain)
                .listRowBackground(Theme.bg1)
                .accessibilityIdentifier(A11y.Chat.result(message.id))
            }
        }
        .scrollContentBackground(.hidden)
        .task(id: "\(conversation.groupId ?? "")|\(signature)|\(attempt)") {
            guard let groupId = conversation.groupId else {
                pins = []
                return
            }
            do {
                pins = try await model.core.session(serverId).loadPins(groupId)
                failed = nil
            } catch {
                if !Task.isCancelled { failed = ErrorText.describe(error) }
            }
        }
    }
}
