import Foundation
import XCTest
@testable import ZunaHost
@testable import ZunaModels

/// Every call `CoreAPI.swift` makes, against the real core bundle with no server joined. The
/// core reads a call's name before anything else (`serveCore` in rpc.ts), so a name it hasn't
/// got fails as "no such thing to do", and a session's call it has fails as the server not being
/// connected. A method renamed in the core is no type error in Swift, which this catches.
final class CoreAPITests: XCTestCase {
    private var directory: URL!
    private var runtime: CoreRuntime!
    private var connection: CoreConnection!

    private static let unknownMethod = "The core has no such thing to do."
    private static let notConnected = "That server isn't connected."

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        runtime = try CoreRuntime(options: .init(dataDirectory: directory, deviceKey: Data(repeating: 3, count: 32), deviceName: "API"))
        try await runtime.start()
        connection = CoreConnection(runtime: runtime) { _ in }
    }

    override func tearDown() async throws {
        connection = nil
        try? FileManager.default.removeItem(at: directory)
    }

    /// The call reached a method the core has: it worked, or failed for some reason of its own.
    private func reaches(_ name: String, line: UInt = #line, _ call: () async throws -> Void) async {
        do {
            try await call()
        } catch let error as CoreCallError {
            XCTAssertNotEqual(error.message, Self.unknownMethod, "\(name) names no method of the client", line: line)
        } catch {
            XCTFail("\(name) failed outside the core: \(error)", line: line)
        }
    }

    /// The call reached a method of a session, which the core then found no server for.
    private func needsServer(_ name: String, line: UInt = #line, _ call: () async throws -> Void) async {
        do {
            try await call()
            XCTFail("\(name) worked without a server", line: line)
        } catch let error as CoreCallError {
            XCTAssertEqual(error.message, Self.notConnected, "\(name)", line: line)
        } catch {
            XCTFail("\(name) failed outside the core: \(error)", line: line)
        }
    }

    func testAnUnknownCallIsRefusedByName() async throws {
        do {
            try await connection.call("noSuchMethod")
            XCTFail("an unknown method was called")
        } catch let error as CoreCallError {
            XCTAssertEqual(error.message, Self.unknownMethod)
        }
        do {
            try await connection.call("noSuchMethod", server: "s")
            XCTFail("an unknown method was called")
        } catch let error as CoreCallError {
            XCTAssertEqual(error.message, Self.unknownMethod)
        }
        // A private part of the session isn't callable either.
        do {
            try await connection.call("withLock", server: "s")
            XCTFail("a private method was called")
        } catch let error as CoreCallError {
            XCTAssertEqual(error.message, Self.unknownMethod)
        }
    }

    func testTheClientsCalls() async throws {
        let connection = connection!
        // Nothing listens on port 1, so whatever goes to a server fails there, not in the core's RPC.
        let nowhere = "http://127.0.0.1:1"
        let info = ServerInfo(name: "Nowhere", version: "0", hasIcon: false, claimed: true, registration: "invite", maxUploadMb: 10,
                              allowMemberInvites: true, retentionDays: 0, emoteSetId: "", emoteSetName: "", userCount: 1)
        let invite = InvitePreview(url: nowhere, code: "code", setup: false, server: info)

        await reaches("serverInfo") { _ = try await connection.serverInfo(url: nowhere) }
        await reaches("register") { _ = try await connection.register(invite, username: "someone", password: "a long password here", profile: Profile(displayName: "Someone")) }
        await reaches("login") { _ = try await connection.login(url: nowhere, username: "someone", password: "a long password here") }
        await reaches("recover") { _ = try await connection.recover(url: nowhere, username: "someone", recoveryKey: "key", newPassword: "another long password") }
        await reaches("reorderServers") { try await connection.reorderServers([]) }
        await reaches("leaveServer") { try await connection.leaveServer("nowhere") }
        await reaches("deleteAccount") { try await connection.deleteAccount("nowhere", password: "a long password here") }
        await reaches("nudge") { try await connection.nudge() }
        await reaches("setActive") { try await connection.setActive(true, shownServer: nil) }
        await reaches("reload") { try await connection.reload() }
        await reaches("forwardMessages") {
            try await connection.forwardMessages(from: "nowhere", groupId: "g", ids: ["m"], to: "nowhere", conversationKey: "user:u")
        }
        // Previews of this device's own pages are refused, so this asks nothing of the network.
        await reaches("linkPreview") { _ = try await connection.linkPreview("https://127.0.0.1/") }

        let link = try await connection.findLink("see https://example.com/page for it")
        XCTAssertEqual(link, "https://example.com/page")
        let none = try await connection.findLink("nothing to see")
        XCTAssertNil(none)
        let servers = try await connection.listServers()
        XCTAssertEqual(servers, [])
    }

    func testEverySessionCallNamesAMethodOfTheSession() async throws {
        let session = connection.session("not-joined")
        XCTAssertEqual(session.serverId, "not-joined")
        let file = WireFile(path: directory.appendingPathComponent("a.png").path, type: "image/png")
        let attachment = Attachment(fileId: "f", key: "k", prefix: "p", chunks: 1, name: "a.png", mime: "image/png", size: 3)
        let avatar = AvatarRef(fileId: "f", key: "k", prefix: "p", chunks: 1, mime: "image/png")
        let body = MessageBody(text: "hi", replyTo: "m0", emotes: ["KEKW": EmoteRef(id: "e", animated: true)], attachments: [attachment],
                               mentions: ["u"], location: SharedLocation(lat: 52.2, lon: 21.0, accuracy: 5))
        let outgoing = OutgoingFile(blob: file, name: "a.png", mime: "image/png", width: 2, height: 2, thumb: "data:,", duration: 1, voice: false, waveform: "AA", round: false)
        let push = PushSettings(relay: "https://relay.example", handle: "h", callHandle: "c", key: Data([1, 2]), registration: "r", sendMuted: true)
        let channel = NewChannel(type: .voice, name: "Talk", topic: "t", category: "c", bitrate: 64000, userLimit: 5, screenLimit: 1, sounds: true, watch: true, slowMode: 10)
        let changes = ChannelChanges(name: "Talk", topic: "t", category: "c", bitrate: 64000, userLimit: 5, screenLimit: 1, sounds: false, watch: false, slowMode: 0)
        let update = VoiceUpdate(muted: true, deafened: false, camera: false, screen: false)
        let settings = ServerSettingsChanges(name: "Here", registration: "invite", allowMemberInvites: true, maxUploadMb: 20, retentionDays: 30,
                                             screenShare: .defaults, allowMemberBots: false, maxBots: 2)

        // State
        await needsServer("getConnectionState") { _ = try await session.getConnectionState() }
        await needsServer("getSelf") { _ = try await session.getSelf() }
        await needsServer("getInfo") { _ = try await session.getInfo() }
        await needsServer("getUsers") { _ = try await session.getUsers() }
        await needsServer("getConversations") { _ = try await session.getConversations() }
        await needsServer("getPreferences") { _ = try await session.getPreferences() }
        await needsServer("updatePreferences") { try await session.updatePreferences(PreferenceChanges(pinned: ["a"], hidden: [], muted: [], sendReadReceipts: true)) }
        await needsServer("getEmotes") { _ = try await session.getEmotes() }
        await needsServer("getDevices") { _ = try await session.getDevices() }
        await needsServer("getNewDevices") { _ = try await session.getNewDevices() }
        await needsServer("answerNewDevice") { try await session.answerNewDevice("d", mine: true) }

        // Messages
        await needsServer("loadMessages") { _ = try await session.loadMessages("g") }
        await needsServer("loadMessages before") { _ = try await session.loadMessages("g", before: 9) }
        await needsServer("loadAround") { _ = try await session.loadAround("g", seq: 3) }
        await needsServer("loadNewer") { _ = try await session.loadNewer("g", after: 3) }
        await needsServer("messageById") { _ = try await session.messageById("g", id: "m") }
        await needsServer("catchUpFirst") { try await session.catchUpFirst("g") }
        await needsServer("unreadMentions") { _ = try await session.unreadMentions("g", after: 0) }
        await needsServer("markMentionSeen") { try await session.markMentionSeen("g", id: "m") }
        await needsServer("loadPins") { _ = try await session.loadPins("g") }
        await needsServer("search") { _ = try await session.search("words") }
        await needsServer("search in a chat") { _ = try await session.search("words", groupId: "g", limit: 5) }
        await needsServer("searchCoverage") { _ = try await session.searchCoverage() }
        await needsServer("mediaCounts") { _ = try await session.mediaCounts("g") }
        await needsServer("loadMedia") { _ = try await session.loadMedia("g", kind: .photo) }
        await needsServer("loadMedia with a limit") { _ = try await session.loadMedia("g", kind: .link, before: 4, limit: 2) }
        await needsServer("sendMessage") { _ = try await session.sendMessage("user:u", body, previewUrl: "https://example.com") }
        await needsServer("sendWithAttachments") { try await session.sendWithAttachments("user:u", files: [outgoing], body: body, keepMetadata: true) }
        await needsServer("sendNow") { try await session.sendNow("user:u", files: [], body: MessageBody(text: "now")) }
        await needsServer("emotesIn") { _ = try await session.emotesIn("KEKW") }
        await needsServer("retryMessage") { try await session.retryMessage("g", id: "m") }
        await needsServer("discardMessage") { try await session.discardMessage("g", id: "m") }
        await needsServer("editMessage") { try await session.editMessage("g", id: "m", text: "fixed", emotes: [:], mentions: []) }
        await needsServer("deleteMessage") { try await session.deleteMessage("g", id: "m") }
        await needsServer("deleteMessages") { try await session.deleteMessages("g", ids: ["m"]) }
        await needsServer("mute") { try await session.mute("user:u") }
        await needsServer("mute until") { try await session.mute("user:u", until: 1_900_000_000_000) }
        await needsServer("unmute") { try await session.unmute("user:u") }
        await needsServer("setMarkedUnread") { try await session.setMarkedUnread("user:u", marked: true) }
        await needsServer("setBlocked") { try await session.setBlocked("u", blocked: true) }
        await needsServer("setMentionsOnly") { try await session.setMentionsOnly("group:g", on: true) }
        await needsServer("markChatRead") { try await session.markChatRead("user:u") }
        await needsServer("setPinned") { try await session.setPinned("g", id: "m", pinned: true) }
        await needsServer("toggleReaction") { try await session.toggleReaction("g", messageId: "m", key: "👍") }
        await needsServer("toggleReaction with an emote") { try await session.toggleReaction("g", messageId: "m", key: "KEKW", emote: EmoteRef(id: "e")) }
        await needsServer("pressButton") { try await session.pressButton("g", messageId: "m", row: 0, column: 1) }
        await needsServer("sendTyping") { try await session.sendTyping("g") }
        await needsServer("markRead") { try await session.markRead("g", seq: 4) }
        await needsServer("setPush") { try await session.setPush(push) }
        await needsServer("setPush off") { try await session.setPush(nil) }

        // Groups
        await needsServer("createGroup") { _ = try await session.createGroup("Weekend", memberIds: ["u"], historyVisible: true) }
        await needsServer("addMembers") { try await session.addMembers("g", userIds: ["u"]) }
        await needsServer("removeMember") { try await session.removeMember("g", userId: "u") }
        await needsServer("leaveGroup") { try await session.leaveGroup("g") }
        await needsServer("deleteGroup") { try await session.deleteGroup("g") }
        await needsServer("forgetConversation") { try await session.forgetConversation("g") }
        await needsServer("setGroupRole") { try await session.setGroupRole("g", userId: "u", role: .admin) }
        await needsServer("updateGroupMeta") { try await session.updateGroupMeta("g", GroupMetaChanges(name: "New", description: "About")) }
        await needsServer("updateGroupMeta, a picture") { try await session.updateGroupMeta("g", GroupMetaChanges(), avatar: .set(file), historyVisible: false) }
        await needsServer("updateGroupMeta, no picture") { try await session.updateGroupMeta("g", GroupMetaChanges(), avatar: .removed) }
        await needsServer("setDisappearing") { try await session.setDisappearing("g", seconds: 3600) }

        // Channels
        await needsServer("getChannels") { _ = try await session.getChannels() }
        await needsServer("getVoiceMembers") { _ = try await session.getVoiceMembers() }
        await needsServer("createChannel") { _ = try await session.createChannel(channel) }
        await needsServer("updateChannel") { try await session.updateChannel("c", changes) }
        await needsServer("reorderChannels") { try await session.reorderChannels(["c"]) }
        await needsServer("deleteChannel") { try await session.deleteChannel("c") }

        // Voice channels
        await needsServer("voiceAccess") { _ = try await session.voiceAccess("c") }
        await needsServer("voiceKey") { _ = try await session.voiceKey("c") }
        await needsServer("setVoiceState") { try await session.setVoiceState("c", update, ring: true) }
        await needsServer("setVoiceState, leaving") { try await session.setVoiceState(nil, nil) }
        await needsServer("voiceDisconnect") { try await session.voiceDisconnect("c", userId: "u") }
        await needsServer("voiceMute") { try await session.voiceMute("c", userId: "u", muted: true) }
        await needsServer("voiceScreenAccess") { _ = try await session.voiceScreenAccess("c", ScreenRequest(sound: true)) }
        await needsServer("voiceScreenStop") { try await session.voiceScreenStop("c") }
        await needsServer("voiceScreenStopOf") { try await session.voiceScreenStopOf("c", userId: "u") }

        // Calls
        await needsServer("getCalls") { _ = try await session.getCalls() }
        await needsServer("prepareCall") { _ = try await session.prepareCall("user:u") }
        await needsServer("ringCall") { try await session.ringCall("g", userIds: ["u"]) }
        await needsServer("declineCall") { try await session.declineCall("g") }

        // Soundboard
        await needsServer("getSounds") { _ = try await session.getSounds() }
        await needsServer("addSound") { _ = try await session.addSound(file, name: "Horn", emoji: "📯") }
        await needsServer("updateSound") { try await session.updateSound("s", SoundChanges(name: "Horn", emoji: "📣")) }
        await needsServer("deleteSound") { try await session.deleteSound("s") }
        await needsServer("soundFile") { _ = try await session.soundFile("s") }
        await needsServer("playSound") { try await session.playSound("c", soundId: "s") }

        // Watching together
        await needsServer("getWatch") { _ = try await session.getWatch("c") }
        await needsServer("watchStart") { try await session.watchStart("c", url: "https://youtu.be/dQw4w9WgXcQ") }
        await needsServer("watchControl") { try await session.watchControl("c", WatchChange(playing: true, position: 1000, rate: 1.5)) }
        await needsServer("watchStop") { try await session.watchStop("c") }

        // Invites and verification
        await needsServer("invites") { _ = try await session.invites() }
        await needsServer("createInvite") { _ = try await session.createInvite(maxUses: 1, expiresInSeconds: 60) }
        await needsServer("linkForInvite") { _ = try await session.linkForInvite("code") }
        await needsServer("revokeInvite") { try await session.revokeInvite("code") }
        await needsServer("safetyCheck") { _ = try await session.safetyCheck("u") }
        await needsServer("markVerified") { try await session.markVerified("u", covers: "x") }
        await needsServer("clearVerification") { try await session.clearVerification("u") }

        // Profile and security
        await needsServer("updateProfile") { try await session.updateProfile(ProfileChanges(displayName: "Me", bio: "About me")) }
        await needsServer("updateProfile, a picture") { try await session.updateProfile(ProfileChanges(), avatar: .set(file)) }
        await needsServer("updateProfile, no picture") { try await session.updateProfile(ProfileChanges(), avatar: .removed) }
        await needsServer("setHideLastSeen") { try await session.setHideLastSeen(true) }
        await needsServer("exportServerData") { _ = try await session.exportServerData() }
        await needsServer("revokeDevice") { try await session.revokeDevice("d") }
        await needsServer("changePassword") { try await session.changePassword(current: "a long password here", next: "another long password") }
        await needsServer("regenerateRecoveryKey") { _ = try await session.regenerateRecoveryKey(password: "a long password here") }

        // Server administration
        await needsServer("updateServerIcon") { try await session.updateServerIcon(file) }
        await needsServer("setEmoteSet") { _ = try await session.setEmoteSet("https://7tv.app/emote-sets/x") }
        await needsServer("setServerRole") { try await session.setServerRole("u", role: .admin) }
        await needsServer("banUser") { try await session.banUser("u") }
        await needsServer("unbanUser") { try await session.unbanUser("u") }
        await needsServer("getBans") { _ = try await session.getBans() }
        await needsServer("reportUser") { try await session.reportUser("u", reason: .spam) }
        await needsServer("getReports") { _ = try await session.getReports() }
        await needsServer("dismissReports") { try await session.dismissReports("u") }
        await needsServer("updateServerSettings") { try await session.updateServerSettings(settings) }

        // Bots
        await needsServer("getBots") { _ = try await session.getBots() }
        await needsServer("createBot") { _ = try await session.createBot(NewBot(username: "helper", name: "Helper", listed: true, add: .admins, files: false)) }
        await needsServer("newBotLink") { _ = try await session.newBotLink("b") }
        await needsServer("updateBot") { try await session.updateBot("b", BotChanges(listed: false, add: .owner, files: true)) }
        await needsServer("updateBotProfile") { try await session.updateBotProfile("b", ProfileChanges(displayName: "Helper")) }
        await needsServer("updateBotProfile, a picture") { try await session.updateBotProfile("b", ProfileChanges(), avatar: .set(file)) }
        await needsServer("updateBotProfile, no picture") { try await session.updateBotProfile("b", ProfileChanges(), avatar: .removed) }
        await needsServer("deleteBot") { try await session.deleteBot("b") }
        await needsServer("setBotChannels") { try await session.setBotChannels("b", channelIds: ["c"]) }

        // Files
        await needsServer("downloadFile") { _ = try await session.downloadFile(attachment) }
        await needsServer("downloadFile, a picture") { _ = try await session.downloadFile(avatar) }
        await needsServer("downloadChunk") { _ = try await session.downloadChunk(attachment, index: 0) }
    }

    /// What goes over the wire for the arguments that aren't plain: one left out is `undefined`, not null.
    func testArgumentsAreWrittenAsTheCoreReadsThem() throws {
        let encode = { (value: any Encodable) in String(decoding: try CoreConnection.encoder.encode(AnyArgument(value)), as: UTF8.self) }
        XCTAssertEqual(try encode(Absent()), #"{"$undefined":true}"#)
        let file = WireFile(path: "/tmp/a", type: "image/png")
        let wrapped = try JSONSerialization.jsonObject(with: CoreConnection.encoder.encode(file)) as? [String: [String: String]]
        XCTAssertEqual(wrapped, ["$file": ["path": "/tmp/a", "type": "image/png"]])
        XCTAssertEqual(try CoreConnection.decoder.decode(WireFile.self, from: CoreConnection.encoder.encode(file)), file)
        let settings = try JSONSerialization.jsonObject(with: CoreConnection.encoder.encode(ServerSettingsChanges(allowMemberInvites: false, maxUploadMb: 5))) as? [String: Any]
        XCTAssertEqual(settings?.keys.sorted(), ["allow_member_invites", "max_upload_mb"])
        let emotes = try CoreConnection.decoder.decode(EmoteSetChange.self, from: Data(#"{"set_id":"s","set_name":"Set","count":3}"#.utf8))
        XCTAssertEqual(emotes, EmoteSetChange(setId: "s", setName: "Set", count: 3))
        let created = try CoreConnection.decoder.decode(CreatedBot.self, from: Data(#"""
        {"bot":{"id":"b","username":"helper","ownerId":"u","listed":true,"add":"anyone","files":true,"channels":["c"],"setUp":false,"createdAt":5},
         "link":"https://chat.example/bot/x"}
        """#.utf8))
        XCTAssertEqual(created.bot.add, .anyone)
        XCTAssertEqual(created.link, "https://chat.example/bot/x")
        let place = try CoreConnection.decoder.decode([MessagePlace].self, from: Data(#"[{"id":"m","seq":7}]"#.utf8))
        XCTAssertEqual(place, [MessagePlace(id: "m", seq: 7)])
    }
}

private struct AnyArgument: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
