//! A plugin's manifest, `plugin.json`: what the app knows of a plugin without running it, and
//! everything it can ever ask the broker for. It has to parse exactly: a field the app doesn't
//! know, a value of the wrong shape or a permission it doesn't have refuses the whole package,
//! as `checkManifest` in packages/plugin-sdk/src/manifest.ts refuses it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
            Permission::MessagesRead => "Reads your messages",
            Permission::MessagesSend => "Writes and deletes messages as you",
            Permission::Network => "Contacts the internet",
            Permission::FilesRead => "Reads files and photos sent to you",
            Permission::MessagesIntercept => "Changes what you send before it's encrypted",
            Permission::ActivityIntercept => "Changes what others see of your activity",
            Permission::MessagesDecorate => "Changes how messages are shown to you",
            Permission::Notifications => "Shows and hides notifications",
            Permission::ClipboardRead => "Reads your clipboard",
            Permission::ClipboardWrite => "Writes to your clipboard",
            Permission::VoiceControl => "Joins, leaves and mutes voice for you",
            Permission::VoiceRead => "Sees who's in voice",
            Permission::UsersRead => "Sees the people on your servers",
            Permission::ConversationsRead => "Sees your chats and who's in them",
            Permission::ServersRead => "Sees which servers you're on",
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
        let manifest: Manifest = serde_json::from_slice(bytes).map_err(|error| format!("Its plugin.json is invalid: {error}"))?;
        manifest.check()?;
        Ok(manifest)
    }

    fn check(&self) -> Result<(), String> {
        let fail = |problem: &str| Err(problem.to_string());
        if self.manifest != 1 {
            return fail("This version of Zuna can't read its manifest.");
        }
        if !id_ok(&self.id) {
            return fail("Its id must be 3 to 40 lowercase letters, digits or hyphens.");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 40 {
            return fail("Its name must be 1 to 40 characters.");
        }
        if parse_version(&self.version).is_none() {
            return fail("Its version must be in MAJOR.MINOR.PATCH form.");
        }
        if self.description.chars().count() > 300 {
            return fail("Its description is longer than 300 characters.");
        }
        if self.author.name.trim().is_empty() || self.author.name.chars().count() > 60 || self.author.url.as_ref().is_some_and(|url| !url.starts_with("https://")) {
            return fail("Its author isn't in the right format.");
        }
        if self.license.trim().is_empty() || self.license.chars().count() > 60 {
            return fail("It doesn't name a license.");
        }
        if self.source.as_ref().is_some_and(|url| !url.starts_with("https://") || url.len() > 300) {
            return fail("Its source isn't an https:// address.");
        }
        if self.icon.as_ref().is_some_and(|icon| !asset_ok(icon)) {
            return fail("Its icon must be a file in assets/.");
        }
        if self.main.as_ref().is_some_and(|main| main != "main.js") {
            return fail("Its script must be main.js.");
        }
        if self.api != API {
            return fail(if self.api > API { "It needs a newer version of Zuna. Update the app to use it." } else { "It was made for an older version of Zuna and hasn't been updated." });
        }
        let mut seen = std::collections::HashSet::new();
        if !self.permissions.iter().all(|permission| seen.insert(*permission)) {
            return fail("It lists a permission twice.");
        }
        if self.has(Permission::MessagesDecorate) && !self.has(Permission::MessagesRead) {
            return fail("It asks to change how messages look without permission to read them.");
        }
        if !self.permissions.is_empty() && self.main.is_none() {
            return fail("It asks for permissions but has no script to use them.");
        }
        if self.hosts.len() > 20 || !self.hosts.iter().all(|host| host_ok(host)) {
            return fail("Some of its hosts aren't valid host names.");
        }
        if self.has(Permission::Network) != !self.hosts.is_empty() {
            return fail("It lists hosts without network access, or network access without any hosts.");
        }
        let contributes = &self.contributes;
        if contributes.settings.len() > 40 || contributes.commands.len() > 40 || contributes.themes.len() > 10 {
            return fail("It adds more than a plugin is allowed to.");
        }
        let mut keys = std::collections::HashSet::new();
        for setting in &contributes.settings {
            if !key_ok(setting.key()) || !keys.insert(setting.key().to_string()) {
                return fail("One of its settings has an invalid or repeated key.");
            }
            if setting.label().trim().is_empty() || setting.label().chars().count() > 80 || setting.hint().is_some_and(|hint| hint.chars().count() > 200) {
                return fail("One of its settings has no label, or a label or hint that's too long.");
            }
            match setting {
                SettingSpec::Select { choices, default, .. } => {
                    if choices.is_empty() || choices.len() > 50 || choices.iter().any(|choice| choice.chars().count() > 80) || default.as_ref().is_some_and(|default| !choices.contains(default)) {
                        return fail("One of its choice settings is invalid.");
                    }
                }
                SettingSpec::Text { default, placeholder, .. } => {
                    if default.as_ref().is_some_and(|text| text.chars().count() > 500) || placeholder.as_ref().is_some_and(|text| text.chars().count() > 120) {
                        return fail("One of its text settings is too long.");
                    }
                }
                SettingSpec::Slider { default, .. } => {
                    if default.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
                        return fail("One of its sliders has a default outside 0 to 1.");
                    }
                }
                SettingSpec::Switch { .. } => {}
            }
        }
        if !contributes.commands.is_empty() && self.main.is_none() {
            return fail("It has commands but no script to run them.");
        }
        for command in &contributes.commands {
            let keys_ok = command.keys.as_ref().is_none_or(|keys| (1..=40).contains(&keys.len()) && keys.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            let slash_ok = command.slash.as_ref().is_none_or(|slash| (1..=32).contains(&slash.len()) && slash.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            if !key_ok(&command.id) || command.title.trim().is_empty() || command.title.chars().count() > 80 || !keys_ok || !slash_ok {
                return fail("One of its commands isn't in the right format.");
            }
        }
        for theme in &contributes.themes {
            if !key_ok(&theme.id) || theme.name.trim().is_empty() || theme.name.chars().count() > 40 {
                return fail("One of its themes has no name.");
            }
            if !theme.colors.iter().all(|(token, color)| THEME_TOKENS.contains(&token.as_str()) && color_ok(color)) {
                return fail("One of its themes sets an unknown color or an invalid color value.");
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
            lines.push((format!("Can send your messages to {}", self.hosts.join(", ")), true));
        }
        for permission in self.sorted_permissions() {
            let line = if permission == Permission::Network { format!("Connects to {}. Each can see your IP address and whatever the plugin sends it", self.hosts.join(", ")) } else { permission.told().to_string() };
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
