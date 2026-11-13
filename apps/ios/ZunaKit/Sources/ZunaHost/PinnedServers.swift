import CryptoKit
import Foundation
import Network
import Security

/// Servers reached by their IP address, which make their own certificate: the pins
/// from their links, by address, which the core hands over (`pinServer`) before
/// anything reaches such a server. Its certificate is trusted by its key matching
/// one, and nothing else. Every other certificate is the system's to judge.
public final class PinnedServers: NSObject, URLSessionDelegate, @unchecked Sendable {
    public static let shared = PinnedServers()

    private let lock = NSLock()
    private var pins: [String: Set<String>] = [:]

    /// For what the app fetches from a server itself, such as its picture, through the proxy when one is set.
    public var session: URLSession { proxied.session }
    private lazy var proxied = ProxiedSession(configuration: .default, delegate: self)

    /// Only an address over HTTPS can have a pin (`checkPinnable` in the core), never a
    /// name, so nothing can have the app trust another key for one.
    @discardableResult
    public func add(url: String, pin: String) -> Bool {
        guard let components = URLComponents(string: url), components.scheme == "https",
              let host = components.host.map(Self.bare), IPv4Address(host) != nil || IPv6Address(host) != nil,
              pin.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return false }
        lock.withLock { _ = pins[host, default: []].insert(pin) }
        return true
    }

    func pins(for host: String) -> Set<String>? {
        lock.withLock { pins[Self.bare(host)] }
    }

    /// What URLSession should do about a server's certificate.
    public func judge(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let wanted = pins(for: challenge.protectionSpace.host) else { return (.performDefaultHandling, nil) }
        guard let trust = challenge.protectionSpace.serverTrust, Self.accepts(trust, wanted) else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: trust))
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (disposition, credential) = judge(challenge)
        completionHandler(disposition, credential)
    }

    /// TLS for a Network.framework connection to `host`, checking its pin if it has one.
    func tls(host: String, queue: DispatchQueue) -> NWProtocolTLS.Options {
        let options = NWProtocolTLS.Options()
        if let wanted = pins(for: host) {
            sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, complete in
                complete(Self.accepts(sec_trust_copy_ref(trust).takeRetainedValue(), wanted))
            }, queue)
        }
        return options
    }

    static func accepts(_ trust: SecTrust, _ wanted: Set<String>) -> Bool {
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first, let pin = pin(of: leaf) else { return false }
        return wanted.contains(pin)
    }

    /// The SHA-256 of a certificate's SubjectPublicKeyInfo, in base64url, as links carry
    /// it. Servers make P-256 keys, whose SubjectPublicKeyInfo is this header and the point.
    static func pin(of certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              (attributes[kSecAttrKeySizeInBits] as? NSNumber)?.intValue == 256,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data?, point.count == 65 else { return nil }
        let digest = Data(SHA256.hash(data: p256Header + point))
        return digest.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static let p256Header = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])

    /// An address as a host name, with an IPv6 one out of its brackets.
    static func bare(_ host: String) -> String {
        host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
    }
}
