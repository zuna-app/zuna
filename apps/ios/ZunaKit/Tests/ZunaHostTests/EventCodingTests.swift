import Foundation
import XCTest
@testable import ZunaModels

/// The core's events and lists as Swift reads them: every kind of event both ways, as the app
/// hands them on, and lists that keep what they can read of a row the models don't know.
final class EventCodingTests: XCTestCase {
    private let decoder = CoreConnection.decoder
    private let encoder = CoreConnection.encoder

    private func message(_ id: String) throws -> MessageView {
        try decoder.decode(MessageView.self, from: Data(#"""
        {"id":"\#(id)","groupId":"g1","seq":3,"senderId":"u1","createdAt":1,"editedAt":null,"deletedAt":null,"pinnedAt":null,
         "pinnedBy":null,"status":"sent","text":"hi","emotes":{},"attachments":[],"mentions":[],"reply":null,"reactions":[],"system":null}
        """#.utf8))
    }

    private var info: ServerInfo {
        ServerInfo(name: "Chat", version: "1", hasIcon: false, claimed: true, registration: "invite", maxUploadMb: 25, allowMemberInvites: true,
                   allowMemberBots: false, maxBots: 3, retentionDays: 0, emoteSetId: "s", emoteSetName: "Set", userCount: 4,
                   communityKey: "k", voice: 1, calls: 1, screenShare: .defaults)
    }

    func testEveryEventGoesBothWays() throws {
        let member = VoiceMember(channelId: "c", userId: "u", deviceId: "d", muted: false, deafened: false, serverMuted: true, camera: true, screen: false, since: 9)
        let watch = WatchView(session: "w", video: .init(id: "dQw4w9WgXcQ", startedBy: "u", title: "A video", author: "Someone", image: nil),
                              playing: true, position: 1000, at: 5000, rate: 1.5, changedBy: "u")
        let events: [CoreEvent] = [
            .connection(serverId: "s", state: .online),
            .conversations(serverId: "s"),
            .channels(serverId: "s"),
            .voice(serverId: "s", channelId: "c", userId: "u", deviceId: "d", member: member),
            .voice(serverId: "s", channelId: "c", userId: "u", deviceId: "d", member: nil),
            .voiceKey(serverId: "s", channelId: "c"),
            .voiceEnded(serverId: "s", channelId: "c", reason: "removed"),
            .screenEnded(serverId: "s", channelId: "c", reason: "stopped"),
            .call(serverId: "s", groupId: "g", call: CallView(groupId: "g", startedBy: "u", startedAt: 1, ringing: ["v"], declined: [])),
            .call(serverId: "s", groupId: "g", call: nil),
            .calls(serverId: "s"),
            .message(serverId: "s", message: try message("m1"), isNew: true),
            .messageRemoved(serverId: "s", groupId: "g", id: "m1"),
            .messageMoved(serverId: "s", fromGroupId: "g0", message: try message("m2")),
            .users(serverId: "s"),
            .presence(serverId: "s", userId: "u", online: false, lastSeenAt: 77),
            .presence(serverId: "s", userId: "u", online: true, lastSeenAt: nil),
            .typing(serverId: "s", groupId: "g", userId: "u"),
            .read(serverId: "s", groupId: "g", userId: "u", seq: 12),
            .settings(serverId: "s", info: info),
            .emotes(serverId: "s"),
            .sounds(serverId: "s"),
            .sound(serverId: "s", channelId: "c", userId: "u", soundId: "o"),
            .watch(serverId: "s", channelId: "c", watch: watch),
            .watch(serverId: "s", channelId: "c", watch: nil),
            .preferences(serverId: "s"),
            .signedOut(serverId: "s", reason: "Your password was changed."),
            .signedIn(serverId: "s"),
            .security(serverId: "s", userId: "u", message: "Their keys changed."),
            .newDevices(serverId: "s", devices: [NewDevice(id: "d2", name: "iPad", createdAt: 3, secret: nil)]),
            .notify(serverId: "s", title: "Someone", body: "hi", conversationKey: "user:u", groupId: "g", messageId: "m1", inUse: false),
            .activity(serverId: "s", elsewhere: true),
        ]
        for event in events {
            let data = try encoder.encode(event)
            XCTAssertEqual(try decoder.decode(CoreEvent.self, from: data), event, String(decoding: data, as: UTF8.self))
            XCTAssertEqual(event.serverId, "s")
            XCTAssertEqual(event.isSignedOut, { if case .signedOut = event { true } else { false } }())
        }
        XCTAssertThrowsError(try decoder.decode(CoreEvent.self, from: Data(#"{"type":"something_new","serverId":"s"}"#.utf8)))
    }

    func testAnEventsWireNamesAreTheCores() throws {
        let encoded = try JSONSerialization.jsonObject(with: encoder.encode(CoreEvent.newDevices(serverId: "s", devices: []))) as? [String: Any]
        XCTAssertEqual(encoded?["type"] as? String, "new_devices")
        let removed = try JSONSerialization.jsonObject(with: encoder.encode(CoreEvent.messageRemoved(serverId: "s", groupId: "g", id: "m"))) as? [String: Any]
        XCTAssertEqual(removed?["type"] as? String, "message_removed")
        // What a notification says, from the core's own words for it.
        let notify = try decoder.decode(CoreEvent.self, from: Data(#"""
        {"type":"notify","serverId":"s","title":"Ann","body":"Lunch?","conversationKey":"user:a","groupId":"g","messageId":"m","inUse":true}
        """#.utf8))
        XCTAssertEqual(notify, .notify(serverId: "s", title: "Ann", body: "Lunch?", conversationKey: "user:a", groupId: "g", messageId: "m", inUse: true))
    }

    func testAListKeepsTheRowsItCanRead() throws {
        let list = try decoder.decode(LossyList<SoundView>.self, from: Data(#"""
        [{"id":"a","name":"Horn","emoji":"📯","durationMs":900}, {"id":"b"}, 7, {"id":"c","name":"Bell","emoji":"🔔","durationMs":400}]
        """#.utf8))
        XCTAssertEqual(list.items.map(\.id), ["a", "c"])
        XCTAssertEqual(try decoder.decode(LossyList<SoundView>.self, from: encoder.encode(list)).items, list.items)

        // A page of messages leaves out one it can't read, and says whether there's more.
        let page = try decoder.decode(MessagePage.self, from: Data(#"""
        {"messages":[{"id":"broken"}],"hasMore":true}
        """#.utf8))
        XCTAssertEqual(page.messages, [])
        XCTAssertTrue(page.hasMore)
        let full = try decoder.decode(MessagePage.self, from: Data(#"{"messages":[],"hasMore":false}"#.utf8))
        XCTAssertEqual(try decoder.decode(MessagePage.self, from: encoder.encode(full)), full)
    }

    func testAVideoWatchedTogetherIsWhereItsClockSays() {
        var watch = WatchView(session: "w", video: .init(id: "v", startedBy: "u", title: "", author: ""), playing: true, position: 1000, at: 10_000, rate: 2, changedBy: "u")
        XCTAssertEqual(watch.position(at: 10_500), 2000)
        // Before the change was made, it's at the start at most.
        XCTAssertEqual(watch.position(at: 9000), 0)
        watch.playing = false
        XCTAssertEqual(watch.position(at: 99_000), 1000)
    }

    func testRowsAreKnownByWhoTheyreAbout() throws {
        let report = try decoder.decode(ReportView.self, from: Data(#"{"userId":"u","count":2,"reasons":["spam","other"],"lastAt":5}"#.utf8))
        XCTAssertEqual(report.id, "u")
        XCTAssertEqual(report.reasons, [.spam, .other])
        let ban = try decoder.decode(BanView.self, from: Data(#"{"userId":"v","bannedAt":1,"bannedBy":"u"}"#.utf8))
        XCTAssertEqual(ban.id, "v")
        let conversation = try decoder.decode(ConversationView.self, from: Data(#"""
        {"key":"user:u","kind":"dm","groupId":"g","peerId":"u","title":"Someone","avatar":null,"description":"","lastMessage":null,
         "lastActivityAt":1,"unread":0,"mentioned":false,"unreadMentions":0,"pinned":false,"muted":false,"hidden":false,"markedUnread":false,
         "mentionsOnly":false,"blocked":false,"members":[{"userId":"u","role":"member","joinedAt":1}],"historyVisible":false,"readBy":{},"ownRead":0,
         "ready":true,"removed":false,"disappearAfter":0,"slowMode":0,"slowUntil":0}
        """#.utf8))
        XCTAssertEqual(conversation.id, "user:u")
        XCTAssertEqual(conversation.members.first?.role, .member)
        let device = NewDevice(id: "d", name: "Phone", createdAt: 1, secret: "s")
        XCTAssertEqual(try decoder.decode(NewDevice.self, from: encoder.encode(device)), device)
    }

    func testWhatTheAppMakesForTheCoreIsWhatItSaysItIs() throws {
        let body = MessageBody(text: "here", location: SharedLocation(lat: 1, lon: 2))
        XCTAssertEqual(try decoder.decode(MessageBody.self, from: encoder.encode(body)), body)
        XCTAssertEqual(try decoder.decode(SendOptions.self, from: encoder.encode(SendOptions(previewUrl: "https://a.example", keepMetadata: true))),
                       SendOptions(previewUrl: "https://a.example", keepMetadata: true))
        XCTAssertEqual(Profile(displayName: "Me", bio: "Hi").bio, "Hi")
        XCTAssertEqual(EmoteRef(id: "e", animated: true, zeroWidth: true, owner: "o").owner, "o")
        let channel = NewChannel(type: .text, name: "general")
        XCTAssertNil(channel.topic)
        XCTAssertEqual(ChannelChanges(name: "talk").name, "talk")
        XCTAssertEqual(SoundChanges(emoji: "🔔").emoji, "🔔")
        XCTAssertEqual(VoiceUpdate(muted: true, deafened: true, camera: false, screen: true).screen, true)
        XCTAssertEqual(ScreenRequest(sound: false).sound, false)
    }
}
