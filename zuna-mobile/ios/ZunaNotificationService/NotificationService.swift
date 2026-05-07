import CryptoKit
import os
import Security
import UserNotifications

private let log = OSLog(subsystem: "chat.zuna.mobile.NotificationService", category: "NSE")

class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        let userInfo = request.content.userInfo

        guard
            let ct = userInfo["ct"] as? String,
            let iv = userInfo["iv"] as? String,
            let at = userInfo["at"] as? String,
            let sik = userInfo["sik"] as? String
        else {
            contentHandler(content)
            return
        }

        guard let encPrivKeyB64 = readEncPrivateKey() else {
            contentHandler(content)
            return
        }

        guard let plaintext = decryptMessage(
            encPrivKeyB64: encPrivKeyB64,
            senderIdentityKeyB64: sik,
            ciphertextB64: ct,
            ivB64: iv,
            authTagB64: at
        ) else {
            contentHandler(content)
            return
        }

        content.body = plaintext

        if let sid = userInfo["sid"] as? String, let entry = readUserMap()?[sid] {
            content.title = entry.username
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let content = bestAttemptContent {
            handler(content)
        }
    }

    // MARK: – Keychain

    private func readEncPrivateKey() -> String? {
        let keyData = Data("zuna_enc_private_key".utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "zuna_nse_keys:no-auth",
            kSecAttrAccount: keyData,
            kSecAttrGeneric: keyData,
            kSecAttrAccessGroup: "SGKB9R23YT.chat.zuna.mobile",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private struct UserMapEntry: Decodable {
        let username: String
        let serverAddress: String
    }

    private func readUserMap() -> [String: UserMapEntry]? {
        let keyData = Data("zuna_user_map".utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "zuna_nse_keys:no-auth",
            kSecAttrAccount: keyData,
            kSecAttrGeneric: keyData,
            kSecAttrAccessGroup: "SGKB9R23YT.chat.zuna.mobile",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode([String: UserMapEntry].self, from: data)
    }

    // MARK: – Base64

    private func base64Decode(_ b64: String) -> Data? {
        var s = b64
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: s)
    }

    private func rawFromPkcs8(_ b64: String) -> Data? {
        guard let data = base64Decode(b64), data.count >= 48 else { return nil }
        return data.subdata(in: 16 ..< data.count)
    }

    private func rawFromSpki(_ b64: String) -> Data? {
        guard let data = base64Decode(b64), data.count >= 44 else { return nil }
        return data.subdata(in: 12 ..< data.count)
    }

    private func extractPublicKeyBytes(_ b64: String) -> Data? {
        guard let data = base64Decode(b64) else { return nil }
        if data.count == 44 { return rawFromSpki(b64) }
        return data
    }

    // MARK: – Crypto

    private func decryptMessage(
        encPrivKeyB64: String,
        senderIdentityKeyB64: String,
        ciphertextB64: String,
        ivB64: String,
        authTagB64: String
    ) -> String? {
        guard #available(iOSApplicationExtension 13.0, *) else { return nil }

        guard let privRaw = rawFromPkcs8(encPrivKeyB64) else { return nil }
        guard let pubRaw = extractPublicKeyBytes(senderIdentityKeyB64) else { return nil }

        guard
            let privateKey = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privRaw),
            let publicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: pubRaw),
            let sharedSecret = try? privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        else { return nil }

        let sharedKeyData: Data = sharedSecret.withUnsafeBytes { Data($0) }

        guard
            let ciphertext = base64Decode(ciphertextB64),
            let ivData = base64Decode(ivB64),
            let tagData = base64Decode(authTagB64)
        else { return nil }

        guard
            let nonce = try? AES.GCM.Nonce(data: ivData),
            let sealedBox = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tagData)
        else { return nil }

        let symmetricKey = SymmetricKey(data: sharedKeyData)
        guard let plainData = try? AES.GCM.open(sealedBox, using: symmetricKey) else { return nil }
        return String(data: plainData, encoding: .utf8)
    }
}
