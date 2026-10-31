import SwiftUI
import ZunaModels

/// The pinned message under the chat's title, as in Telegram: a tap shows it
/// and moves on to the next pin; the button lists them all.
struct PinnedBar: View {
    @Environment(AppModel.self) private var model
    let serverId: String
    let conversation: ConversationView
    let onShowAll: () -> Void

    @State private var pins: [MessageView] = []
    @State private var index = 0

    var body: some View {
        let groupId = conversation.groupId
        let signature = groupId.flatMap { model.list(serverId, $0)?.items.filter { $0.pinnedAt != nil }.map(\.id).joined(separator: ",") } ?? ""
        // A stack, not a Group: with nothing pinned a Group is empty, and its task would never run.
        VStack(spacing: 0) {
            if let current = pins.isEmpty ? nil : pins[min(index, pins.count - 1)] {
                HStack(spacing: 10) {
                    Button {
                        guard let groupId else { return }
                        Task { await model.jumpToMessage(serverId, groupId: groupId, messageId: current.id, seq: current.seq) }
                        index = (index + 1) % pins.count
                    } label: {
                        HStack(spacing: 10) {
                            VStack(spacing: 2) {
                                ForEach(pins.prefix(4)) { pin in
                                    Capsule().fill(pin.id == current.id ? model.settings.accent.text : Theme.text3.opacity(0.5)).frame(width: 2)
                                }
                            }
                            .frame(height: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(pins.count > 1 ? "Pinned message \(min(index, pins.count - 1) + 1) of \(pins.count)" : "Pinned message")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(model.settings.accent.text)
                                Text(preview(current))
                                    .font(.footnote)
                                    .foregroundStyle(Theme.text1)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    Button(action: onShowAll) {
                        Image(systemName: "pin").foregroundStyle(Theme.text2).frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("All pinned messages")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(Theme.bg1)
                .overlay(alignment: .bottom) { Divider().overlay(Theme.line) }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(A11y.Chat.pinnedBar)
            }
        }
        .task(id: "\(groupId ?? "")|\(signature)") {
            guard let groupId else { return }
            pins = (try? await model.core.session(serverId).loadPins(groupId)) ?? []
        }
    }

    private func preview(_ message: MessageView) -> String {
        let text = plainText(message.text.components(separatedBy: "\n").first ?? "")
        return text.isEmpty ? message.attachments.first?.name ?? "Attachment" : String(text.prefix(120))
    }
}

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

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces)
        NavigationStack {
            List {
                if let coverage, coverage.total > 0, coverage.done < coverage.total {
                    Text("Still downloading your history. Older messages will appear in results soon.")
                        .font(.footnote).foregroundStyle(Theme.text3).listRowBackground(Color.clear)
                }
                if needle.count < 2 {
                    Text("Search runs on this device. The server never sees what you look for.")
                        .font(.footnote).foregroundStyle(Theme.text3).frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if results.isEmpty {
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
                    return
                }
                try? await Task.sleep(for: .milliseconds(140))
                guard !Task.isCancelled else { return }
                let session = model.core.session(serverId)
                results = (try? await session.search(needle, groupId: groupId)) ?? []
                coverage = try? await session.searchCoverage()
            }
        }
    }

    private func open(_ message: MessageView) {
        dismiss()
        Task { await model.jumpToMessage(serverId, groupId: message.groupId, messageId: message.id, seq: message.seq) }
    }
}

/// Every pinned message, with Unpin, as the desktop's side panel shows them.
struct PinsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let serverId: String
    let conversation: ConversationView
    let server: AppModel.ServerState

    @State private var pins: [MessageView]?

    var body: some View {
        NavigationStack {
            List {
                if pins?.isEmpty == true {
                    ContentUnavailableView("Nothing is pinned yet.", systemImage: "pin", description: Text("Press and hold a message to pin it."))
                        .listRowBackground(Color.clear)
                }
                ForEach(pins ?? []) { message in
                    Button {
                        dismiss()
                        Task { await model.jumpToMessage(serverId, groupId: message.groupId, messageId: message.id, seq: message.seq) }
                    } label: {
                        ResultRow(message: message, server: server) {
                            Button {
                                Task {
                                    do {
                                        try await model.core.session(serverId).setPinned(message.groupId, id: message.id, pinned: false)
                                        pins?.removeAll { $0.id == message.id }
                                    } catch {
                                        model.toast(OnboardingText.describe(error), .error)
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
                    .listRowBackground(Theme.bg2)
                    .accessibilityIdentifier(A11y.Chat.result(message.id))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("Pinned messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task {
                guard let groupId = conversation.groupId else {
                    pins = []
                    return
                }
                pins = (try? await model.core.session(serverId).loadPins(groupId)) ?? []
            }
        }
    }
}
