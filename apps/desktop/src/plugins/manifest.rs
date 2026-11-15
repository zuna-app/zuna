//! A plugin's manifest, `plugin.json`: what the app knows of a plugin without running it, and
//! everything it can ever ask the broker for. It has to parse exactly: a field the app doesn't
//! know, a value of the wrong shape or a permission it doesn't have refuses the whole package,
//! as `checkManifest` in packages/plugin-sdk/src/manifest.ts refuses it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::i18n::t;

/// The plugin API's version. An app runs only plugins made for its own.
pub const API: u32 = 1;

/// Everything a plugin can be granted, worst first, as the dialogs list them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "messages.read")]
    MessagesRead,
    #[serde(rename = "messages.send")]
    MessagesSend,
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "files.read")]
    FilesRead,
    #[serde(rename = "messages.intercept")]
    MessagesIntercept,
    #[serde(rename = "activity.intercept")]
    ActivityIntercept,
    #[serde(rename = "messages.decorate")]
    MessagesDecorate,
    #[serde(rename = "notifications")]
    Notifications,
    #[serde(rename = "clipboard.read")]
    ClipboardRead,
    #[serde(rename = "clipboard.write")]
    ClipboardWrite,
    #[serde(rename = "voice.control")]
    VoiceControl,
    #[serde(rename = "voice.read")]
    VoiceRead,
    #[serde(rename = "users.read")]
    UsersRead,
    #[serde(rename = "conversations.read")]
    ConversationsRead,
    #[serde(rename = "servers.read")]
    ServersRead,
}

