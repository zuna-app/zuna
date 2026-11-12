//! A server with something of everything on it, as the core would describe it: people and a bot,
//! direct messages, a group and channels, and messages of every kind, for the stand-in to give.

use serde_json::{Value, json};

pub const SERVER: &str = "server-1";
pub const OTHER: &str = "server-2";
pub const ME: &str = "u-alice";
pub const BOB: &str = "u-bob";
pub const CAROL: &str = "u-carol";
pub const BOT: &str = "u-helper";
pub const DM: &str = "g-dm-bob";
pub const GROUP: &str = "g-lab";
pub const BOT_DM: &str = "g-dm-helper";
pub const GENERAL: &str = "c-general";
pub const LOUNGE: &str = "c-lounge";
pub const NOW: f64 = 1_800_000_000_000.0;

/// A picture small enough to be a thumbnail, as a data address.
const THUMB: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// What the stand-in answers with, by server and method, which a test may change before opening the app.
pub struct World {
    pub name: String,
    pub client: serde_json::Map<String, Value>,
    pub server: serde_json::Map<String, Value>,
    pub other: serde_json::Map<String, Value>,
}

fn user(id: &str, username: &str, name: &str, extra: Value) -> Value {
    let mut user = json!({ "id": id, "username": username, "displayName": name, "role": "member", "online": false, "trust": "verified", "lastSeenAt": NOW - 3_600_000.0 });
    merge(&mut user, extra);
    user
}

fn merge(into: &mut Value, extra: Value) {
    if let (Some(into), Value::Object(extra)) = (into.as_object_mut(), extra) {
        into.extend(extra);
    }
}

pub fn message(id: &str, group: &str, seq: f64, sender: &str, text: &str, extra: Value) -> Value {
    let mut message = json!({ "id": id, "groupId": group, "seq": seq, "senderId": sender, "createdAt": NOW - (100.0 - seq) * 60_000.0, "status": "sent", "text": text });
    merge(&mut message, extra);
    message
}

fn conversation(key: &str, kind: &str, group: &str, title: &str, extra: Value) -> Value {
    let mut conversation = json!({ "key": key, "kind": kind, "groupId": group, "title": title, "ready": true, "lastActivityAt": NOW - 60_000.0, "ownRead": 0 });
    merge(&mut conversation, extra);
    conversation
}

/// Every kind of message the chat draws.
pub fn messages(group: &str) -> Vec<Value> {
    let file = |name: &str, mime: &str, extra: Value| {
        let mut attachment = json!({ "fileId": "f".repeat(32), "key": "a2V5", "prefix": "cHJlZml4", "chunks": 1, "name": name, "mime": mime, "size": 123456 });
        merge(&mut attachment, extra);
        attachment
    };
    vec![
        message("m01", group, 1.0, BOB, "Hi! **bold**, _italic_, ~~struck~~, ||hidden||, `code` and https://example.com/page", json!({ "preview": { "url": "https://example.com/page", "title": "A page", "description": "What it says", "siteName": "example.com", "image": { "data": THUMB, "width": 1, "height": 1 } } })),
        message("m02", group, 2.0, ME, "> quoted\n```rust\nfn main() {}\n```\nand @bob too", json!({ "mentions": [BOB], "editedAt": NOW - 30_000.0, "reactions": [{ "key": "👍", "userIds": [BOB, ME] }, { "key": "Kappa", "emote": { "id": "01KAPPA", "animated": false }, "userIds": [BOB] }] })),
        message("m03", group, 3.0, BOB, "Replying", json!({ "reply": { "id": "m02", "senderId": ME, "text": "and @bob too", "hasAttachment": false, "deleted": false } })),
        message("m04", group, 4.0, BOB, "", json!({ "attachments": [file("photo.png", "image/png", json!({ "width": 640, "height": 480, "thumb": THUMB }))] })),
        message("m05", group, 5.0, BOB, "A file", json!({ "attachments": [file("report.pdf", "application/pdf", json!({}))] })),
        message("m06", group, 6.0, ME, "", json!({ "attachments": [file("voice.ogg", "audio/ogg", json!({ "voice": true, "duration": 7.5, "waveform": "AAECAwQFBgcICQ==" }))] })),
        message("m07", group, 7.0, BOB, "", json!({ "attachments": [file("round.mp4", "video/mp4", json!({ "round": true, "duration": 4.0, "width": 240, "height": 240, "thumb": THUMB }))] })),
        message("m08", group, 8.0, BOB, "", json!({ "attachments": [file("clip.mp4", "video/mp4", json!({ "duration": 12.0, "width": 320, "height": 180, "thumb": THUMB })), file("song.mp3", "audio/mpeg", json!({ "duration": 61.0 }))] })),
        message("m09", group, 9.0, BOB, "Forwarded along", json!({ "forwarded": { "userId": CAROL } })),
        message("m10", group, 10.0, BOB, "", json!({ "location": { "lat": 52.23, "lon": 21.01, "accuracy": 15 } })),
        message("m11", group, 11.0, BOB, "", json!({ "system": { "type": "member_added", "actorId": ME, "targetIds": [CAROL] } })),
        message("m12", group, 12.0, BOB, "", json!({ "deletedAt": NOW - 10_000.0 })),
        message("m13", group, 13.0, ME, "Pinned and :Kappa:", json!({ "pinnedAt": NOW - 5_000.0, "pinnedBy": ME, "emotes": { "Kappa": { "id": "01KAPPA" } } })),
        message("m14", group, 14.0, ME, "Still sending", json!({ "seq": null, "status": "sending", "uploadProgress": 0.4 })),
        message("m15", group, 15.0, ME, "Didn't go", json!({ "seq": null, "status": "failed" })),
        message("m16", group, 16.0, BOB, "Gone soon", json!({ "expiresAt": NOW + 3_600_000.0, "timeDiffers": true })),
    ]
}

