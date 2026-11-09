//! The core's shapes (packages/core/src/types.ts), as the iOS app mirrors them in
//! Models.swift. Lenient: a field the core adds later doesn't stop anything showing.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub has_icon: bool,
    pub claimed: bool,
    pub registration: String,
    pub max_upload_mb: f64,
    pub allow_member_invites: bool,
    /// Whether everyone may make private bots. The server's admins always may, and only they make listed ones.
    pub allow_member_bots: bool,
    /// How many bots one person may have.
    pub max_bots: f64,
    pub retention_days: f64,
    pub emote_set_id: String,
    pub emote_set_name: String,
    pub user_count: f64,
    pub community_key: Option<String>,
    pub voice: Option<f64>,
    pub calls: Option<f64>,
    /// What its admins say about sharing a screen. Absent for anyone not signed in.
    pub screen_share: Option<ScreenRules>,
}

/// What a server's admins say about sharing a screen. Who may share, with sound, and how
/// many at once hold whatever an app does. The rest is about media the server can't see,
/// so apps keep to it themselves.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct ScreenRules {
    pub who: String,
    pub sound: bool,
    pub admins_exempt: bool,
    pub max_per_channel: u32,
    pub max_per_server: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub max_kbps: u32,
}

impl Default for ScreenRules {
    fn default() -> Self {
        ScreenRules { who: "everyone".into(), sound: true, admins_exempt: false, max_per_channel: 0, max_per_server: 0, max_height: 0, max_fps: 0, max_kbps: 0 }
    }
}

/// A sound on the server's soundboard.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SoundView {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub duration_ms: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct InvitePreview {
    pub url: String,
    pub code: String,
    pub community_key: Option<String>,
    pub pin: Option<String>,
    pub setup: bool,
    pub server: ServerInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AvatarRef {
    pub file_id: String,
    pub key: String,
    pub prefix: String,
    pub chunks: f64,
    pub mime: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub role: String,
    pub display_name: String,
    pub bio: String,
    pub avatar: Option<AvatarRef>,
    pub online: bool,
    pub last_seen_at: Option<f64>,
    pub hides_last_seen: bool,
    pub banned: bool,
    pub deleted: bool,
    pub trust: String,
    pub is_self: bool,
    /// Set for a bot, which shows a badge wherever its name does, and never as online or last seen.
    pub bot: Option<BotInfo>,
    /// A bot's commands, which typing "/" in a chat it's in offers. Nobody else has any.
    pub commands: Vec<BotCommand>,
}

/// A command a bot answers to: what's typed after the "/", and what it's for.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct BotCommand {
    pub command: String,
    pub description: String,
}

/// A button under a bot's message. One with a link opens it, through the same question a link in a
/// message asks. One with data sends that back to the bot when it's pressed.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct MessageButton {
    pub text: String,
    pub url: Option<String>,
    pub data: Option<String>,
}

/// What makes an account a bot's: one a program runs, which reads everything said in the chats it's in.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BotInfo {
    pub owner_id: String,
    /// Everyone on the server sees it. A private one is only there for its owner and for whoever is in a chat with it.
    pub listed: bool,
    /// Who may add it to a group: "owner", "admins" or "anyone".
    pub add: String,
}

