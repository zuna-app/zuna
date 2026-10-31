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
        static func row(_ key: String) -> String { "chatList.row.\(key)" }
    }

    enum Settings {
        static let screen = "settings.screen"
        static let appearance = "settings.appearance"
        static func accent(_ id: String) -> String { "settings.accent.\(id)" }
    }
}
