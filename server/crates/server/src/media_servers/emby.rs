//! Emby provider (`docs/spec/media-servers.md` rules 8, 9, 11, 14): token header, timeouts, F29/F42 via `outbound`.
use crate::outbound::{ITEM_TIMEOUT, LIST_TIMEOUT, TEST_TIMEOUT, base_url, client, error_text};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;
use std::time::Duration;

pub const TYPE: &str = "emby";
pub const LABEL: &str = "Emby";
pub const EVENTS: [&str; 7] = [
    "download.complete",
    "subtitle.downloaded",
    "subtitle.upgraded",
    "subtitle.synced",
    "file.deleted",
    "media.deleted",
    "library.rescan",
];
pub const PAGE: usize = 500;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Played,
    Resumable,
    Resume,
}

pub struct Conn {
    base: String,
    token: Option<String>,
}

pub struct User {
    pub id: String,
    pub name: Option<String>,
}

/// The `UserData` / `ProviderIds` members the import reads; anything absent or mistyped reads as absent.
#[derive(Default)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub tmdb: Option<String>,
    pub series_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub run_ticks: f64,
    pub played: bool,
    pub position_ticks: f64,
    pub last_played: Option<String>,
    pub date_created: Option<String>,
    pub premiere: Option<String>,
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    v.as_f64().map(|f| f as i64)
}

impl Item {
    pub fn from_json(v: &Value) -> Self {
        let data = &v["UserData"];
        Self {
            id: text(&v["Id"]).unwrap_or_default(),
            kind: v["Type"].as_str().unwrap_or_default().into(),
            tmdb: text(&v["ProviderIds"]["Tmdb"]),
            series_id: text(&v["SeriesId"]).filter(|s| !s.is_empty()),
            season: int(&v["ParentIndexNumber"]),
            episode: int(&v["IndexNumber"]),
            run_ticks: v["RunTimeTicks"].as_f64().unwrap_or(0.0),
            played: data["Played"].as_bool() == Some(true),
            position_ticks: data["PlaybackPositionTicks"].as_f64().unwrap_or(0.0),
            last_played: data["LastPlayedDate"].as_str().map(Into::into),
            date_created: v["DateCreated"].as_str().map(Into::into),
            premiere: v["PremiereDate"].as_str().map(Into::into),
        }
    }
}

fn seg(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

impl Conn {
    pub fn new(url: &str, api_key: Option<&str>) -> Self {
        Self {
            base: base_url(url, false),
            token: api_key.map(Into::into),
        }
    }

    async fn send(&self, rb: reqwest::RequestBuilder, timeout: Duration) -> Result<Value, String> {
        let mut rb = rb.timeout(timeout);
        if let Some(t) = &self.token {
            rb = rb.header("X-Emby-Token", t);
        }
        let res = rb.send().await.map_err(error_text)?;
        if !res.status().is_success() {
            return Err(format!(
                "Request failed with status code {}",
                res.status().as_u16()
            ));
        }
        let bytes = res.bytes().await.map_err(error_text)?;
        // An undecodable 2xx body is axios' string: no members, no items.
        Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// `{ok, message}` of `testConnection` (rule 8).
    pub async fn test(&self) -> (bool, String) {
        let rb = client().get(format!("{}/System/Info", self.base));
        match self.send(rb, TEST_TIMEOUT).await {
            Ok(v) => (
                true,
                format!("Connecte a {}", v["ServerName"].as_str().unwrap_or(LABEL)),
            ),
            Err(e) => (false, e),
        }
    }

    pub async fn refresh_library(&self) -> Result<(), String> {
        let rb = client().post(format!("{}/Library/Refresh", self.base));
        self.send(rb, ITEM_TIMEOUT).await.map(drop)
    }

    pub async fn users(&self) -> Result<Vec<User>, String> {
        let rb = client().get(format!("{}/Users", self.base));
        let v = self.send(rb, ITEM_TIMEOUT).await?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .map(|u| User {
                id: text(&u["Id"]).unwrap_or_default(),
                name: u["Name"].as_str().map(Into::into),
            })
            .collect())
    }

    /// One page of `/Items` or `/Items/Resume` and the server's `TotalRecordCount`.
    pub async fn page(
        &self,
        user: &str,
        mode: Mode,
        offset: usize,
    ) -> Result<(Vec<Item>, usize), String> {
        let tail = if mode == Mode::Resume { "/Resume" } else { "" };
        let mut q = vec![
            ("IncludeItemTypes", "Movie,Episode".to_owned()),
            (
                "Fields",
                "ProviderIds,UserData,ParentIndexNumber,IndexNumber,SeriesName,SeriesId,\
                 RunTimeTicks,DateCreated,PremiereDate"
                    .into(),
            ),
            ("Recursive", "true".into()),
            ("StartIndex", offset.to_string()),
            ("Limit", PAGE.to_string()),
        ];
        match mode {
            Mode::Played => q.push(("IsPlayed", "true".into())),
            Mode::Resumable => q.push(("IsResumable", "true".into())),
            Mode::Resume => {}
        }
        let rb = client()
            .get(format!("{}/Users/{}/Items{tail}", self.base, seg(user)))
            .query(&q);
        let v = self.send(rb, LIST_TIMEOUT).await?;
        let items = v["Items"].as_array().into_iter().flatten();
        let total = v["TotalRecordCount"].as_f64().unwrap_or(0.0).max(0.0) as usize;
        Ok((items.map(Item::from_json).collect(), total))
    }

    /// A single item; any failure is `None`.
    pub async fn item(&self, user: &str, id: &str) -> Option<Item> {
        let rb = client().get(format!(
            "{}/Users/{}/Items/{}",
            self.base,
            seg(user),
            seg(id)
        ));
        let v = self.send(rb, ITEM_TIMEOUT).await.ok()?;
        v.is_object().then(|| Item::from_json(&v))
    }
}
