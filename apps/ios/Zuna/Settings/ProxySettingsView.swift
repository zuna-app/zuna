import SwiftUI
import ZunaHost
import ZunaModels

/// The SOCKS5 proxy everything this device sends goes through, for every server on it, as the
/// desktop's Proxy dialog (`ui/overlays/proxy.rs`): from Privacy, and from the first screen, before
/// any server is joined. Saving closes every connection and opens them again the new way.
struct ProxySettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var on: Bool
    @State private var host: String
    @State private var port: String
    @State private var username: String
    @State private var password = ""
    @State private var problem: String?
    @State private var checking = false
    @State private var report: Socks.Report?
    private let keptPassword = ProxyStore.keepsPassword

    init() {
        let setting = ProxyStore.load()
        _on = State(initialValue: setting.on)
        _host = State(initialValue: setting.host)
        _port = State(initialValue: setting.host.isEmpty ? "" : String(setting.port))
        _username = State(initialValue: setting.username)
    }

    var body: some View {
        List {
            Section {
                Toggle(t("settings.proxy.connectThrough"), isOn: $on)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.proxyOn)
            } footer: {
                Text(t("settings.proxy.hint"))
            }
            if on {
                Section {
                    TextField(t("settings.proxy.address"), text: $host, prompt: Text(t("settings.proxy.addressPrompt")))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier(A11y.Settings.proxyHost)
                    TextField(t("settings.proxy.port"), text: $port, prompt: Text(t("settings.proxy.port")))
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier(A11y.Settings.proxyPort)
                    // Not a username and password as the system knows them: it would offer to keep the proxy's
                    // password in Passwords, which syncs it, and it stays on this device. A field that's a
                    // one-time code is the only one it doesn't offer that for.
                    TextField(t("common.username"), text: $username, prompt: Text(t("settings.proxy.usernamePrompt")))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier(A11y.Settings.proxyUsername)
                    SecureField(t("common.password"), text: $password, prompt: Text(keptPassword ? t("settings.proxy.passwordKept") : t("settings.proxy.passwordPrompt")))
                        .textContentType(.oneTimeCode)
                        .accessibilityIdentifier(A11y.Settings.proxyPassword)
                } footer: {
                    Text(t("settings.proxy.serversHint"))
                }
                Section {
                    Button {
                        Task { await check() }
                    } label: {
                        HStack {
                            Text(t("settings.proxy.check"))
                            Spacer()
                            if checking { ProgressView() }
                        }
                    }
                    .disabled(checking)
                    .accessibilityIdentifier(A11y.Settings.proxyCheck)
                    if let report {
                        ReportLines(report: report)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier(A11y.Settings.proxyReport)
                    }
                }
            }
            if let problem {
                Section {
                    Text(problem).foregroundStyle(Theme.red)
                }
            }
        }
        .navigationTitle(t("settings.proxy.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(t("common.save"), action: save)
                    .disabled(checking)
                    .accessibilityIdentifier(A11y.Settings.proxySave)
            }
        }
    }

    /// The proxy as the form has it, or why it can't be read.
    private func proxy() -> Result<NetworkProxy, ProxyFormProblem> {
        let host = host.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty, !host.contains("/"), !host.contains(" ") else { return .failure(ProxyFormProblem(t("settings.proxy.addressMissing"))) }
        guard let port = UInt16(port.trimmingCharacters(in: .whitespaces)), port > 0 else { return .failure(ProxyFormProblem(t("settings.proxy.badPort"))) }
        let password = password.isEmpty ? (ProxyStore.password() ?? "") : password
        guard username.utf8.count <= 255, password.utf8.count <= 255 else { return .failure(ProxyFormProblem(t("settings.proxy.tooLong"))) }
        return .success(NetworkProxy(host: host, port: port, username: username, password: password))
    }

    private func check() async {
        problem = nil
        report = nil
        switch proxy() {
        case let .failure(why):
            problem = why.message
        case let .success(proxy):
            checking = true
            let servers = model.order.compactMap { id in model.servers[id].map { (name: $0.entry.name, url: $0.entry.url) } }
            report = await Socks.check(proxy, servers: servers)
            checking = false
        }
    }

    private func save() {
        problem = nil
        var setting = ProxyStore.load()
        setting.on = on
        var newPassword: String?
        if on {
            switch proxy() {
            case let .failure(why):
                problem = why.message
                return
            case let .success(proxy):
                setting.host = proxy.host
                setting.port = proxy.port
                setting.username = proxy.username
                // A password typed in replaces the one kept; with none typed, the kept one stays.
                if !password.isEmpty { newPassword = password }
            }
        }
        do {
            try ProxyStore.save(setting, password: newPassword)
        } catch {
            problem = t("settings.proxy.couldntSavePassword", ["error": error.localizedDescription])
            return
        }
        model.proxyChanged()
        dismiss()
    }
}

private struct ProxyFormProblem: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// What a check found, a line each, as the desktop shows it.
private struct ReportLines: View {
    let report: Socks.Report

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch report.signedIn {
            case let .success(took):
                line(true, t("settings.proxy.connectedIn", ["time": milliseconds(took)]))
                line(report.udp, report.udp ? t("settings.proxy.udp") : t("settings.proxy.noUdp"))
            case let .failure(failure):
                line(false, failure.description)
            }
            ForEach(Array(report.servers.enumerated()), id: \.offset) { _, server in
                switch server.reached {
                case let .reached(took): line(true, t("settings.proxy.reached", ["server": server.name, "time": milliseconds(took)]))
                case let .failed(why): line(false, t("settings.proxy.serverFailed", ["server": server.name, "reason": why]))
                }
            }
        }
        .font(.subheadline)
        .padding(.vertical, 4)
    }

    private func line(_ good: Bool, _ text: String) -> some View {
        Label {
            Text(text).foregroundStyle(Theme.text1)
        } icon: {
            Image(systemName: good ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(good ? Theme.green : Theme.red)
        }
    }

    private func milliseconds(_ seconds: TimeInterval) -> String {
        t("settings.proxy.milliseconds", ["count": Int((seconds * 1000).rounded())])
    }
}
