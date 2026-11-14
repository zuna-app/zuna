import Foundation
import ZunaModels

// The Telegram account linked on this device (docs/TELEGRAM_PLAN.md): linking it, the steps the
// core says, and unlinking it. Its chats are a server's to the rest of the app, under
// `ServerEntry.telegram`, with what Telegram hasn't got left out where it would show.
extension AppModel {
    /// The linked Telegram account, if there is one here.
    var telegram: ServerState? { servers[ServerEntry.telegram] }

    /// Whether the account on show is the linked Telegram one, whose chats aren't end-to-end encrypted.
    var showsTelegram: Bool { activeServer?.entry.isTelegram == true }

    /// The linking screens can be offered: this app can link one, and none is linked yet.
    var canLinkTelegram: Bool { telegramAvailable && telegram == nil }

    /// Opens the linking screens, which say what this is before anything is sent to Telegram.
    func startLinkingTelegram() {
        telegramLink = nil
        linkingTelegram = true
    }

    /// The person read what linking means and goes on: the engine starts, and its first step comes as an event.
    func beginLinkingTelegram() async throws {
        telegramLink = .starting
        try await core.linkTelegram()
    }

    /// Starts linking over from nothing: TDLib takes no phone number once it has shown a QR code,
    /// so moving from the code to a number begins again, with nothing linked to lose.
    func restartLinkingTelegram() async throws {
        telegramLink = .starting
        _ = try? await core.unlinkTelegram()
        try await core.linkTelegram()
        if telegramLink == nil || telegramLink.map({ if case .unlinked = $0 { true } else { false } }) == true {
            telegramLink = .starting
        }
    }

    /// The linking screens closed before the account was in: what was started is erased.
    func cancelLinkingTelegram() {
        let started = telegramLink != nil
        linkingTelegram = false
        telegramLink = nil
        guard started, telegram == nil else { return }
        Task { _ = try? await core.unlinkTelegram() }
    }

    /// What the core said of linking: once Telegram lets the account in, its chats join the list
    /// of servers and open, and once it's unlinked, here or elsewhere, nothing of it stays.
    func telegramChanged(_ link: TelegramLink) {
        telegramLink = link
        switch link {
        case .ready:
            guard telegram == nil else { return }
            // Shown as it comes in only when it was linked just now; an account linked before
            // comes back as the app starts, and stays where it was in the list.
            guard linkingTelegram else {
                Task { await load() }
                return
            }
            Task {
                await addServer(ServerEntry.telegram)
                linkingTelegram = false
            }
        case let .unlinked(signedOut):
            // Unlinked from here, or its session ended from another device. A link left half done says nothing.
            guard telegram != nil else { return }
            removeServer(ServerEntry.telegram)
            linkingTelegram = false
            telegramLink = nil
            if !signedOut {
                toast("Telegram is unlinked here. End Zuna's session from Telegram's Devices on another device.")
            }
        default:
            break
        }
    }

    /// Signs the Telegram account out, which ends its session at Telegram if it can, and erases everything of it here.
    func unlinkTelegram() async {
        do {
            let unlinked = try await core.unlinkTelegram()
            if telegram != nil { removeServer(ServerEntry.telegram) }
            telegramLink = nil
            toast(unlinked.signedOut ? "Telegram is unlinked." : "Telegram is unlinked here. End Zuna's session from Telegram's Devices on another device.")
        } catch {
            toast(ErrorText.describe(error), .error)
        }
    }
}
