/**
 * Expo config plugin that adds the ZunaNotificationService app extension target
 * to the Xcode project. Applied automatically during `npx expo prebuild`.
 *
 * The extension decrypts incoming APN payloads (mutable-content: 1) using
 * an X25519 shared secret + AES-256-GCM, matching the JS crypto in lib/crypto/x25519.ts.
 */

const { withXcodeProject, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const NSE_NAME = 'ZunaNotificationService';
const NSE_BUNDLE_SUFFIX = 'NotificationService';
const TEAM_ID = 'SGKB9R23YT';
const ACCESS_GROUP = `${TEAM_ID}.chat.zuna.mobile`;
const DEPLOYMENT_TARGET = '15.1';

// ── UUIDs (stable across prebuild runs) ────────────────────────────────────
const UUID = {
  NSE_SOURCES_PHASE: 'A1B2C3D4E5F60001A1B2C3D4',
  NSE_RESOURCES_PHASE: 'A1B2C3D4E5F60002A1B2C3D4',
  NSE_FRAMEWORKS_PHASE: 'A1B2C3D4E5F60003A1B2C3D4',
  NSE_TARGET: 'A1B2C3D4E5F60004A1B2C3D4',
  NSE_FILE_SWIFT: 'A1B2C3D4E5F60005A1B2C3D4',
  NSE_FILE_PLIST: 'A1B2C3D4E5F60006A1B2C3D4',
  NSE_FILE_ENTITLEMENTS: 'A1B2C3D4E5F60007A1B2C3D4',
  NSE_PRODUCT: 'A1B2C3D4E5F60008A1B2C3D4',
  NSE_BUILD_SWIFT: 'A1B2C3D4E5F60009A1B2C3D4',
  NSE_BUILD_PLIST: 'A1B2C3D4E5F6000AA1B2C3D4',
  NSE_GROUP: 'A1B2C3D4E5F6000BA1B2C3D4',
  NSE_DEBUG_CONFIG: 'A1B2C3D4E5F6000CA1B2C3D4',
  NSE_RELEASE_CONFIG: 'A1B2C3D4E5F6000DA1B2C3D4',
  NSE_CONFIG_LIST: 'A1B2C3D4E5F6000EA1B2C3D4',
  EMBED_PHASE: 'A1B2C3D4E5F6000FA1B2C3D4',
  EMBED_FILE: 'A1B2C3D4E5F60010A1B2C3D4',
  TARGET_DEP: 'A1B2C3D4E5F60011A1B2C3D4',
  CONTAINER_PROXY: 'A1B2C3D4E5F60012A1B2C3D4',
};

// ── Write source files ──────────────────────────────────────────────────────
const withNseFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const nseDir = path.join(cfg.modRequest.platformProjectRoot, NSE_NAME);
      fs.mkdirSync(nseDir, { recursive: true });

      const bundleId = `${cfg.ios?.bundleIdentifier ?? 'chat.zuna.mobile'}.${NSE_BUNDLE_SUFFIX}`;

      // NotificationService.swift — copied from committed file if it exists,
      // otherwise generated from the template below.
      const swiftSrc = path.join(nseDir, 'NotificationService.swift');
      if (!fs.existsSync(swiftSrc)) {
        fs.writeFileSync(swiftSrc, notificationServiceSwift());
      }

      // Info.plist
      fs.writeFileSync(path.join(nseDir, 'Info.plist'), nseInfoPlist(bundleId));

      // Entitlements
      fs.writeFileSync(
        path.join(nseDir, `${NSE_NAME}.entitlements`),
        nseEntitlements(ACCESS_GROUP)
      );

      return cfg;
    },
  ]);

