import AVFoundation
import XCTest

/// Voice and video messages, picking several messages to act on together, and
/// muting a chat for a while. Each test checks what the desktop received.
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

    private func videoMessages(_ alice: Peer) throws -> [[String: Any]] {
        try aliceMessages(alice).filter { (($0["attachments"] as? [[String: Any]])?.first?["round"] as? Bool) == true }
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

        // A tap is too short to record: it switches to video messages, and another back, saying how to record.
        // Whatever an earlier test left it on, this starts from voice messages.
        if microphone.label == "Record a video message" { microphone.tap() }
        try waitFor("voice messages") { microphone.label == "Record a voice message" }
        microphone.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Hold to record a video message").waitForExistence(timeout: 5))
        try waitFor("video messages") { microphone.label == "Record a video message" }
        microphone.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Hold to record a voice message").waitForExistence(timeout: 5))
        try waitFor("voice messages again") { microphone.label == "Record a voice message" }

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

        // One from the Linux desktop, Opus in MP4 as Chromium writes it, plays to its end too.
        let opus = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "chromium-opus", withExtension: "m4a")))
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": opus.base64EncodedString(), "type": "audio/mp4"]],
                "name": "Voice message.m4a", "mime": "audio/mp4", "duration": 4.98, "voice": true,
                "waveform": Data((0..<48).map { UInt8(($0 * 53) % 256) }).base64EncodedString(),
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.voiceMessages(alice).count == before + 3 }
        let fromLinux = try XCTUnwrap(try voiceMessages(alice).last?["id"] as? String)
        let opusCard = zuna.element(A11y.Chat.voice(fromLinux))
        XCTAssertTrue(opusCard.waitForExistence(timeout: 15))
        let started = Date()
        opusCard.buttons["Play voice message"].tap()
        XCTAssertTrue(opusCard.buttons["Pause"].waitForExistence(timeout: 10), failure.exists ? failure.label : "it didn't start")
        XCTAssertTrue(opusCard.buttons["Play voice message"].waitForExistence(timeout: 15))
        // As Chromium wrote the durations, it would stop at 4.3 s.
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 4.6)

        // One from Firefox on the web, its Opus moved from WebM into MP4 by `lib/mp4.ts`, plays to its end too.
        let webm = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "firefox-opus", withExtension: "m4a")))
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": webm.base64EncodedString(), "type": "audio/mp4"]],
                "name": "Voice message.m4a", "mime": "audio/mp4", "duration": 4.2, "voice": true,
                "waveform": Data((0..<48).map { UInt8(($0 * 71) % 256) }).base64EncodedString(),
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.voiceMessages(alice).count == before + 4 }
        let fromFirefox = try XCTUnwrap(try voiceMessages(alice).last?["id"] as? String)
        let firefoxCard = zuna.element(A11y.Chat.voice(fromFirefox))
        XCTAssertTrue(firefoxCard.waitForExistence(timeout: 15))
        let heard = Date()
        firefoxCard.buttons["Play voice message"].tap()
        XCTAssertTrue(firefoxCard.buttons["Pause"].waitForExistence(timeout: 10), failure.exists ? failure.label : "it didn't start")
        XCTAssertTrue(firefoxCard.buttons["Play voice message"].waitForExistence(timeout: 15))
        XCTAssertGreaterThan(Date().timeIntervalSince(heard), 3.8)
    }

    /// A voice message plays faster from the speed beside its time, as in Telegram, and so does
    /// every one after it, until the speed's changed back.
    func testPlaysVoiceMessagesFaster() throws {
        try openAlice()
        let alice = try Peer("alice")
        let before = try voiceMessages(alice).count
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": try toneFile().base64EncodedString(), "type": "audio/mp4"]],
                "name": "Voice message.m4a", "mime": "audio/mp4", "duration": 5.0, "voice": true,
                "waveform": Data((0..<48).map { UInt8(($0 * 29) % 256) }).base64EncodedString(),
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.voiceMessages(alice).count == before + 1 }
        let id = try XCTUnwrap(try voiceMessages(alice).last?["id"] as? String)
        let card = zuna.element(A11y.Chat.voice(id))
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        let speed = zuna.element(A11y.Chat.voiceSpeed(id))
        XCTAssertFalse(speed.exists)

        // It shows once it plays, at 1×, and two taps make it 2×.
        card.buttons["Play voice message"].tap()
        XCTAssertTrue(speed.waitForExistence(timeout: 10))
        XCTAssertEqual(speed.label, "Playback speed, 1×")
        let started = Date()
        speed.tap()
        speed.tap()
        try waitFor("2×") { speed.label == "Playback speed, 2×" }
        zuna.screenshot("121-voice-speed")
        XCTAssertTrue(card.buttons["Play voice message"].waitForExistence(timeout: 10))
        // Its five seconds ended sooner than five seconds.
        XCTAssertLessThan(Date().timeIntervalSince(started), 4.5)

        // Played again, it's still 2×; back to 1× for the tests after.
        card.buttons["Play voice message"].tap()
        XCTAssertTrue(speed.waitForExistence(timeout: 10))
        XCTAssertEqual(speed.label, "Playback speed, 2×")
        speed.tap()
        try waitFor("1×") { speed.label == "Playback speed, 1×" }
        card.buttons["Pause"].tap()
    }

    func testRecordsVideoMessagesAndPlaysThem() throws {
        try openAlice()
        let alice = try Peer("alice")
        let before = try videoMessages(alice).count
        let microphone = zuna.element(A11y.Composer.microphone)
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        // Back to voice messages once this one's done, for the tests after.
        defer {
            if microphone.label == "Record a video message" {
                microphone.tap()
                try? waitFor("voice messages") { microphone.label == "Record a voice message" }
            }
        }

        // A tap switches to video messages, as in Telegram.
        if microphone.label != "Record a video message" { microphone.tap() }
        try waitFor("video messages") { microphone.label == "Record a video message" }

        // Held, it records, moving bars standing in for the camera; let go, it sends, square.
        microphone.press(forDuration: 2.5)
        try waitFor("alice to get the video message", timeout: 40) { try self.videoMessages(alice).count > before }
        let sent = try XCTUnwrap(try videoMessages(alice).last)
        let file = try XCTUnwrap((sent["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(file["mime"] as? String, "video/mp4")
        XCTAssertEqual(file["name"] as? String, "Video message.mp4")
        XCTAssertEqual(file["width"] as? Int, 480)
        XCTAssertEqual(file["height"] as? Int, 480)
        XCTAssertNotNil(file["thumb"] as? String)
        let duration = try XCTUnwrap(file["duration"] as? Double)
        XCTAssertTrue((1.5...3.5).contains(duration), "\(duration)")
        let bytes = try WorldControl.download("alice", file)
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        try bytes.write(to: copy)
        let size = try blocking { try await AVURLAsset(url: copy).loadTracks(withMediaType: .video).first?.load(.naturalSize) }
        XCTAssertEqual(size, CGSize(width: 480, height: 480))
        let ownId = try XCTUnwrap(sent["id"] as? String)
        XCTAssertTrue(zuna.element(A11y.Chat.round(ownId)).waitForExistence(timeout: 15))

        // One from the desktop, as Chromium records it, plays with its sound on a tap.
        let recorded = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "chromium-round", withExtension: "mp4")))
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": recorded.base64EncodedString(), "type": "video/mp4"]],
                "name": "Video message.mp4", "mime": "video/mp4", "width": 480, "height": 480, "duration": 2.4, "round": true,
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.videoMessages(alice).count == before + 2 }
        let fromAlice = try XCTUnwrap(try videoMessages(alice).last?["id"] as? String)
        let card = zuna.element(A11y.Chat.round(fromAlice))
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        zuna.screenshot("121-video-messages")
        card.tap()
        let failure = zuna.toast(startingWith: "Couldn't play")
        try waitFor(failure.exists ? failure.label : "it to play with its sound", timeout: 10) { (card.value as? String) == "Playing" }
        zuna.screenshot("121b-video-message-playing")
        // It plays to the end, and goes back to playing by itself without sound.
        try waitFor("it to finish", timeout: 15) { (card.value as? String) != "Playing" }

        // One from Firefox on the web, H.264 from WebCodecs and Opus in MP4 by `lib/mp4.ts`, plays with its sound too.
        let encoded = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "firefox-round", withExtension: "mp4")))
        _ = try alice.call("sendWithAttachments", [
            "user:\(bobId)",
            [[
                "blob": ["$blob": ["bytes": encoded.base64EncodedString(), "type": "video/mp4"]],
                "name": "Video message.mp4", "mime": "video/mp4", "width": 480, "height": 480, "duration": 2.2, "round": true,
            ]],
            [:],
        ])
        try waitFor("bob's phone to show it", timeout: 20) { try self.videoMessages(alice).count == before + 3 }
        let fromFirefox = try XCTUnwrap(try videoMessages(alice).last?["id"] as? String)
        let firefoxCard = zuna.element(A11y.Chat.round(fromFirefox))
        XCTAssertTrue(firefoxCard.waitForExistence(timeout: 15))
        firefoxCard.tap()
        try waitFor(failure.exists ? failure.label : "it to play with its sound", timeout: 10) { (firefoxCard.value as? String) == "Playing" }
        zuna.screenshot("121c-firefox-video-message-playing")
        try waitFor("it to finish", timeout: 15) { (firefoxCard.value as? String) != "Playing" }
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
        // Below what other tests shared in this chat, which the list only makes once it's scrolled to.
        try waitFor("the notifications switch", timeout: 15) {
            if !notifications.exists, self.zuna.element(A11y.Details.screen).exists { self.zuna.element(A11y.Details.screen).swipeUp() }
            return notifications.isHittable
        }
        XCTAssertTrue(notifications.label.contains("Muted until"), notifications.label)
        zuna.screenshot("124-muted-until")
        notifications.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("the laptop to see it unmuted", timeout: 20) {
            try laptop.conversation("user:\(self.aliceId)")?["muted"] as? Bool == false
        }
    }
}
