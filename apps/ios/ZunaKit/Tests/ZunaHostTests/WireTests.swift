import XCTest
@testable import ZunaModels

/// How arguments travel to the core (apps/ios/core-bundle/src/wire.ts).
final class WireTests: XCTestCase {
    /// JSON's null can mean something to the core (in updateGroupMeta, null removes
    /// the picture), so an argument left out travels as a tag the core reads as undefined.
    func testLeftOutArgumentsAreNotNull() throws {
        let absent = String(decoding: try CoreConnection.encoder.encode(Absent()), as: UTF8.self)
        XCTAssertEqual(absent, #"{"$undefined":true}"#)
        let removed = String(decoding: try CoreConnection.encoder.encode(Optional<WireFile>.none), as: UTF8.self)
        XCTAssertEqual(removed, "null")
    }
}
