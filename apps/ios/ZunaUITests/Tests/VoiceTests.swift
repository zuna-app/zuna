import XCTest

/// Voice channels: joined from the list, the call over the app with everyone in
/// it, and what the phone does there told to everyone else; an admin's say over
/// it; the bar at the top while looking elsewhere; and leaving. The desktop peers
/// have no media of their own, so they're in the channel only as far as the
/// server can tell. What crosses between the phone and a real desktop app is
/// checked by `npm run test:ios:voice`.
final class VoiceTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }

    private func channelId(_ peer: Peer, _ name: String) throws -> String {
        let channels = try peer.call("getChannels") as? [[String: Any]] ?? []
        return try XCTUnwrap(channels.first { $0["name"] as? String == name }?["id"] as? String, "no \(name)")
    }

    /// Everyone in voice channels on the server, as a peer is told.
    private func members(_ peer: Peer) throws -> [[String: Any]] {
        try peer.call("getVoiceMembers") as? [[String: Any]] ?? []
    }

    private func bobsPhone(_ peer: Peer) throws -> [String: Any]? {
        let device = try phoneDevice()
        return try members(peer).first { $0["deviceId"] as? String == device }
    }

    private func phoneDevice() throws -> String {
        let control = zuna.control!, serverId = zuna.serverId
        return try blocking {
            let me = try await control.call("getSelf", server: serverId) as? [String: Any]
            return me?["deviceId"] as? String ?? ""
        }
    }

    private let here: [String: Any] = ["muted": false, "deafened": false, "camera": false, "screen": false]

    /// What the app says about its call, as the control server's `voiceState`.
    private func voiceState() throws -> [String: Any] {
        let control = zuna.control!
        let text = try blocking { try await control.host("voiceState") as? String ?? "{}" }
        return (try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
    }

    func testComesIntoAVoiceChannelAndSaysWhatItsDoing() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        let lounge = try channelId(alice, "Lounge")
        // Carol is in already, as far as the server can tell.
        try carol.call("setVoiceState", [lounge, here])
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let device = try phoneDevice()
        let carolDevice = try XCTUnwrap(try members(alice).first { $0["channelId"] as? String == lounge }?["deviceId"] as? String)

        // A tap comes in, with the call over the app, encrypted.
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Voice.stage).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Voice.encrypted).exists)
        XCTAssertTrue(zuna.element(A11y.Voice.person(device)).waitForExistence(timeout: 30))
        XCTAssertTrue(zuna.element(A11y.Voice.person(carolDevice)).exists)
        try waitFor("alice to see bob come in") { try self.bobsPhone(alice)?["channelId"] as? String == lounge }
        XCTAssertEqual(try bobsPhone(alice)?["muted"] as? Bool, false)
        zuna.screenshot("95-voice-call")

        // Muting, and deafening, is told to everyone.
        zuna.element(A11y.Voice.mute).tap()
        try waitFor("alice to see bob muted") { try self.bobsPhone(alice)?["muted"] as? Bool == true }
        zuna.element(A11y.Voice.mute).tap()
        try waitFor("alice to see bob talking again") { try self.bobsPhone(alice)?["muted"] as? Bool == false }
        zuna.element(A11y.Voice.deafen).tap()
        try waitFor("alice to see bob deafened") { try self.bobsPhone(alice)?["deafened"] as? Bool == true }
        // Unmuting while deafened undoes both.
        zuna.element(A11y.Voice.mute).tap()
        try waitFor("alice to see bob hearing again") {
            let phone = try self.bobsPhone(alice)
            return phone?["deafened"] as? Bool == false && phone?["muted"] as? Bool == false
        }

        // An admin mutes him for everyone, which only an admin can undo.
        try alice.call("voiceMute", [lounge, bobId, true])
        XCTAssertTrue(zuna.toast(startingWith: "An admin muted you").waitForExistence(timeout: 10))
        try waitFor("the microphone to be held") { !self.zuna.element(A11y.Voice.mute).isEnabled }
        try alice.call("voiceMute", [lounge, bobId, false])
        XCTAssertTrue(zuna.toast(startingWith: "An admin unmuted you").waitForExistence(timeout: 10))
        try waitFor("the microphone to be back") { self.zuna.element(A11y.Voice.mute).isEnabled }

        // The camera, which everyone is told about, and which shows on his own tile.
        zuna.element(A11y.Voice.camera).tap()
        try waitFor("alice to see bob's camera") { try self.bobsPhone(alice)?["camera"] as? Bool == true }
        try waitFor("his picture on his tile") { self.zuna.element(A11y.Voice.person(device)).label.contains("camera on") }
        XCTAssertTrue(zuna.element(A11y.Voice.flip).exists)
        // All of it on the screen, the camera's switch too, which once pushed the controls past both edges.
        for id in [A11y.Voice.mute, A11y.Voice.leave, A11y.Voice.flip, A11y.Voice.person(device), A11y.Voice.person(carolDevice)] {
            XCTAssertTrue(zuna.app.frame.contains(zuna.element(id).frame), "\(id) goes past the screen's edge")
        }
        zuna.screenshot("96-voice-camera")
        zuna.element(A11y.Voice.camera).tap()
        try waitFor("alice to see it off") { try self.bobsPhone(alice)?["camera"] as? Bool == false }

        // His screen, which everyone is told about too, and which he sees on his own stage.
        let share = zuna.element(A11y.Voice.shareScreen)
        XCTAssertTrue(zuna.app.frame.contains(share.frame), "sharing the screen goes past the screen's edge")
        share.tap()
        try waitFor("alice to see bob's screen") { try self.bobsPhone(alice)?["screen"] as? Bool == true }
        let ownScreen = zuna.app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Your screen")).firstMatch
        XCTAssertTrue(ownScreen.waitForExistence(timeout: 10))
        XCTAssertEqual(share.label, "Stop sharing")
        zuna.screenshot("96b-voice-screen")
        share.tap()
        try waitFor("alice to see it stopped") { try self.bobsPhone(alice)?["screen"] as? Bool == false }
        try waitFor("his screen off his stage") { !ownScreen.exists }

        // Once the server only lets admins share, he's told why, and nothing goes out.
        let rules: [String: Any] = ["who": "admins", "sound": true, "admins_exempt": false, "max_per_channel": 0, "max_per_server": 0, "max_height": 0, "max_fps": 0, "max_kbps": 0, "max_sound_kbps": 0, "default_height": 0, "default_fps": 60, "default_kbps": 20_000]
        try alice.call("updateServerSettings", [["screen_share": rules]])
        share.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Only admins can share a screen").waitForExistence(timeout: 10))
        XCTAssertEqual(try bobsPhone(alice)?["screen"] as? Bool, false)
        try alice.call("updateServerSettings", [["screen_share": rules.merging(["who": "everyone"]) { $1 }]])

        // Someone else, from a long press: how loud they are, and muting them here alone.
        zuna.element(A11y.Voice.person(carolDevice)).press(forDuration: 1.0)
        XCTAssertTrue(zuna.element(A11y.Voice.memberSheet).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Voice.volume).exists)
        zuna.element(A11y.Voice.muteForMe).switches.firstMatch.tap()
        zuna.screenshot("97-voice-member")
        zuna.app.buttons["Done"].tap()
        try waitFor("carol muted here") { self.zuna.element(A11y.Voice.person(carolDevice)).label.contains("muted for you") }

        // Down into the bar, to look elsewhere, and back.
        zuna.element(A11y.Voice.minimize).tap()
        let bar = zuna.element(A11y.Voice.bar)
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertTrue(bar.label.contains("Lounge"))
        zuna.screenshot("98-voice-bar")
        bar.tap()
        XCTAssertTrue(zuna.element(A11y.Voice.stage).waitForExistence(timeout: 5))

        // The channel's chat, with the call still in the bar.
        zuna.element(A11y.Voice.chat).tap()
        XCTAssertTrue(zuna.element(A11y.Chat.title).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Chat.title).label.contains("Lounge"))
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        bar.tap()

        // Leaving tells everyone.
        XCTAssertTrue(zuna.element(A11y.Voice.leave).waitForExistence(timeout: 5))
        zuna.element(A11y.Voice.leave).tap()
        try waitFor("alice to see bob leave") { try self.bobsPhone(alice) == nil }
        XCTAssertFalse(zuna.element(A11y.Voice.bar).exists)
        XCTAssertFalse(zuna.element(A11y.Channels.occupant(device)).exists)
        try carol.call("setVoiceState", [NSNull(), NSNull()])
    }

    func testPlaysASoundFromTheSoundboardToEveryoneInTheChannel() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        let lounge = try channelId(alice, "Lounge")
        // Carol is in already, and hears whatever's played there.
        try carol.call("setVoiceState", [lounge, here])
        defer { _ = try? carol.call("setVoiceState", [NSNull(), NSNull()]) }
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let device = try phoneDevice()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Voice.person(device)).waitForExistence(timeout: 30))
        try waitFor("alice to see bob come in") { try self.bobsPhone(alice)?["channelId"] as? String == lounge }
        let heard = try WorldControl.soundsHeard("carol").count

        // The server's sounds, from the call's controls.
        let button = zuna.element(A11y.Voice.soundboardButton)
        XCTAssertTrue(zuna.app.frame.contains(button.frame), "the soundboard goes past the screen's edge")
        button.tap()
        XCTAssertTrue(zuna.element(A11y.Voice.soundboard).waitForExistence(timeout: 5))
        let horn = zuna.element(A11y.Voice.sound("Airhorn"))
        XCTAssertTrue(horn.waitForExistence(timeout: 15))
        zuna.screenshot("99-voice-soundboard")
        horn.tap()
        zuna.app.buttons["Done"].tap()

        // Carol's app is told bob played it, and his tile here says he's playing a sound.
        try waitFor("carol to hear bob's sound") { try WorldControl.soundsHeard("carol").count > heard }
        XCTAssertEqual(try WorldControl.soundsHeard("carol").last?["userId"], bobId)
        try waitFor("bob's tile to say he's playing a sound") { self.zuna.element(A11y.Voice.person(device)).label.contains("playing a sound") }
        zuna.screenshot("99b-voice-sound-playing")

        // Muted, the soundboard says why, and nothing can be played.
        zuna.element(A11y.Voice.mute).tap()
        try waitFor("alice to see bob muted") { try self.bobsPhone(alice)?["muted"] as? Bool == true }
        button.tap()
        XCTAssertTrue(zuna.element(A11y.Voice.soundRefusal).waitForExistence(timeout: 5))
        XCTAssertFalse(zuna.element(A11y.Voice.sound("Airhorn")).isEnabled)
        zuna.app.buttons["Done"].tap()
        zuna.element(A11y.Voice.mute).tap()

        zuna.element(A11y.Voice.leave).tap()
        try waitFor("alice to see bob leave") { try self.bobsPhone(alice) == nil }
    }

    func testSharesAtTheMostChosenInSettings() throws {
        let alice = try Peer("alice")
        let lounge = try channelId(alice, "Lounge")
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()

        // At most 2 Mbit/s, where the server suggests 20.
        zuna.tab("Settings").tap()
        let voiceSettings = zuna.element(A11y.Settings.voice)
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 10))
        voiceSettings.tap()
        let bitrate = zuna.element(A11y.Settings.screenBitrate)
        XCTAssertTrue(bitrate.waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Your screen goes out at its own size")).firstMatch.exists)
        bitrate.tap()
        let choice = zuna.app.buttons["2 Mbit/s"]
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        choice.tap()
        zuna.screenshot("99-voice-share-settings")

        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        try waitFor("alice to see bob come in", timeout: 30) { try self.bobsPhone(alice) != nil }
        let share = zuna.element(A11y.Voice.shareScreen)
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        try waitFor("alice to see bob's screen") { try self.bobsPhone(alice)?["screen"] as? Bool == true }
        XCTAssertEqual(try voiceState()["screenKbps"] as? Int, 2000)
        zuna.element(A11y.Voice.leave).tap()
        try waitFor("alice to see bob leave") { try self.bobsPhone(alice) == nil }
    }

    func testShowsWhatGoesOutInStreamStats() throws {
        let alice = try Peer("alice")
        let lounge = try channelId(alice, "Lounge")
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        try waitFor("alice to see bob come in", timeout: 30) { try self.bobsPhone(alice) != nil }

        // The camera and the screen, before the stats cover the controls.
        zuna.element(A11y.Voice.camera).tap()
        try waitFor("alice to see bob's camera") { try self.bobsPhone(alice)?["camera"] as? Bool == true }
        zuna.element(A11y.Voice.shareScreen).tap()
        try waitFor("alice to see bob's screen") { try self.bobsPhone(alice)?["screen"] as? Bool == true }

        // From the connection's bars, over the call, each stream's frames counted. The peers here watch nothing, so
        // the media server soon has the phone stop sending them: what reaches a desktop is in `npm run test:ios:voice`.
        zuna.element(A11y.Voice.stats).tap()
        let sheet = zuna.element(A11y.Voice.statsSheet)
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        let headline = { (title: String) in
            self.zuna.app.descendants(matching: .any).matching(identifier: A11y.Voice.statsHeadline).matching(NSPredicate(format: "label BEGINSWITH %@", "\(title):")).firstMatch
        }
        let text = { (start: String) in self.zuna.app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", start)).firstMatch }
        let capturing = { () -> Double in
            let element = text("Capturing, ")
            guard element.exists else { return 0 }
            return Double(element.label.dropFirst("Capturing, ".count).split(separator: " ").first ?? "") ?? 0
        }
        // The list only has what's on screen, so what's further down is scrolled to.
        let reveal = { (element: XCUIElement) in
            for _ in 0..<12 where !(element.exists && element.isHittable) { sheet.swipeUp() }
        }
        XCTAssertTrue(headline("Your camera").waitForExistence(timeout: 10))
        try waitFor("frames from the camera", timeout: 15) { capturing() > 0 }
        zuna.screenshot("99b-voice-stats")
        // The screen's against the frame rate it was asked for.
        reveal(headline("Your screen"))
        XCTAssertTrue(headline("Your screen").label.contains("fps sent of "), headline("Your screen").label)

        // Further down, how the screen goes out, the connection, and the microphone.
        for (start, what) in [("Sent through, Moving bars", "how the screen goes out"), ("Media server", "the media server"), ("Encryption, End to end, key", "the room's key"), ("Your microphone", "the microphone")] {
            let element = text(start)
            reveal(element)
            XCTAssertTrue(element.exists, "no \(what) in the stats")
        }
        zuna.screenshot("99c-voice-stats-connection")
        // What's copied is what `voice-run.ts` reads, through the same text.
        zuna.app.buttons["Copy all of it"].tap()

        zuna.app.buttons["Done"].tap()
        try waitFor("the stats to close") { !sheet.exists }
        zuna.element(A11y.Voice.leave).tap()
        try waitFor("alice to see bob leave") { try self.bobsPhone(alice) == nil }
    }

    /// What the system has of the call (`SystemCall.report`).
    private func systemCall() throws -> [String: Any] {
        try voiceState()["systemCall"] as? [String: Any] ?? [:]
    }

    /// The simulator's CallKit takes a call and ends it at once, having no audio to give it, so this checks
    /// that a call handed to it goes on all the same. The lock screen and its buttons need a device.
    func testHandsTheCallToTheSystemAndGoesOnWithoutIt() throws {
        let alice = try Peer("alice")
        let lounge = try channelId(alice, "Lounge")
        try zuna.launch(systemCall: true)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        try waitFor("alice to see bob come in", timeout: 30) { try self.bobsPhone(alice) != nil }
        XCTAssertEqual(try systemCall()["handed"] as? Bool, true, "the system didn't take the call")

        // Still in once the system has let go of it, and muting still reaches everyone.
        try waitFor("the system to let go of the call") { try self.systemCall()["current"] as? Bool == false }
        zuna.element(A11y.Voice.mute).tap()
        try waitFor("alice to see bob muted") { try self.bobsPhone(alice)?["muted"] as? Bool == true }
        XCTAssertTrue(zuna.element(A11y.Voice.stage).exists)

        zuna.element(A11y.Voice.leave).tap()
        try waitFor("alice to see bob leave") { try self.bobsPhone(alice) == nil }
    }

    func testIsTakenOutByAnAdminOrAnotherDevice() throws {
        let alice = try Peer("alice")
        let bobLaptop = try Peer("bobLaptop")
        let lounge = try channelId(alice, "Lounge")
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(lounge))
        XCTAssertTrue(row.waitForExistence(timeout: 30))

        // An admin disconnects him.
        row.tap()
        try waitFor("alice to see bob come in", timeout: 30) { try self.bobsPhone(alice) != nil }
        try alice.call("voiceDisconnect", [lounge, bobId])
        XCTAssertTrue(zuna.toast(startingWith: "An admin took you out").waitForExistence(timeout: 10))
        try waitFor("the call to close") { !self.zuna.element(A11y.Voice.stage).exists && !self.zuna.element(A11y.Voice.bar).exists }

        // Coming in on his laptop ends it on the phone, as only one device can be in.
        row.tap()
        try waitFor("alice to see bob come in again", timeout: 30) { try self.bobsPhone(alice) != nil }
        try bobLaptop.call("setVoiceState", [lounge, here])
        XCTAssertTrue(zuna.toast(startingWith: "You joined this voice channel on another device").waitForExistence(timeout: 10))
        try waitFor("the call to close") { !self.zuna.element(A11y.Voice.stage).exists && !self.zuna.element(A11y.Voice.bar).exists }
        try bobLaptop.call("setVoiceState", [NSNull(), NSNull()])
    }
}
