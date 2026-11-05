import Foundation
import JavaScriptCore
import ZunaCrypto

/// Installs the Rust encryption core as `__zunaCrypto`. The JavaScript shim in
/// the core bundle gives it exactly the shape of the desktop's WebAssembly
/// build, so the client core can't tell them apart.
final class CryptoBridge {
    private var clients: [Int: MlsClient] = [:]
    private var nextHandle = 1

    func install(in context: JSContext) {
        let object = JSValue(newObjectIn: context)!
        func define(_ name: String, _ block: Any) {
            object.setObject(block, forKeyedSubscript: name as NSString)
        }

        let randomBytes: @convention(block) (Double) -> JSValue = { len in
            bytes { try ZunaCrypto.randomBytes(len: UInt32(len)) }
        }
        define("randomBytes", randomBytes)

        let argon2id: @convention(block) (JSValue, JSValue, Double, Double, Double, Double) -> JSValue = {
            password, salt, memory, iterations, parallelism, outLen in
            bytes {
                try ZunaCrypto.argon2id(
                    password: data(password), salt: data(salt), memoryKib: UInt32(memory),
                    iterations: UInt32(iterations), parallelism: UInt32(parallelism), outLen: UInt32(outLen)
                )
            }
        }
        define("argon2id", argon2id)

        let hkdfSha256: @convention(block) (JSValue, JSValue, JSValue, Double) -> JSValue = { ikm, salt, info, len in
            bytes { try ZunaCrypto.hkdfSha256(ikm: data(ikm), salt: data(salt), info: data(info), len: UInt32(len)) }
        }
        define("hkdfSha256", hkdfSha256)

        let sha256: @convention(block) (JSValue) -> JSValue = { input in
            bytes { ZunaCrypto.sha256(data: data(input)) }
        }
        define("sha256", sha256)

        let aeadSeal: @convention(block) (JSValue, JSValue, JSValue) -> JSValue = { key, plaintext, aad in
            bytes { try ZunaCrypto.aeadSeal(key: data(key), plaintext: data(plaintext), aad: data(aad)) }
        }
        define("aeadSeal", aeadSeal)

        let aeadOpen: @convention(block) (JSValue, JSValue, JSValue) -> JSValue = { key, sealed, aad in
            bytes { try ZunaCrypto.aeadOpen(key: data(key), data: data(sealed), aad: data(aad)) }
        }
        define("aeadOpen", aeadOpen)

        let streamSeal: @convention(block) (JSValue, JSValue, Double, Bool, JSValue) -> JSValue = {
            key, prefix, index, last, plaintext in
            bytes {
                try ZunaCrypto.streamSeal(
                    key: data(key), prefix: data(prefix), index: UInt32(index), last: last, plaintext: data(plaintext)
                )
            }
        }
        define("streamSeal", streamSeal)

        let streamOpen: @convention(block) (JSValue, JSValue, Double, Bool, JSValue) -> JSValue = {
            key, prefix, index, last, ciphertext in
            bytes {
                try ZunaCrypto.streamOpen(
                    key: data(key), prefix: data(prefix), index: UInt32(index), last: last, ciphertext: data(ciphertext)
                )
            }
        }
        define("streamOpen", streamOpen)

        let signingKeygen: @convention(block) () -> JSValue = {
            keyPair { try ZunaCrypto.signingKeygen() }
        }
        define("signingKeygen", signingKeygen)

        let sign: @convention(block) (JSValue, JSValue) -> JSValue = { secret, message in
            bytes { try ZunaCrypto.sign(secret: data(secret), message: data(message)) }
        }
        define("sign", sign)

        let verify: @convention(block) (JSValue, JSValue, JSValue) -> Bool = { publicKey, message, signature in
            ZunaCrypto.verify(publicKey: data(publicKey), message: data(message), signature: data(signature))
        }
        define("verify", verify)

        let hpkeKeygen: @convention(block) () -> JSValue = {
            keyPair { try ZunaCrypto.hpkeKeygen() }
        }
        define("hpkeKeygen", hpkeKeygen)

        let hpkeSeal: @convention(block) (JSValue, JSValue, JSValue, JSValue) -> JSValue = {
            recipient, info, aad, plaintext in
            bytes {
                try ZunaCrypto.hpkeSeal(recipient: data(recipient), info: data(info), aad: data(aad), plaintext: data(plaintext))
            }
        }
        define("hpkeSeal", hpkeSeal)

        let hpkeOpen: @convention(block) (JSValue, JSValue, JSValue, JSValue) -> JSValue = { secret, info, aad, sealed in
            bytes { try ZunaCrypto.hpkeOpen(secret: data(secret), info: data(info), aad: data(aad), sealed: data(sealed)) }
        }
        define("hpkeOpen", hpkeOpen)

        let safetyDigest: @convention(block) (JSValue, JSValue) -> JSValue = { a, b in
            bytes { ZunaCrypto.safetyDigest(keyA: data(a), keyB: data(b)) }
        }
        define("safetyDigest", safetyDigest)

        let mlsNew: @convention(block) (JSValue, JSValue, JSValue, JSValue) -> Double = { [unowned self] pub, sec, cred, state in
            let entries = state.arrayElements.map { pair in
                StateEntry(key: data(pair.atIndex(0)), value: data(pair.atIndex(1)))
            }
            let client = MlsClient(devicePublic: data(pub), deviceSecret: data(sec), credential: data(cred), state: entries)
            let handle = nextHandle
            nextHandle += 1
            clients[handle] = client
            return Double(handle)
        }
        define("mlsNew", mlsNew)

        let mlsFree: @convention(block) (Double) -> Void = { [unowned self] handle in
            clients[Int(handle)] = nil
        }
        define("mlsFree", mlsFree)

        let mls: @convention(block) (Double, String) -> JSValue = { [unowned self] handle, method in
            let context = JSContext.current()!
            let args = (JSContext.currentArguments() as? [JSValue]) ?? []
            let arg = { (index: Int) -> JSValue? in args.count > index + 2 ? args[index + 2] : nil }
            guard let client = clients[Int(handle)] else {
                return fail("MLS client \(Int(handle)) doesn't exist", in: context)
            }
            do {
                return try callMls(client, method, arg, in: context)
            } catch {
                return fail(message(of: error), in: context)
            }
        }
        define("mls", mls)

        context.setObject(object, forKeyedSubscript: "__zunaCrypto" as NSString)
    }

