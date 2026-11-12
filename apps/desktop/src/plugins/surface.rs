//! The table every core call and event of a plugin is checked against: for each method of the
//! client and of a server's session, the permission it needs, or never. It's written in the SDK,
//! typed against the core (packages/plugin-sdk/src/surface.ts), and core-bundle/build.mjs writes
//! it beside the core bundle as JSON, which this reads. A name the table doesn't have is never.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use super::manifest::Permission;

const SURFACE: &str = include_str!("../../assets/core/plugin-surface.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    Never,
    Needs(Permission),
}

pub struct Surface {
    client: HashMap<String, Rule>,
    session: HashMap<String, Rule>,
    events: HashMap<String, Rule>,
}

#[derive(Deserialize)]
struct Raw {
    client: HashMap<String, String>,
    session: HashMap<String, String>,
    events: HashMap<String, String>,
}

fn rules(raw: HashMap<String, String>) -> HashMap<String, Rule> {
    raw.into_iter()
        .map(|(name, rule)| {
            let rule = Permission::parse(&rule).map(Rule::Needs).unwrap_or(Rule::Never);
            (name, rule)
        })
        .collect()
}

pub fn surface() -> &'static Surface {
    static SURFACE_TABLE: OnceLock<Surface> = OnceLock::new();
    SURFACE_TABLE.get_or_init(|| {
        let raw: Raw = serde_json::from_str(SURFACE).expect("the plugins' table is the SDK's");
        Surface { client: rules(raw.client), session: rules(raw.session), events: rules(raw.events) }
    })
}

impl Surface {
    /// What calling a method needs: of a server's session with `server`, of the client without.
    pub fn method(&self, server: bool, name: &str) -> Rule {
        let table = if server { &self.session } else { &self.client };
        table.get(name).copied().unwrap_or(Rule::Never)
    }

    pub fn event(&self, kind: &str) -> Rule {
        self.events.get(kind).copied().unwrap_or(Rule::Never)
    }

    /// Every method, for tests: (on a session, name, rule).
    #[cfg(test)]
    pub fn methods(&self) -> Vec<(bool, String, Rule)> {
        self.client.iter().map(|(name, rule)| (false, name.clone(), *rule)).chain(self.session.iter().map(|(name, rule)| (true, name.clone(), *rule))).collect()
    }
}
