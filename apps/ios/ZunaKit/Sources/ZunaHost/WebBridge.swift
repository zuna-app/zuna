import Foundation
import ImageIO
import JavaScriptCore
import UniformTypeIdentifiers

/// Link previews: fetches the page a link points to, and shrinks its picture,
/// for the core's `WebAdapter` (links.ts). Requests keep no cookies or cache,
/// stop after the bytes a preview needs, and follow only redirects to
/// addresses previews allow. What they fetched only goes back if every
/// connection really went somewhere public. Results go back on the core's
/// queue through `__zunaWebDone`.
final class WebBridge: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private static let userAgent = "Mozilla/5.0 (compatible; Zuna link preview)"
    private static let maxRedirects = 5

    private let queue: DispatchQueue
    private let deliver: (_ function: String, _ arguments: [Any]) -> Void
    private lazy var session: ProxiedSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 10
        configuration.httpAdditionalHeaders = ["User-Agent": Self.userAgent, "Accept": "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5"]
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        delegateQueue.maxConcurrentOperationCount = 1
        return ProxiedSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    private struct Fetch {
        let id: Int
        let maxBytes: Int
        var data = Data()
        var redirects = 0
        /// Whether every connection went somewhere public, once the session says where they went.
        var wentPublic: Bool?
        /// How the task ended, once it has.
        var ended: (response: URLResponse?, error: Error?)?
    }

    private var fetches: [Int: Fetch] = [:]

    init(queue: DispatchQueue, deliver: @escaping (_ function: String, _ arguments: [Any]) -> Void) {
        self.queue = queue
        self.deliver = deliver
    }

    /// Test builds' previews may reach this device, for their test pages. A released app never does.
    private static func isTestPage(_ host: String) -> Bool {
        #if DEBUG
        ["localhost", "127.0.0.1", "::1"].contains(host) || host.hasSuffix(".localhost")
        #else
        false
        #endif
    }

    /// HTTPS to somewhere public (previewable in links.ts). Pages can redirect
    /// anywhere, so this is checked again for every address along the way.
    static func previewable(_ url: URL?) -> Bool {
        guard let url, let host = url.host?.lowercased() else { return false }
        if isTestPage(host) { return url.scheme == "https" || url.scheme == "http" }
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        if host.contains(":") || host.allSatisfy({ $0.isNumber || $0 == "." }) { return !privateAddress(host) }
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        let local = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"]
        return name.contains(".") && !local.contains { name.hasSuffix($0) }
    }

    /// Whether an address, as a resolver gives it, is on this device or a private network (privateAddress in links.ts).
    static func privateAddress(_ address: String) -> Bool {
        if address.contains(":") {
            guard let bytes = ipv6Bytes(address) else { return true }
            if inRange(bytes, ipv6Bytes("::ffff:0:0") ?? [], bits: 96) {
                return privateAddress(bytes[12...].map { String($0) }.joined(separator: "."))
            }
            return privateIPv6.contains { inRange(bytes, $0.network, bits: $0.bits) }
        }
        let parts = address.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return true }
        let (a, b, c) = (parts[0], parts[1], parts[2])
        return a == 0 || a == 10 || a == 127 || (a == 100 && (64...127).contains(b)) || (a == 169 && b == 254)
            || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 0 && (c == 0 || c == 2)) || (a == 192 && b == 168)
            || (a == 198 && (b == 18 || b == 19)) || (a == 198 && b == 51 && c == 100) || (a == 203 && b == 0 && c == 113) || a >= 224
    }

    /// Besides this device and private networks: documentation, and the ways of carrying
    /// IPv4 inside IPv6, which can lead anywhere in IPv4 with none of the checks on it.
    private static let privateIPv6: [(network: [UInt8], bits: Int)] = [
        ("::", 96), ("64:ff9b::", 96), ("64:ff9b:1::", 48), ("100::", 64), ("2001::", 32), ("2001:db8::", 32),
        ("2002::", 16), ("fc00::", 7), ("fe80::", 10), ("fec0::", 10), ("ff00::", 8),
    ].map { (network: ipv6Bytes($0.0) ?? [], bits: $0.1) }

    private static func ipv6Bytes(_ text: String) -> [UInt8]? {
        var address = in6_addr()
        guard inet_pton(AF_INET6, text, &address) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    private static func inRange(_ bytes: [UInt8], _ network: [UInt8], bits: Int) -> Bool {
        guard bytes.count == 16, network.count == 16 else { return false }
        for index in 0..<16 {
            let used = min(max(bits - index * 8, 0), 8)
            let mask = UInt8(truncatingIfNeeded: 0xff << (8 - used))
            if bytes[index] & mask != network[index] & mask { return false }
        }
        return true
    }

    /// Whether each connection a fetch made went where previews may go, by the
    /// address the network says it reached. A name checked beforehand can lead
    /// somewhere else by the time it's used. A proxy's own address says nothing
    /// about where it went, and an address the system doesn't give can't be checked,
    /// so those go by the check beforehand.
    static func wentPublic(_ connections: [(host: String?, address: String?, proxy: Bool)]) -> Bool {
        connections.allSatisfy { connection in
            if connection.proxy || isTestPage(connection.host?.lowercased() ?? "") { return true }
            return connection.address.map { !privateAddress($0) } ?? true
        }
    }

    /// Whether a link leads somewhere public: a public name can point at this
    /// device or a private network, and what a preview finds there would go into
    /// the message. The answer comes on the core's queue. Under a proxy it goes by
    /// the name and the address alone, as this device can't look a name up without
    /// telling its resolver, and where a name leads is the proxy's to say.
    private func checkDestination(_ url: URL, then done: @escaping (Bool) -> Void) {
        guard Self.previewable(url), let host = url.host?.lowercased() else {
            done(false)
            return
        }
        if NetworkProxy.current != nil {
            done(!NetworkProxy.goesAround(host))
            return
        }
        if Self.isTestPage(host) {
            done(true)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [queue] in
            var hints = addrinfo()
            hints.ai_socktype = SOCK_STREAM
            var results: UnsafeMutablePointer<addrinfo>?
            var safe = false
            if getaddrinfo(host, nil, &hints, &results) == 0 {
                safe = true
                var current = results
                while let entry = current {
                    var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(entry.pointee.ai_addr, entry.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) != 0
                        || Self.privateAddress(String(decoding: name.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)) {
                        safe = false
                    }
                    current = entry.pointee.ai_next
                }
                freeaddrinfo(results)
            }
            queue.async { done(safe) }
        }
    }

    func install(into object: JSValue) {
        let webFetch: @convention(block) (Double, String, Double) -> Void = { [unowned self] id, url, maxBytes in
            fetch(id: Int(id), url: url, maxBytes: Int(maxBytes))
        }
        object.setObject(webFetch, forKeyedSubscript: "webFetch" as NSString)

        let imageShrink: @convention(block) (JSValue, Double) -> JSValue = { bytes, maxSize in
            let context = JSContext.current()!
            guard let data = JSBytes.read(bytes), let shrunk = Self.shrink(data, maxSize: Int(maxSize)) else {
                return JSValue(nullIn: context)
            }
            return JSValue(object: ["data": shrunk.data, "width": shrunk.width, "height": shrunk.height], in: context)
        }
        object.setObject(imageShrink, forKeyedSubscript: "imageShrink" as NSString)
    }

    private func fetch(id: Int, url: String, maxBytes: Int) {
        guard let target = URL(string: url), Self.previewable(target) else {
            deliver("__zunaWebDone", [id, url, "", NSNull(), "That link can't be previewed."])
            return
        }
        checkDestination(target) { [self] safe in
            guard safe else {
                deliver("__zunaWebDone", [id, url, "", NSNull(), "That link can't be previewed."])
                return
            }
            let task = session.session.dataTask(with: target)
            fetches[task.taskIdentifier] = Fetch(id: id, maxBytes: maxBytes)
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        fetches[task.taskIdentifier]?.redirects += 1
        guard (fetches[task.taskIdentifier]?.redirects ?? .max) <= Self.maxRedirects, let target = request.url else {
            completionHandler(nil)
            return
        }
        checkDestination(target) { safe in completionHandler(safe ? request : nil) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard var fetch = fetches[dataTask.taskIdentifier] else { return }
        fetch.data.append(data)
        fetches[dataTask.taskIdentifier] = fetch
        // Only as much as a preview needs, however large the page is.
        if fetch.data.count >= fetch.maxBytes {
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let connections = metrics.transactionMetrics.filter { $0.resourceFetchType == .networkLoad }.map {
            (host: $0.request.url?.host, address: $0.remoteAddress, proxy: $0.isProxyConnection)
        }
        // Through a proxy, each connection's address is the proxy's, which says nothing about where it went.
        fetches[task.taskIdentifier]?.wentPublic = NetworkProxy.current != nil || Self.wentPublic(connections)
        finish(task.taskIdentifier)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        fetches[task.taskIdentifier]?.ended = (task.response, error)
        finish(task.taskIdentifier)
        // The metrics come first. Should they never come, the fetch can't be checked, so it's refused.
        let identifier = task.taskIdentifier
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, let fetch = self.fetches[identifier], fetch.wentPublic == nil else { return }
            self.fetches[identifier]?.wentPublic = false
            self.finish(identifier)
        }
    }

    /// Sends back what was fetched, once the task has ended and where it went is known.
    private func finish(_ identifier: Int) {
        guard let fetch = fetches[identifier], let ended = fetch.ended, let wentPublic = fetch.wentPublic else { return }
        fetches.removeValue(forKey: identifier)
        // A task cancelled for having all a preview needs ended well.
        let error = fetch.data.count >= fetch.maxBytes ? nil : ended.error
        let response = ended.response as? HTTPURLResponse
        guard wentPublic, error == nil, let response, (200..<300).contains(response.statusCode), Self.previewable(response.url) else {
            deliver("__zunaWebDone", [fetch.id, "", "", NSNull(), error?.localizedDescription ?? "The page isn't available."])
            return
        }
        var type = response.mimeType ?? ""
        var body = fetch.data.prefix(fetch.maxBytes)
        // The core reads pages as UTF-8, so a page the server says is in another encoding is converted here.
        if let name = response.textEncodingName, type.hasPrefix("text/") || type.contains("html") {
            let encoding = CFStringConvertEncodingToNSStringEncoding(CFStringConvertIANACharSetNameToEncoding(name as CFString))
            if encoding != String.Encoding.utf8.rawValue, let text = String(data: body, encoding: String.Encoding(rawValue: encoding)) {
                body = Data(text.utf8)
            }
            type += "; charset=utf-8"
        }
        deliver("__zunaWebDone", [fetch.id, response.url?.absoluteString ?? "", type, Data(body), NSNull()])
    }

    /// A picture shrunk to fit within `maxSize` pixels, on white, as a JPEG data URL.
    static func shrink(_ data: Data, maxSize: Int) -> (data: String, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxSize,
              ] as CFDictionary) else { return nil }
        let width = image.width, height = image.height
        // JPEG has no transparency; logos are usually drawn for a light page.
        guard let canvas = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        canvas.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        canvas.fill(CGRect(x: 0, y: 0, width: width, height: height))
        canvas.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let flattened = canvas.makeImage() else { return nil }
        let jpeg = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, flattened, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return ("data:image/jpeg;base64,\((jpeg as Data).base64EncodedString())", width, height)
    }
}
