/// Accessibility identifiers, shared by the app and its UI tests, so tests
/// find elements without depending on their wording.
enum A11y {
    enum Root {
        static let failed = "root.failed"
        static let appLock = "root.appLock"
        static let unlockApp = "root.unlockApp"
    }

    enum Onboarding {
        static let welcome = "onboarding.welcome"
        static let joinWithInvite = "onboarding.joinWithInvite"
        static let link = "onboarding.link"
        static let paste = "onboarding.paste"
        static let `continue` = "onboarding.continue"
        static let error = "onboarding.error"
        static let signIn = "onboarding.signIn"
        static let cancel = "onboarding.cancel"
        static let joinScreen = "onboarding.join"
        static let displayName = "onboarding.displayName"
        static let username = "onboarding.username"
        static let password = "onboarding.password"
        static let confirmPassword = "onboarding.confirmPassword"
        static let strength = "onboarding.strength"
        static let create = "onboarding.create"
        static let terms = "onboarding.terms"
        static let recoveryKey = "onboarding.recoveryKey"
        static let copyKey = "onboarding.copyKey"
        static let saveKey = "onboarding.saveKey"
        static let keyStored = "onboarding.keyStored"
        static let keyContinue = "onboarding.keyContinue"
        static let serverName = "onboarding.serverName"
        static let nameDone = "onboarding.nameDone"
        static let serverAddress = "onboarding.serverAddress"
        static let signInSubmit = "onboarding.signInSubmit"
        static let forgot = "onboarding.forgot"
        static let recoveryInput = "onboarding.recoveryInput"
        static let newPassword = "onboarding.newPassword"
        static let recover = "onboarding.recover"
    }

    enum Unlock {
        static let screen = "unlock.screen"
        static let account = "unlock.account"
        static let password = "unlock.password"
        static let submit = "unlock.submit"
        static let error = "unlock.error"
        static let forgot = "unlock.forgot"
    }

    enum Shell {
        static let chatsTab = "shell.tab.chats"
        static let channelsTab = "shell.tab.channels"
        static let servers = "shell.servers"
        static let settingsTab = "shell.tab.settings"
        static let newGroup = "shell.newGroup"
        static let title = "shell.title"
    }

    enum Servers {
        static let list = "servers.list"
        static let join = "servers.join"
        static func row(_ id: String) -> String { "servers.row.\(id)" }
    }

    enum ChatList {
        static let list = "chatList.list"
        static let search = "chatList.search"
        static let empty = "chatList.empty"
        static let filter = "chatList.filter"
        static let hiddenToggle = "chatList.hiddenToggle"
        static func row(_ key: String) -> String { "chatList.row.\(key)" }
        static func messageHit(_ id: String) -> String { "chatList.hit.\(id)" }
    }

    enum Channels {
        static func row(_ id: String) -> String { "channels.row.\(id)" }
        static func heading(_ name: String) -> String { "channels.heading.\(name)" }
        static func add(_ name: String) -> String { "channels.add.\(name)" }
        static func occupant(_ deviceId: String) -> String { "channels.occupant.\(deviceId)" }
        static func member(_ userId: String) -> String { "channels.member.\(userId)" }
        /// A row of the member list beside the chat, apart from the details' rows.
        static func listedMember(_ userId: String) -> String { "channels.memberList.\(userId)" }
        static let memberList = "channels.memberList"
        static let memberListToggle = "channels.memberList.toggle"
        static let jumpToPresent = "channels.jumpToPresent"
        static let inPlaceEditor = "channels.inPlace"
        static let inPlaceInput = "channels.inPlace.input"
        static let inPlaceSave = "channels.inPlace.save"
        static let inPlaceCancel = "channels.inPlace.cancel"
        static let newChannel = "channels.new"
        static let list = "channels.list"
        static let listSearch = "channels.list.search"
        static let empty = "channels.empty"
        static let joining = "channels.joining"
        static let welcome = "channels.welcome"
        static let welcomeEdit = "channels.welcome.edit"
        static let typing = "channels.typing"
        static let search = "channels.search"
        static let details = "channels.details"
        static let editor = "channels.editor"
        static let editorType = "channels.editor.type"
        static let editorName = "channels.editor.name"
        static let editorFinalName = "channels.editor.finalName"
        static let editorTopic = "channels.editor.topic"
        static let editorHeading = "channels.editor.heading"
        static let editorSlowMode = "channels.editor.slowMode"
        static let editorSlowModeTime = "channels.editor.slowModeTime"
        static let editorSave = "channels.editor.save"
        static let editorBitrate = "channels.editor.bitrate"
        static let editorUserLimit = "channels.editor.userLimit"
        static let editorScreenLimit = "channels.editor.screenLimit"
        static let editorSounds = "channels.editor.sounds"
        static let edit = "channels.edit"
        static let delete = "channels.delete"
        static let manage = "channels.manage"
    }

