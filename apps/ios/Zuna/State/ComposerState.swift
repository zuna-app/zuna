import Foundation
import ZunaModels

/// What's being written in a chat: the draft, the message it answers or
/// edits, and files picked to send. Kept per conversation, like the desktop's drafts.
struct ComposerState: Equatable {
    var text = ""
    var replyTo: MessageView?
    var editing: MessageView?
    var files: [StagedFile] = []
    /// The preview of the draft's first link, made on this device.
    var link: LinkDraft?
    /// A link whose preview was removed, so it isn't made again for this draft.
    var dismissedLink: String?

    var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
    }
}

struct LinkDraft: Equatable {
    let url: String
    var preview: LinkPreview?
    var loading: Bool
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

        // Only a preview that's ready: sending doesn't wait for a slow page.
        let preview = state.link.flatMap { value.contains($0.url) ? $0.preview : nil }
        let body = MessageBody(text: value.isEmpty ? nil : value, replyTo: state.replyTo?.id, emotes: emotes, mentions: mentions, preview: preview)
        let files = state.files
        updateComposer(serverId, conversation.key) {
            $0.text = ""
            $0.replyTo = nil
            $0.files = []
            $0.link = nil
            $0.dismissedLink = nil
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

    /// Makes the preview of a draft's first link once typing pauses, as the desktop does.
    /// Edits keep the preview they had.
    func updateLinkPreview(_ serverId: String, _ conversationKey: String, text: String) async {
        let state = composer(serverId, conversationKey)
        guard settings.linkPreviews, state.editing == nil else {
            if state.link != nil { updateComposer(serverId, conversationKey) { $0.link = nil } }
            return
        }
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        let found = (try? await core.findLink(text)) ?? nil
        guard !Task.isCancelled else { return }
        guard let link = found, link != composer(serverId, conversationKey).dismissedLink else {
            updateComposer(serverId, conversationKey) { $0.link = nil }
            return
        }
        if let current = composer(serverId, conversationKey).link, current.url == link, !current.loading { return }
        updateComposer(serverId, conversationKey) { $0.link = LinkDraft(url: link, preview: $0.link?.url == link ? $0.link?.preview : nil, loading: true) }
        // The core remembers it, so a later call while typing doesn't fetch the page again.
        let preview = (try? await core.linkPreview(link)) ?? nil
        guard !Task.isCancelled else { return }
        updateComposer(serverId, conversationKey) { $0.link = LinkDraft(url: link, preview: preview, loading: false) }
    }

    /// Forwards a message to a chat on any server, and says where it went.
    func forward(_ message: MessageView, from serverId: String, to targetServerId: String, _ conversation: ConversationView) async {
        do {
            try await core.forwardMessage(from: serverId, groupId: message.groupId, id: message.id, to: targetServerId, conversationKey: conversation.key)
            toast("Forwarded to \(conversation.title)")
        } catch {
            toast(OnboardingText.describe(error), .error)
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
