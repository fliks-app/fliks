//! `subtitle_files` rows and their JSON (`subtitles.md` rules 4-5).
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{FromRow, PgExecutor};

/// Column list of a [`Row`]; enums read as text.
pub const COLS: &str = r#"id, "createdAt" AS created_at, "updatedAt" AS updated_at, "mediaId" AS media_id,
  "episodeId" AS episode_id, "mediaFileId" AS media_file_id, language, forced,
  "hearingImpaired" AS hearing_impaired, "providerType"::text AS provider_type,
  "providerFileId" AS provider_file_id, "filePath" AS file_path, status::text AS status,
  "streamIndex" AS stream_index, "sourceStreamIndex" AS source_stream_index, codec, score,
  "hashMatched" AS hash_matched, synced, "syncFailed" AS sync_failed, "syncOffset" AS sync_offset,
  "errorMessage" AS error_message, locked, tags, "translationProviderId" AS translation_provider_id,
  "translationEngine" AS translation_engine, "translationModel" AS translation_model,
  "translationProviderName" AS translation_provider_name"#;

#[derive(Debug, Clone, FromRow)]
pub struct Row {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub media_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub media_file_id: Option<i32>,
    pub language: String,
    pub forced: bool,
    pub hearing_impaired: bool,
    pub provider_type: String,
    pub provider_file_id: Option<String>,
    pub file_path: Option<String>,
    pub status: String,
    pub stream_index: Option<i32>,
    pub source_stream_index: Option<i32>,
    pub codec: Option<String>,
    pub score: i32,
    pub hash_matched: bool,
    pub synced: bool,
    pub sync_failed: bool,
    pub sync_offset: Option<i32>,
    pub error_message: Option<String>,
    pub locked: bool,
    pub tags: String,
    pub translation_provider_id: Option<i32>,
    pub translation_engine: Option<String>,
    pub translation_model: Option<String>,
    pub translation_provider_name: Option<String>,
}

impl Row {
    /// `SF`: every column as stored, `filePath` as `relativePath`.
    pub fn json(&self) -> Value {
        let tags = serde_json::from_str::<Value>(&self.tags)
            .ok()
            .filter(Value::is_array)
            .unwrap_or_else(|| json!([]));
        json!({
            "id": self.id,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "mediaId": self.media_id,
            "episodeId": self.episode_id,
            "mediaFileId": self.media_file_id,
            "language": self.language,
            "forced": self.forced,
            "hearingImpaired": self.hearing_impaired,
            "providerType": self.provider_type,
            "providerFileId": self.provider_file_id,
            "relativePath": self.file_path,
            "status": self.status,
            "streamIndex": self.stream_index,
            "sourceStreamIndex": self.source_stream_index,
            "codec": self.codec,
            "score": self.score,
            "hashMatched": self.hash_matched,
            "synced": self.synced,
            "syncFailed": self.sync_failed,
            "syncOffset": self.sync_offset,
            "errorMessage": self.error_message,
            "locked": self.locked,
            "tags": tags,
            "translationProviderId": self.translation_provider_id,
            "translationEngine": self.translation_engine,
            "translationModel": self.translation_model,
            "translationProviderName": self.translation_provider_name,
        })
    }

    /// Image-based tracks carry no text.
    pub fn is_embedded(&self) -> bool {
        self.provider_type == "embedded"
    }
}

pub use fliks_domain::js::iso;

/// An insert; unset options stay NULL, flags default like the column defaults.
#[derive(Debug, Clone, Default)]
pub struct New {
    pub media_id: i32,
    pub media_file_id: i32,
    pub episode_id: Option<i32>,
    pub language: String,
    pub forced: bool,
    pub hearing_impaired: bool,
    pub provider_type: String,
    pub provider_file_id: Option<String>,
    pub file_path: Option<String>,
    pub status: String,
    pub stream_index: Option<i32>,
    pub source_stream_index: Option<i32>,
    pub codec: Option<String>,
    pub score: i32,
    pub hash_matched: bool,
    pub synced: bool,
    pub locked: bool,
    pub tags: Option<String>,
    pub translation_provider_id: Option<i32>,
    pub translation_engine: Option<String>,
    pub translation_model: Option<String>,
    pub translation_provider_name: Option<String>,
}

