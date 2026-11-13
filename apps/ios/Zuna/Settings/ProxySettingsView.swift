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
                Toggle("Connect through a proxy", isOn: $on)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.proxyOn)
            } footer: {
                Text("Everything this device sends can go through a SOCKS5 proxy you choose, for every server you've joined: messages, files, calls, link previews, emotes and YouTube. Your servers and their media servers then see the proxy's address rather than yours. The proxy sees which servers you reach, when and how much, but nothing you send, which stays encrypted.")
            }
            if on {
                Section {
                    TextField("Address", text: $host, prompt: Text("A name or an IP address"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier(A11y.Settings.proxyHost)
                    TextField("Port", text: $port, prompt: Text("Port"))
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier(A11y.Settings.proxyPort)
                    // Not a username and password as the system knows them: it would offer to keep the proxy's
                    // password in Passwords, which syncs it, and it stays on this device. A field that's a
                    // one-time code is the only one it doesn't offer that for.
                    TextField("Username", text: $username, prompt: Text("Username, optional"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier(A11y.Settings.proxyUsername)
                    SecureField("Password", text: $password, prompt: Text(keptPassword ? "Password, kept on this device" : "Password, optional"))
                        .textContentType(.oneTimeCode)
                        .accessibilityIdentifier(A11y.Settings.proxyPassword)
                } footer: {
                    Text("While the proxy can't be reached, Zuna connects to nothing, and never goes around it. SOCKS5 isn't encrypted on the way to the proxy, so its password and the names of your servers cross that stretch as they are. A server on this phone itself can't be reached through a proxy.")
                }
                Section {
                    Button {
                        Task { await check() }
                    } label: {
                        HStack {
                            Text("Check")
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
        .navigationTitle("Proxy")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(checking)
                    .accessibilityIdentifier(A11y.Settings.proxySave)
            }
        }
    }

    /// The proxy as the form has it, or why it can't be read.
    private func proxy() -> Result<NetworkProxy, ProxyFormProblem> {
        let host = host.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty, !host.contains("/"), !host.contains(" ") else { return .failure(ProxyFormProblem("Give the proxy's address: a name or an IP address.")) }
        guard let port = UInt16(port.trimmingCharacters(in: .whitespaces)), port > 0 else { return .failure(ProxyFormProblem("The port is a number from 1 to 65535.")) }
        let password = password.isEmpty ? (ProxyStore.password() ?? "") : password
        guard username.utf8.count <= 255, password.utf8.count <= 255 else { return .failure(ProxyFormProblem("A SOCKS5 username or password is at most 255 bytes.")) }
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
            problem = "The password couldn't be kept: \(error.localizedDescription)"
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
                line(true, "Signed in to the proxy in \(milliseconds(took)).")
                line(report.udp, report.udp ? "It carries UDP, which calls use." : "It doesn't carry UDP, so calls through it would go over TCP, and may sound worse.")
            case let .failure(failure):
                line(false, failure.description)
            }
            ForEach(Array(report.servers.enumerated()), id: \.offset) { _, server in
                switch server.reached {
                case let .reached(took): line(true, "Reached \(server.name) through it in \(milliseconds(took)).")
                case let .failed(why): line(false, "\(server.name): \(why)")
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
        "\(Int((seconds * 1000).rounded())) ms"
    }
}
