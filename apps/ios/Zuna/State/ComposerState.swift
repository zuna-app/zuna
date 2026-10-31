import Foundation
import ZunaModels

/// What's being written in a chat: the draft, the message it answers or
/// edits, and files picked to send. Kept per conversation, like the desktop's drafts.
struct ComposerState: Equatable {
    var text = ""
    var replyTo: MessageView?
    var editing: MessageView?
    var files: [StagedFile] = []

    var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
    }
}

extension AppModel {
    static func composerKey(_ serverId: String, _ conversationKey: String) -> String {
        "\(serverId)/\(conversationKey)"
    }

    func composer(_ serverId: String, _ conversationKey: String) -> ComposerState {
        composers[Self.composerKey(serverId, conversationKey)] ?? ComposerState()
    }

    func updateComposer(_ serverId: String, _ conversationKey: String, _ change: (inout ComposerState) -> Void) {
        let key = Self.composerKey(serverId, conversationKey)
        var state = composers[key] ?? ComposerState()
        change(&state)
        composers[key] = state
    }

    /// Answers a message; editing stops.
    func reply(_ serverId: String, _ conversationKey: String, to message: MessageView?) {
        updateComposer(serverId, conversationKey) {
            $0.replyTo = message
            if message != nil { $0.editing = nil }
        }
    }

    /// Edits one of your messages in the composer; a reply in progress stops.
    func edit(_ serverId: String, _ conversationKey: String, _ message: MessageView?) {
        updateComposer(serverId, conversationKey) {
            $0.editing = message
            $0.text = message?.text ?? ""
            if message != nil { $0.replyTo = nil }
        }
    }

    /// Sends what's in the composer, or saves the edit, as the desktop's composer does.
    func sendComposer(_ serverId: String, _ conversation: ConversationView) {
        let state = composer(serverId, conversation.key)
        let value = state.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let server = servers[serverId], !value.isEmpty || !state.files.isEmpty else { return }
        let session = core.session(serverId)
        let emotes = Self.emotes(in: value, server.emotes)
        let mentions = Self.mentions(in: value, server.users)

        if let editing = state.editing {
            if !value.isEmpty, value != editing.text {
                Task {
                    do {
                        try await session.editMessage(editing.groupId, id: editing.id, text: value, emotes: emotes, mentions: mentions)
                    } catch {
                        toast(OnboardingText.describe(error), .error)
                    }
                }
            }
            updateComposer(serverId, conversation.key) { $0 = ComposerState() }
            return
        }

        let body = MessageBody(text: value.isEmpty ? nil : value, replyTo: state.replyTo?.id, emotes: emotes, mentions: mentions)
        let files = state.files
        updateComposer(serverId, conversation.key) {
            $0.text = ""
            $0.replyTo = nil
            $0.files = []
        }
        Task {
            do {
                if files.isEmpty {
                    try await session.sendMessage(conversation.key, body)
                } else {
                    try await session.sendWithAttachments(conversation.key, files: files.map(\.file), body: body)
                    files.forEach(OutgoingFiles.discard)
                }
            } catch {
                toast(OnboardingText.describe(error), .error)
            }
        }
    }

    /// The server's emotes named in the text, recorded in the message so it renders the same for everyone.
    static func emotes(in text: String, _ set: EmoteSet) -> [String: EmoteRef] {
        let byName = Dictionary(set.emotes.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        var out: [String: EmoteRef] = [:]
        for word in text.split(whereSeparator: \.isWhitespace).map(String.init) {
            if let emote = byName[word] {
                out[word] = EmoteRef(id: emote.id, animated: emote.animated, zeroWidth: emote.zeroWidth, owner: emote.owner)
            }
        }
        return out
    }

    /// The people mentioned with `@username`, as the desktop finds them.
    static func mentions(in text: String, _ users: [String: UserView]) -> [String] {
        let byName = Dictionary(users.values.map { ($0.username.lowercased(), $0.id) }, uniquingKeysWith: { first, _ in first })
        let pattern = try! NSRegularExpression(pattern: #"(?:^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})"#)
        let ns = text as NSString
        var ids: [String] = []
        for match in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if let id = byName[ns.substring(with: match.range(at: 1)).lowercased()], !ids.contains(id) { ids.append(id) }
        }
        return ids
    }
}
