//! A plugin's network, made by the broker, never by the plugin's process: HTTPS to the hosts its
//! manifest names and nowhere else, through the app's own certificate rules, with no cookie and
//! nothing of the account. Names are resolved here and refused if any address they lead to is on
//! this machine or a private network, as link previews refuse them (host/web.rs), but for a plugin
//! a developer loaded from a folder, which may reach a server of their own on this machine.
//! A redirect is followed only to another of the plugin's hosts.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(30);
/// The most a request may carry, and a response bring back.
pub const MAX_BODY: usize = 1 << 20;
pub const MAX_RESPONSE: usize = 8 << 20;
const USER_AGENT: &str = "Zuna plugin";
/// Headers a plugin may not set, which say something of the app or the connection rather than of what's asked.
const REFUSED_HEADERS: [&str; 12] = ["cookie", "host", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "keep-alive", "origin", "referer"];

struct Resolver {
    local: bool,
}

impl reqwest::dns::Resolve for Resolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let local = self.local;
        Box::pin(async move {
            if !local && crate::host::web::local_name(&host) {
                return Err("That host is on this computer's network.".into());
            }
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 443)).await?.collect();
            if addresses.is_empty() || (!local && addresses.iter().any(|address| crate::host::web::private_address(address.ip()))) {
                return Err("That host is on this computer's network.".into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Whether a URL is one a plugin with these hosts may reach.
pub fn allowed(url: &Url, hosts: &[String]) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host(), Some(url::Host::Domain(name)) if hosts.iter().any(|host| host == &name.to_ascii_lowercase()))
}

fn client(hosts: Vec<String>, local: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .use_preconfigured_tls(crate::host::tls_config())
        .dns_resolver(Arc::new(Resolver { local }))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 {
                attempt.error("Too many redirects.")
            } else if allowed(attempt.url(), &hosts) {
                attempt.follow()
            } else {
                attempt.error("It redirected to a host the plugin doesn't name.")
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .expect("a client for plugins")
}

/// Makes a plugin's request, answering as the plugin API's `Response` is made: status, headers, and the body in base64.
pub async fn fetch(args: Value, hosts: Vec<String>, local: bool) -> Result<Value, String> {
    let url = Url::parse(args.get("url").and_then(Value::as_str).unwrap_or_default()).map_err(|_| "That isn't an address.".to_string())?;
    if !allowed(&url, &hosts) {
        return Err(format!("The plugin may only reach {}, over HTTPS.", hosts.join(", ")));
    }
    let method = args.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&method.as_str()) {
        return Err("That isn't a method a plugin may use.".into());
    }
    let body = match args.get("body").and_then(Value::as_str) {
        Some(encoded) => Some(base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "The body isn't readable.".to_string())?),
        None => None,
    };
    if body.as_ref().is_some_and(|body| body.len() > MAX_BODY) {
        return Err("A request carries at most 1 MB.".into());
    }
    let headers: HashMap<String, String> = args.get("headers").and_then(|headers| serde_json::from_value(headers.clone()).ok()).unwrap_or_default();
    if headers.len() > 40 {
        return Err("Too many headers.".into());
    }
    let client = client(hosts, local);
    let mut request = client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "That isn't a method.".to_string())?, url);
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if REFUSED_HEADERS.contains(&lower.as_str()) || lower.starts_with("sec-") || lower.starts_with("proxy-") || value.len() > 8192 {
            return Err(format!("A plugin can't set {name}."));
        }
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let task = crate::host::tokio().spawn(async move {
        let mut response = request.send().await.map_err(|error| {
            use std::error::Error;
            let mut text = error.to_string();
            let mut source = error.source();
            while let Some(inner) = source {
                text.push_str(": ");
                text.push_str(&inner.to_string());
                source = inner.source();
            }
            text
        })?;
        let status = response.status().as_u16();
        let mut fields = serde_json::Map::new();
        for (name, value) in response.headers() {
            if name.as_str().eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            fields.insert(name.as_str().to_ascii_lowercase(), json!(value.to_str().unwrap_or_default()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len() + chunk.len() > MAX_RESPONSE {
                return Err("The response was larger than 8 MB.".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(json!({ "status": status, "headers": fields, "body": base64::engine::general_purpose::STANDARD.encode(&body) }))
    });
    task.await.map_err(|error| error.to_string())?
}