    enum Chat {
        static let screen = "chat.screen"
        static let list = "chat.list"
        static let title = "chat.title"
        static let status = "chat.status"
        static let banner = "chat.keyBanner"
        static let bannerVerify = "chat.keyBanner.verify"
        static let readBy = "chat.readBy"
        static func blockedMessage(_ id: String) -> String { "chat.blocked.\(id)" }
        static let toBottom = "chat.toBottom"
        static let call = "chat.call"
        static let videoCall = "chat.videoCall"
        static let joinCall = "chat.joinCall"
        static let callBanner = "chat.callBanner"
        static let toMention = "chat.toMention"
        static let unreadLine = "chat.unreadLine"
        static func location(_ messageId: String) -> String { "chat.location.\(messageId)" }
        static let empty = "chat.empty"
        static let reply = "chat.reply"
        static let emoteCard = "chat.emoteCard"
        static let menu = "chat.menu"
        static let search = "chat.search"
        static let pins = "chat.pins"
        static let pinsScreen = "chat.pinsScreen"
        static let photoViewer = "chat.photoViewer"
        static let photoViewerTitle = "chat.photoViewer.title"
        static let forwarded = "chat.forwarded"
        static let selectionBar = "chat.selectionBar"
        static let selectionCount = "chat.selectionCount"
        static func selectToggle(_ id: String) -> String { "chat.select.\(id)" }
        static func voice(_ id: String) -> String { "chat.voice.\(id)" }
        static func round(_ id: String) -> String { "chat.round.\(id)" }
        static func linkPreview(_ id: String) -> String { "chat.linkPreview.\(id)" }
        static func quickReaction(_ emoji: String) -> String { "chat.quickReaction.\(emoji)" }
        static func result(_ id: String) -> String { "chat.result.\(id)" }
        static func message(_ id: String) -> String { "chat.message.\(id)" }
        static func text(_ id: String) -> String { "chat.text.\(id)" }
        static func meta(_ id: String) -> String { "chat.meta.\(id)" }
        static func reaction(_ key: String) -> String { "chat.reaction.\(key)" }
        static let reactionsMenu = "chat.reactionsMenu"
        static let retryLoad = "chat.retryLoad"
        static func reactionInMenu(_ key: String) -> String { "chat.reactionsMenu.\(key)" }
        static func attachment(_ name: String) -> String { "chat.attachment.\(name)" }
    }

    enum Composer {
        static let input = "composer.input"
        static let send = "composer.send"
        static let slowWait = "composer.slowWait"
        static let attach = "composer.attach"
        static let emoji = "composer.emoji"
        static let context = "composer.context"
        static let cancelContext = "composer.cancelContext"
        static let picker = "composer.picker"
        static let disabled = "composer.disabled"
        static let linkPreview = "composer.linkPreview"
        static let removeLinkPreview = "composer.removeLinkPreview"
        static let microphone = "composer.microphone"
        static let roundPreview = "composer.roundPreview"
        static let recording = "composer.recording"
        static func pickerEmote(_ name: String) -> String { "composer.picker.\(name)" }
        static func suggestion(_ label: String) -> String { "composer.suggestion.\(label)" }
        static func file(_ name: String) -> String { "composer.file.\(name)" }
    }

