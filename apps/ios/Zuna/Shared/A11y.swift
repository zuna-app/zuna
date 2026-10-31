/// Accessibility identifiers, shared by the app and its UI tests, so tests
/// find elements without depending on their wording.
enum A11y {
    enum Root {
        static let ready = "root.ready"
        static let failed = "root.failed"
    }

    enum Unlock {
        static let screen = "unlock.screen"
        static let account = "unlock.account"
        static let password = "unlock.password"
        static let submit = "unlock.submit"
        static let error = "unlock.error"
        static let forgot = "unlock.forgot"
    }
}