// ── Xcode project modifications ─────────────────────────────────────────────
const withNseXcodeProject = (config) =>
  withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;

    // Guard against double-adding on repeated prebuild runs.
    const alreadyAdded = Object.values(proj.pbxNativeTargetSection()).some(
      (t) => t && typeof t === 'object' && t.name === NSE_NAME
    );
    if (alreadyAdded) return cfg;

    const bundleId = `${cfg.ios?.bundleIdentifier ?? 'chat.zuna.mobile'}.${NSE_BUNDLE_SUFFIX}`;
    const mainTargetUuid = proj.getFirstTarget().uuid;

    // 1. File references
    addFileRef(proj, UUID.NSE_FILE_SWIFT, 'sourcecode.swift', 'NotificationService.swift', NSE_NAME);
    addFileRef(proj, UUID.NSE_FILE_PLIST, 'text.plist.xml', 'Info.plist', NSE_NAME);
    addFileRef(proj, UUID.NSE_FILE_ENTITLEMENTS, 'text.plist.entitlements', `${NSE_NAME}.entitlements`, NSE_NAME);
    proj.pbxFileReferenceSection()[UUID.NSE_PRODUCT] = {
      isa: 'PBXFileReference',
      explicitFileType: '"wrapper.app-extension"',
      includeInIndex: 0,
      path: `${NSE_NAME}.appex`,
      sourceTree: 'BUILT_PRODUCTS_DIR',
    };

    // 2. Build files
    proj.pbxBuildFileSection()[UUID.NSE_BUILD_SWIFT] = {
      isa: 'PBXBuildFile',
      fileRef: UUID.NSE_FILE_SWIFT,
      comment: `NotificationService.swift in Sources`,
    };
    proj.pbxBuildFileSection()[UUID.NSE_BUILD_PLIST] = {
      isa: 'PBXBuildFile',
      fileRef: UUID.NSE_FILE_PLIST,
      comment: `Info.plist in Resources`,
    };
    proj.pbxBuildFileSection()[UUID.EMBED_FILE] = {
      isa: 'PBXBuildFile',
      fileRef: UUID.NSE_PRODUCT,
      comment: `${NSE_NAME}.appex in Embed App Extensions`,
      settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
    };

    // 3. Group
    const rootGroup = proj.pbxGroupByName(proj.getFirstProject().firstProject.mainGroup);
    proj.pbxGroupSection()[UUID.NSE_GROUP] = {
      isa: 'PBXGroup',
      children: [
        quoteRef(UUID.NSE_FILE_SWIFT, 'NotificationService.swift'),
        quoteRef(UUID.NSE_FILE_PLIST, 'Info.plist'),
        quoteRef(UUID.NSE_FILE_ENTITLEMENTS, `${NSE_NAME}.entitlements`),
      ],
      name: NSE_NAME,
      path: NSE_NAME,
      sourceTree: '"<group>"',
    };
    rootGroup.children.push(quoteRef(UUID.NSE_GROUP, NSE_NAME));

    // Product in Products group
    const productsGroup = proj.pbxGroupByName('Products');
    if (productsGroup) {
      productsGroup.children.push(quoteRef(UUID.NSE_PRODUCT, `${NSE_NAME}.appex`));
    }

    // 4. Build phases
    proj.pbxSourcesBuildPhaseSection = proj.pbxSourcesBuildPhaseSection || {};
    addBuildPhase(proj, 'PBXSourcesBuildPhase', UUID.NSE_SOURCES_PHASE, 'Sources', [
      quoteRef(UUID.NSE_BUILD_SWIFT, 'NotificationService.swift in Sources'),
    ]);
    addBuildPhase(proj, 'PBXResourcesBuildPhase', UUID.NSE_RESOURCES_PHASE, 'Resources', [
      quoteRef(UUID.NSE_BUILD_PLIST, 'Info.plist in Resources'),
    ]);
    addBuildPhase(proj, 'PBXFrameworksBuildPhase', UUID.NSE_FRAMEWORKS_PHASE, 'Frameworks', []);

    // 5. Embed App Extensions phase in the main target
    const embedPhase = {
      isa: 'PBXCopyFilesBuildPhase',
      buildActionMask: 2147483647,
      dstPath: '""',
      dstSubfolderSpec: 13,
      files: [quoteRef(UUID.EMBED_FILE, `${NSE_NAME}.appex in Embed App Extensions`)],
      name: '"Embed App Extensions"',
      runOnlyForDeploymentPostprocessing: 0,
    };
    proj.hash.project.objects['PBXCopyFilesBuildPhase'] =
      proj.hash.project.objects['PBXCopyFilesBuildPhase'] || {};
    proj.hash.project.objects['PBXCopyFilesBuildPhase'][UUID.EMBED_PHASE] = embedPhase;

    const mainTarget = proj.pbxNativeTargetSection()[mainTargetUuid];
    if (mainTarget) {
      mainTarget.buildPhases = mainTarget.buildPhases || [];
      mainTarget.buildPhases.push(quoteRef(UUID.EMBED_PHASE, 'Embed App Extensions'));
      mainTarget.dependencies = mainTarget.dependencies || [];
      mainTarget.dependencies.push(quoteRef(UUID.TARGET_DEP, 'PBXTargetDependency'));
    }

    // 6. Target dependency + container proxy
    proj.hash.project.objects['PBXContainerItemProxy'] =
      proj.hash.project.objects['PBXContainerItemProxy'] || {};
    proj.hash.project.objects['PBXContainerItemProxy'][UUID.CONTAINER_PROXY] = {
      isa: 'PBXContainerItemProxy',
      containerPortal: proj.getFirstProject().uuid,
      proxyType: 1,
      remoteGlobalIDString: UUID.NSE_TARGET,
      remoteInfo: NSE_NAME,
    };
    proj.hash.project.objects['PBXTargetDependency'] =
      proj.hash.project.objects['PBXTargetDependency'] || {};
    proj.hash.project.objects['PBXTargetDependency'][UUID.TARGET_DEP] = {
      isa: 'PBXTargetDependency',
      target: UUID.NSE_TARGET,
      targetProxy: UUID.CONTAINER_PROXY,
    };

    // 7. Build configurations
    const buildSettings = {
      CODE_SIGN_ENTITLEMENTS: `${NSE_NAME}/${NSE_NAME}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: TEAM_ID,
      INFOPLIST_FILE: `${NSE_NAME}/Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
      LD_RUNPATH_SEARCH_PATHS: [
        '"$(inherited)"',
        '"@executable_path/Frameworks"',
        '"@executable_path/../../Frameworks"',
      ],
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
      PRODUCT_NAME: NSE_NAME,
      SKIP_INSTALL: 'YES',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
    };
    const xccfg = proj.pbxXCBuildConfigurationSection();
    xccfg[UUID.NSE_DEBUG_CONFIG] = { isa: 'XCBuildConfiguration', buildSettings, name: 'Debug' };
    xccfg[UUID.NSE_RELEASE_CONFIG] = { isa: 'XCBuildConfiguration', buildSettings, name: 'Release' };

    // 8. Config list
    proj.pbxXCConfigurationListSection()[UUID.NSE_CONFIG_LIST] = {
      isa: 'XCConfigurationList',
      buildConfigurations: [
        quoteRef(UUID.NSE_DEBUG_CONFIG, 'Debug'),
        quoteRef(UUID.NSE_RELEASE_CONFIG, 'Release'),
      ],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: 'Release',
    };

    // 9. Native target
    proj.pbxNativeTargetSection()[UUID.NSE_TARGET] = {
      isa: 'PBXNativeTarget',
      buildConfigurationList: UUID.NSE_CONFIG_LIST,
      buildPhases: [
        quoteRef(UUID.NSE_SOURCES_PHASE, 'Sources'),
        quoteRef(UUID.NSE_FRAMEWORKS_PHASE, 'Frameworks'),
        quoteRef(UUID.NSE_RESOURCES_PHASE, 'Resources'),
      ],
      buildRules: [],
      dependencies: [],
      name: NSE_NAME,
      productName: NSE_NAME,
      productReference: UUID.NSE_PRODUCT,
      productType: '"com.apple.product-type.app-extension"',
    };

    // 10. Add to project targets list
    const firstProject = proj.getFirstProject().firstProject;
    firstProject.targets = firstProject.targets || [];
    firstProject.targets.push(quoteRef(UUID.NSE_TARGET, NSE_NAME));

    return cfg;
  });

