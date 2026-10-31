// zuna-host: the iOS app's core host, headless on macOS. End-to-end tests start
// it, then drive it over the control channel exactly as the app's UI would.
//
//   zuna-host --data <folder> [--control <port>] [--device-name <name>]
//
// Prints "ZUNA_HOST_READY port=<port>" once the core is running.

import Foundation
import Security
import ZunaControl
import ZunaHost

func option(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("zuna-host: \(message)\n".utf8))
    exit(1)
}

guard let dataPath = option("--data") else { fail("--data <folder> is required") }
let dataDirectory = URL(fileURLWithPath: dataPath, isDirectory: true)
try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)

// The app keeps this in the Keychain. Here a file in the data folder stands in,
// so a test can restart the host and keep its data.
let keyFile = dataDirectory.appendingPathComponent("device-key")
let deviceKey: Data
if let stored = try? Data(contentsOf: keyFile), stored.count == 32 {
    deviceKey = stored
} else {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fail("no randomness") }
    deviceKey = Data(bytes)
    try? deviceKey.write(to: keyFile)
}

var options = CoreRuntime.Options(
    dataDirectory: dataDirectory,
    deviceKey: deviceKey,
    deviceName: option("--device-name") ?? "iPhone"
)
options.logToStandardError = true

let runtime: CoreRuntime
do {
    runtime = try CoreRuntime(options: options)
} catch {
    fail("\(error)")
}

let server = ControlServer(runtime: runtime)

Task {
    do {
        try await runtime.start()
        let port = try await server.start(port: UInt16(option("--control") ?? "0") ?? 0)
        print("ZUNA_HOST_READY port=\(port)")
        fflush(stdout)
    } catch {
        fail("\(error)")
    }
}

dispatchMain()