impl World {
    pub fn new(name: &str) -> World {
        let entry = |id: &str, name: &str, extra: Value| {
            let mut entry = json!({ "id": id, "url": format!("https://{id}.example"), "address": format!("{id}.example"), "name": name, "username": "alice", "userId": ME, "role": "owner" });
            merge(&mut entry, extra);
            entry
        };
        let mut client = serde_json::Map::new();
        client.insert("listServers".into(), json!([entry(SERVER, "Test Server", json!({ "hasIcon": false })), entry(OTHER, "Elsewhere", json!({ "signedOut": "removed", "role": "member" }))]));

        let users = json!([
            user(ME, "alice", "Alice", json!({ "role": "owner", "isSelf": true, "online": true, "bio": "It's me" })),
            user(BOB, "bob", "Bob", json!({ "online": true })),
            user(CAROL, "carol", "Carol", json!({ "trust": "changed", "role": "admin", "hidesLastSeen": true })),
            user(BOT, "helper", "Helper", json!({ "bot": { "ownerId": ME, "listed": true, "add": "anyone" }, "commands": [{ "command": "start", "description": "Begin" }, { "command": "help", "description": "Ask" }] })),
            user("u-gone", "gone", "", json!({ "deleted": true })),
        ]);
        let members = |ids: &[&str]| ids.iter().map(|id| json!({ "userId": id, "role": if *id == ME { "admin" } else { "member" }, "joinedAt": NOW - 86_400_000.0 })).collect::<Vec<_>>();
        let last = |id: &str, group: &str, text: &str| message(id, group, 20.0, BOB, text, json!({}));
        let conversations = json!([
            conversation(&format!("user:{BOB}"), "dm", DM, "Bob", json!({ "peerId": BOB, "unread": 2, "pinned": true, "lastMessage": last("l1", DM, "See you"), "members": members(&[ME, BOB]), "readBy": { BOB: 13 } })),
            conversation(&format!("group:{GROUP}"), "group", GROUP, "The lab", json!({ "muted": true, "unreadMentions": 1, "mentioned": true, "description": "Where we work", "lastMessage": last("l2", GROUP, "Meeting at 5"), "members": members(&[ME, BOB, CAROL]), "historyVisible": true, "disappearAfter": 86400 })),
            conversation(&format!("user:{BOT}"), "dm", BOT_DM, "Helper", json!({ "peerId": BOT, "bot": true, "members": members(&[ME, BOT]) })),
            conversation(&format!("user:{ME}"), "dm", "g-saved", "Saved messages", json!({ "peerId": ME, "members": members(&[ME]) })),
            conversation(&format!("user:{CAROL}"), "dm", "g-dm-carol", "Carol", json!({ "peerId": CAROL, "blocked": true, "markedUnread": true, "members": members(&[ME, CAROL]) })),
        ]);
        let channels = json!([
            { "id": GENERAL, "type": "text", "key": format!("group:{GENERAL}"), "name": "general", "topic": "Anything goes", "category": "Talk", "position": 0,
              "conversation": conversation(&format!("group:{GENERAL}"), "channel", GENERAL, "general", json!({ "unread": 3, "members": members(&[ME, BOB, CAROL]) })) },
            { "id": "c-news", "type": "text", "key": "group:c-news", "name": "news", "category": "Talk", "position": 1, "unreadable": true },
            { "id": LOUNGE, "type": "voice", "key": format!("group:{LOUNGE}"), "name": "Lounge", "category": "Voice", "position": 2, "bitrate": 64, "userLimit": 10, "sounds": true, "watch": true,
              "conversation": conversation(&format!("group:{LOUNGE}"), "channel", LOUNGE, "Lounge", json!({ "members": members(&[ME, BOB]) })) },
        ]);
        let mut server = serde_json::Map::new();
        server.insert("getUsers".into(), users);
        server.insert("getConversations".into(), conversations);
        server.insert("getChannels".into(), channels);
        server.insert("getEmotes".into(), json!({ "setId": "set", "setName": "Our set", "emotes": [{ "id": "01KAPPA", "name": "Kappa", "animated": false, "width": 28, "height": 28 }] }));
        server.insert("getPreferences".into(), json!({ "pinned": [format!("user:{BOB}")], "hidden": [], "muted": [format!("group:{GROUP}")], "sendReadReceipts": true, "blocked": [CAROL] }));
        server.insert("getSelf".into(), json!({ "userId": ME, "username": "alice", "role": "owner", "deviceId": "d-1" }));
        server.insert("getConnectionState".into(), json!("online"));
        server.insert(
            "getInfo".into(),
            json!({ "name": "Test Server", "version": "test", "claimed": true, "registration": "invite", "max_upload_mb": 100, "max_bots": 5, "retention_days": 0, "emote_set_id": "set", "emote_set_name": "Our set", "user_count": 4, "voice": 1, "calls": 1,
                    "screen_share": { "who": "everyone", "sound": true } }),
        );
        server.insert("getVoiceMembers".into(), json!([{ "channelId": LOUNGE, "userId": BOB, "deviceId": "d-bob", "muted": true, "camera": false, "screen": true, "since": NOW - 120_000.0 }]));
        server.insert("getCalls".into(), json!([{ "groupId": DM, "startedBy": BOB, "startedAt": NOW - 30_000.0, "ringing": [ME], "declined": [] }]));
        server.insert("getSounds".into(), json!([{ "id": "s1", "name": "Boom", "emoji": "💥", "durationMs": 1200 }]));
        server.insert("getNewDevices".into(), json!([]));
        server.insert("loadMessages".into(), json!({ "messages": messages(DM), "hasMore": false }));
        server.insert("loadPins".into(), json!([message("m13", DM, 13.0, ME, "Pinned", json!({ "pinnedAt": NOW }))]));
        server.insert("loadMedia".into(), json!({ "messages": [messages(DM)[3].clone(), messages(DM)[4].clone()], "hasMore": false }));
        server.insert("mediaCounts".into(), json!({ "photo": 1, "video": 1, "file": 1, "audio": 1, "link": 1, "voice": 1 }));
        server.insert("getDevices".into(), json!([{ "id": "d-1", "name": "This computer", "createdAt": NOW - 86_400_000.0, "current": true }, { "id": "d-2", "name": "Phone", "createdAt": NOW - 3_600_000.0 }]));
        server.insert("invites".into(), json!([{ "code": "abc", "maxUses": 1, "uses": 0, "createdAt": NOW, "link": "https://server-1.example/invite/abc" }]));
        server.insert("getBots".into(), json!([{ "id": BOT, "username": "helper", "displayName": "Helper", "ownerId": ME, "listed": true, "add": "anyone", "files": true, "setUp": true, "channels": [GENERAL] }]));
        server.insert("getBans".into(), json!([]));
        server.insert("getReports".into(), json!([]));
        server.insert("search".into(), json!([{ "message": messages(DM)[0].clone(), "conversationKey": format!("user:{BOB}") }]));
        server.insert("safetyCheck".into(), json!({ "emoji": [{ "emoji": "🐶", "name": "Dog" }, { "emoji": "🐱", "name": "Cat" }], "number": "12345 67890" }));
        server.insert("previewText".into(), json!("See you"));
        for method in ["markRead", "markChatRead", "setActive", "sendTyping", "nudge", "resume", "suspend", "flushOutbox", "updatePreferences", "mute", "unmute", "setPinned", "toggleReaction"] {
            server.insert(method.into(), Value::Null);
        }
        let mut other = serde_json::Map::new();
        other.insert("getSelf".into(), json!({ "userId": ME, "username": "alice", "role": "member" }));
        other.insert("getConnectionState".into(), json!("signed_out"));
        World { name: name.to_string(), client, server, other }
    }

    pub fn fixtures(&self) -> Value {
        json!({ "": self.client, SERVER: self.server, OTHER: self.other })
    }
}
