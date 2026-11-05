import Foundation
import LiveKit
import ObjectiveC
import os
import ZunaHost

/// LiveKit's socket to a room makes a URLSession of its own, whose delegate leaves
/// certificates to the system, so a server that makes its own certificate couldn't be
/// reached for voice. The delegate is a private class of LiveKit's, so this gives it
/// the method that checks pins (`PinnedServers`), once, before any room connects,
/// rather than keeping a fork of LiveKit. It only adds what the class doesn't have.
/// Checked against LiveKit 2.19 (`Delegate` in its `WebSocket.swift`): a newer one
/// that renames it, or checks certificates itself, makes this fail loudly in tests.
enum LiveKitPins {
    static let installed: Bool = install()

    private static func install() -> Bool {
        let logger = Logger(subsystem: "chat.zuna", category: "voice")
        guard let image = class_getImageName(Room.self) else {
            logger.error("LiveKit's classes can't be found, so voice can't reach a server with its own certificate")
            return false
        }
        var count: UInt32 = 0
        guard let names = objc_copyClassNamesForImage(image, &count) else { return false }
        defer { free(names) }
        let socketDelegate = objc_getProtocol("NSURLSessionWebSocketDelegate")
        let delegates = (0..<Int(count)).compactMap { index -> AnyClass? in
            let name = String(cString: names[index])
            guard name.contains("WebSocket"), name.hasSuffix("Delegate"), let found = objc_getClass(names[index]) as? AnyClass,
                  let socketDelegate, class_conformsToProtocol(found, socketDelegate) else { return nil }
            return found
        }
        guard delegates.count == 1, let delegate = delegates.first else {
            logger.error("Found \(delegates.count) of LiveKit's socket delegates, so voice can't reach a server with its own certificate")
            return false
        }
        let check: @convention(block) (AnyObject, URLSession, URLAuthenticationChallenge, @escaping @convention(block) (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) -> Void = { _, _, challenge, completion in
            let (disposition, credential) = PinnedServers.shared.judge(challenge)
            completion(disposition, credential)
        }
        let added = class_addMethod(delegate, NSSelectorFromString("URLSession:didReceiveChallenge:completionHandler:"), imp_implementationWithBlock(check), "v@:@@@?")
        if !added { logger.error("LiveKit's socket checks certificates itself now, so LiveKitPins.swift should go") }
        return added
    }
}
