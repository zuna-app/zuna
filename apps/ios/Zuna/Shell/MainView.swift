import SwiftUI
import ZunaModels

/// The app once it has a server: Channels, Chats and Settings tabs, as in
/// Telegram, opening on Chats. Both lists are the active server's, picked
/// with the server button at their top left.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(Notifications.self) private var notifications
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var voice = model.voice
        VStack(spacing: 0) {
            // A call goes on while looking elsewhere, in a bar above everything, as a phone call's does.
            if voice.inCall && !voice.stageShown {
                CallBar()
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            Group {
                if sizeClass == .regular {
                    WideLayout()
                } else {
                    compact
                }
            }
        }
        .animation(.snappy(duration: 0.25), value: voice.inCall && !voice.stageShown)
        // A call ringing, where the system doesn't ring it, over whatever's open.
        .overlay(alignment: .top) { IncomingCallOverlay() }
        .animation(.snappy(duration: 0.25), value: voice.incoming.first?.id)
        .fullScreenCover(isPresented: $voice.stageShown) {
            CallScreen()
        }
        // Coming into voice here ends it on another of this person's devices, which is asked first.
        .alert("Join on this device?", isPresented: Binding(get: { voice.moving != nil }, set: { if !$0 { voice.moving = nil } }), presenting: voice.moving) { move in
            Button("Join here") { Task { await voice.move(move) } }
            Button("Cancel", role: .cancel) {}
        } message: { move in
            Text("You're in \(voice.place(of: move)) on another device. Joining here disconnects that device.")
        }
        .task { await notifications.askOnce() }
        // Linking a Telegram account, from the list of servers or from Settings.
        .sheet(isPresented: Binding(get: { model.linkingTelegram }, set: { if !$0 { model.cancelLinkingTelegram() } })) {
            LinkTelegramView()
        }
    }

    private var compact: some View {
        @Bindable var model = model
        return TabView(selection: $model.tab) {
            if model.hasServers {
                Tab("Channels", systemImage: "number", value: AppModel.Tab.channels) {
                    ChannelsTab()
                }
                // The open server's alone, as the server button carries the others'.
                .badge(model.chatsServer?.channelMentions ?? 0)
                .accessibilityIdentifier(A11y.Shell.channelsTab)

                Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: AppModel.Tab.chats) {
                    ChatsTab()
                }
                .badge(model.chatsServer?.chatsUnread ?? 0)
                .accessibilityIdentifier(A11y.Shell.chatsTab)
            }

            // The Telegram account linked here, a tap away (docs/TELEGRAM_PLAN.md).
            if let telegram = model.telegram {
                Tab("Telegram", systemImage: TelegramIcon.symbol, value: AppModel.Tab.telegram) {
                    TelegramTab()
                }
                .badge(telegram.chatsUnread)
                .accessibilityIdentifier(A11y.Shell.telegramTab)
            }

            Tab("Settings", systemImage: "gearshape.fill", value: AppModel.Tab.settings) {
                SettingsView()
            }
            .accessibilityIdentifier(A11y.Shell.settingsTab)
        }
        .background(Theme.bg0)
        .sheet(isPresented: $model.joining) {
            JoinFlow(embedded: true)
        }
        // With no server joined but Telegram, its tab is where the app opens.
        .onAppear {
            if !model.hasServers, model.telegram != nil, model.tab != .settings { model.tab = .telegram }
        }
    }
}

/// Telegram's tab on a phone: the linked account's chats, with a place of their own.
private struct TelegramTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.telegramPath) {
            ChatListView()
                .navigationDestination(for: ChatRoute.self) { ChatRouteView(route: $0) }
        }
    }
}

/// The Chats tab on a phone: the active server's chats, then the chats and
/// their details pushed over them.
private struct ChatsTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.chatsPath) {
            ChatListView()
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
        .sheet(isPresented: $showingSettings) { SettingsView(onDone: { showingSettings = false }) }
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
            ContentUnavailableView("Choose a chat", systemImage: "bubble.left.and.bubble.right", description: Text(model.showsTelegram ? "Telegram's chats aren't end-to-end encrypted." : "Messages are end-to-end encrypted."))
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
