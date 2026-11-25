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

/// Fast classification of a request by its `@type` alone, avoiding full DOM parsing for `Rule::Any` and refused methods.
pub enum FastCheck {
    Allowed,
    Refused(String),
    NeedsFields,
}

pub fn check_kind(kind: &str) -> FastCheck {
    match rules().get(kind) {
        None => FastCheck::Refused(format!("{kind} isn't something Zuna does on Telegram")),
        Some(Rule::Any) => FastCheck::Allowed,
        Some(Rule::Only(_)) => FastCheck::NeedsFields,
    }
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

    #[test]
    fn a_call_speaks_the_one_protocol_and_touches_this_session_alone() {
        let protocol = json!({ "@type": "callProtocol", "udp_p2p": true, "udp_reflector": true, "min_layer": 65, "max_layer": 92, "library_versions": ["13.0.0"] });
        assert_eq!(refusal(&json!({ "@type": "createCall", "user_id": 5, "protocol": protocol, "is_video": false })), None);
        assert_eq!(refusal(&json!({ "@type": "acceptCall", "call_id": 1, "protocol": protocol })), None);
        for other in [
            json!({ "@type": "callProtocol", "udp_p2p": true, "udp_reflector": true, "min_layer": 65, "max_layer": 92, "library_versions": ["13.0.0", "11.0.0"] }),
            json!({ "@type": "callProtocol", "udp_p2p": true, "udp_reflector": true, "min_layer": 65, "max_layer": 92, "library_versions": ["4.0.0"] }),
            json!({ "@type": "callProtocol", "udp_p2p": false, "udp_reflector": true, "min_layer": 65, "max_layer": 92, "library_versions": ["13.0.0"] }),
            json!(null),
        ] {
            assert!(refusal(&json!({ "@type": "createCall", "user_id": 5, "protocol": other, "is_video": false })).is_some(), "{other} was let through");
            assert!(refusal(&json!({ "@type": "acceptCall", "call_id": 1, "protocol": other })).is_some());
        }
        assert!(refusal(&json!({ "@type": "createCall", "user_id": 5 })).is_some());
        assert_eq!(refusal(&json!({ "@type": "toggleSessionCanAcceptCalls", "session_id": 0, "can_accept_calls": false })), None);
        assert!(refusal(&json!({ "@type": "toggleSessionCanAcceptCalls", "session_id": 77, "can_accept_calls": false })).is_some());
        assert!(refusal(&json!({ "@type": "toggleSessionCanAcceptCalls", "can_accept_calls": false })).is_some());
        for kind in ["sendCallDebugInformation", "sendCallLog", "toggleSessionCanAcceptSecretChats", "terminateSession"] {
            assert!(refusal(&json!({ "@type": kind })).is_some(), "{kind} was let through");
        }
    }
}
