//! Imported sidecar subtitle rows (`importers.md` rules 18-20, 25).
use fliks_domain::{
    arr_import::{hearing_impaired_from_tags, parse_subtitle_tags},
    language::normalize_language_code,
};
use sqlx::PgPool;

pub const SUBTITLE_EXTS: [&str; 5] = [".srt", ".ass", ".ssa", ".sub", ".vtt"];

pub struct Sidecar<'a> {
    pub media_id: i32,
    pub media_file_id: i32,
    pub episode_id: Option<i32>,
    pub provider: &'a str,
    pub language: &'a str,
    pub relative_path: &'a str,
}

/// 1 when a row was inserted or updated, else 0; `update` is the import's `mode`.
pub async fn upsert(db: &PgPool, update: bool, s: &Sidecar<'_>) -> sqlx::Result<i64> {
    let tags = parse_subtitle_tags(s.relative_path);
    let forced = tags.contains(&"forced");
    let hearing_impaired = hearing_impaired_from_tags(&tags);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    let language = normalize_language_code(Some(s.language));
    let found = sqlx::query_scalar!(
        r#"SELECT id FROM subtitle_files
           WHERE "mediaFileId" = $1 AND language = $2 AND forced = $3 AND "filePath" = $4
           ORDER BY id LIMIT 1"#,
        s.media_file_id,
        language,
        forced,
        s.relative_path
    )
    .fetch_optional(db)
    .await?;
    let (target, was_embedded) = match found {
        Some(id) => (Some(id), false),
        None if update => {
            // A mis-tagged embedded row (no stream index) is adopted; one with an index is left alone.
            let embedded = sqlx::query!(
                r#"SELECT id, "streamIndex" AS stream_index FROM subtitle_files
                   WHERE "mediaFileId" = $1 AND language = $2 AND forced = $3 AND "providerType" = 'embedded'
                   ORDER BY id LIMIT 1"#,
                s.media_file_id,
                language,
                forced
            )
            .fetch_optional(db)
            .await?;
            (
                embedded.filter(|e| e.stream_index.is_none()).map(|e| e.id),
                true,
            )
        }
        None => (None, false),
    };
    match target {
        Some(_) if !update => Ok(0),
        Some(id) => {
            sqlx::query!(
                r#"UPDATE subtitle_files SET "providerType" = $2::text::subtitle_files_providertype_enum,
                          "hearingImpaired" = $3, tags = $4, "filePath" = $5, status = 'downloaded', score = 100,
                          "streamIndex" = CASE WHEN $6 THEN NULL ELSE "streamIndex" END,
                          codec = CASE WHEN $6 THEN NULL ELSE codec END
                   WHERE id = $1"#,
                id,
                s.provider,
                hearing_impaired,
                tags_json,
                s.relative_path,
                was_embedded
            )
            .execute(db)
            .await?;
            Ok(1)
        }
        None => {
            sqlx::query!(
                r#"INSERT INTO subtitle_files ("mediaId", "mediaFileId", "itemId", language, forced,
                          "hearingImpaired", "providerType", status, score, "filePath", tags)
                   VALUES ($1, $2, $3, $4, $5, $6, $7::text::subtitle_files_providertype_enum,
                           'downloaded', 100, $8, $9)"#,
                s.media_id,
                s.media_file_id,
                s.episode_id,
                language,
                forced,
                hearing_impaired,
                s.provider,
                s.relative_path,
                tags_json
            )
            .execute(db)
            .await?;
            Ok(1)
        }
    }
}
