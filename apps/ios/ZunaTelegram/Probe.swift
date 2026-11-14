#if DEBUG
import Darwin
import Foundation
import Security

/// What the box must refuse, tried from inside it, as `zuna-telegram --probe` does on the desktop:
/// Debug builds alone, asked by the app with `{"zuna":"probe"}`. Each answer says what happened,
/// and the app's check holds each to what it should be. The simulator keeps nothing in a box, so
/// only a phone's answers count: there, on iOS 27.0.1, its own container, its loopback, the network
/// and the system's random numbers were allowed, and the rest refused (docs/TELEGRAM_PLAN.md).
enum Probe {
    static func run(app: String, door: Door?) -> [String: String] {
        var results: [String: String] = [:]
        results["folder"] = Helper.folder.path

        // Its own folder: written, moved within, and read back.
        do {
            let folder = Helper.folder.appendingPathComponent("probe", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("a")
            try Data("probe".utf8).write(to: file)
            try FileManager.default.moveItem(at: file, to: folder.appendingPathComponent("b"))
            try FileManager.default.removeItem(at: folder)
            results["own folder"] = "allowed"
        } catch {
            results["own folder"] = "refused: \(error.localizedDescription)"
        }

        // Writing anywhere but there: the app's data, the rest of its own container, and outside it.
        let manager = FileManager.default
        var places = [
            ("write Caches", manager.urls(for: .cachesDirectory, in: .userDomainMask)[0].path),
            ("write temporary", NSTemporaryDirectory()),
            ("write outside its container", "/private/var/tmp"),
        ]
        if !app.isEmpty { places.append(("write app's data", app)) }
        for (name, folder) in places {
            let file = URL(fileURLWithPath: folder).appendingPathComponent("zuna-probe-\(getpid())")
            do {
                try Data("probe".utf8).write(to: file)
                try manager.removeItem(at: file)
                results[name] = "allowed (\(folder))"
            } catch {
                results[name] = "refused (\(folder))"
            }
        }

        // The app's data, and the rest of the disk.
        for (name, path) in [("app's data", app), ("app group", "/private/var/mobile/Containers/Shared/AppGroup"), ("other apps", "/private/var/mobile/Containers/Data/Application"), ("media", "/private/var/mobile/Media/DCIM")] where !path.isEmpty {
            results[name] = (try? FileManager.default.contentsOfDirectory(atPath: path)).map { "allowed (\($0.count) entries)" } ?? "refused"
        }

        // The network: its own loopback, which the door needs, and anywhere else, which it mustn't reach.
        results["own loopback"] = door.map { connect(to: "127.0.0.1", port: $0.port) } ?? "no door"
        results["Telegram by address"] = connect(to: "149.154.167.40", port: 443)
        results["internet by address"] = connect(to: "1.1.1.1", port: 443)
        var found: UnsafeMutablePointer<addrinfo>?
        let resolved = getaddrinfo("example.com", "443", nil, &found)
        results["internet by name"] = resolved == 0 ? "allowed" : "refused (\(resolved))"
        if found != nil { freeaddrinfo(found) }
        let udp = socket(AF_INET, SOCK_DGRAM, 0)
        results["UDP"] = udp >= 0 ? "allowed" : "refused (\(errno))"
        if udp >= 0 { close(udp) }

        // Starting a program.
        var child: pid_t = 0
        let spawned = posix_spawn(&child, "/bin/sh", nil, nil, nil, nil)
        results["starting a program"] = spawned == 0 ? "allowed" : "refused (\(spawned))"

        // The keychain, which holds Zuna's own secrets in the app's groups.
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        var items: CFTypeRef?
        let keychain = SecItemCopyMatching(query as CFDictionary, &items)
        results["keychain"] = keychain == errSecSuccess ? "allowed" : "refused (\(keychain))"

        // The system's random numbers, which it needs.
        var bytes = [UInt8](repeating: 0, count: 16)
        results["random numbers"] = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess ? "allowed" : "refused"
        return results
    }

    private static func connect(to host: String, port: UInt16) -> String {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { return "refused (socket: \(errno))" }
        defer { close(socket) }
        var time = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr(host)
        address.sin_port = port.bigEndian
        let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        return connected == 0 ? "allowed" : "refused (\(String(cString: strerror(errno))))"
    }
}
#endif
