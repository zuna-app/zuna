import SwiftUI
import ZunaModels

/// Marks a bot, wherever its name shows: an account a program runs, which reads the chats
/// it's in (the web's `BotBadge`).
struct BotBadge: View {
    var body: some View {
        Text("BOT")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(Theme.text2)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Theme.bg4, in: .rect(cornerRadius: 4))
            .fixedSize()
            .accessibilityLabel("Bot")
    }
}

/// What the interface needs to know about bots: who may add one, which are in a chat, and
/// the words it says before one is added (the web's `lib/bots.ts`).
enum Bots {
    /// What someone is told before they add a bot to a group.
    static let reads = "A bot is a program. It reads everything said here from now on, on whichever machine runs it, and gets nothing from before."

    /// Whether this person may add someone to a group, which only a bot may say no to: its
    /// owner always may, and for a listed bot whoever its owner chose. The server holds
    /// everyone to it, and the bot itself does too.
    static func mayAdd(_ user: UserView, in server: AppModel.ServerState) -> Bool {
        guard let bot = user.bot else { return true }
        if bot.ownerId == server.me?.userId { return true }
        guard bot.listed else { return false }
        return bot.add == .anyone || (bot.add == .admins && server.isAdmin)
    }

    /// The bots in a chat: the one a direct message is with, or the ones among a group's or
    /// a channel's members.
    static func inChat(_ conversation: ConversationView, _ server: AppModel.ServerState) -> [UserView] {
        let ids: [String] = conversation.kind == .dm ? [conversation.peerId].compactMap { $0 } : conversation.members.map(\.userId)
        return ids.compactMap { server.users[$0] }.filter { $0.bot != nil && !$0.deleted && !$0.banned }
    }

    /// A command one of a chat's bots answers to.
    struct Offered: Identifiable, Equatable {
        let bot: UserView
        let command: BotCommand
        /// What picking it writes: the command, and whose it is where more than one bot could answer.
        let insert: String
        var id: String { bot.id + "/" + command.command }
    }

    /// The commands a chat's bots answer to, for what's typed after the "/".
    static func commands(in conversation: ConversationView, _ server: AppModel.ServerState, typed: String) -> [Offered] {
        let bots = inChat(conversation, server)
        var offered: [Offered] = []
        for bot in bots {
            let whose = bots.count > 1 ? "@" + bot.username : ""
            for command in bot.commands ?? [] where command.command.hasPrefix(typed) {
                offered.append(Offered(bot: bot, command: command, insert: "/" + command.command + whose + " "))
            }
        }
        return offered
    }

    /// How the question before bots are added is headed, and what its button says.
    static func question(_ bots: [UserView]) -> (title: String, action: String) {
        let names = bots.map(\.displayName).joined(separator: ", ")
        return bots.count == 1 ? ("Add the bot \(names)?", "Add the bot") : ("Add the bots \(names)?", "Add the bots")
    }

    /// Whose a bot is, for its details: "Your bot", or its owner's by name.
    static func whose(_ bot: BotInfo, _ server: AppModel.ServerState) -> String {
        if bot.ownerId == server.me?.userId { return "Your bot" }
        let owner = server.users[bot.ownerId]?.displayName ?? "Someone"
        return "\(owner)'s bot"
    }
}

/// The rows of buttons under a bot's message (the web's `MessageButtons.tsx`). One with a link
/// opens it, as a link in a message does. One with data sends that back to the bot: a press
/// goes to the whole chat, as a chat's messages do, and nobody's app shows it.
struct MessageButtonsView: View {
    @Environment(\.openURL) private var openURL
    let message: MessageView
    let press: (_ row: Int, _ column: Int) -> Void

    var body: some View {
        VStack(spacing: 3) {
            ForEach(Array((message.buttons ?? []).enumerated()), id: \.offset) { rowIndex, row in
                HStack(spacing: 3) {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, button in
                        Button {
                            if let link = button.url {
                                if let url = URL(string: link) { openURL(url) }
                            } else if message.status == .sent {
                                press(rowIndex, column)
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(button.text)
                                    .lineLimit(1)
                                if button.url != nil {
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption2)
                                        .foregroundStyle(Theme.text3)
                                }
                            }
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.text1)
                            .padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, minHeight: 34)
                            .background(Theme.bg3, in: .rect(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: 280)
    }
}
