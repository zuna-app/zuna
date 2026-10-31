/// Accessibility identifiers, shared by the app and its UI tests, so tests
/// find elements without depending on their wording.
enum A11y {
    enum Root {
        static let failed = "root.failed"
    }

    enum Onboarding {
        static let welcome = "onboarding.welcome"
        static let link = "onboarding.link"
        static let paste = "onboarding.paste"
        static let `continue` = "onboarding.continue"
        static let error = "onboarding.error"
        static let signIn = "onboarding.signIn"
        static let cancel = "onboarding.cancel"
        static let joinScreen = "onboarding.join"
        static let displayName = "onboarding.displayName"
        static let username = "onboarding.username"
        static let password = "onboarding.password"
        static let strength = "onboarding.strength"
        static let create = "onboarding.create"
        static let recoveryKey = "onboarding.recoveryKey"
        static let copyKey = "onboarding.copyKey"
        static let saveKey = "onboarding.saveKey"
        static let keyStored = "onboarding.keyStored"
        static let keyContinue = "onboarding.keyContinue"
        static let serverName = "onboarding.serverName"
        static let nameDone = "onboarding.nameDone"
        static let serverAddress = "onboarding.serverAddress"
        static let signInSubmit = "onboarding.signInSubmit"
        static let forgot = "onboarding.forgot"
        static let recoveryInput = "onboarding.recoveryInput"
        static let newPassword = "onboarding.newPassword"
        static let recover = "onboarding.recover"
    }

    enum Unlock {
        static let screen = "unlock.screen"
        static let account = "unlock.account"
        static let password = "unlock.password"
        static let submit = "unlock.submit"
        static let error = "unlock.error"
        static let forgot = "unlock.forgot"
    }

    enum Shell {
        static let chatsTab = "shell.tab.chats"
        static let settingsTab = "shell.tab.settings"
        static let serverButton = "shell.serverButton"
        static let title = "shell.title"
    }

    enum Drawer {
        static let screen = "drawer.screen"
        static let join = "drawer.join"
        static let profile = "drawer.profile"
        static func server(_ id: String) -> String { "drawer.server.\(id)" }
    }

    enum ChatList {
        static let list = "chatList.list"
        static let empty = "chatList.empty"
        static let filter = "chatList.filter"
        static let hiddenToggle = "chatList.hiddenToggle"
        static func row(_ key: String) -> String { "chatList.row.\(key)" }
        static func messageHit(_ id: String) -> String { "chatList.hit.\(id)" }
    }

    enum Chat {
        static let screen = "chat.screen"
        static let list = "chat.list"
        static let title = "chat.title"
        static let status = "chat.status"
        static let banner = "chat.keyBanner"
        static let toBottom = "chat.toBottom"
        static let empty = "chat.empty"
        static let reply = "chat.reply"
        static let emoteCard = "chat.emoteCard"
        static let pinnedBar = "chat.pinnedBar"
        static let menu = "chat.menu"
        static let search = "chat.search"
        static let pins = "chat.pins"
        static func quickReaction(_ emoji: String) -> String { "chat.quickReaction.\(emoji)" }
        static func result(_ id: String) -> String { "chat.result.\(id)" }
        static func message(_ id: String) -> String { "chat.message.\(id)" }
        static func text(_ id: String) -> String { "chat.text.\(id)" }
        static func meta(_ id: String) -> String { "chat.meta.\(id)" }
        static func reaction(_ key: String) -> String { "chat.reaction.\(key)" }
        static func attachment(_ name: String) -> String { "chat.attachment.\(name)" }
    }

    enum Composer {
        static let input = "composer.input"
        static let send = "composer.send"
        static let attach = "composer.attach"
        static let emoji = "composer.emoji"
        static let context = "composer.context"
        static let cancelContext = "composer.cancelContext"
        static let picker = "composer.picker"
        static let disabled = "composer.disabled"
        static func pickerEmote(_ name: String) -> String { "composer.picker.\(name)" }
        static func suggestion(_ label: String) -> String { "composer.suggestion.\(label)" }
        static func file(_ name: String) -> String { "composer.file.\(name)" }
    }

    enum Toast {
        static let item = "toast"
    }

    enum Settings {
        static let screen = "settings.screen"
        static let appearance = "settings.appearance"
        static func accent(_ id: String) -> String { "settings.accent.\(id)" }
    }
}
