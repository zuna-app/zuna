//! Interface text in the person's language (docs/TRANSLATING.md), as packages/i18n has it for the
//! core and the web app, held to the same vectors. Code names each text by its key in
//! packages/i18n/locales/en.json: `t("settings.privacy.readReceipts")` for text as it is, and
//! `tr!("chat.typing.one", name = who)` for text with something filled in, or a count's, whose form
//! `count` picks. Every catalog is built into the app (build.rs), English always, and another
//! language's words are read the first time it's chosen.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::{LazyLock, Mutex, RwLock};

include!(concat!(env!("OUT_DIR"), "/locales.rs"));

/// CLDR's plural categories, in the order a catalog's rules are tried.
const CATEGORIES: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

/// One relation of a plural rule: `i % 10 = 2..4`, for whole numbers.
struct Relation {
    /// n or i, which are the number. The other operands are 0 for a whole number.
    whole: bool,
    modulo: Option<u64>,
    equal: bool,
    ranges: Vec<(u64, u64)>,
}

/// Relations joined by `and`, joined by `or`.
type Rule = Vec<Vec<Relation>>;

enum Entry {
    Text(&'static str),
    /// Each category's form, and the `other` one.
    Plural(Vec<(&'static str, &'static str)>, &'static str),
}

pub struct Catalog {
    pub tag: &'static str,
    /// The language's own name for itself.
    pub name: String,
    rules: Vec<(&'static str, Rule)>,
    entries: HashMap<String, Entry>,
    /// The catalog's file, for the core.
    pub json: &'static str,
}

/// A CLDR plural rule for whole numbers, or why it can't be read.
fn compile_rule(source: &str) -> Result<Rule, String> {
    let text = source.split('@').next().unwrap_or("").trim();
    if text.is_empty() {
        return Err("A plural rule is empty.".into());
    }
    let bad = || format!("A plural rule can't be read: {source}");
    let split = |text: &str, word: &str| -> Vec<String> { text.split_whitespace().collect::<Vec<_>>().join(" ").split(&format!(" {word} ")).map(str::to_string).collect() };
    split(text, "or")
        .iter()
        .map(|part| {
            split(part, "and")
                .iter()
                .map(|relation| {
                    let relation = relation.replace(' ', "");
                    let (left, right, equal) = match relation.split_once("!=") {
                        Some((left, right)) => (left.to_string(), right.to_string(), false),
                        None => {
                            let (left, right) = relation.split_once('=').ok_or_else(bad)?;
                            (left.to_string(), right.to_string(), true)
                        }
                    };
                    let (operand, modulo) = match left.split_once('%') {
                        Some((operand, modulo)) => (operand.to_string(), Some(modulo.parse::<u64>().map_err(|_| bad())?)),
                        None => (left, None),
                    };
                    if modulo == Some(0) || !matches!(operand.as_str(), "n" | "i" | "v" | "w" | "f" | "t" | "c" | "e") || right.is_empty() {
                        return Err(bad());
                    }
                    let ranges = right
                        .split(',')
                        .map(|item| {
                            let bounds: Vec<&str> = item.split("..").collect();
                            if bounds.len() > 2 || bounds.iter().any(|bound| bound.is_empty() || !bound.bytes().all(|byte| byte.is_ascii_digit())) {
                                return Err(bad());
                            }
                            let low = bounds[0].parse::<u64>().map_err(|_| bad())?;
                            let high = bounds[bounds.len() - 1].parse::<u64>().map_err(|_| bad())?;
                            Ok((low, high))
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    Ok(Relation { whole: operand == "n" || operand == "i", modulo, equal, ranges })
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .collect()
}

fn holds(rule: &Rule, count: u64) -> bool {
    rule.iter().any(|ands| {
        ands.iter().all(|relation| {
            let value = if relation.whole { relation.modulo.map_or(count, |modulo| count % modulo) } else { 0 };
            let within = relation.ranges.iter().any(|&(low, high)| value >= low && value <= high);
            within == relation.equal
        })
    })
}

impl Catalog {
    /// A catalog from its file, checked as packages/i18n checks it.
    pub fn parse(tag: &'static str, json: &'static str) -> Result<Catalog, String> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|error| format!("{tag}: {error}"))?;
        let record = value.as_object().ok_or_else(|| format!("{tag}: a catalog is a JSON object."))?;
        let name = record.get("$language").and_then(|name| name.as_str()).map(str::trim).filter(|name| !name.is_empty()).ok_or_else(|| format!("{tag}: $language is the language's own name."))?;
        let mut rules = Vec::new();
        if let Some(plural) = record.get("$plural") {
            let plural = plural.as_object().ok_or_else(|| format!("{tag}: $plural is an object of rules."))?;
            for category in CATEGORIES {
                if let Some(source) = plural.get(category) {
                    let source = source.as_str().ok_or_else(|| format!("{tag}: the rule for {category} is text."))?;
                    rules.push((category, compile_rule(source)?));
                }
            }
            if let Some(odd) = plural.keys().find(|key| !CATEGORIES[..5].contains(&key.as_str())) {
                return Err(format!("{tag}: \"{odd}\" isn't a plural category with a rule."));
            }
        }
        let leak = |text: &str| -> &'static str { Box::leak(text.to_string().into_boxed_str()) };
        let mut entries = HashMap::new();
        for (key, value) in record {
            if key.starts_with('$') {
                if key != "$language" && key != "$plural" {
                    return Err(format!("{tag}: \"{key}\" isn't something a catalog says."));
                }
                continue;
            }
            match value {
                serde_json::Value::Null => {}
                serde_json::Value::String(text) if text.is_empty() => {}
                serde_json::Value::String(text) => {
                    entries.insert(key.clone(), Entry::Text(leak(text)));
                }
                serde_json::Value::Object(forms) => {
                    let mut kept = Vec::new();
                    let mut other = None;
                    for (category, form) in forms {
                        let category = CATEGORIES.iter().find(|known| **known == category).ok_or_else(|| format!("{tag}: \"{key}\" has a form for \"{category}\", which isn't a plural category."))?;
                        match form {
                            serde_json::Value::Null => {}
                            serde_json::Value::String(text) if text.is_empty() => {}
                            serde_json::Value::String(text) if *category == "other" => other = Some(leak(text)),
                            serde_json::Value::String(text) => kept.push((*category, leak(text))),
                            _ => return Err(format!("{tag}: \"{key}\"'s \"{category}\" form is text.")),
                        }
                    }
                    if let Some(other) = other {
                        entries.insert(key.clone(), Entry::Plural(kept, other));
                    }
                }
                _ => return Err(format!("{tag}: \"{key}\" is text, null or plural forms.")),
            }
        }
        Ok(Catalog { tag, name: name.to_string(), rules, entries, json })
    }

    /// Which form a count takes.
    fn category(&self, count: i64) -> &'static str {
        let whole = count.unsigned_abs();
        self.rules.iter().find(|(_, rule)| holds(rule, whole)).map_or("other", |(category, _)| category)
    }

    /// A key's words, with the form a count takes.
    fn get(&self, key: &str, count: Option<i64>) -> Option<&'static str> {
        match self.entries.get(key)? {
            Entry::Text(text) => Some(text),
            Entry::Plural(forms, other) => {
                let category = count.map_or("other", |count| self.category(count));
                Some(forms.iter().find(|(name, _)| *name == category).map_or(*other, |(_, form)| form))
            }
        }
    }
}

/// A text with its {name}s filled in. A name it isn't given stays as written.
pub fn fill(text: &str, vars: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_end = after.find('}');
        let name = name_end.map(|end| &after[..end]).filter(|name| {
            let mut chars = name.chars();
            chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_') && chars.all(|char| char.is_ascii_alphanumeric() || char == '_')
        });
        match name.and_then(|name| vars.iter().find(|(var, _)| *var == name).map(|(_, value)| (name, value))) {
            Some((name, value)) => {
                out.push_str(&value.to_string());
                rest = &after[name.len() + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The number a count's form is picked by: `count`, written with separators or not.
pub fn count_of(vars: &[(&str, &dyn Display)]) -> Option<i64> {
    let written = vars.iter().find(|(name, _)| *name == "count")?.1.to_string();
    let digits: String = written.chars().filter(|char| char.is_ascii_digit() || *char == '-').collect();
    let negative = digits.starts_with('-');
    let digits = digits.trim_start_matches('-');
    if digits.is_empty() || digits.contains('-') {
        return None;
    }
    digits.parse::<i64>().ok().map(|count| if negative { -count } else { count })
}

/// Which of the languages there are best suits someone who prefers some, in order: the same tag,
/// or the same language in another region, as packages/i18n's `matchLanguage`.
pub fn match_language(preferred: &[String], available: &[&'static str]) -> Option<&'static str> {
    let normal = |tag: &str| tag.split(['.', '@']).next().unwrap_or("").replace('_', "-").to_lowercase();
    let base = |tag: &str| normal(tag).split('-').next().unwrap_or("").to_string();
    for wanted in preferred {
        let tag = normal(wanted);
        if tag.is_empty() || tag == "c" || tag == "posix" {
            continue;
        }
        if let Some(exact) = available.iter().find(|have| normal(have) == tag) {
            return Some(exact);
        }
        let language = base(wanted);
        if let Some(close) = available.iter().find(|have| normal(have) == language).or_else(|| available.iter().find(|have| base(have) == language)) {
            return Some(close);
        }
    }
    None
}

// --- The language shown ---

static ENGLISH: LazyLock<&'static Catalog> = LazyLock::new(|| {
    let json = CATALOGS.iter().find(|(tag, _)| *tag == "en").map(|(_, json)| *json).expect("en.json is built in");
    Box::leak(Box::new(Catalog::parse("en", json).expect("en.json reads")))
});

/// Each language read so far, kept for the app's life, as its words are handed out as they are.
static READ: LazyLock<Mutex<HashMap<&'static str, &'static Catalog>>> = LazyLock::new(Default::default);

static CURRENT: RwLock<Option<&'static Catalog>> = RwLock::new(None);

fn catalog(tag: &str) -> Option<&'static Catalog> {
    let (tag, json) = CATALOGS.iter().find(|(have, _)| *have == tag)?;
    let mut read = READ.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(catalog) = read.get(tag) {
        return Some(catalog);
    }
    match Catalog::parse(tag, json) {
        Ok(catalog) => {
            let catalog: &'static Catalog = Box::leak(Box::new(catalog));
            read.insert(tag, catalog);
            Some(catalog)
        }
        Err(error) => {
            log::warn!("{error}");
            None
        }
    }
}

fn current() -> Option<&'static Catalog> {
    *CURRENT.read().unwrap_or_else(|poison| poison.into_inner())
}

fn lookup(key: &str, count: Option<i64>) -> Option<&'static str> {
    current().and_then(|catalog| catalog.get(key, count)).or_else(|| ENGLISH.get(key, count))
}

/// A key's text in the person's language. A count's is its `other` form, so use `tr!` with
/// `count` for one. A key no catalog has is shown as it is, so that it's noticed.
pub fn t(key: &'static str) -> &'static str {
    lookup(key, None).unwrap_or(key)
}

/// A key's text with its {name}s filled in, and a count's form by `count`. `tr!` calls it.
pub fn format(key: &'static str, vars: &[(&str, &dyn Display)]) -> String {
    fill(lookup(key, count_of(vars)).unwrap_or(key), vars)
}

/// The languages there are, English first, then by their own names: each one's tag and name.
pub fn languages() -> Vec<(&'static str, String)> {
    let mut others: Vec<(&'static str, String)> = CATALOGS.iter().filter(|(tag, _)| *tag != "en").filter_map(|(tag, _)| catalog(tag).map(|catalog| (*tag, catalog.name.clone()))).collect();
    others.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    let mut all = vec![("en", ENGLISH.name.clone())];
    all.extend(others);
    all
}

/// The language a choice in Settings comes to: a tag there is, or the system's, or English.
pub fn resolve(choice: Option<&str>) -> &'static str {
    let tags: Vec<&'static str> = CATALOGS.iter().map(|(tag, _)| *tag).collect();
    if let Some(tag) = choice.and_then(|choice| tags.iter().find(|tag| **tag == choice)) {
        return tag;
    }
    match_language(&preferred_languages(), &tags).unwrap_or("en")
}

/// Shows the app in a language from now on: a tag, or `None` for the system's. Gives the tag it
/// came to.
pub fn set_language(choice: Option<&str>) -> &'static str {
    let tag = resolve(choice);
    let catalog = if tag == "en" { None } else { catalog(tag) };
    *CURRENT.write().unwrap_or_else(|poison| poison.into_inner()) = catalog;
    catalog.map_or("en", |catalog| catalog.tag)
}

/// The language shown, and its catalog's file for the core, or `None` for English.
pub fn shown() -> (&'static str, Option<&'static str>) {
    current().map_or(("en", None), |catalog| (catalog.tag, Some(catalog.json)))
}

/// What the core is told of the language shown (`ZunaClient.setLanguage`): its tag and catalog.
pub fn for_core() -> Vec<serde_json::Value> {
    let (tag, json) = shown();
    vec![serde_json::Value::from(tag), json.and_then(|json| serde_json::from_str(json).ok()).unwrap_or(serde_json::Value::Null)]
}

/// The languages the person prefers, in order, as the system says.
pub fn preferred_languages() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
        let (mut count, mut length) = (0u32, 0u32);
        // SAFETY: asked once for the length, then given a buffer of it, which the call fills with
        // tags, each ending in a nul, and a nul after the last.
        unsafe {
            if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut length).is_ok() && length > 0 {
                let mut buffer = vec![0u16; length as usize];
                if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(windows::core::PWSTR(buffer.as_mut_ptr())), &mut length).is_ok() {
                    return buffer.split(|unit| *unit == 0).filter(|tag| !tag.is_empty()).map(String::from_utf16_lossy).collect();
                }
            }
        }
        Vec::new()
    }
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSLocale::preferredLanguages().iter().map(|tag| tag.to_string()).collect()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // LANGUAGE lists them in order; the others name one.
        let mut tags = Vec::new();
        if let Ok(list) = std::env::var("LANGUAGE") {
            tags.extend(list.split(':').filter(|tag| !tag.is_empty()).map(str::to_string));
        }
        for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(tag) = std::env::var(name) {
                if !tag.is_empty() {
                    tags.push(tag);
                    break;
                }
            }
        }
        tags
    }
}

/// `tr!("key", name = value, …)`: a key's text with its {name}s filled in, and a count's form by
/// `count`. Without names it's `t`'s text, as a `String`.
#[macro_export]
macro_rules! tr {
    ($key:literal $(,)?) => {
        $crate::i18n::format($key, &[])
    };
    ($key:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::format($key, &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),+])
    };
}

/// Marks a key kept in a table, to look up with `t` where it's shown, so the check knows it's used.
pub const fn mark(key: &'static str) -> &'static str {
    key
}

#[cfg(test)]
mod tests;