    private func callMls(_ client: MlsClient, _ method: String, _ arg: @escaping (Int) -> JSValue?, in context: JSContext) throws -> JSValue {
        let object = { (fields: [(String, JSValue)]) -> JSValue in
            let value = JSValue(newObjectIn: context)!
            for (key, field) in fields { value.setObject(field, forKeyedSubscript: key as NSString) }
            return value
        }
        let array = { (items: [JSValue]) -> JSValue in
            let value = JSValue(newArrayIn: context)!
            for (index, item) in items.enumerated() { value.setObject(item, atIndexedSubscript: index) }
            return value
        }
        let b = { (bytes: Data) in JSBytes.make(bytes, in: context) }
        let optionalBytes = { (bytes: Data?) in bytes.map(b) ?? JSValue(nullIn: context)! }
        let number = { (value: UInt64) in JSValue(double: Double(value), in: context)! }
        let groupId = { data(arg(0)) }

        switch method {
        case "setCredential":
            client.setCredential(credential: data(arg(0)))
            return JSValue(undefinedIn: context)
        case "takeChanges":
            let changes = client.takeChanges()
            return object([
                ("set", array(changes.set.map { array([b($0.key), b($0.value)]) })),
                ("deleted", array(changes.deleted.map(b))),
            ])
        case "rollback":
            client.rollback()
            return JSValue(undefinedIn: context)
        case "hasGroup":
            return JSValue(bool: try client.hasGroup(groupId: groupId()), in: context)
        case "generateKeyPackage":
            return b(try client.generateKeyPackage(lastResort: arg(0)?.toBool() ?? false))
        case "keyPackageCredential":
            return b(try client.keyPackageCredential(keyPackage: groupId()))
        case "keyPackageSignatureKey":
            return b(try client.keyPackageSignatureKey(keyPackage: groupId()))
        case "createGroup":
            return number(try client.createGroup(groupId: groupId(), roster: optionalData(arg(1))))
        case "commitChanges":
            let packages = (arg(1)?.arrayElements ?? []).map { data($0) }
            let pending = try client.commitChanges(
                groupId: groupId(), keyPackages: packages, removeLeaves: JSBytes.readUInt32s(arg(2)), roster: optionalData(arg(3))
            )
            return object([
                ("commit", b(pending.commit)),
                ("welcome", optionalBytes(pending.welcome)),
                ("groupInfo", optionalBytes(pending.groupInfo)),
            ])
        case "mergePending":
            return number(try client.mergePending(groupId: groupId()))
        case "clearPending":
            try client.clearPending(groupId: groupId())
            return JSValue(undefinedIn: context)
        case "hasPending":
            return JSValue(bool: try client.hasPending(groupId: groupId()), in: context)
        case "processCommit":
            let processed = try client.processCommit(groupId: groupId(), commit: data(arg(1)))
            return object([
                ("epoch", number(processed.epoch)),
                ("senderCredential", b(processed.senderCredential)),
                ("isExternal", JSValue(bool: processed.isExternal, in: context)),
                ("addedCredentials", array(processed.addedCredentials.map(b))),
                ("removedCredentials", array(processed.removedCredentials.map(b))),
                ("selfRemoved", JSValue(bool: processed.selfRemoved, in: context)),
            ])
        case "joinFromWelcome":
            let joined = try client.joinFromWelcome(welcome: groupId(), groupId: data(arg(1)))
            return object([("groupId", b(joined.groupId)), ("epoch", number(joined.epoch))])
        case "joinExternal":
            let joined = try client.joinExternal(groupId: groupId(), groupInfo: data(arg(1)))
            return object([("commit", b(joined.commit)), ("epoch", number(joined.epoch))])
        case "exportGroupInfo":
            return b(try client.exportGroupInfo(groupId: groupId()))
        case "epoch":
            return number(try client.epoch(groupId: groupId()))
        case "roster":
            return optionalBytes(try client.roster(groupId: groupId()))
        case "ownLeafIndex":
            return JSValue(double: Double(try client.ownLeafIndex(groupId: groupId())), in: context)
        case "members":
            return array(try client.members(groupId: groupId()).map { member in
                object([
                    ("leafIndex", JSValue(double: Double(member.leafIndex), in: context)),
                    ("credential", b(member.credential)),
                    ("signatureKey", b(member.signatureKey)),
                ])
            })
        case "exportSecret", "exportPendingSecret":
            let label = arg(1)?.toString() ?? ""
            let secretContext = data(arg(2))
            let length = UInt32(arg(3)?.toDouble() ?? 0)
            let secret = method == "exportSecret"
                ? try client.exportSecret(groupId: groupId(), label: label, context: secretContext, len: length)
                : try client.exportPendingSecret(groupId: groupId(), label: label, context: secretContext, len: length)
            return b(secret)
        case "deleteGroup":
            try client.deleteGroup(groupId: groupId())
            return JSValue(undefinedIn: context)
        default:
            return fail("Unknown MLS method \(method)", in: context)
        }
    }
}

