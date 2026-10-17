//! Pre-roll candidates (spec rule 20): the winning plugin's answer, ACL-gated per file.
use super::file::resolve_file;
use crate::{http::auth::Authed, state::AppState};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub media_file_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skippable: Option<bool>,
}

/// `[]` on any failure: the winning plugin's pre-roll route, sanitised (`plugins.md` rule 51).
async fn ask(
    st: &AppState,
    file: i32,
    media: Option<i32>,
    episode: Option<i32>,
    user: i32,
) -> Vec<Item> {
    let body = json!({"mediaFileId": file, "mediaId": media, "episodeId": episode});
    let Some(v) = st.plugins.pre_roll(body, user).await else {
        return vec![];
    };
    sanitize(&v, file)
}

/// An array of objects with a positive integer `mediaFileId` (not the main file, no repeat), at most 5.
fn sanitize(body: &serde_json::Value, main: i32) -> Vec<Item> {
    let mut seen = vec![i64::from(main)];
    let mut out = vec![];
    for e in body.as_array().into_iter().flatten() {
        if out.len() >= 5 {
            break;
        }
        let id = e["mediaFileId"]
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n < 9.0e15);
        let Some(id) = id.filter(|_| e.is_object()).map(|n| n as i64) else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        out.push(Item {
            media_file_id: id,
            label_key: e["labelKey"].as_str().map(str::to_owned),
            skippable: e["skippable"].as_bool(),
        });
    }
    out
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
