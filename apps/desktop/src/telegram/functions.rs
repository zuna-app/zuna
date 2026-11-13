//! What the core may ask of the engine: the list in `packages/core/src/telegram/functions.json`,
//! built into the app, which nothing changes while it runs.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

const LIST: &str = include_str!("../../../../packages/core/src/telegram/functions.json");

enum Rule {
    Any,
    /// The values each named field may have.
    Only(HashMap<String, Vec<Value>>),
}

fn rules() -> &'static HashMap<String, Rule> {
    static RULES: OnceLock<HashMap<String, Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let list: Value = serde_json::from_str(LIST).expect("functions.json is JSON");
        let functions = list.get("functions").and_then(Value::as_object).expect("functions.json lists functions");
        functions
            .iter()
            .map(|(name, rule)| {
                let rule = match rule {
                    Value::Bool(true) => Rule::Any,
                    Value::Object(fields) => Rule::Only(
                        fields.iter().map(|(field, values)| (field.clone(), values.as_array().cloned().unwrap_or_default())).collect(),
                    ),
                    _ => panic!("functions.json: {name} is neither true nor a list of values"),
                };
                (name.clone(), rule)
            })
            .collect()
    })
}

/// Why a request may not go to the engine, or None if it may.
pub fn refusal(request: &Value) -> Option<String> {
    let Some(kind) = request.get("@type").and_then(Value::as_str) else { return Some("a request with no type".into()) };
    match rules().get(kind) {
        None => Some(format!("{kind} isn't something Zuna does on Telegram")),
        Some(Rule::Any) => None,
        Some(Rule::Only(fields)) => fields
            .iter()
            .find(|(field, values)| !request.get(field.as_str()).is_some_and(|value| values.contains(value)))
            .map(|(field, _)| format!("{kind} with that {field} isn't something Zuna does on Telegram")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn what_s_listed_goes_and_nothing_else() {
        assert_eq!(refusal(&json!({ "@type": "getChats", "limit": 20 })), None);
        assert_eq!(refusal(&json!({ "@type": "sendMessage", "chat_id": 1 })), None);
        for kind in ["deleteAccount", "setPassword", "terminateAllOtherSessions", "terminateSession", "changePhoneNumber", "importContacts", "addProxy", "setTdlibParameters", "logOut", "destroy", "sendPaymentForm", "setLoginEmailAddress"] {
            assert!(refusal(&json!({ "@type": kind })).is_some(), "{kind} was let through");
        }
        assert!(refusal(&json!({ "limit": 20 })).is_some());
    }

    #[test]
    fn a_field_held_to_values_takes_only_those() {
        assert_eq!(refusal(&json!({ "@type": "setOption", "name": "online", "value": { "@type": "optionValueBoolean", "value": true } })), None);
        assert!(refusal(&json!({ "@type": "setOption", "name": "use_storage_optimizer" })).is_some());
        assert!(refusal(&json!({ "@type": "setOption" })).is_some());
    }
}