    /// The attach menu, laid out as Telegram's.
    enum Attach {
        static let sheet = "attach.sheet"
        static let albums = "attach.albums"
        static let manage = "attach.manage"
        static let caption = "attach.caption"
        static let send = "attach.send"
        static let photos = "attach.photos"
        static let files = "attach.files"
        static let paste = "attach.paste"
        static let sendLocation = "attach.sendLocation"
        static let camera = "attach.camera"
        static func tab(_ name: String) -> String { "attach.tab.\(name)" }
        static func tile(_ index: Int) -> String { "attach.tile.\(index)" }
        static func taken(_ index: Int) -> String { "attach.taken.\(index)" }
    }

    enum Forward {
        static let sheet = "forward.sheet"
        static func row(_ title: String) -> String { "forward.row.\(title)" }
    }

    /// The share extension's sheet.
    enum Share {
        static let sheet = "share.sheet"
        static func row(_ title: String) -> String { "share.row.\(title)" }
        static let comment = "share.comment"
        static let send = "share.send"
        static let sending = "share.sending"
        static let notice = "share.notice"
        static let servers = "share.servers"
        static func server(_ name: String) -> String { "share.server.\(name)" }
    }

    enum Details {
        static let screen = "details.screen"
        static let header = "details.header"
        static let trust = "details.trust"
        static let notifications = "details.notifications"
        static let mentionsOnly = "details.mentionsOnly"
        static let block = "details.block"
        static let report = "details.report"
        static let history = "details.history"
        static let disappearing = "details.disappearing"
        static let edit = "details.edit"
        static let addMembers = "details.addMembers"
        static let leave = "details.leave"
        static let bio = "details.bio"
        static let username = "details.username"
        static let description = "details.description"
        static func member(_ id: String) -> String { "details.member.\(id)" }
        /// A button in the row under the name: `call`, `video`, `join`, `mute`, `search` or `pins`.
        static func action(_ name: String) -> String { "details.action.\(name)" }
        /// The row for one kind of thing in the chat: `photo`, `file`, `groups` and so on.
        static func shared(_ kind: String) -> String { "details.shared.\(kind)" }
    }

    /// A chat's photos, files, links and so on, and the groups in common.
    enum Shared {
        static let screen = "shared.screen"
        /// An attachment, by its name, or a message's links, by the message's ID.
        static func item(_ id: String) -> String { "shared.item.\(id)" }
        static func group(_ key: String) -> String { "shared.group.\(key)" }
    }

    enum Verify {
        static let screen = "verify.screen"
        static let emoji = "verify.emoji"
        static let match = "verify.match"
        static let mismatch = "verify.mismatch"
        static let remove = "verify.remove"
    }

    enum Groups {
        static let name = "groups.name"
        static let description = "groups.description"
        static let search = "groups.search"
        static let create = "groups.create"
        static let add = "groups.add"
        static let save = "groups.save"
        static func person(_ username: String) -> String { "groups.person.\(username)" }
    }

    enum Invites {
        static let screen = "invites.screen"
        static let create = "invites.create"
        static let link = "invites.link"
        static func row(_ code: String) -> String { "invites.row.\(code)" }
    }

    enum Toast {
        static let item = "toast"
    }