impl Permission {
    pub const ALL: [Permission; 15] = [
        Permission::MessagesRead,
        Permission::MessagesSend,
        Permission::Network,
        Permission::FilesRead,
        Permission::MessagesIntercept,
        Permission::ActivityIntercept,
        Permission::MessagesDecorate,
        Permission::Notifications,
        Permission::ClipboardRead,
        Permission::ClipboardWrite,
        Permission::VoiceControl,
        Permission::VoiceRead,
        Permission::UsersRead,
        Permission::ConversationsRead,
        Permission::ServersRead,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Permission::MessagesRead => "messages.read",
            Permission::MessagesSend => "messages.send",
            Permission::Network => "network",
            Permission::FilesRead => "files.read",
            Permission::MessagesIntercept => "messages.intercept",
            Permission::ActivityIntercept => "activity.intercept",
            Permission::MessagesDecorate => "messages.decorate",
            Permission::Notifications => "notifications",
            Permission::ClipboardRead => "clipboard.read",
            Permission::ClipboardWrite => "clipboard.write",
            Permission::VoiceControl => "voice.control",
            Permission::VoiceRead => "voice.read",
            Permission::UsersRead => "users.read",
            Permission::ConversationsRead => "conversations.read",
            Permission::ServersRead => "servers.read",
        }
    }

    pub fn parse(name: &str) -> Option<Permission> {
        Permission::ALL.into_iter().find(|permission| permission.name() == name)
    }

    /// What the person is told it allows, in the same words everywhere.
    pub fn told(self) -> &'static str {
        match self {
            Permission::MessagesRead => t("plugins.permissions.messagesRead"),
            Permission::MessagesSend => t("plugins.permissions.messagesSend"),
            Permission::Network => t("plugins.permissions.network"),
            Permission::FilesRead => t("plugins.permissions.filesRead"),
            Permission::MessagesIntercept => t("plugins.permissions.messagesIntercept"),
            Permission::ActivityIntercept => t("plugins.permissions.activityIntercept"),
            Permission::MessagesDecorate => t("plugins.permissions.messagesDecorate"),
            Permission::Notifications => t("plugins.permissions.notifications"),
            Permission::ClipboardRead => t("plugins.permissions.clipboardRead"),
            Permission::ClipboardWrite => t("plugins.permissions.clipboardWrite"),
            Permission::VoiceControl => t("plugins.permissions.voiceControl"),
            Permission::VoiceRead => t("plugins.permissions.voiceRead"),
            Permission::UsersRead => t("plugins.permissions.usersRead"),
            Permission::ConversationsRead => t("plugins.permissions.conversationsRead"),
            Permission::ServersRead => t("plugins.permissions.serversRead"),
        }
    }

    /// Whether it's written in bold, as the plan's table has it.
    pub fn strong(self) -> bool {
        matches!(self, Permission::MessagesRead | Permission::MessagesSend | Permission::Network)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A setting the app draws itself, in the plugin's own section of Settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum SettingSpec {
    Switch {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<bool>,
    },
    Select {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        choices: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    Text {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    Slider {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
    },
}

impl SettingSpec {
    pub fn key(&self) -> &str {
        match self {
            SettingSpec::Switch { key, .. } | SettingSpec::Select { key, .. } | SettingSpec::Text { key, .. } | SettingSpec::Slider { key, .. } => key,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            SettingSpec::Switch { label, .. } | SettingSpec::Select { label, .. } | SettingSpec::Text { label, .. } | SettingSpec::Slider { label, .. } => label,
        }
    }

    pub fn hint(&self) -> Option<&str> {
        match self {
            SettingSpec::Switch { hint, .. } | SettingSpec::Select { hint, .. } | SettingSpec::Text { hint, .. } | SettingSpec::Slider { hint, .. } => hint.as_deref(),
        }
    }

    /// Its value before the person sets it.
    pub fn default_value(&self) -> serde_json::Value {
        match self {
            SettingSpec::Switch { default, .. } => serde_json::json!(default.unwrap_or(false)),
            SettingSpec::Select { default, choices, .. } => serde_json::json!(default.clone().or_else(|| choices.first().cloned()).unwrap_or_default()),
            SettingSpec::Text { default, .. } => serde_json::json!(default.clone().unwrap_or_default()),
            SettingSpec::Slider { default, .. } => serde_json::json!(default.unwrap_or(0.5)),
        }
    }

    /// Whether a value is one this setting can hold.
    pub fn takes(&self, value: &serde_json::Value) -> bool {
        match self {
            SettingSpec::Switch { .. } => value.is_boolean(),
            SettingSpec::Select { choices, .. } => value.as_str().is_some_and(|value| choices.iter().any(|choice| choice == value)),
            SettingSpec::Text { .. } => value.as_str().is_some_and(|value| value.chars().count() <= 500),
            SettingSpec::Slider { .. } => value.as_f64().is_some_and(|value| (0.0..=1.0).contains(&value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandSpec {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeSpec {
    pub id: String,
    pub name: String,
    pub colors: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contributes {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<SettingSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CommandSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub themes: Vec<ThemeSpec>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub manifest: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Author,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    pub api: u32,
    #[serde(default)]
    pub min_build: u32,
    pub permissions: Vec<Permission>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
}

/// The tokens a theme may set, as `Theme` names them (theme.rs) in the SDK's camelCase.
pub const THEME_TOKENS: [&str; 27] = [
    "bg0", "bg1", "bg2", "bg3", "bg4", "bg5", "bgChat", "line", "lineStrong", "hover", "hoverStrong", "text1", "text2", "text3", "accent", "accentHover", "onAccent", "accentSoft", "accentText", "bubbleOwn",
    "bubbleOwnText", "bubbleOther", "bubbleMeta", "link", "green", "red", "amber",
];

fn id_ok(id: &str) -> bool {
    (3..=40).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn key_ok(key: &str) -> bool {
    let mut bytes = key.bytes();
    key.len() <= 40 && bytes.next().is_some_and(|first| first.is_ascii_alphabetic()) && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// MAJOR.MINOR.PATCH, each without leading zeros.
pub fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let number = |part: &str| -> Option<u32> {
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|byte| byte.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        part.parse().ok()
    };
    Some((number(parts[0])?, number(parts[1])?, number(parts[2])?))
}

/// A host's name, as `network` names them: no scheme, port, path or address.
pub fn host_ok(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'))
        && labels.last().is_some_and(|tld| tld.len() >= 2 && tld.bytes().all(|byte| byte.is_ascii_lowercase()))
}

fn asset_ok(path: &str) -> bool {
    super::package::bad_path(path).is_none() && path.starts_with("assets/")
}

fn color_ok(color: &str) -> bool {
    let digits = color.strip_prefix('#').unwrap_or("");
    (digits.len() == 6 || digits.len() == 8) && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl Manifest {
    /// Parses and checks a manifest, saying what's wrong with the first thing that is.
    pub fn parse(bytes: &[u8]) -> Result<Manifest, String> {
        let manifest: Manifest = serde_json::from_slice(bytes).map_err(|error| tr!("plugins.manifest.invalid", error = error))?;
        manifest.check()?;
        Ok(manifest)
    }

    fn check(&self) -> Result<(), String> {
        let fail = |problem: &str| Err(problem.to_string());
        if self.manifest != 1 {
            return fail(t("plugins.manifest.unknownFormat"));
        }
        if !id_ok(&self.id) {
            return fail(t("plugins.manifest.badId"));
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 40 {
            return fail(t("plugins.manifest.badName"));
        }
        if parse_version(&self.version).is_none() {
            return fail(t("plugins.manifest.badVersion"));
        }
        if self.description.chars().count() > 300 {
            return fail(t("plugins.manifest.longDescription"));
        }
        if self.author.name.trim().is_empty() || self.author.name.chars().count() > 60 || self.author.url.as_ref().is_some_and(|url| !url.starts_with("https://")) {
            return fail(t("plugins.manifest.badAuthor"));
        }
        if self.license.trim().is_empty() || self.license.chars().count() > 60 {
            return fail(t("plugins.manifest.noLicense"));
        }
        if self.source.as_ref().is_some_and(|url| !url.starts_with("https://") || url.len() > 300) {
            return fail(t("plugins.manifest.badSource"));
        }
        if self.icon.as_ref().is_some_and(|icon| !asset_ok(icon)) {
            return fail(t("plugins.manifest.badIcon"));
        }
        if self.main.as_ref().is_some_and(|main| main != "main.js") {
            return fail(t("plugins.manifest.badScript"));
        }
        if self.api != API {
            return fail(if self.api > API { t("plugins.manifest.newerApi") } else { t("plugins.manifest.olderApi") });
        }
        let mut seen = std::collections::HashSet::new();
        if !self.permissions.iter().all(|permission| seen.insert(*permission)) {
            return fail(t("plugins.manifest.permissionTwice"));
        }
        if self.has(Permission::MessagesDecorate) && !self.has(Permission::MessagesRead) {
            return fail(t("plugins.manifest.decorateWithoutRead"));
        }
        if !self.permissions.is_empty() && self.main.is_none() {
            return fail(t("plugins.manifest.permissionsWithoutScript"));
        }
        if self.hosts.len() > 20 || !self.hosts.iter().all(|host| host_ok(host)) {
            return fail(t("plugins.manifest.badHosts"));
        }
        if self.has(Permission::Network) != !self.hosts.is_empty() {
            return fail(t("plugins.manifest.hostsWithoutNetwork"));
        }
        let contributes = &self.contributes;
        if contributes.settings.len() > 40 || contributes.commands.len() > 40 || contributes.themes.len() > 10 {
            return fail(t("plugins.manifest.tooMuch"));
        }
        let mut keys = std::collections::HashSet::new();
        for setting in &contributes.settings {
            if !key_ok(setting.key()) || !keys.insert(setting.key().to_string()) {
                return fail(t("plugins.manifest.badSettingKey"));
            }
            if setting.label().trim().is_empty() || setting.label().chars().count() > 80 || setting.hint().is_some_and(|hint| hint.chars().count() > 200) {
                return fail(t("plugins.manifest.badSettingLabel"));
            }
            match setting {
                SettingSpec::Select { choices, default, .. } => {
                    if choices.is_empty() || choices.len() > 50 || choices.iter().any(|choice| choice.chars().count() > 80) || default.as_ref().is_some_and(|default| !choices.contains(default)) {
                        return fail(t("plugins.manifest.badChoices"));
                    }
                }
                SettingSpec::Text { default, placeholder, .. } => {
                    if default.as_ref().is_some_and(|text| text.chars().count() > 500) || placeholder.as_ref().is_some_and(|text| text.chars().count() > 120) {
                        return fail(t("plugins.manifest.longText"));
                    }
                }
                SettingSpec::Slider { default, .. } => {
                    if default.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
                        return fail(t("plugins.manifest.badSlider"));
                    }
                }
                SettingSpec::Switch { .. } => {}
            }
        }
        if !contributes.commands.is_empty() && self.main.is_none() {
            return fail(t("plugins.manifest.commandsWithoutScript"));
        }
        for command in &contributes.commands {
            let keys_ok = command.keys.as_ref().is_none_or(|keys| (1..=40).contains(&keys.len()) && keys.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            let slash_ok = command.slash.as_ref().is_none_or(|slash| (1..=32).contains(&slash.len()) && slash.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            if !key_ok(&command.id) || command.title.trim().is_empty() || command.title.chars().count() > 80 || !keys_ok || !slash_ok {
                return fail(t("plugins.manifest.badCommand"));
            }
        }
        for theme in &contributes.themes {
            if !key_ok(&theme.id) || theme.name.trim().is_empty() || theme.name.chars().count() > 40 {
                return fail(t("plugins.manifest.themeWithoutName"));
            }
            if !theme.colors.iter().all(|(token, color)| THEME_TOKENS.contains(&token.as_str()) && color_ok(color)) {
                return fail(t("plugins.manifest.badThemeColor"));
            }
        }
        Ok(())
    }

    pub fn has(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    /// Whether it runs a script, rather than only giving themes.
    pub fn scripted(&self) -> bool {
        self.main.is_some()
    }

    /// Its permissions, worst first.
    pub fn sorted_permissions(&self) -> Vec<Permission> {
        let mut permissions = self.permissions.clone();
        permissions.sort();
        permissions
    }

    /// Whether it can read what's private and reach the internet, the pair the dialogs name above the rest.
    pub fn can_leak(&self) -> bool {
        (self.has(Permission::MessagesRead) || self.has(Permission::FilesRead)) && self.has(Permission::Network)
    }

    /// What it asks for in the dialogs' words, worst first: the dangerous pair, then each permission.
    pub fn told(&self) -> Vec<(String, bool)> {
        let mut lines = Vec::new();
        if self.can_leak() {
            lines.push((tr!("plugins.canSendTo", hosts = self.hosts.join(", ")), true));
        }
        for permission in self.sorted_permissions() {
            let line = if permission == Permission::Network { tr!("plugins.connectsTo", hosts = self.hosts.join(", ")) } else { permission.told().to_string() };
            lines.push((line, permission.strong()));
        }
        lines
    }

    /// What a newer version asks for that this one doesn't: permissions and hosts.
    pub fn more_than(&self, older: &Manifest) -> (Vec<Permission>, Vec<String>) {
        let permissions = self.sorted_permissions().into_iter().filter(|permission| !older.has(*permission)).collect();
        let hosts = self.hosts.iter().filter(|host| !older.hosts.contains(host)).cloned().collect();
        (permissions, hosts)
    }
}
