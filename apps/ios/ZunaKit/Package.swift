// swift-tools-version: 6.0
// The parts of the iOS app that don't depend on UIKit: the Rust encryption
// core, SQLite, and the host that runs the shared TypeScript client core in
// JavaScriptCore. Everything here also builds for macOS, so tests can run the
// exact same host without a simulator.

import PackageDescription

let package = Package(
    name: "ZunaKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ZunaHost", targets: ["ZunaHost"]),
        .library(name: "ZunaModels", targets: ["ZunaModels"]),
        .library(name: "ZunaControl", targets: ["ZunaControl"]),
        .executable(name: "zuna-host", targets: ["ZunaHostCLI"]),
    ],
    targets: [
        // Built by scripts/build-crypto-apple.mjs.
        .binaryTarget(name: "ZunaCryptoFFI", path: "Frameworks/ZunaCryptoFFI.xcframework"),
        .target(
            name: "ZunaCrypto",
            dependencies: ["ZunaCryptoFFI"],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("Security")]
        ),
        // Downloaded by scripts/fetch-sqlite.mjs, the same version the desktop app uses.
        .target(
            name: "CSQLite",
            exclude: [".version"],
            cSettings: [
                .define("SQLITE_ENABLE_FTS5"),
                .define("SQLITE_DQS", to: "0"),
                .define("SQLITE_DEFAULT_MEMSTATUS", to: "0"),
                .define("SQLITE_DEFAULT_WAL_SYNCHRONOUS", to: "1"),
                .define("SQLITE_OMIT_LOAD_EXTENSION"),
                .define("SQLITE_OMIT_DEPRECATED"),
                // Keeps a cached statement's plan when new values are bound, instead of
                // compiling it again for those whose plan could depend on them (LIMIT ?).
                .define("SQLITE_ENABLE_QPSG"),
            ]
        ),
        .target(
            name: "ZunaHost",
            dependencies: ["ZunaCrypto", "CSQLite"],
            // Built by apps/ios/core-bundle/build.mjs.
            resources: [.copy("Resources/zuna-core.js"), .copy("Resources/zuna-highlight.js"), .copy("Resources/zuna-password.js"), .copy("Resources/zuna-relay.js"), .copy("Resources/watch.html"), .copy("Resources/telegram-functions.json")]
        ),
        // The core's types in Swift, and the RPC client the UI uses.
        .target(name: "ZunaModels", dependencies: ["ZunaHost"]),
        // Test builds only: drives a host over a local WebSocket.
        .target(
            name: "ZunaControl",
            dependencies: ["ZunaHost"]
        ),
        .executableTarget(
            name: "ZunaHostCLI",
            dependencies: ["ZunaHost", "ZunaControl"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ZunaHostTests",
            dependencies: ["ZunaHost", "ZunaCrypto", "ZunaModels"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