pub struct Inserted {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub async fn insert(db: impl PgExecutor<'_>, n: &New) -> sqlx::Result<Inserted> {
    let r: (i32, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
        r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", "episodeId", language, forced,
             "hearingImpaired", "providerType", "providerFileId", "filePath", status, "streamIndex",
             "sourceStreamIndex", codec, score, "hashMatched", synced, locked, tags,
             "translationProviderId", "translationEngine", "translationModel", "translationProviderName")
           VALUES ($1, $2, $3, $4, $5, $6, $7::text::subtitle_files_providertype_enum, $8, $9,
             $10::text::subtitle_files_status_enum, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, '[]'),
             $19, $20, $21, $22)
           RETURNING id, "createdAt", "updatedAt""#,
    )
    .bind(n.media_id)
    .bind(n.media_file_id)
    .bind(n.episode_id)
    .bind(&n.language)
    .bind(n.forced)
    .bind(n.hearing_impaired)
    .bind(&n.provider_type)
    .bind(&n.provider_file_id)
    .bind(&n.file_path)
    .bind(&n.status)
    .bind(n.stream_index)
    .bind(n.source_stream_index)
    .bind(&n.codec)
    .bind(n.score)
    .bind(n.hash_matched)
    .bind(n.synced)
    .bind(n.locked)
    .bind(&n.tags)
    .bind(n.translation_provider_id)
    .bind(&n.translation_engine)
    .bind(&n.translation_model)
    .bind(&n.translation_provider_name)
    .fetch_one(db)
    .await?;
    Ok(Inserted {
        id: r.0,
        created_at: r.1,
        updated_at: r.2,
    })
}

impl New {
    /// `SFnew`: what `repo.save` returns (recorded): every column, the relation stubs, and the
    /// translation provider id only when one is set.
    pub fn saved_json(&self, i: &Inserted) -> Value {
        let tags = self
            .tags
            .as_deref()
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or_else(|| json!([]));
        let mut m = json!({
            "id": i.id,
            "createdAt": iso(i.created_at),
            "updatedAt": iso(i.updated_at),
            "media": {"id": self.media_id},
            "mediaId": self.media_id,
            "mediaFile": {"id": self.media_file_id},
            "mediaFileId": self.media_file_id,
            "episode": self.episode_id.map(|e| json!({"id": e})),
            "episodeId": self.episode_id,
            "language": self.language,
            "forced": self.forced,
            "hearingImpaired": self.hearing_impaired,
            "providerType": self.provider_type,
            "providerFileId": self.provider_file_id,
            "relativePath": self.file_path,
            "status": self.status,
            "streamIndex": self.stream_index,
            "sourceStreamIndex": self.source_stream_index,
            "codec": self.codec,
            "score": self.score,
            "hashMatched": self.hash_matched,
            "synced": self.synced,
            "syncFailed": false,
            "syncOffset": null,
            "errorMessage": null,
            "locked": self.locked,
            "tags": tags,
            "translationEngine": self.translation_engine,
            "translationModel": self.translation_model,
            "translationProviderName": self.translation_provider_name,
        });
        if let Some(v) = self.translation_provider_id {
            m["translationProvider"] = json!({"id": v});
            m["translationProviderId"] = json!(v);
        }
        m
    }
}

pub async fn by_id(db: impl PgExecutor<'_>, id: i32) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM subtitle_files WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn of_media(db: impl PgExecutor<'_>, media_id: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM subtitle_files WHERE "mediaId" = $1 ORDER BY language ASC, score DESC, id ASC"#
    )))
    .bind(media_id)
    .fetch_all(db)
    .await
}

pub async fn of_file(db: impl PgExecutor<'_>, file_id: i32) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COLS} FROM subtitle_files WHERE "mediaFileId" = $1 ORDER BY language ASC, score DESC, id ASC"#
    )))
    .bind(file_id)
    .fetch_all(db)
    .await
}
