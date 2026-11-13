import Foundation
import JavaScriptCore
import Network

/// The native side of `fetch` and `WebSocket` in the core bundle. Results go
/// back to JavaScript on the core's queue through `__zunaHttpDone` and
/// `__zunaWsEvent`. Only used on the core's queue, which is what makes it safe
/// to send between closures.
final class NetworkBridge: NSObject, @unchecked Sendable {
    private let queue: DispatchQueue
    private let deliver: (_ function: String, _ arguments: [Any]) -> Void
    private lazy var session = makeSession()
    /// What adds to a conversation without saying who's sending goes on connections of its
    /// own, with TLS sessions of its own: an ephemeral session shares neither with another.
    /// Under a proxy both leave it from the same address, as docs/SOCKS5_PLAN.md says.
    private lazy var sealedSession = makeSession()

    private func makeSession() -> ProxiedSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.waitsForConnectivity = false
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        delegateQueue.maxConcurrentOperationCount = 1
        // A server that makes its own certificate is trusted by its pin, and nothing else.
        return ProxiedSession(configuration: configuration, delegate: PinnedServers.shared, delegateQueue: delegateQueue)
    }
    private var requests: [Int: URLSessionDataTask] = [:]
    private var sockets: [Int: NWConnection] = [:]
    /// Set by tests to make the network fail on purpose.
    var offline = false
    #if DEBUG
    /// Set by tests: the process exits the moment a matching response arrives.
    var crashOnResponse: (method: String, url: NSRegularExpression)?
    #endif

    init(queue: DispatchQueue, deliver: @escaping (_ function: String, _ arguments: [Any]) -> Void) {
        self.queue = queue
        self.deliver = deliver
    }

    /// Fails everything in flight the way losing the network would, so the core notices and
    /// reconnects later: when testing, or once the proxy changed, so that nothing stays open the old way.
    func cancelAll() {
        for (id, task) in requests {
            task.cancel()
            deliver("__zunaHttpDone", [id, 0, "{}", NSNull(), "The network connection was lost."])
        }
        requests.removeAll()
        for id in Array(sockets.keys) {
            socketClosed(id: id, code: 1006, error: true)
        }
    }

    func install(into object: JSValue) {
        let http: @convention(block) (Double, String, String, String, JSValue, Double, Bool) -> Void = {
            [unowned self] id, method, url, headers, body, timeoutMs, sealed in
            request(id: Int(id), method: method, url: url, headers: headers, body: body, timeoutMs: timeoutMs, sealed: sealed)
        }
        object.setObject(http, forKeyedSubscript: "http" as NSString)

        let httpCancel: @convention(block) (Double) -> Void = { [unowned self] id in
            requests.removeValue(forKey: Int(id))?.cancel()
        }
        object.setObject(httpCancel, forKeyedSubscript: "httpCancel" as NSString)

        let wsOpen: @convention(block) (Double, String) -> Void = { [unowned self] id, url in
            openSocket(id: Int(id), url: url)
        }
        object.setObject(wsOpen, forKeyedSubscript: "wsOpen" as NSString)

        let wsSend: @convention(block) (Double, String) -> Void = { [unowned self] id, text in
            sendText(id: Int(id), text: text)
        }
        object.setObject(wsSend, forKeyedSubscript: "wsSend" as NSString)

        let wsClose: @convention(block) (Double, Double) -> Void = { [unowned self] id, code in
            closeSocket(id: Int(id), code: UInt16(code))
        }
        object.setObject(wsClose, forKeyedSubscript: "wsClose" as NSString)

        let pinServer: @convention(block) (String, String) -> Bool = { url, pin in
            PinnedServers.shared.add(url: url, pin: pin)
        }
        object.setObject(pinServer, forKeyedSubscript: "pinServer" as NSString)
    }

    // MARK: HTTP

    private func request(id: Int, method: String, url: String, headers: String, body: JSValue, timeoutMs: Double, sealed: Bool) {
        guard !offline, let target = URL(string: url) else {
            deliver("__zunaHttpDone", [id, 0, "{}", NSNull(), offline ? "The network is offline." : "Invalid URL"])
            return
        }
        // Under a proxy, nothing the system would reach around it.
        if NetworkProxy.current != nil, NetworkProxy.goesAround(target.host ?? "") {
            deliver("__zunaHttpDone", [id, 0, "{}", NSNull(), NetworkProxy.goesAroundMessage])
            return
        }
        var request = URLRequest(url: target)
        request.httpMethod = method
        if timeoutMs > 0 { request.timeoutInterval = timeoutMs / 1000 }
        if let data = headers.data(using: .utf8),
           let fields = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            for (name, value) in fields { request.setValue(value, forHTTPHeaderField: name) }
        }
        if let bytes = JSBytes.read(body) {
            request.httpBody = bytes
        } else if body.isString {
            request.httpBody = body.toString().data(using: .utf8)
        }
        let task = (sealed ? sealedSession : session).session.dataTask(with: request) { [weak self] data, response, error in
            guard let self, requests.removeValue(forKey: id) != nil else { return }
            #if DEBUG
            if let crash = crashOnResponse, error == nil, crash.method == method,
               crash.url.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil {
                // Like the app being killed after the server acted on a request, before we could.
                exit(9)
            }
            #endif
            if let error {
                deliver("__zunaHttpDone", [id, 0, "{}", NSNull(), error.localizedDescription])
                return
            }
            let http = response as? HTTPURLResponse
            var fields: [String: String] = [:]
            for (name, value) in http?.allHeaderFields ?? [:] {
                fields[String(describing: name).lowercased()] = String(describing: value)
            }
            let json = (try? JSONSerialization.data(withJSONObject: fields)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            deliver("__zunaHttpDone", [id, http?.statusCode ?? 0, json, data ?? Data(), NSNull()])
        }
        requests[id] = task
        task.resume()
    }

    // MARK: WebSocket

    private func openSocket(id: Int, url: String) {
        let proxy = NetworkProxy.current
        guard !offline, let target = URL(string: url), proxy == nil || !NetworkProxy.goesAround(target.host ?? "") else {
            queue.async { self.socketClosed(id: id, code: 1006, error: true) }
            return
        }
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = 16 << 20
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 15
        let parameters = target.scheme == "wss"
            ? NWParameters(tls: PinnedServers.shared.tls(host: target.host ?? "", queue: queue), tcp: tcp)
            : NWParameters(tls: nil, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        NetworkProxy.apply(proxy, to: parameters)
        let connection = NWConnection(to: .url(target), using: parameters)
        sockets[id] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, sockets[id] === connection else { return }
            switch state {
            case .ready:
                deliver("__zunaWsEvent", [id, "open", NSNull(), 0])
                receive(id: id, on: connection)
            case .waiting, .failed:
                // A browser reports an unreachable server as an error and then a close.
                socketClosed(id: id, code: 1006, error: true)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(id: Int, on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] content, context, _, error in
            guard let self, let connection, sockets[id] === connection else { return }
            if error != nil {
                socketClosed(id: id, code: 1006, error: true)
                return
            }
            if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch metadata.opcode {
                case .text:
                    let text = content.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    deliver("__zunaWsEvent", [id, "message", text, 0])
                case .close:
                    socketClosed(id: id, code: closeCode(metadata.closeCode), error: false)
                    return
                default:
                    break
                }
            }
            receive(id: id, on: connection)
        }
    }

    private func sendText(id: Int, text: String) {
        guard let connection = sockets[id] else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent)
    }

    private func closeSocket(id: Int, code: UInt16) {
        guard let connection = sockets[id] else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = code == 1000 ? .protocolCode(.normalClosure) : .privateCode(code)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
        socketClosed(id: id, code: code, error: false)
    }

    private func socketClosed(id: Int, code: UInt16, error: Bool) {
        guard let connection = sockets.removeValue(forKey: id) else { return }
        connection.cancel()
        if error { deliver("__zunaWsEvent", [id, "error", NSNull(), 0]) }
        deliver("__zunaWsEvent", [id, "close", NSNull(), Int(code)])
    }

    private func closeCode(_ code: NWProtocolWebSocket.CloseCode) -> UInt16 {
        switch code {
        case let .protocolCode(value): return value.rawValue
        case let .applicationCode(value): return value
        case let .privateCode(value): return value
        @unknown default: return 1006
        }
    }
}
