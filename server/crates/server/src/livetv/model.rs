//! Rows of the `livetv_*` tables as the routes serialise them (`livetv-*.md` Routes tables).
use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, types::Json};

/// Every `livetv_sources` column but `password`, which no route ever serialises (F5).
pub const SOURCE_COLS: &str = r#"id, "createdAt", "updatedAt", name, kind, url, username, "userAgent", referer, "maxStreams",
    "maxStreamsIsManual", "refreshIntervalHours", "includeGroupsPattern", "excludeGroupsPattern", "expiresAt",
    "accountStatus", "guideUrls", "playlistEtag", "playlistLastModified", enabled, priority, "lastSyncAt",
    "lastSyncStatus", "lastSyncError", "lastAdultGuardError", "channelCount""#;

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub username: Option<String>,
    /// Only selected by the sync and the test; never serialised.
    #[serde(skip)]
    #[sqlx(default)]
    pub password: Option<String>,
    #[sqlx(rename = "userAgent")]
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    #[sqlx(rename = "maxStreams")]
    pub max_streams: i32,
    #[sqlx(rename = "maxStreamsIsManual")]
    pub max_streams_is_manual: bool,
    #[sqlx(rename = "refreshIntervalHours")]
    pub refresh_interval_hours: i32,
    #[sqlx(rename = "includeGroupsPattern")]
    pub include_groups_pattern: Option<String>,
    #[sqlx(rename = "excludeGroupsPattern")]
    pub exclude_groups_pattern: Option<String>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "expiresAt")]
    pub expires_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "accountStatus")]
    pub account_status: Option<String>,
    #[sqlx(rename = "guideUrls")]
    pub guide_urls: Json<Vec<String>>,
    #[sqlx(rename = "playlistEtag")]
    pub playlist_etag: Option<String>,
    #[sqlx(rename = "playlistLastModified")]
    pub playlist_last_modified: Option<String>,
    pub enabled: bool,
    pub priority: i32,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastSyncAt")]
    pub last_sync_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastSyncStatus")]
    pub last_sync_status: String,
    #[sqlx(rename = "lastSyncError")]
    pub last_sync_error: Option<String>,
    #[sqlx(rename = "lastAdultGuardError")]
    pub last_adult_guard_error: Option<String>,
    #[sqlx(rename = "channelCount")]
    pub channel_count: i32,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSource {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub kind: String,
    pub url: Option<String>,
    #[sqlx(rename = "sourceId")]
    pub source_id: Option<i32>,
    #[sqlx(rename = "refreshIntervalHours")]
    pub refresh_interval_hours: i32,
    #[sqlx(rename = "timezoneOffsetMinutes")]
    pub timezone_offset_minutes: i32,
    pub language: Option<String>,
    pub priority: i32,
    pub enabled: bool,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastSyncAt")]
    pub last_sync_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastSyncStatus")]
    pub last_sync_status: String,
    #[sqlx(rename = "lastSyncError")]
    pub last_sync_error: Option<String>,
    #[sqlx(rename = "programCount")]
    pub program_count: i32,
    pub etag: Option<String>,
    #[sqlx(rename = "lastModified")]
    pub last_modified: Option<String>,
}

pub const GUIDE_SOURCE_COLS: &str = r#"id, "createdAt", "updatedAt", name, kind, url, "sourceId", "refreshIntervalHours",
    "timezoneOffsetMinutes", language, priority, enabled, "lastSyncAt", "lastSyncStatus", "lastSyncError",
    "programCount", etag, "lastModified""#;

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "guideSourceId")]
    pub guide_source_id: Option<i32>,
    #[sqlx(rename = "guideChannelId")]
    pub guide_channel_id: String,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "startsAt")]
    pub starts_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "endsAt")]
    pub ends_at: DateTime<Utc>,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub categories: Json<Vec<String>>,
    #[sqlx(rename = "iconUrl")]
    pub icon_url: Option<String>,
    #[sqlx(rename = "seasonNumber")]
    pub season_number: Option<i32>,
    #[sqlx(rename = "episodeNumber")]
    pub episode_number: Option<i32>,
    #[sqlx(rename = "seriesId")]
    pub series_id: Option<String>,
    #[sqlx(rename = "isNew")]
    pub is_new: bool,
    #[sqlx(rename = "isLive")]
    pub is_live: bool,
    pub rating: Option<String>,
    pub year: Option<i32>,
}