private func data(_ value: JSValue?) -> Data {
    JSBytes.read(value) ?? Data()
}

/// Bytes, or nil for null and undefined.
private func optionalData(_ value: JSValue?) -> Data? {
    guard let value, !value.isNull, !value.isUndefined else { return nil }
    return JSBytes.read(value)
}

private func message(of error: Error) -> String {
    if case let .Failed(message) = error as? CryptoError { return message }
    return String(describing: error)
}

/// Throws a JavaScript Error from inside a native call.
private func fail(_ message: String, in context: JSContext) -> JSValue {
    context.exception = JSValue(newErrorFromMessage: message, in: context)
    return JSValue(undefinedIn: context)
}

private func bytes(_ body: () throws -> Data) -> JSValue {
    let context = JSContext.current()!
    do {
        return JSBytes.make(try body(), in: context)
    } catch {
        return fail(message(of: error), in: context)
    }
}

private func keyPair(_ body: () throws -> KeyPair) -> JSValue {
    let context = JSContext.current()!
    do {
        let pair = try body()
        let value = JSValue(newObjectIn: context)!
        value.setObject(JSBytes.make(pair.publicKey, in: context), forKeyedSubscript: "publicKey" as NSString)
        value.setObject(JSBytes.make(pair.secretKey, in: context), forKeyedSubscript: "secretKey" as NSString)
        return value
    } catch {
        return fail(message(of: error), in: context)
    }
}
