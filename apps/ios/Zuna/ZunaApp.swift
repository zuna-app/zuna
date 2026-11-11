import SwiftUI
import UserNotifications

@main
struct ZunaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    private var core: CoreController { delegate.core }

    var body: some Scene {
        WindowGroup {
            root
        }
    }

    private var root: some View {
        RootView()
            .environment(core)
            .onOpenURL { core.open($0) }
            .preferredColorScheme(.dark)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: core.didEnterBackground()
                case .active: core.didBecomeActive()
                default: break
                }
            }
    }
}

/// Starts the core as the app launches, which may be in the background to act
/// on a notification, and answers the system's questions about notifications.
final class AppDelegate: NSObject, UIApplicationDelegate {
    let core = CoreController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Notifications.categories)
        // An iPad's chat list puts its five filters in a narrow column, where equal parts cut "Channels" short.
        if UIDevice.current.userInterfaceIdiom == .pad { UISegmentedControl.appearance().apportionsSegmentWidthsByContent = true }
        // PushKit has to have its delegate as the app launches, or a VoIP push that woke it is never handed over.
        core.listenForCalls()
        Task { await core.start() }
        return true
    }

    /// Upright on a phone, except for a call's video watched full screen.
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .phone ? Orientation.mask : .all
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        core.pushToken = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // The simulator, or a build without the push entitlement: notifications wait for a token.
    }

    /// Silent pushes: what was read or deleted on another device is cleared here, and a call that stopped ringing.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let push = PushStore.open(userInfo), push.kind != .message else {
            completionHandler(.noData)
            return
        }
        Task {
            if push.kind == .callEnd { core.voice.callEndedByPush(serverId: push.serverId, groupId: push.groupId) }
            await Notifications.clear(push)
            if push.kind != .callEnd { await core.clearedElsewhere(push) }
            completionHandler(.newData)
        }
    }
}

extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(core.notifications?.presentation(for: notification) ?? [.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task {
            await core.respond(to: response)
            completionHandler()
        }
    }
}

/// Starting up, unlocking after a restart, and then the app itself.
struct RootView: View {
    @Environment(CoreController.self) private var core

    var body: some View {
        ZStack {
            Theme.bg0.ignoresSafeArea()
            if core.phase == .locked {
                UnlockView()
            } else if core.phase == .ready, let model = core.model, let images = core.images, let notifications = core.notifications {
                Group {
                    if model.appLocked {
                        // Nothing under App lock's cover, so VoiceOver can't read the chats either.
                        Theme.bg0.ignoresSafeArea()
                    } else if model.onboarding {
                        JoinFlow(embedded: false)
                    } else {
                        MainView()
                    }
                }
                .overlay(alignment: .top) { ToastStack() }
                .overlay { AppLockGate() }
                .modifier(NewDeviceWindowHost(model: model))
                .environment(model)
                .environment(model.voice)
                .environment(images)
                .environment(notifications)
                .tint(model.settings.accent.color)
            } else {
                status
            }
        }
    }

    /// Starting up, or failing to.
    private var status: some View {
        VStack(spacing: 14) {
            Text("Zuna")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.text1)
            switch core.phase {
            case .booting:
                ProgressView().tint(Theme.text1)
            case .locked, .ready:
                EmptyView()
            case let .failed(message):
                Text("Zuna couldn't start")
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                    .accessibilityIdentifier(A11y.Root.failed)
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
        }
    }
}

/// App lock: with it on, the app asks for Face ID, Touch ID or the passcode
/// each time it opens, and covers the chats while it isn't in front, so the
/// app switcher doesn't show them.
private struct AppLockGate: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var asking = false

    private var locked: Bool { model.appLocked }

    var body: some View {
        Group {
            if model.settings.appLock && (locked || scenePhase != .active) {
                ZStack {
                    Theme.bg0.ignoresSafeArea()
                    VStack(spacing: 18) {
                        ZunaLogo(size: 72)
                        if locked && scenePhase == .active {
                            Button {
                                unlock()
                            } label: {
                                Label("Unlock with \(AppLock.methodName)", systemImage: "lock.fill")
                                    .padding(.horizontal, 18)
                                    .frame(minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(model.settings.accent.color)
                            .foregroundStyle(model.settings.accent.onAccent)
                            .accessibilityIdentifier(A11y.Root.unlockApp)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(A11y.Root.appLock)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, model.settings.appLock { model.appLocked = true }
            if phase == .active, locked { unlock() }
        }
        .onAppear {
            if locked { unlock() }
        }
    }

    private func unlock() {
        guard !asking else { return }
        asking = true
        Task {
            switch await AppLock.authenticate(reason: "Unlock Zuna") {
            case .unlocked:
                model.appLocked = false
            case .unavailable:
                // The passcode was turned off, so nothing could ever unlock it: App lock goes with it.
                model.settings.appLock = false
                model.appLocked = false
                model.toast("App lock is off, as this iPhone has no passcode.", .security)
            case .refused:
                break
            }
            asking = false
        }
    }
}
