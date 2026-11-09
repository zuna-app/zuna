import Foundation
import Observation
import SwiftUI
import ZunaModels

/// What changes many times a minute on a server, kept apart from `AppModel.ServerState`,
/// which nearly every screen reads: who's typing, and who's online. Only the views that
/// show these read them here, each only its own group's typing or its own person's
/// presence, so someone typing or coming online redraws just those.
@MainActor
@Observable
final class LiveState {
    /// Who's typing, a box for each group.
    private(set) var typing: [String: LiveTypists] = [:]
    /// Presence since the people were last loaded, a box for each person, over what the
    /// core said of them then.
    private(set) var presence: [String: LivePresence] = [:]

    /// Nothing known, for a server not loaded yet.
    static let none = LiveState()

    func isOnline(_ user: UserView) -> Bool {
        presence[user.id]?.online ?? user.online
    }

    func isOnline(_ userId: String, in server: AppModel.ServerState) -> Bool {
        server.users[userId].map { isOnline($0) } ?? false
    }

    func lastSeenAt(_ user: UserView) -> Int? {
        if let box = presence[user.id] { return box.lastSeenAt }
        return user.lastSeenAt
    }

    /// Who's typing in a group.
    func typists(in groupId: String?) -> [String] {
        groupId.flatMap { typing[$0] }.map { Array($0.until.keys) } ?? []
    }

    func setPresence(_ userId: String, online: Bool, lastSeenAt: Int?) {
        guard let box = presence[userId] else {
            presence[userId] = LivePresence(online: online, lastSeenAt: lastSeenAt)
            return
        }
        if box.online != online { box.online = online }
        if box.lastSeenAt != lastSeenAt { box.lastSeenAt = lastSeenAt }
    }

    /// The people were loaded again, with their presence as it is now.
    func forgetPresence() {
        if !presence.isEmpty { presence = [:] }
    }

    /// Someone started typing, which shows for five seconds unless they type again.
    func startTyping(_ userId: String, in groupId: String) {
        let until = Date().addingTimeInterval(5)
        if let box = typing[groupId] {
            box.until[userId] = until
        } else {
            let box = LiveTypists()
            box.until[userId] = until
            typing[groupId] = box
        }
    }

    /// Takes away whoever's five seconds are over.
    func stopTyping(_ userId: String, in groupId: String) {
        guard let box = typing[groupId], let until = box.until[userId], until <= Date() else { return }
        box.until[userId] = nil
    }

    /// Their message came, which ends their typing at once, as on the desktop.
    func endTyping(_ userId: String, in groupId: String) {
        guard let box = typing[groupId], box.until[userId] != nil else { return }
        box.until[userId] = nil
    }
}

/// Who's typing in one group: user to when it stops showing.
@MainActor
@Observable
final class LiveTypists {
    var until: [String: Date] = [:]
}

/// One person's presence, from the events since the people were loaded.
@MainActor
@Observable
final class LivePresence {
    var online: Bool
    var lastSeenAt: Int?

    init(online: Bool, lastSeenAt: Int?) {
        self.online = online
        self.lastSeenAt = lastSeenAt
    }
}

/// Shows whether someone's online, reading only their own presence, so that the view
/// around it doesn't draw again as people come and go.
struct WithPresence<Content: View>: View {
    @Environment(AppModel.self) private var model
    let serverId: String
    let user: UserView?
    @ViewBuilder let content: (_ online: Bool) -> Content

    var body: some View {
        content(user.map { model.live(serverId).isOnline($0) } ?? false)
    }
}
