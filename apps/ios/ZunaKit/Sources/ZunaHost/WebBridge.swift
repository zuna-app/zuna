import Foundation
import ImageIO
import JavaScriptCore
import UniformTypeIdentifiers

/// Link previews: fetches the page a link points to, and shrinks its picture,
/// for the core's `WebAdapter` (links.ts). Requests keep no cookies or cache,
/// stop after the bytes a preview needs, and follow only redirects to
/// addresses previews allow. Results go back on the core's queue through
/// `__zunaWebDone`.
final class WebBridge: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private static let userAgent = "Mozilla/5.0 (compatible; Zuna link preview)"
    private static let maxRedirects = 5

    private let queue: DispatchQueue
    private let deliver: (_ function: String, _ arguments: [Any]) -> Void
    private lazy var session: URLSession = {
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
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    private struct Fetch {
        let id: Int
        let maxBytes: Int
        var data = Data()
        var redirects = 0
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
        guard url.scheme == "https" else { return false }
        if host.contains(":") || host.allSatisfy({ $0.isNumber || $0 == "." }) { return !privateAddress(host) }
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        let local = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"]
        return name.contains(".") && !local.contains { name.hasSuffix($0) }
    }

    /// Whether an address, as a resolver gives it, is on this device or a private network (privateAddress in links.ts).
    static func privateAddress(_ address: String) -> Bool {
        let text = address.lowercased()
        if text.contains(":") {
            if text.hasPrefix("::ffff:") || (text.hasPrefix("::") && text.contains(".")) {
                let inner = String(text.dropFirst(text.hasPrefix("::ffff:") ? 7 : 2))
                if inner.contains(".") { return privateAddress(inner) }
                let parts = inner.split(separator: ":").compactMap { Int($0, radix: 16) }
                guard parts.count == 2 else { return true }
                return privateAddress("\(parts[0] >> 8).\(parts[0] & 255).\(parts[1] >> 8).\(parts[1] & 255)")
            }
            return text == "::" || text == "::1" || text.hasPrefix("fc") || text.hasPrefix("fd") || text.hasPrefix("fe8") || text.hasPrefix("fe9")
                || text.hasPrefix("fea") || text.hasPrefix("feb") || text.hasPrefix("ff")
        }
        let parts = text.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return true }
        let (a, b) = (parts[0], parts[1])
        return a == 0 || a == 10 || a == 127 || (a == 100 && (64...127).contains(b)) || (a == 169 && b == 254)
            || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)) || a >= 224
    }

    /// Whether a link leads somewhere public: a public name can point at this
    /// device or a private network, and what a preview finds there would go into
    /// the message. The answer comes on the core's queue.
    private func checkDestination(_ url: URL, then done: @escaping (Bool) -> Void) {
        guard Self.previewable(url), let host = url.host?.lowercased() else {
            done(false)
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
            let task = session.dataTask(with: target)
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
            finish(dataTask, error: nil)
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(task, error: error)
    }

    private func finish(_ task: URLSessionTask, error: Error?) {
        guard let fetch = fetches.removeValue(forKey: task.taskIdentifier) else { return }
        let response = task.response as? HTTPURLResponse
        guard error == nil, let response, (200..<300).contains(response.statusCode), Self.previewable(response.url) else {
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