pub const PROGRAM_COLS: &str = r#"p.id, p."createdAt", p."updatedAt", p."guideSourceId", p."guideChannelId", p."startsAt",
    p."endsAt", p.title, p.subtitle, p.description, p.categories, p."iconUrl", p."seasonNumber", p."episodeNumber",
    p."seriesId", p."isNew", p."isLive", p.rating, p.year"#;

/// A channel as a user lists it.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelItem {
    pub id: i32,
    pub name: String,
    pub number: Option<i32>,
    #[sqlx(rename = "logoPath")]
    pub logo_path: Option<String>,
    #[sqlx(rename = "groupName")]
    pub group_name: Option<String>,
    #[sqlx(rename = "guideChannelId")]
    pub guide_channel_id: Option<String>,
    pub favorite: bool,
}

/// The entity row of the admin list, without its `streams`.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub number: Option<i32>,
    #[sqlx(rename = "logoPath")]
    pub logo_path: Option<String>,
    #[sqlx(rename = "groupName")]
    pub group_name: Option<String>,
    #[sqlx(rename = "groupNameSource")]
    pub group_name_source: String,
    pub enabled: bool,
    #[sqlx(rename = "sortIndex")]
    pub sort_index: i32,
    #[sqlx(rename = "guideChannelId")]
    pub guide_channel_id: Option<String>,
    #[sqlx(rename = "guideMatchKind")]
    pub guide_match_kind: Option<String>,
    #[sqlx(rename = "guideShiftMinutes")]
    pub guide_shift_minutes: i32,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastPlayedAt")]
    pub last_played_at: Option<DateTime<Utc>>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastErrorAt")]
    pub last_error_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "consecutiveFailures")]
    pub consecutive_failures: i32,
}

pub const CHANNEL_COLS: &str = r#"c.id, c."createdAt", c."updatedAt", c.name, c.number, c."logoPath", c."groupName",
    c."groupNameSource", c.enabled, c."sortIndex", c."guideChannelId", c."guideMatchKind", c."guideShiftMinutes",
    c."lastPlayedAt", c."lastErrorAt", c."consecutiveFailures""#;

/// A stream row; the admin list nests its source, the session code reads the source's columns itself.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "externalId")]
    pub external_id: String,
    pub url: String,
    pub priority: i32,
    #[sqlx(rename = "qualityLabel")]
    pub quality_label: Option<String>,
    #[sqlx(rename = "providerName")]
    pub provider_name: String,
    #[sqlx(rename = "userAgent")]
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastSeenAt")]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "probedVideoCodec")]
    pub probed_video_codec: Option<String>,
    #[sqlx(rename = "probedAudioCodec")]
    pub probed_audio_codec: Option<String>,
    #[sqlx(rename = "probedContainer")]
    pub probed_container: Option<String>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "lastOkAt")]
    pub last_ok_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastError")]
    pub last_error: Option<String>,
    #[sqlx(rename = "channelId")]
    pub channel_id: Option<i32>,
    #[sqlx(rename = "sourceId")]
    pub source_id: Option<i32>,
}

pub const STREAM_COLS: &str = r#"s.id, s."createdAt", s."updatedAt", s."externalId", s.url, s.priority, s."qualityLabel",
    s."providerName", s."userAgent", s.referer, s."lastSeenAt", s."probedVideoCodec", s."probedAudioCodec",
    s."probedContainer", s."lastOkAt", s."lastError", s."channelId", s."sourceId""#;
