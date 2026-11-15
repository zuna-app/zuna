//! The lookups held to packages/i18n's vectors, which the core's and the web's are held to too.

use super::*;

const VECTORS: &str = include_str!("../../../../packages/i18n/test/vectors.json");

fn vectors() -> serde_json::Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn leak(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

/// A vector's vars, as `format` takes them.
fn vars(value: &serde_json::Value) -> Vec<(String, String)> {
    value.as_object().map_or_else(Vec::new, |vars| vars.iter().map(|(name, value)| (name.clone(), value.as_str().map_or_else(|| value.to_string(), str::to_string))).collect())
}

fn look_up(english: &'static Catalog, catalog: Option<&'static Catalog>, lookup: &serde_json::Value) -> String {
    let vars = vars(&lookup["vars"]);
    let shown: Vec<(&str, &dyn Display)> = vars.iter().map(|(name, value)| (name.as_str(), value as &dyn Display)).collect();
    if lookup["call"] == "translate" {
        let text = lookup["text"].as_str().unwrap();
        let key = english.entries.iter().find(|(_, entry)| matches!(entry, Entry::Text(english) if *english == text)).map(|(key, _)| key.clone());
        return key.and_then(|key| catalog.and_then(|catalog| catalog.get(&key, None))).unwrap_or(text).to_string();
    }
    let key = lookup["key"].as_str().unwrap();
    let count = count_of(&shown);
    let found = catalog.and_then(|catalog| catalog.get(key, count)).or_else(|| english.get(key, count)).unwrap_or(key);
    fill(found, &shown)
}

#[test]
fn plural_rules_follow_cldr_as_intl_does() {
    for case in vectors()["plural"].as_array().unwrap() {
        let rules = case["rules"].as_object().unwrap();
        let json = leak(serde_json::json!({ "$language": "x", "$plural": rules }).to_string());
        let catalog = Catalog::parse("xx", json).unwrap();
        for (count, category) in case["cases"].as_object().unwrap() {
            assert_eq!(catalog.category(count.parse().unwrap()), category.as_str().unwrap(), "{} {count}", case["tag"]);
        }
    }
}

#[test]
fn plural_rules_that_cant_be_read_are_refused() {
    for source in vectors()["badRules"].as_array().unwrap() {
        assert!(compile_rule(source.as_str().unwrap()).is_err(), "{source}");
    }
    assert!(compile_rule("i = 1 and v = 0 @integer 1").is_ok());
}

#[test]
fn filling_in_replaces_each_name_given_and_leaves_the_rest() {
    for case in vectors()["fill"].as_array().unwrap() {
        let vars = vars(&case["vars"]);
        let shown: Vec<(&str, &dyn Display)> = vars.iter().map(|(name, value)| (name.as_str(), value as &dyn Display)).collect();
        assert_eq!(fill(case["text"].as_str().unwrap(), &shown), case["out"].as_str().unwrap());
    }
}

#[test]
fn a_counts_form_is_picked_by_the_number_written_with_separators_or_not() {
    for case in vectors()["counts"].as_array().unwrap() {
        let vars = vars(&case["vars"]);
        let shown: Vec<(&str, &dyn Display)> = vars.iter().map(|(name, value)| (name.as_str(), value as &dyn Display)).collect();
        assert_eq!(count_of(&shown), case["out"].as_i64(), "{}", case["vars"]);
    }
}

#[test]
fn languages_match_as_the_core_matches_them() {
    for case in vectors()["match"].as_array().unwrap() {
        let preferred: Vec<String> = case["preferred"].as_array().unwrap().iter().map(|tag| tag.as_str().unwrap().to_string()).collect();
        let available: Vec<&'static str> = case["available"].as_array().unwrap().iter().map(|tag| leak(tag.as_str().unwrap().to_string())).collect();
        assert_eq!(match_language(&preferred, &available), case["out"].as_str(), "{preferred:?}");
    }
}

#[test]
fn catalogs_look_text_up_with_english_where_theyre_silent() {
    let vectors = vectors();
    let english: &'static Catalog = Box::leak(Box::new(Catalog::parse("en", leak(vectors["english"].to_string())).unwrap()));
    let polish: &'static Catalog = Box::leak(Box::new(Catalog::parse("pl", leak(vectors["catalog"]["data"].to_string())).unwrap()));
    assert_eq!(polish.name, "Polski");
    for lookup in vectors["lookups"].as_array().unwrap() {
        assert_eq!(look_up(english, Some(polish), lookup), lookup["out"].as_str().unwrap(), "{lookup}");
    }
    for lookup in vectors["englishLookups"].as_array().unwrap() {
        assert_eq!(look_up(english, None, lookup), lookup["out"].as_str().unwrap(), "{lookup}");
    }
}

#[test]
fn malformed_catalogs_are_refused() {
    for bad in [
        "[]",
        "{}",
        r#"{"$language": " "}"#,
        r#"{"$language": "Polski", "$plural": {"other": "n = 1"}}"#,
        r#"{"$language": "Polski", "$plural": {"one": "nonsense"}}"#,
        r#"{"$language": "Polski", "$comment": "x"}"#,
        r#"{"$language": "Polski", "common.cancel": 1}"#,
        r#"{"$language": "Polski", "group.days": {"lots": "x", "other": "y"}}"#,
        r#"{"$language": "Polski", "group.days": {"other": 2}}"#,
    ] {
        assert!(Catalog::parse("pl", bad).is_err(), "{bad}");
    }
}

#[test]
fn every_built_in_catalog_reads_and_english_is_among_them() {
    assert!(CATALOGS.iter().any(|(tag, _)| *tag == "en"));
    for (tag, json) in CATALOGS {
        Catalog::parse(tag, json).unwrap();
    }
    assert_eq!(languages()[0].0, "en");
    assert_eq!(resolve(Some("en")), "en");
    // A language that isn't built in comes to the system's, or English.
    assert!(CATALOGS.iter().any(|(tag, _)| *tag == resolve(Some("xx-nowhere"))));
}

#[test]
fn the_macro_fills_in_names_and_counts() {
    let catalog = Catalog::parse("en", r#"{"$language": "English", "$plural": {"one": "i = 1 and v = 0"}, "test.members": {"one": "{count} member in {group}", "other": "{count} members in {group}"}}"#).unwrap();
    let shown: [(&str, &dyn Display); 2] = [("count", &1), ("group", &"Ada's")];
    assert_eq!(fill(catalog.get("test.members", count_of(&shown)).unwrap(), &shown), "1 member in Ada's");
    // A key nobody has is shown as it is.
    assert_eq!(crate::tr!("nowhere.at.all", count = 2), "nowhere.at.all");
    assert_eq!(t("nowhere.at.all"), "nowhere.at.all");
}