// ── Helpers ─────────────────────────────────────────────────────────────────

function quoteRef(uuid, comment) {
  return { value: uuid, comment };
}

function addFileRef(proj, uuid, fileType, filename, folder) {
  proj.pbxFileReferenceSection()[uuid] = {
    isa: 'PBXFileReference',
    lastKnownFileType: fileType,
    path: filename,
    sourceTree: '"<group>"',
    name: filename,
  };
}

function addBuildPhase(proj, isa, uuid, name, files) {
  proj.hash.project.objects[isa] = proj.hash.project.objects[isa] || {};
  proj.hash.project.objects[isa][uuid] = {
    isa,
    buildActionMask: 2147483647,
    files,
    runOnlyForDeploymentPostprocessing: 0,
    name,
  };
}

// ── File content templates ───────────────────────────────────────────────────

function notificationServiceSwift() {
  return `import CryptoKit
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

    // MARK: - Keychain

    private func readEncPrivateKey() -> String? {
        let keyData = Data("zuna_enc_private_key".utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "zuna_nse_keys:no-auth",
            kSecAttrAccount: keyData,
            kSecAttrGeneric: keyData,
            kSecAttrAccessGroup: "${ACCESS_GROUP}",
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
            kSecAttrAccessGroup: "${ACCESS_GROUP}",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode([String: UserMapEntry].self, from: data)
    }

    // MARK: - Base64

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

    // MARK: - Crypto

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
`;
}

function nseInfoPlist(bundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>ZunaNotificationService</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>XPC!</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.usernotifications.service</string>
		<key>NSExtensionPrincipalClass</key>
		<string>$(PRODUCT_MODULE_NAME).NotificationService</string>
	</dict>
</dict>
</plist>
`;
}

function nseEntitlements(accessGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>keychain-access-groups</key>
	<array>
		<string>${accessGroup}</string>
	</array>
	<key>aps-environment</key>
	<string>development</string>
</dict>
</plist>
`;
}

module.exports = (config) => {
  config = withNseFiles(config);
  config = withNseXcodeProject(config);
  return config;
};
