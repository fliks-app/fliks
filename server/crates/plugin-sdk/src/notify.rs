//! `notify.users` (plugins.md rule 76): a notification to some users, texts from the manifest `i18n`.
//! Needs the scope `notify:users` and a manifest `fliks` range from the release that links `notify`.

pub use crate::bindings::fliks::plugin::notify::{Notification, NotifyAudience};
use crate::host::HostError;

impl Notification {
    /// `title_key` and `body_key` name entries of the manifest `i18n`.
    pub fn new(title_key: &str, body_key: &str) -> Self {
        Self {
            title_key: title_key.into(),
            body_key: body_key.into(),
            params: vec![],
            url: None,
            image: None,
            media_id: None,
        }
    }

    pub fn param(mut self, name: &str, value: impl ToString) -> Self {
        self.params.push((name.into(), value.to_string()));
        self
    }

    /// An in-app path opened by the notification.
    pub fn url(mut self, path: &str) -> Self {
        self.url = Some(path.into());
        self
    }

    /// A path on the server; the media's poster when unset and `media` is.
    pub fn image(mut self, path: &str) -> Self {
        self.image = Some(path.into());
        self
    }

    /// Opens the media's page and shows its poster unless `url` and `image` say otherwise.
    pub fn media(mut self, id: u32) -> Self {
        self.media_id = Some(id);
        self
    }
}

/// At most 10 calls an hour per plugin, then `ERR_RATE_LIMITED`.
pub fn users(audience: NotifyAudience, notification: &Notification) -> Result<(), HostError> {
    crate::bindings::fliks::plugin::notify::notify_users(&audience, notification)
}
