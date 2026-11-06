//! What a notification says and where it leads, the same for Windows's cards and Linux's
//! system notifications.

use std::sync::Arc;

use gpui::Image;

/// What a notification says and where it leads.
#[derive(Clone)]
pub struct Payload {
    pub title: String,
    pub body: String,
    pub server_id: String,
    pub key: String,
    pub message_id: String,
    pub kind: String,
    /// The chat's picture, or nothing for the app's own when it shows nothing about who.
    pub picture: Option<Picture>,
    pub can_reply: bool,
    /// Stays up until the person next touches the computer, rather than only for a while.
    pub wait_for_input: bool,
}

#[derive(Clone)]
pub struct Picture {
    pub image: Option<Arc<Image>>,
    pub initials: String,
    pub seed: String,
}
