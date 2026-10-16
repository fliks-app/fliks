//! Pre-roll candidates (spec rule 20): the plugin host's answer over the bridge, ACL-gated per file.
use super::file::resolve_file;
use crate::{http::auth::Authed, state::AppState};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::OnceLock, time::Duration};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub media_file_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skippable: Option<bool>,
}

/// `[]` on any failure, like the plugin host itself.
async fn ask(
    st: &AppState,
    file: i32,
    media: Option<i32>,
    episode: Option<i32>,
    user: i32,
) -> Vec<Item> {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    let http = HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client")
    });
    let body = json!({
        "mediaFileId": file, "mediaId": media, "episodeId": episode,
        "principal": {"kind": "delegated", "userId": user},
    });
    let res = http
        .post(format!(
            "{}/internal/plugins/pre-roll",
            crate::nest::url(&st.cfg)
        ))
        .bearer_auth(&st.cfg.bridge_token)
        .json(&body)
        .send()
        .await;
    let items = async {
        let res = res.map_err(|e| e.without_url().to_string())?;
        if !res.status().is_success() {
            return Err(format!("status {}", res.status()));
        }
        res.json::<Vec<Item>>()
            .await
            .map_err(|e| e.without_url().to_string())
    }
    .await;
    items.unwrap_or_else(|e| {
        tracing::warn!("pre-roll bridge: {e}");
        vec![]
    })
}

/// `None` (key omitted) when no candidate survives; each must resolve for the same user as the main file.
pub async fn pre_roll(
    st: &AppState,
    user: &Authed,
    file: i32,
    media: Option<i32>,
    episode: Option<i32>,
) -> Option<Vec<Item>> {
    let candidates = ask(st, file, media, episode, user.user.id).await;
    let checks = join_all(
        candidates
            .iter()
            .map(|c| resolve_file(st, Some(user), c.media_file_id)),
    )
    .await;
    let allowed: Vec<Item> = candidates
        .into_iter()
        .zip(checks)
        .filter_map(|(c, r)| r.is_ok().then_some(c))
        .collect();
    (!allowed.is_empty()).then_some(allowed)
}