    enum Voice {
        static let stage = "voice.stage"
        static let connecting = "voice.connecting"
        static let encrypted = "voice.encrypted"
        static let minimize = "voice.minimize"
        static func person(_ deviceId: String) -> String { "voice.person.\(deviceId)" }
        static func screen(_ id: String) -> String { "voice.screen.\(id)" }
        static func fullScreen(_ id: String) -> String { "voice.fullScreen.\(id)" }
        static func streamSound(_ id: String) -> String { "voice.streamSound.\(id)" }
        static let mute = "voice.mute"
        static let deafen = "voice.deafen"
        static let camera = "voice.camera"
        static let shareScreen = "voice.shareScreen"
        static let flip = "voice.flip"
        static let chat = "voice.chat"
        static let leave = "voice.leave"
        static let bar = "voice.bar"
        static let barMute = "voice.bar.mute"
        static let barLeave = "voice.bar.leave"
        static let memberSheet = "voice.member"
        static let volume = "voice.member.volume"
        static let streamVolume = "voice.member.streamVolume"
        static let muteForMe = "voice.member.muteForMe"
        static let muteForEveryone = "voice.member.muteForEveryone"
        static let disconnect = "voice.member.disconnect"
        static let viewer = "voice.viewer"
        static let closeViewer = "voice.viewer.close"
        static let stats = "voice.stats"
        static let statsSheet = "voice.stats.sheet"
        static let statsHeadline = "voice.stats.headline"
        static func ringing(_ userId: String) -> String { "voice.ringing.\(userId)" }
        static let ringAgain = "voice.ringAgain"
        static let soundboardButton = "voice.soundboardButton"
        static let soundboard = "voice.soundboard"
        static func sound(_ name: String) -> String { "voice.sound.\(name)" }
        static let soundRefusal = "voice.sound.refusal"
        static let incoming = "voice.incoming"
        static let answer = "voice.incoming.answer"
        static let answerWithVideo = "voice.incoming.answerWithVideo"
        static let decline = "voice.incoming.decline"
    }

    enum Settings {
        static let soundboard = "settings.soundboard"
        static let soundEmoji = "settings.soundboard.emoji"
        static let soundName = "settings.soundboard.name"
        static let chooseSound = "settings.soundboard.choose"
        static let addSound = "settings.soundboard.add"
        static func sound(_ name: String) -> String { "settings.soundboard.sound.\(name)" }
        static let screen = "settings.screen"
        static let serverPicker = "settings.serverPicker"
        static let appearance = "settings.appearance"
        static let profile = "settings.profile"
        static let privacy = "settings.privacy"
        static let security = "settings.security"
        static let appLock = "settings.appLock"
        static let notifications = "settings.notifications"
        static let voice = "settings.voice"
        static let screenBitrate = "settings.screenBitrate"
        static let notificationsToggle = "settings.notificationsToggle"
        static let notificationSound = "settings.notificationSound"
        static let notificationPreview = "settings.notificationPreview"
        static let server = "settings.server"
        static let signOut = "settings.signOut"
        static let deleteAccount = "settings.deleteAccount"
        static let deleteAccountPassword = "settings.deleteAccountPassword"
        static let deleteAccountButton = "settings.deleteAccountButton"
        static let about = "settings.about"
        static let displayName = "settings.displayName"
        static let bio = "settings.bio"
        static let save = "settings.save"
        static let readReceipts = "settings.readReceipts"
        static let showOnline = "settings.showOnline"
        static let blocked = "settings.blocked"
        static let linkPreviews = "settings.linkPreviews"
        static let removeMetadata = "settings.removeMetadata"
        static let currentPassword = "settings.currentPassword"
        static let newPassword = "settings.newPassword"
        static let confirmPassword = "settings.confirmPassword"
        static let changePassword = "settings.changePassword"
        static let recoveryPassword = "settings.recoveryPassword"
        static let newRecoveryKey = "settings.newRecoveryKey"
        static let recoveryKey = "settings.recoveryKey"
        static let lockToggle = "settings.lockToggle"
        static let serverName = "settings.serverName"
        static let memberInvites = "settings.memberInvites"
        static let openSignUps = "settings.openSignUps"
        static let emotes = "settings.emotes"
        static let emoteLink = "settings.emoteLink"
        static let useEmotes = "settings.useEmotes"
        static let refreshEmotes = "settings.refreshEmotes"
        static let maxUpload = "settings.maxUpload"
        static let retention = "settings.retention"
        static let screenRules = "settings.screenRules"
        static let screenSound = "settings.screenRules.sound"
        static let screenMaxKbps = "settings.screenRules.maxKbps"
        static func device(_ id: String) -> String { "settings.device.\(id)" }
        static func member(_ username: String) -> String { "settings.member.\(username)" }
        static let reports = "settings.reports"
        static func accent(_ id: String) -> String { "settings.accent.\(id)" }
    }
}
