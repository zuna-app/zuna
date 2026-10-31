import Foundation

/// Finds fields the core sent that a Swift model dropped while decoding: the
/// model is encoded again and the two JSON trees compared. Fields that were
/// null in the core's JSON don't count, since Swift leaves out nil optionals.
enum Drift {
    static func missing<Value: Encodable>(in original: Data, decodedAs value: Value) -> [String] {
        guard let source = try? JSONSerialization.jsonObject(with: original, options: [.fragmentsAllowed]),
              let encoded = try? CoreConnection.encoder.encode(value),
              let roundTrip = try? JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed]) else { return [] }
        var found: [String] = []
        compare(source, roundTrip, path: "", into: &found)
        return found
    }

    private static func compare(_ source: Any, _ roundTrip: Any, path: String, into found: inout [String]) {
        if let object = source as? [String: Any] {
            // Tagged bytes and files are leaves.
            if object["$bytes"] != nil || object["$file"] != nil { return }
            let other = roundTrip as? [String: Any] ?? [:]
            for (key, value) in object where !(value is NSNull) {
                let child = path.isEmpty ? key : "\(path).\(key)"
                if let match = other[key] {
                    compare(value, match, path: child, into: &found)
                } else {
                    found.append(child)
                }
            }
        } else if let array = source as? [Any], let other = roundTrip as? [Any] {
            // One element shows the shape; checking them all would only repeat it.
            if let first = array.first, let match = other.first {
                compare(first, match, path: "\(path)[]", into: &found)
            }
        }
    }
}
