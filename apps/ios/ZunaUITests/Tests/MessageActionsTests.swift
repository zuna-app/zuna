import AVFoundation
import XCTest

/// Voice messages, picking several messages to act on together, and muting a
/// chat for a while. Each test checks what the desktop received.
final class MessageActionsTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceId: String { World.current["alice"].userId }

    private func openAlice() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let row = zuna.element(A11y.ChatList.row("user:\(aliceId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
    }

    /// A conversation's messages as alice's desktop has them, newest last.
    private func aliceMessages(_ alice: Peer, in key: String? = nil) throws -> [[String: Any]] {
        let groupId = try XCTUnwrap(try alice.conversation(key ?? "user:\(bobId)")?["groupId"] as? String)
        let page = try alice.call("loadMessages", [groupId]) as? [String: Any]
        return page?["messages"] as? [[String: Any]] ?? []
    }

    private func voiceMessages(_ alice: Peer) throws -> [[String: Any]] {
        try aliceMessages(alice).filter { (($0["attachments"] as? [[String: Any]])?.first?["voice"] as? Bool) == true }
    }

    private func type(_ text: String) {
        let input = zuna.element(A11y.Composer.input)
        if (input.value(forKey: "hasKeyboardFocus") as? Bool) != true { input.tap() }
        input.typeText(text)
    }

    /// Five seconds of a tone as AAC in MP4, made by Apple's encoder, as the iPhone app records.
    private func toneFile() throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let frames = 5 * 48_000
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        for frame in 0..<frames { buffer.floatChannelData![0][frame] = Float(sin(Double(frame) / 48_000 * 2 * .pi * 330) * 0.3) }
        // The file is finished, with its index, only once it's closed.
        do {
            let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1])
            try file.write(from: buffer)
        }
        return try Data(contentsOf: url)
    }

    func testRecordsVoiceMessagesAndPlaysThem() throws {
        try openAlice()
        let alice = try Peer("alice")
        let before = try voiceMessages(alice).count
        let microphone = zuna.element(A11y.Composer.microphone)
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))

        // A tap is too short, and says how to record.
        microphone.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Hold to record").waitForExistence(timeout: 5))

        // Held, it records; let go, it sends.
        microphone.press(forDuration: 2.5)
        try waitFor("alice to get the voice message", timeout: 30) { try self.voiceMessages(alice).count > before }
        let sent = try XCTUnwrap(try voiceMessages(alice).last)
        let file = try XCTUnwrap((sent["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(file["mime"] as? String, "audio/mp4")
        XCTAssertEqual(file["name"] as? String, "Voice message.m4a")
        let duration = try XCTUnwrap(file["duration"] as? Double)
        // Recording starts once the touch arrives, which near the screen's edge can take a moment.
        XCTAssertTrue((1.5...3.5).contains(duration), "\(duration)")
        XCTAssertEqual(Data(base64Encoded: file["waveform"] as? String ?? "")?.count, 48)

        // Slid to the left, it's thrown away.
        let left = microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: -200, dy: 0))
        microphone.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2, thenDragTo: left)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(try voiceMessages(alice).count, before + 1)

        // One from the desktop, encoded by Apple's encoder here, plays.
        let tone = try toneFile()
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": tone.base64EncodedString(), "type": "audio/mp4"]],
                "name": "Voice message.m4a", "mime": "audio/mp4", "duration": 5.0, "voice": true,
                "waveform": Data((0..<48).map { UInt8(($0 * 37) % 256) }).base64EncodedString(),
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.voiceMessages(alice).count == before + 2 }
        let fromAlice = try XCTUnwrap(try voiceMessages(alice).last?["id"] as? String)
        let card = zuna.element(A11y.Chat.voice(fromAlice))
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        card.buttons["Play voice message"].tap()
        let failure = zuna.toast(startingWith: "Couldn't play")
        XCTAssertTrue(card.buttons["Pause"].waitForExistence(timeout: 10), failure.exists ? failure.label : "it didn't start")
        zuna.screenshot("120-voice-messages")
        // It plays to the end and stops by itself.
        XCTAssertTrue(card.buttons["Play voice message"].waitForExistence(timeout: 15))
    }

    func testPicksMessagesToCopyForwardAndDelete() throws {
        try openAlice()
        let alice = try Peer("alice")
        let first = try alice.send(to: "user:\(bobId)", ["text": "Pick me first"])
        let second = try alice.send(to: "user:\(bobId)", ["text": "Pick me second"])
        XCTAssertTrue(zuna.element(A11y.Chat.message(second)).waitForExistence(timeout: 15))

        func select(_ id: String) {
            zuna.element(A11y.Chat.message(id)).press(forDuration: 1.0)
            let item = zuna.app.buttons["Select"]
            XCTAssertTrue(item.waitForExistence(timeout: 5))
            item.tap()
        }
        let count = zuna.element(A11y.Chat.selectionCount)

        select(first)
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        zuna.element(A11y.Chat.selectToggle(second)).tap()
        try waitFor("two to be picked") { count.label == "2 selected" }
        zuna.screenshot("121-selecting")
        zuna.element(A11y.Chat.selectionBar).buttons["Copy"].tap()
        XCTAssertTrue(zuna.toast(startingWith: "Copied 2 messages").waitForExistence(timeout: 5))
        XCTAssertFalse(count.exists)

        // Forwarded together, they arrive in the chat's order.
        select(second)
        zuna.element(A11y.Chat.selectToggle(first)).tap()
        zuna.element(A11y.Chat.selectionBar).buttons["Forward"].tap()
        let weekend = zuna.element(A11y.Forward.row("Weekend"))
        XCTAssertTrue(weekend.waitForExistence(timeout: 5))
        weekend.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Forwarded to Weekend").waitForExistence(timeout: 15))
        let conversations = try alice.call("getConversations") as? [[String: Any]] ?? []
        let groupKey = try XCTUnwrap(conversations.first { $0["title"] as? String == "Weekend" }?["key"] as? String)
        try waitFor("alice to get both in the group", timeout: 20) {
            let texts = try self.aliceMessages(alice, in: groupKey).compactMap { $0["text"] as? String }
            guard let index = texts.lastIndex(of: "Pick me first") else { return false }
            return texts.dropFirst(index + 1).first == "Pick me second"
        }

        // Your own, deleted together for everyone.
        // The on-screen keyboard's Return makes a new line, so Send sends.
        for text in ["Delete me one", "Delete me two"] {
            type(text)
            zuna.element(A11y.Composer.send).tap()
        }
        try waitFor("alice to get them", timeout: 20) { try alice.texts(with: self.bobId).contains("Delete me two") }
        let own = try aliceMessages(alice).filter { ($0["text"] as? String)?.hasPrefix("Delete me") == true }.compactMap { $0["id"] as? String }
        XCTAssertEqual(own.count, 2)
        select(own[0])
        zuna.element(A11y.Chat.selectToggle(own[1])).tap()
        zuna.element(A11y.Chat.selectionBar).buttons["Delete"].tap()
        let confirm = zuna.app.buttons["Delete for everyone"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        zuna.screenshot("122-delete-several")
        confirm.tap()
        try waitFor("alice to see both go", timeout: 20) {
            try !alice.texts(with: self.bobId).contains { $0.hasPrefix("Delete me") }
        }
    }

    func testMutesAChatForAWhile() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let key = "user:\(aliceId)"
        let row = zuna.element(A11y.ChatList.row(key))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.press(forDuration: 1.0)
        let mute = zuna.app.buttons["Mute"]
        XCTAssertTrue(mute.waitForExistence(timeout: 5))
        mute.tap()
        let hour = zuna.app.buttons["For 1 hour"]
        XCTAssertTrue(hour.waitForExistence(timeout: 5))
        zuna.screenshotScreen("123-mute-menu")
        hour.tap()

        // Synced: bob's laptop sees it muted until about an hour from now.
        let laptop = try Peer("bobLaptop")
        try waitFor("the laptop to see the mute", timeout: 20) {
            let chat = try laptop.conversation("user:\(self.aliceId)")
            guard let until = chat?["mutedUntil"] as? Double else { return false }
            return chat?["muted"] as? Bool == true && abs(until / 1000 - Date().addingTimeInterval(3600).timeIntervalSince1970) < 120
        }
        XCTAssertTrue(row.label.contains("Muted"), row.label)

        // The chat's details say until when, and turning notifications on unmutes it.
        row.tap()
        zuna.element(A11y.Chat.title).tap()
        let notifications = zuna.app.switches[A11y.Details.notifications]
        XCTAssertTrue(notifications.waitForExistence(timeout: 10))
        XCTAssertTrue(notifications.label.contains("Muted until"), notifications.label)
        zuna.screenshot("124-muted-until")
        notifications.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("the laptop to see it unmuted", timeout: 20) {
            try laptop.conversation("user:\(self.aliceId)")?["muted"] as? Bool == false
        }
    }
}
