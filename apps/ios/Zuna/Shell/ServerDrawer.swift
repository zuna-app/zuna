import SwiftUI
import ZunaModels

/// The servers, as in Discord: a rail of icons with unread counts on the left,
/// and the active server beside it. The server's menu comes with the
/// conversation list (F3).
struct ServerDrawer: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            rail
            if let server = model.activeServer {
                ServerPanel(server: server)
            }
        }
        .background(Theme.bg1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Drawer.screen)
    }

    private var rail: some View {
        ServerRail {
            model.drawerOpen = false
            model.tab = .settings
        }
    }

}

/// The column of server icons with unread counts, joining another server, and
/// your own picture at the bottom: in the drawer on a phone, always beside the
/// chats on an iPad, as on the desktop.
struct ServerRail: View {
    @Environment(AppModel.self) private var model
    /// Opens your profile and settings.
    let onProfile: () -> Void
    /// The settings button the desktop's rail has, for the iPad, which has no tab bar.
    var showsSettings = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(model.order, id: \.self) { id in
                        if let server = model.servers[id] {
                            ServerIcon(server: server, active: id == model.activeServerId) {
                                model.selectServer(id)
                            }
                        }
                    }
                    Button {
                        model.joining = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(Theme.green)
                            .frame(width: 48, height: 48)
                            .background(Theme.bg3, in: .rect(cornerRadius: 16, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Join a server")
                    .accessibilityIdentifier(A11y.Drawer.join)
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            if showsSettings {
                Button(action: onProfile) {
                    Image(systemName: "gearshape").font(.system(size: 20)).foregroundStyle(Theme.text2).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
                .accessibilityIdentifier(A11y.Shell.settingsTab)
            }
            if let me = model.activeServer?.selfUser {
                Button(action: onProfile) {
                    AvatarView(name: me.displayName, seed: me.id, source: me.avatar.map { .avatar($0, serverId: model.activeServerId ?? "") } ?? .none, size: 40)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 12)
                .accessibilityLabel("Your profile")
                .accessibilityIdentifier(A11y.Drawer.profile)
            }
        }
        .frame(width: 72)
        .background(Theme.bg0)
    }
}

/// A server in the rail: its icon, a pill beside the active one, and the unread count.
private struct ServerIcon: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState
    let active: Bool
    let select: () -> Void

    var body: some View {
        let unread = server.unread
        Button(action: select) {
            AvatarView(name: server.entry.name, seed: server.entry.url, source: .serverIcon(server.entry), size: 48, rounded: true)
                .overlay(alignment: .bottomTrailing) {
                    if !active, unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(model.settings.accent.onAccent)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(model.settings.accent.color, in: .capsule)
                            .overlay(Capsule().stroke(Theme.bg0, lineWidth: 3))
                            .offset(x: 6, y: 4)
                    }
                }
                .frame(width: 72)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.text1)
                        .frame(width: 4, height: active ? 36 : unread > 0 ? 8 : 0)
                        .offset(x: -2)
                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: active)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(server.entry.name)
        .accessibilityValue(unread > 0 ? "\(unread) unread" : "")
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier(A11y.Drawer.server(server.entry.id))
    }
}

/// The active server beside the rail: its name, address and who's on it.
private struct ServerPanel: View {
    let server: AppModel.ServerState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(server.entry.name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                    .lineLimit(2)
                Text(host)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 14)

            Divider().overlay(Theme.line)

            VStack(alignment: .leading, spacing: 14) {
                Label(members, systemImage: "person.2.fill")
                Label(connection.text, systemImage: connection.icon)
                Label("End-to-end encrypted", systemImage: "lock.fill")
            }
            .font(.subheadline)
            .foregroundStyle(Theme.text2)
            .padding(16)

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var host: String {
        URL(string: server.entry.url)?.host() ?? server.entry.url
    }

    private var members: String {
        let total = server.users.values.filter { !$0.banned }.count
        let online = server.users.values.filter { $0.online && !$0.banned }.count
        return "\(total) member\(total == 1 ? "" : "s"), \(online) online"
    }

    private var connection: (text: String, icon: String) {
        switch server.connection {
        case .online: ("Connected", "checkmark.circle.fill")
        case .syncing: ("Updating…", "arrow.triangle.2.circlepath")
        case .connecting: ("Connecting…", "arrow.triangle.2.circlepath")
        case .offline: ("Waiting for network…", "wifi.slash")
        }
    }
}
