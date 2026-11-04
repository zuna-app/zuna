import CoreLocation
import SwiftUI
import ZunaModels

/// The desktop's words for a shared place.
enum LocationText {
    /// "52.22970° N, 21.01220° E".
    static func coordinates(_ location: SharedLocation) -> String {
        let lat = String(format: "%.5f", abs(location.lat))
        let lon = String(format: "%.5f", abs(location.lon))
        return "\(lat)° \(location.lat >= 0 ? "N" : "S"), \(lon)° \(location.lon >= 0 ? "E" : "W")"
    }

    /// "Within 20 m", or "Within 1.5 km".
    static func accuracy(_ meters: Double) -> String {
        if meters < 1000 { return "Within \(max(1, Int(meters.rounded()))) m" }
        return "Within \(String(format: meters < 10_000 ? "%.1f" : "%.0f", meters / 1000)) km"
    }

    /// Where a place opens: Apple Maps, as the desktop opens OpenStreetMap.
    static func mapURL(_ location: SharedLocation) -> URL? {
        URL(string: String(format: "https://maps.apple.com/?ll=%.6f,%.6f&q=Location", location.lat, location.lon))
    }
}

/// Where this device is, asked for once, when someone chooses to share it.
@MainActor
final class LocationFinder: NSObject, CLLocationManagerDelegate {
    struct Failure: LocalizedError {
        let errorDescription: String?
    }

    private let manager = CLLocationManager()
    private var waiting: CheckedContinuation<SharedLocation, Error>?

    func locate() async throws -> SharedLocation {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        return try await withCheckedThrowingContinuation { continuation in
            waiting = continuation
            start(manager.authorizationStatus)
        }
    }

    private func start(_ status: CLAuthorizationStatus) {
        switch status {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .denied, .restricted: finish(.failure(Failure(errorDescription: "Zuna isn't allowed to use your location. Allow it in Settings, under Privacy.")))
        default: manager.requestLocation()
        }
    }

    private func finish(_ result: Result<SharedLocation, Error>) {
        waiting?.resume(with: result)
        waiting = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if self.waiting != nil, status != .notDetermined { self.start(status) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        let found = SharedLocation(lat: last.coordinate.latitude, lon: last.coordinate.longitude, accuracy: last.horizontalAccuracy >= 0 ? last.horizontalAccuracy.rounded() : nil)
        Task { @MainActor in self.finish(.success(found)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in
            self.finish(.failure(Failure(errorDescription: denied
                ? "Zuna isn't allowed to use your location. Allow it in Settings, under Privacy."
                : "Your location isn't available right now.")))
        }
    }
}

/// A place someone shared, as the desktop shows it: a pin and where it is, with
/// no map drawn, since that would mean fetching it. A tap opens it in Maps.
struct LocationCard: View {
    let location: SharedLocation
    let own: Bool
    let messageId: String
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let url = LocationText.mapURL(location) { openURL(url) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "mappin")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(model.settings.accent.onAccent)
                    .frame(width: 40, height: 40)
                    .background(model.settings.accent.color, in: .circle)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Location").font(.subheadline.weight(.semibold)).foregroundStyle(own ? Color.white : Theme.text1)
                    Text(LocationText.coordinates(location)).font(.footnote).monospacedDigit().foregroundStyle(own ? Color.white : Theme.text1)
                    if let accuracy = location.accuracy {
                        Text(LocationText.accuracy(accuracy)).font(.caption).foregroundStyle(own ? Color.white.opacity(0.7) : Theme.text2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 8)
            .padding(.trailing, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(own ? 0.07 : 0.05), in: .rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens in Maps")
        .accessibilityIdentifier(A11y.Chat.location(messageId))
    }
}

/// Finds where this device is and, once that's shown, sends it to a chat.
struct ShareLocationSheet: View {
    let serverId: String
    let conversationKey: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var found: SharedLocation?
    @State private var error: String?
    @State private var attempt = 0
    @State private var sending = false
    @State private var finder = LocationFinder()

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: "mappin")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(model.settings.accent.onAccent)
                    .frame(width: 60, height: 60)
                    .background(model.settings.accent.color, in: .circle)
                if let found {
                    VStack(spacing: 3) {
                        Text("Your current location").font(.headline).foregroundStyle(Theme.text1)
                        Text(LocationText.coordinates(found)).monospacedDigit().foregroundStyle(Theme.text1).textSelection(.enabled)
                        if let accuracy = found.accuracy {
                            Text(LocationText.accuracy(accuracy)).font(.footnote).foregroundStyle(Theme.text2)
                        }
                    }
                } else if let error {
                    Text(error).multilineTextAlignment(.center).foregroundStyle(Theme.text1)
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Finding where you are…").foregroundStyle(Theme.text2)
                    }
                }
                Text("It's sent encrypted, like a message. Nobody else learns it, unless someone opens it on a map.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.text3)
                Spacer()
                if error != nil {
                    PrimaryButton(title: "Try again") { attempt += 1 }
                } else {
                    PrimaryButton(title: "Send location", busy: sending, action: send)
                        .disabled(found == nil)
                        .accessibilityIdentifier(A11y.Composer.sendLocation)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .background(Theme.bg1)
            .navigationTitle("Share location")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .task(id: attempt) {
            found = nil
            error = nil
            do {
                found = try await finder.locate()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func send() {
        guard let found else { return }
        sending = true
        Task {
            do {
                _ = try await model.core.session(serverId).sendMessage(conversationKey, MessageBody(location: found))
                dismiss()
                if let conversation = model.servers[serverId]?.conversation(conversationKey) { await model.sentTo(serverId, conversation) }
            } catch {
                model.toast(OnboardingText.describe(error), .error)
                sending = false
            }
        }
    }
}