/// A bot as its owner manages it, or one of the server's admins a listed one.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BotView {
    /// Its account's ID, from when it's made.
    pub id: String,
    pub username: String,
    pub owner_id: String,
    pub listed: bool,
    pub add: String,
    /// Whether it may send files.
    pub files: bool,
    /// The channels a server admin gave it, which are the only ones it joins.
    pub channels: Vec<String>,
    /// Its program has signed up with its setup link. Until then it has no account.
    pub set_up: bool,
    pub created_at: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Attachment {
    pub file_id: String,
    pub key: String,
    pub prefix: String,
    pub chunks: f64,
    pub name: String,
    pub mime: String,
    pub size: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub thumb: Option<String>,
    pub duration: Option<f64>,
    pub voice: Option<bool>,
    pub waveform: Option<String>,
    pub round: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct EmoteRef {
    pub id: String,
    pub animated: Option<bool>,
    pub zero_width: Option<bool>,
    pub owner: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<PreviewImage>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct PreviewImage {
    pub data: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ForwardInfo {
    pub user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct SharedLocation {
    pub lat: f64,
    pub lon: f64,
    pub accuracy: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ReactionView {
    pub key: String,
    pub emote: Option<EmoteRef>,
    pub user_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SystemEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub actor_id: Option<String>,
    pub target_ids: Option<Vec<String>>,
    pub seconds: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ReplyPreview {
    pub id: String,
    pub sender_id: String,
    pub text: String,
    pub has_attachment: bool,
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub group_id: String,
    pub seq: Option<f64>,
    pub sender_id: String,
    pub created_at: f64,
    pub edited_at: Option<f64>,
    pub deleted_at: Option<f64>,
    pub pinned_at: Option<f64>,
    pub pinned_by: Option<String>,
    pub status: String,
    pub text: String,
    pub emotes: HashMap<String, EmoteRef>,
    pub attachments: Vec<Attachment>,
    pub mentions: Vec<String>,
    pub reply: Option<ReplyPreview>,
    pub reactions: Vec<ReactionView>,
    pub system: Option<SystemEvent>,
    pub preview: Option<LinkPreview>,
    pub forwarded: Option<ForwardInfo>,
    pub location: Option<SharedLocation>,
    /// Rows of buttons under a bot's message. Empty under anyone else's.
    pub buttons: Vec<Vec<MessageButton>>,
    pub upload_progress: Option<f64>,
    pub time_differs: Option<bool>,
    pub expires_at: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupMemberView {
    pub user_id: String,
    pub role: String,
    pub joined_at: f64,
    pub no_keys: Option<bool>,
    pub not_on_roster: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ConversationView {
    pub key: String,
    pub kind: String,
    pub group_id: Option<String>,
    pub peer_id: Option<String>,
    pub title: String,
    pub avatar: Option<AvatarRef>,
    pub description: String,
    pub last_message: Option<MessageView>,
    pub last_activity_at: f64,
    pub unread: f64,
    pub mentioned: bool,
    pub unread_mentions: f64,
    pub pinned: bool,
    pub muted: bool,
    pub muted_until: Option<f64>,
    pub hidden: bool,
    pub marked_unread: bool,
    pub mentions_only: bool,
    pub blocked: bool,
    /// A direct message with a bot.
    pub bot: bool,
    pub members: Vec<GroupMemberView>,
    pub history_visible: bool,
    pub read_by: HashMap<String, f64>,
    pub own_read: f64,
    pub ready: bool,
    pub removed: bool,
    pub disappear_after: f64,
    pub slow_mode: f64,
    pub slow_until: f64,
}

impl ConversationView {
    /// Whether this person is one of the conversation's own admins.
    pub fn is_admin(&self, self_id: &str) -> bool {
        self.members.iter().any(|member| member.user_id == self_id && member.role == "admin")
    }

    /// What it adds to unread counts: its unread messages, or one if only marked, and nothing while muted.
    pub fn counted_unread(&self) -> u32 {
        if self.muted {
            return 0;
        }
        if self.unread > 0.0 { self.unread as u32 } else if self.marked_unread { 1 } else { 0 }
    }

    /// Where its messages live before and after its group exists.
    pub fn list_id(&self) -> String {
        self.group_id.clone().unwrap_or_else(|| format!("pending:{}", self.key))
    }

    /// How far anyone else has read here, for the ticks, or -1 where nobody's reading is known, as in a channel.
    pub fn read_up_to(&self, self_id: &str) -> f64 {
        if self.kind == "channel" {
            return -1.;
        }
        self.read_by.iter().filter(|(id, _)| *id != self_id).map(|(_, seq)| *seq).fold(0., f64::max)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelView {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
    pub name: String,
    pub topic: String,
    pub category: String,
    pub bitrate: f64,
    pub position: f64,
    pub user_limit: f64,
    pub screen_limit: f64,
    pub sounds: bool,
    pub slow_mode: f64,
    pub unreadable: bool,
    pub conversation: Option<ConversationView>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceMember {
    pub channel_id: String,
    pub user_id: String,
    pub device_id: String,
    pub muted: bool,
    pub deafened: bool,
    pub server_muted: bool,
    pub camera: bool,
    pub screen: bool,
    pub since: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CallView {
    pub group_id: String,
    pub started_by: String,
    pub started_at: f64,
    pub ringing: Vec<String>,
    pub declined: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct Emote {
    pub id: String,
    pub name: String,
    pub animated: bool,
    pub zero_width: bool,
    pub width: f64,
    pub height: f64,
    pub owner: String,
}

impl Emote {
    /// What a message or a reaction keeps of an emote it uses (the core's `EmoteRef`).
    pub fn to_ref(&self) -> serde_json::Value {
        serde_json::json!({ "id": self.id, "animated": self.animated, "zeroWidth": self.zero_width, "owner": self.owner })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct EmoteSet {
    pub set_id: String,
    pub set_name: String,
    pub emotes: Vec<Emote>,
}

impl EmoteSet {
    /// The emotes a text uses, by the word that names each, as a message sends them.
    pub fn refs_in(&self, text: &str) -> serde_json::Map<String, serde_json::Value> {
        text.split_whitespace().filter_map(|word| self.emotes.iter().find(|emote| emote.name == word).map(|emote| (word.to_string(), emote.to_ref()))).collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub pinned: Vec<String>,
    pub hidden: Vec<String>,
    pub muted: Vec<String>,
    pub muted_until: Option<HashMap<String, f64>>,
    pub marked_unread: Option<Vec<String>>,
    pub mentions_only: Option<Vec<String>>,
    pub blocked: Option<Vec<String>>,
    pub reported: Option<Vec<String>>,
    pub send_read_receipts: bool,
}

impl Preferences {
    pub fn blocked(&self) -> &[String] {
        self.blocked.as_deref().unwrap_or(&[])
    }

    pub fn reported(&self) -> &[String] {
        self.reported.as_deref().unwrap_or(&[])
    }
}

/// Someone reported to a server's admins, as the admins see it: how often, what for and
/// when last. Never what was said, which the server can't read, nor who reported them.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ReportView {
    pub user_id: String,
    pub count: f64,
    pub reasons: Vec<String>,
    pub last_at: f64,
}

/// Someone banned from a server, as its admins see it: when, and by which admin, whose
/// user ID is empty when the server doesn't know it.
#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BanView {
    pub user_id: String,
    pub banned_at: f64,
    pub banned_by: String,
}

/// What someone can be reported for, in the order offered, with what each is called
/// (`REPORT_REASON_LABELS` in lib/report.ts).
pub const REPORT_REASONS: [(&str, &str); 4] = [("spam", "Spam"), ("harassment", "Harassment"), ("inappropriate", "Inappropriate content"), ("other", "Something else")];

/// What a reason for reporting someone is called.
pub fn report_reason_label(reason: &str) -> &str {
    REPORT_REASONS.iter().find(|(known, _)| *known == reason).map(|(_, label)| *label).unwrap_or(reason)
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub created_at: f64,
    pub last_seen_at: f64,
    pub is_current: bool,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchResult {
    pub message: MessageView,
    pub conversation_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerEntry {
    pub id: String,
    pub url: String,
    pub address: String,
    pub name: String,
    pub has_icon: bool,
    pub username: String,
    pub user_id: String,
    pub role: String,
    pub signed_out: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerSelf {
    pub user_id: String,
    pub username: String,
    pub role: String,
    pub device_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct SafetyEmoji {
    pub emoji: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct SafetyCheck {
    pub emoji: Vec<SafetyEmoji>,
    pub trust: String,
    pub covers: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<MessageView>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Registered {
    pub server_id: String,
    pub recovery_key: String,
}

/// Reads a value from the core, or its default if it doesn't fit.
/// Where a server serves one of its emotes, at twice its size, which is how every place draws them.
pub fn emote_url(server_url: &str, id: &str) -> String {
    format!("{server_url}/api/emotes/{id}/2x.webp")
}

pub fn from_value<T: for<'de> Deserialize<'de> + Default>(value: Value) -> T {
    serde_json::from_value(value).unwrap_or_else(|error| {
        log::warn!("a value from the core didn't fit: {error}");
        T::default()
    })
}
