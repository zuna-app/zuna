import Foundation
import Network

/// A SOCKS5 proxy everything this device sends goes through (docs/SOCKS5_PLAN.md). The app sets it
/// from its setting before its core starts, and the extensions from the same setting before theirs,
/// so nothing connects around it. Names are left to the proxy, and nothing falls back to going
/// direct when it can't be reached.
public struct NetworkProxy: Equatable, Sendable, CustomStringConvertible {
    public var host: String
    public var port: UInt16
    public var username: String
    public var password: String

    public init(host: String, port: UInt16, username: String = "", password: String = "") {
        self.host = PinnedServers.bare(host)
        self.port = port
        self.username = username
        self.password = password
    }

    /// From `socks5://user:password@host:port`, as the command-line host and the checks give it.
    public init?(url text: String) {
        guard let components = URLComponents(string: text), ["socks5", "socks5h"].contains(components.scheme?.lowercased() ?? ""),
              let host = components.host, !host.isEmpty, let port = components.port, (1...65535).contains(port) else { return nil }
        self.init(host: host, port: UInt16(port), username: components.user ?? "", password: components.password ?? "")
    }

    /// Its address, with no username or password.
    public var description: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }

    var signsIn: Bool { !username.isEmpty || !password.isEmpty }

    /// The system's own SOCKS5, which sends names for the proxy to look up, and never goes around it.
    public var configuration: ProxyConfiguration {
        var configuration = ProxyConfiguration(socksv5Proxy: .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any))
        if signsIn { configuration.applyCredential(username: username, password: password) }
        configuration.allowFailover = false
        return configuration
    }

    // MARK: The one this process uses

    private static let lock = NSLock()
    nonisolated(unsafe) private static var set: NetworkProxy?
    nonisolated(unsafe) private static var changes = 0

    /// The proxy this process goes through, or nil.
    public static var current: NetworkProxy? { lock.withLock { set } }

    /// The proxy and how many times it has changed, read together.
    static var state: (proxy: NetworkProxy?, generation: Int) { lock.withLock { (set, changes) } }

    /// Sets the proxy this process goes through, and says whether that changed it. Sessions made
    /// after it go the new way; a runtime is told with `CoreRuntime.networkChanged`, which closes
    /// what it has open.
    @discardableResult
    public static func use(_ proxy: NetworkProxy?) -> Bool {
        lock.withLock {
            guard set != proxy else { return false }
            set = proxy
            changes += 1
            return true
        }
    }

    /// A URLSession's configuration through the proxy given, or as it was without one.
    public static func apply(_ proxy: NetworkProxy?, to configuration: URLSessionConfiguration) {
        configuration.proxyConfigurations = proxy.map { [$0.configuration] } ?? []
    }

    /// A Network connection's parameters through the proxy given.
    static func apply(_ proxy: NetworkProxy?, to parameters: NWParameters) {
        guard let proxy else { return }
        let context = NWParameters.PrivacyContext(description: "Zuna's proxy")
        context.proxyConfigurations = [proxy.configuration]
        parameters.setPrivacyContext(context)
    }

    // MARK: What the system reaches around it

    /// What the app says when it won't connect to somewhere the system would reach around the proxy.
    public static let goesAroundMessage = "A proxy can't reach this device, and connecting directly would bypass the proxy."

    /// Whether the system would reach `host` around a proxy, as it does for this device itself:
    /// `localhost`, the loopback, link-local and unique local addresses, and the addresses this
    /// device has on its networks, which Network sends straight there with `allowFailover` off
    /// (tried on macOS 27, docs/SOCKS5_PLAN.md). Under a proxy, those are refused. Every other name,
    /// `*.localhost` among them, and every other address, private ones among them, went to the proxy.
    public static func goesAround(_ host: String) -> Bool {
        var name = PinnedServers.bare(host).lowercased()
        while name.hasSuffix(".") { name.removeLast() }
        if name == "localhost" { return true }
        if let address = IPv4Address(name) {
            return special(address) || ownAddresses().contains(address.rawValue)
        }
        if let address = IPv6Address(name.split(separator: "%").first.map(String.init) ?? name) {
            if let mapped = address.asIPv4 { return special(mapped) || ownAddresses().contains(mapped.rawValue) }
            let first = address.rawValue.first ?? 0
            return address.isLoopback || address.isAny || address.isLinkLocal || address.isMulticast
                || first & 0xfe == 0xfc || ownAddresses().contains(address.rawValue)
        }
        return false
    }

    /// Whether an address is this device's own: its loopback, or one it has on a network.
    static func isThisDevice(_ host: String) -> Bool {
        let bare = PinnedServers.bare(host).split(separator: "%").first.map(String.init) ?? host
        if let address = IPv4Address(bare) { return address.isLoopback || ownAddresses().contains(address.rawValue) }
        if let address = IPv6Address(bare) {
            if let mapped = address.asIPv4 { return mapped.isLoopback || ownAddresses().contains(mapped.rawValue) }
            return address.isLoopback || ownAddresses().contains(address.rawValue)
        }
        return false
    }

    private static func special(_ address: IPv4Address) -> Bool {
        let bytes = [UInt8](address.rawValue)
        return bytes[0] == 127 || bytes[0] == 0 || (bytes[0] == 169 && bytes[1] == 254) || bytes[0] >= 224
    }

    /// The addresses this device has on its networks, as raw bytes.
    private static func ownAddresses() -> Set<Data> {
        var found = Set<Data>()
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return found }
        defer { freeifaddrs(list) }
        var current = list
        while let entry = current {
            if let address = entry.pointee.ifa_addr {
                switch Int32(address.pointee.sa_family) {
                case AF_INET:
                    address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        var raw = $0.pointee.sin_addr
                        found.insert(Data(bytes: &raw, count: 4))
                    }
                case AF_INET6:
                    address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                        var raw = $0.pointee.sin6_addr
                        found.insert(Data(bytes: &raw, count: 16))
                    }
                default:
                    break
                }
            }
            current = entry.pointee.ifa_next
        }
        return found
    }
}

/// A URLSession through the proxy that's set, made again whenever it changes, which cancels what
/// the one before still had going.
public final class ProxiedSession: @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private let delegate: URLSessionDelegate?
    private let delegateQueue: OperationQueue?
    private let lock = NSLock()
    private var made: (generation: Int, session: URLSession)?

    public init(configuration: URLSessionConfiguration, delegate: URLSessionDelegate? = nil, delegateQueue: OperationQueue? = nil) {
        self.configuration = configuration
        self.delegate = delegate
        self.delegateQueue = delegateQueue
    }

    public var session: URLSession {
        lock.withLock {
            let (proxy, generation) = NetworkProxy.state
            if let made, made.generation == generation { return made.session }
            made?.session.invalidateAndCancel()
            let configuration = self.configuration.copy() as! URLSessionConfiguration
            NetworkProxy.apply(proxy, to: configuration)
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: delegateQueue)
            made = (generation, session)
            return session
        }
    }

    /// The configuration sessions are made from, before the proxy.
    public var baseConfiguration: URLSessionConfiguration { configuration }
}
