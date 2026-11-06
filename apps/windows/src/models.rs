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
    pub max_sound_kbps: u32,
    pub default_height: u32,
    pub default_fps: u32,
    pub default_kbps: u32,
}

impl Default for ScreenRules {
    fn default() -> Self {
        ScreenRules { who: "everyone".into(), sound: true, admins_exempt: false, max_per_channel: 0, max_per_server: 0, max_height: 0, max_fps: 0, max_kbps: 0, max_sound_kbps: 0, default_height: 0, default_fps: 60, default_kbps: 20_000 }
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
    pub trust: String,
    pub is_self: bool,
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
    pub upload_progress: Option<f64>,
    pub time_differs: Option<bool>,
    pub expires_at: Option<f64>,
}

impl MessageView {
    pub fn seq_or(&self, fallback: f64) -> f64 {
        self.seq.unwrap_or(fallback)
    }
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

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq)]
#[serde(default)]
pub struct EmoteSet {
    pub set_id: String,
    pub set_name: String,
    pub emotes: Vec<Emote>,
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
    pub send_read_receipts: bool,
}

impl Preferences {
    pub fn blocked(&self) -> &[String] {
        self.blocked.as_deref().unwrap_or(&[])
    }
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
pub fn from_value<T: for<'de> Deserialize<'de> + Default>(value: Value) -> T {
    serde_json::from_value(value).unwrap_or_else(|error| {
        log::warn!("a value from the core didn't fit: {error}");
        T::default()
    })
}
