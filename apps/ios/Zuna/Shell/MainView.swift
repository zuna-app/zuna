import SwiftUI
import ZunaModels

/// The app once it has a server: Chats and Settings tabs, as in Telegram.
/// The Chats tab starts at the list of servers, as Mail starts at its
/// mailboxes, or at the chats when there's only one. A Calls tab comes with
/// calls.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(Notifications.self) private var notifications
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Group {
            if sizeClass == .regular {
                WideLayout()
            } else {
                compact
            }
        }
        .task { await notifications.askOnce() }
    }

    private var compact: some View {
        @Bindable var model = model
        return TabView(selection: $model.tab) {
            Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: AppModel.Tab.chats) {
                ChatsTab()
            }
            .badge(model.totalUnread)
            .accessibilityIdentifier(A11y.Shell.chatsTab)

            Tab("Settings", systemImage: "gearshape.fill", value: AppModel.Tab.settings) {
                SettingsView()
            }
            .accessibilityIdentifier(A11y.Shell.settingsTab)
        }
        .background(Theme.bg0)
        .sheet(isPresented: $model.joining) {
            JoinFlow(embedded: true)
        }
    }
}

/// The Chats tab on a phone: the servers, then a server's chats pushed over
/// them, then its chats and their details.
private struct ChatsTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.chatsStack) {
            Group {
                if model.hasServerList {
                    ServerListView()
                } else {
                    ChatListView()
                }
            }
            .navigationDestination(for: ChatRoute.self) { ChatRouteView(route: $0) }
        }
    }
}

/// The iPad, laid out like Mail: the servers in the sidebar when there's more
/// than one, the conversations beside them, and the open chat filling the rest.
private struct WideLayout: View {
    @Environment(AppModel.self) private var model
    @State private var showingSettings = false
    @State private var columns = NavigationSplitViewVisibility.automatic

    var body: some View {
        @Bindable var model = model
        GeometryReader { proxy in
            if model.hasServerList {
                NavigationSplitView(columnVisibility: $columns) {
                    ServerListView(sidebar: true)
                        .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
                } content: {
                    chats
                } detail: {
                    detail
                }
                .onChange(of: model.activeServerId) {
                    // In portrait the servers cover the chats, as Mail's mailboxes do; choosing one uncovers them.
                    if proxy.size.width < 1000 { columns = .doubleColumn }
                }
            } else {
                NavigationSplitView {
                    chats
                } detail: {
                    detail
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .background(Theme.bg0)
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(isPresented: $model.joining) { JoinFlow(embedded: true) }
    }

    private var chats: some View {
        ChatListView(sidebar: true, onSettings: { showingSettings = true })
            .navigationSplitViewColumnWidth(min: 300, ideal: 350, max: 440)
    }

    @ViewBuilder
    private var detail: some View {
        if let first = model.chatPath.first {
            NavigationStack(path: Binding(get: { Array(model.chatPath.dropFirst()) }, set: { model.chatPath = [first] + $0 })) {
                ChatRouteView(route: first)
                    .navigationDestination(for: ChatRoute.self) { ChatRouteView(route: $0) }
            }
            .id(first)
        } else {
            ContentUnavailableView("Choose a chat", systemImage: "bubble.left.and.bubble.right", description: Text("Messages are end-to-end encrypted."))
                .foregroundStyle(Theme.text2)
                .background(Theme.bg0)
        }
    }
}

/// Toasts from the core and the app, above everything, including the join screens.
struct ToastStack: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.toasts) { toast in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: icon(toast.kind))
                        .foregroundStyle(color(toast.kind))
                        .accessibilityHidden(true)
                    Text(toast.message)
                        .font(.subheadline)
                        .foregroundStyle(Theme.text1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Theme.bg3, in: .rect(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.lineStrong))
                .onTapGesture { model.dismissToast(toast.id) }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(A11y.Toast.item)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 12)
        .animation(.spring(response: 0.3, dampingFraction: 0.9), value: model.toasts)
    }

    private func icon(_ kind: AppModel.Toast.Kind) -> String {
        switch kind {
        case .info: "info.circle.fill"
        case .error: "exclamationmark.circle.fill"
        case .security: "exclamationmark.shield.fill"
        }
    }

    private func color(_ kind: AppModel.Toast.Kind) -> Color {
        switch kind {
        case .info: Theme.text2
        case .error: Theme.red
        case .security: Theme.amber
        }
    }
}
