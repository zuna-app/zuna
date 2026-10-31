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

    /// HTTPS, or plain HTTP on this device, as for servers (previewable in links.ts).
    static func previewable(_ url: URL?) -> Bool {
        guard let url, let host = url.host?.lowercased() else { return false }
        let local = ["localhost", "127.0.0.1", "::1"].contains(host) || host.hasSuffix(".localhost")
        return url.scheme == "https" || (url.scheme == "http" && local)
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
        let task = session.dataTask(with: target)
        fetches[task.taskIdentifier] = Fetch(id: id, maxBytes: maxBytes)
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        fetches[task.taskIdentifier]?.redirects += 1
        let allowed = (fetches[task.taskIdentifier]?.redirects ?? .max) <= Self.maxRedirects && Self.previewable(request.url)
        completionHandler(allowed ? request : nil)
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
