import Security
import XCTest
@testable import ZunaHost

final class PinnedServersTests: XCTestCase {
    /// A server's own certificate, for 192.168.1.10, and its pin as `openssl` hashes its key.
    private static let certificate = "MIIBczCCARmgAwIBAgIUKjhn20QEkmquKe308D/UhIF5N7gwCgYIKoZIzj0EAwIwFzEVMBMGA1UEAwwMMTkyLjE2OC4xLjEwMB4XDTI2MTEwNTE2NTU1N1oXDTI3MTIwNzE2NTU1N1owFzEVMBMGA1UEAwwMMTkyLjE2OC4xLjEwMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzX0NAlwgvnDHQAvxkzzubTTcFbMVHwO1e+3IZrsFgpWhYj2qiHkmBCqh3kUYOZUfAJjcVtGXD9gSLkEGY2f4m6NDMEEwHQYDVR0OBBYEFK34xJgD7OYbalXk2DJYHNUFpPBiMA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEwKgBCjAKBggqhkjOPQQDAgNIADBFAiEAmkGAMZ0zh+y2b5X0FDB0Ezp5HXtkq9rol/rtoP526XUCIHMuonzYBNKYSVedmHQMvkTHxb5Kus997Z/Mqmjbm5TE"
    private static let pin = "VD-Ikn5cNN0KSCr99lLkkNSqllK1AH9BBobkHYVBcbA"

    func testThePinIsTheHashOfTheKeyAsTheServerAndTheDesktopMakeIt() throws {
        let der = try XCTUnwrap(Data(base64Encoded: Self.certificate))
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        XCTAssertEqual(PinnedServers.pin(of: certificate), Self.pin)
    }

    func testOnlyAnAddressOverHTTPSCanHaveAPin() {
        let pinned = PinnedServers()
        XCTAssertTrue(pinned.add(url: "https://192.168.1.10", pin: Self.pin))
        XCTAssertTrue(pinned.add(url: "https://[2001:db8::1]:8443", pin: Self.pin))
        XCTAssertEqual(pinned.pins(for: "2001:db8::1"), [Self.pin])
        XCTAssertEqual(pinned.pins(for: "[2001:db8::1]"), [Self.pin])
        // A name never gets one, so no link can replace the certificate of where updates or pushes come from.
        XCTAssertFalse(pinned.add(url: "https://relay.example.com", pin: Self.pin))
        XCTAssertFalse(pinned.add(url: "http://192.168.1.11", pin: Self.pin))
        XCTAssertFalse(pinned.add(url: "https://192.168.1.12", pin: "cut-short"))
        XCTAssertNil(pinned.pins(for: "relay.example.com"))
        XCTAssertNil(pinned.pins(for: "192.168.1.11"))
    }

    func testACertificateIsTrustedByItsPinAndNothingElse() throws {
        let der = try XCTUnwrap(Data(base64Encoded: Self.certificate))
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        let made = try XCTUnwrap(trust)
        XCTAssertTrue(PinnedServers.accepts(made, [Self.pin]))
        XCTAssertFalse(PinnedServers.accepts(made, ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]))
        XCTAssertFalse(PinnedServers.accepts(made, []))

        // A connection to a pinned address checks its pin, and any other the system's way; both get TLS.
        let pinned = PinnedServers()
        XCTAssertTrue(pinned.add(url: "https://192.168.1.10", pin: Self.pin))
        let queue = DispatchQueue(label: "pins")
        XCTAssertNotNil(pinned.tls(host: "192.168.1.10", queue: queue).securityProtocolOptions)
        XCTAssertNotNil(pinned.tls(host: "chat.example", queue: queue).securityProtocolOptions)
        // What the app fetches from a server itself has a session of its own.
        XCTAssertTrue(pinned.session === pinned.session)
    }
}
