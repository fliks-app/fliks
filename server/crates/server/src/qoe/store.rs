//! SQL of QoE (`docs/spec/qoe.md` SQL section): flush, admin reads, purge.
use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;

/// One `playback_qoe_sessions` row; the fields carry the column names, which `query_as!` matches by name.
#[derive(Clone, Debug, Serialize)]
#[allow(non_snake_case)]
pub struct QoeRow {
    pub sessionId: String,
    pub playbackId: Option<String>,
    pub userId: Option<i32>,
    pub mediaFileId: Option<i32>,
    pub mediaTitle: Option<String>,
    #[serde(with = "iso_ms")]
    pub startedAt: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub lastSeenAt: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    pub endedAt: Option<DateTime<Utc>>,
    pub deviceLabel: Option<String>,
    pub systemName: Option<String>,
    pub appVersion: Option<String>,
    pub engine: Option<String>,
    pub cmcd: bool,
    pub cmcdClaimed: bool,
    pub playMethod: Option<String>,
    pub quality: Option<String>,
    pub transcodeReasons: Value,
    pub videoCodec: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub decoderName: Option<String>,
    pub hwDecoder: Option<bool>,
    pub watchedMs: i32,
    pub stallCount: i32,
    pub stallMs: i32,
    pub droppedFrames: Option<i32>,
    pub decodedFrames: Option<i32>,
    pub avgBandwidthBps: Option<f64>,
    pub minBandwidthBps: Option<f64>,
    pub avgVariantBitrate: Option<f64>,
    pub recoveryReloads: i32,
    pub errorCount: i32,
    pub medianTranscodeSpeed: Option<f64>,
    pub stallBufferAheadS: Option<f64>,
    pub stallBandwidthBps: Option<f64>,
    pub cmcdThroughputBps: Option<f64>,
    pub unrecoveredError: bool,
    pub sampleCount: i32,
    pub stallCauseMs: Option<Value>,
    pub stallReasonMs: Option<Value>,
    pub pipeline: Option<Value>,
    pub verdict: String,
    pub confidence: String,
    pub reasons: Value,
    pub playbackVerdict: String,
    pub playbackConfidence: String,
}

pub struct EventRow {
    pub session_id: String,
    pub at: DateTime<Utc>,
    pub kind: String,
    pub data: Value,
}

/// `SELECT KEY` of the spec: a playbackId is unique per user only.
pub struct PageRow {
    pub key: String,
    pub uid: Option<i32>,
    pub pid: Option<String>,
    pub total: i64,
}

pub struct SummaryRow {
    pub device: Option<String>,
    pub system_name: Option<String>,
    pub engine: Option<String>,
    pub hw: Option<bool>,
    pub verdict: Option<String>,
    pub stalls: Option<i64>,
    pub dropped: Option<i64>,
    pub decoded: Option<i64>,
}

pub struct PageFilter<'a> {
    pub floor: DateTime<Utc>,
    pub since: DateTime<Utc>,
    pub verdict: Option<&'a str>,
    pub user_id: Option<i32>,
    pub devices: &'a [String],
    pub limit: i64,
    pub offset: i64,
}

pub async fn upsert(db: &PgPool, r: &QoeRow) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO playback_qoe_sessions ("sessionId", "playbackId", "userId", "mediaFileId", "mediaTitle", "startedAt", "lastSeenAt", "endedAt", "deviceLabel", "systemName", "appVersion", "engine", "cmcd", "cmcdClaimed", "playMethod", "quality", "transcodeReasons", "videoCodec", "width", "height", "decoderName", "hwDecoder", "watchedMs", "stallCount", "stallMs", "droppedFrames", "decodedFrames", "avgBandwidthBps", "minBandwidthBps", "avgVariantBitrate", "recoveryReloads", "errorCount", "medianTranscodeSpeed", "stallBufferAheadS", "stallBandwidthBps", "cmcdThroughputBps", "unrecoveredError", "sampleCount", "stallCauseMs", "stallReasonMs", "pipeline", "verdict", "confidence", "reasons", "playbackVerdict", "playbackConfidence")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46)
           ON CONFLICT ("sessionId") DO UPDATE SET "playbackId" = EXCLUDED."playbackId",
               "userId" = EXCLUDED."userId",
               "mediaFileId" = EXCLUDED."mediaFileId",
               "mediaTitle" = EXCLUDED."mediaTitle",
               "startedAt" = EXCLUDED."startedAt",
               "lastSeenAt" = EXCLUDED."lastSeenAt",
               "endedAt" = EXCLUDED."endedAt",
               "deviceLabel" = EXCLUDED."deviceLabel",
               "systemName" = EXCLUDED."systemName",
               "appVersion" = EXCLUDED."appVersion",
               "engine" = EXCLUDED."engine",
               "cmcd" = EXCLUDED."cmcd",
               "cmcdClaimed" = EXCLUDED."cmcdClaimed",
               "playMethod" = EXCLUDED."playMethod",
               "quality" = EXCLUDED."quality",
               "transcodeReasons" = EXCLUDED."transcodeReasons",
               "videoCodec" = EXCLUDED."videoCodec",
               "width" = EXCLUDED."width",
               "height" = EXCLUDED."height",
               "decoderName" = EXCLUDED."decoderName",
               "hwDecoder" = EXCLUDED."hwDecoder",
               "watchedMs" = EXCLUDED."watchedMs",
               "stallCount" = EXCLUDED."stallCount",
               "stallMs" = EXCLUDED."stallMs",
               "droppedFrames" = EXCLUDED."droppedFrames",
               "decodedFrames" = EXCLUDED."decodedFrames",
               "avgBandwidthBps" = EXCLUDED."avgBandwidthBps",
               "minBandwidthBps" = EXCLUDED."minBandwidthBps",
               "avgVariantBitrate" = EXCLUDED."avgVariantBitrate",
               "recoveryReloads" = EXCLUDED."recoveryReloads",
               "errorCount" = EXCLUDED."errorCount",
               "medianTranscodeSpeed" = EXCLUDED."medianTranscodeSpeed",
               "stallBufferAheadS" = EXCLUDED."stallBufferAheadS",
               "stallBandwidthBps" = EXCLUDED."stallBandwidthBps",
               "cmcdThroughputBps" = EXCLUDED."cmcdThroughputBps",
               "unrecoveredError" = EXCLUDED."unrecoveredError",
               "sampleCount" = EXCLUDED."sampleCount",
               "stallCauseMs" = EXCLUDED."stallCauseMs",
               "stallReasonMs" = EXCLUDED."stallReasonMs",
               "pipeline" = EXCLUDED."pipeline",
               "verdict" = EXCLUDED."verdict",
               "confidence" = EXCLUDED."confidence",
               "reasons" = EXCLUDED."reasons",
               "playbackVerdict" = EXCLUDED."playbackVerdict",
               "playbackConfidence" = EXCLUDED."playbackConfidence""#,
        &r.sessionId,
        r.playbackId.as_deref(),
        r.userId,
        r.mediaFileId,
        r.mediaTitle.as_deref(),
        r.startedAt,
        r.lastSeenAt,
        r.endedAt,
        r.deviceLabel.as_deref(),
        r.systemName.as_deref(),
        r.appVersion.as_deref(),
        r.engine.as_deref(),
        r.cmcd,
        r.cmcdClaimed,
        r.playMethod.as_deref(),
        r.quality.as_deref(),
        &r.transcodeReasons,
        r.videoCodec.as_deref(),
        r.width,
        r.height,
        r.decoderName.as_deref(),
        r.hwDecoder,
        r.watchedMs,
        r.stallCount,
        r.stallMs,
        r.droppedFrames,
        r.decodedFrames,
        r.avgBandwidthBps,
        r.minBandwidthBps,
        r.avgVariantBitrate,
        r.recoveryReloads,
        r.errorCount,
        r.medianTranscodeSpeed,
        r.stallBufferAheadS,
        r.stallBandwidthBps,
        r.cmcdThroughputBps,
        r.unrecoveredError,
        r.sampleCount,
        r.stallCauseMs.as_ref(),
        r.stallReasonMs.as_ref(),
        r.pipeline.as_ref(),
        &r.verdict,
        &r.confidence,
        &r.reasons,
        &r.playbackVerdict,
        &r.playbackConfidence,
    )
    .execute(db)
    .await
    .map(drop)
}

/// One multi-row insert, ids follow the array order.
pub async fn insert_events(db: &PgPool, events: &[EventRow]) -> sqlx::Result<()> {
    let sids: Vec<String> = events.iter().map(|e| e.session_id.clone()).collect();
    let ats: Vec<DateTime<Utc>> = events.iter().map(|e| e.at).collect();
    let kinds: Vec<String> = events.iter().map(|e| e.kind.clone()).collect();
    let data: Vec<Value> = events.iter().map(|e| e.data.clone()).collect();
    sqlx::query!(
        r#"INSERT INTO playback_qoe_events ("sessionId", "at", "type", "data")
           SELECT * FROM UNNEST($1::varchar[], $2::timestamptz[], $3::varchar[], $4::jsonb[])"#,
        &sids,
        &ats,
        &kinds,
        &data
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn siblings(
    db: &PgPool,
    user: i32,
    playback: &str,
    sid: &str,
) -> sqlx::Result<Vec<QoeRow>> {
    sqlx::query_as!(
        QoeRow,
        r#"SELECT * FROM playback_qoe_sessions WHERE "userId" = $1 AND "playbackId" = $2 AND "sessionId" <> $3"#,
        user,
        playback,
        sid
    )
    .fetch_all(db)
    .await
}

pub async fn restate(db: &PgPool, r: &QoeRow) -> sqlx::Result<()> {
    let (Some(user), Some(playback)) = (r.userId, r.playbackId.as_deref()) else {
        return Ok(());
    };
    sqlx::query!(
        r#"UPDATE playback_qoe_sessions SET "playbackVerdict" = $1, "playbackConfidence" = $2
           WHERE "userId" = $3 AND "playbackId" = $4 AND "sessionId" <> $5
             AND ("playbackVerdict" IS DISTINCT FROM $1 OR "playbackConfidence" IS DISTINCT FROM $2)"#,
        r.playbackVerdict,
        r.playbackConfidence,
        user,
        playback,
        r.sessionId
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn purge(db: &PgPool, cutoff: DateTime<Utc>) -> sqlx::Result<u64> {
    sqlx::query!(
        r#"DELETE FROM playback_qoe_sessions WHERE "lastSeenAt" < $1"#,
        cutoff
    )
    .execute(db)
    .await
    .map(|r| r.rows_affected())
}

pub async fn setting(db: &PgPool, key: &str) -> sqlx::Result<Option<String>> {
    Ok(
        sqlx::query_scalar!(r#"SELECT "value" FROM app_settings WHERE "key" = $1"#, key)
            .fetch_optional(db)
            .await?
            .flatten(),
    )
}

pub async fn page(db: &PgPool, f: &PageFilter<'_>) -> sqlx::Result<Vec<PageRow>> {
    sqlx::query_as!(
        PageRow,
        r#"SELECT COALESCE(s."userId"::text || ':' || s."playbackId", s."sessionId") AS "key!",
                  MAX(s."userId") AS "uid", MAX(s."playbackId") AS "pid",
                  COUNT(*) OVER() AS "total!"
           FROM playback_qoe_sessions s
           WHERE s."lastSeenAt" >= $1
             AND ($3::text IS NULL OR s."playbackVerdict" = $3)
             AND ($4::int4 IS NULL OR s."userId" = $4)
             AND (cardinality($5::text[]) = 0 OR s."deviceLabel" = ANY($5))
           GROUP BY COALESCE(s."userId"::text || ':' || s."playbackId", s."sessionId")
           HAVING MAX(s."lastSeenAt") >= $2
           ORDER BY MAX(s."lastSeenAt") DESC
           LIMIT $6 OFFSET $7"#,
        f.floor,
        f.since,
        f.verdict,
        f.user_id,
        f.devices,
        f.limit,
        f.offset
    )
    .fetch_all(db)
    .await
}

/// The two `ANY` lists also match cross pairs of different playbacks; the caller filters by key.
pub async fn rows_of(
    db: &PgPool,
    sids: &[String],
    uids: &[i32],
    pids: &[String],
) -> sqlx::Result<Vec<QoeRow>> {
    sqlx::query_as!(
        QoeRow,
        r#"SELECT * FROM playback_qoe_sessions s
           WHERE s."sessionId" = ANY($1) OR (s."userId" = ANY($2) AND s."playbackId" = ANY($3))"#,
        sids,
        uids,
        pids
    )
    .fetch_all(db)
    .await
}

pub async fn anchor(db: &PgPool, sid: &str) -> sqlx::Result<Option<QoeRow>> {
    sqlx::query_as!(
        QoeRow,
        r#"SELECT * FROM playback_qoe_sessions WHERE "sessionId" = $1 LIMIT 1"#,
        sid
    )
    .fetch_optional(db)
    .await
}

pub async fn playback_rows(db: &PgPool, user: i32, playback: &str) -> sqlx::Result<Vec<QoeRow>> {
    sqlx::query_as!(
        QoeRow,
        r#"SELECT * FROM playback_qoe_sessions WHERE "userId" = $1 AND "playbackId" = $2"#,
        user,
        playback
    )
    .fetch_all(db)
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventOut {
    pub id: i32,
    pub session_id: String,
    #[serde(with = "iso_ms")]
    pub at: DateTime<Utc>,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Value,
}

pub async fn events_of(db: &PgPool, sids: &[String]) -> sqlx::Result<Vec<EventOut>> {
    sqlx::query_as!(
        EventOut,
        r#"SELECT "id", "sessionId" AS "session_id", "at", "type" AS "kind", "data"
           FROM playback_qoe_events WHERE "sessionId" = ANY($1) ORDER BY "at" ASC, "id" ASC"#,
        sids
    )
    .fetch_all(db)
    .await
}

pub async fn summary_rows(
    db: &PgPool,
    floor: DateTime<Utc>,
    since: DateTime<Utc>,
) -> sqlx::Result<Vec<SummaryRow>> {
    sqlx::query_as!(
        SummaryRow,
        r#"SELECT (ARRAY_AGG(s."deviceLabel" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."deviceLabel" IS NOT NULL))[1] AS "device",
                  (ARRAY_AGG(s."systemName" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."systemName" IS NOT NULL))[1] AS "system_name",
                  (ARRAY_AGG(s."engine" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."engine" IS NOT NULL))[1] AS "engine",
                  (ARRAY_AGG(s."hwDecoder" ORDER BY s."lastSeenAt" DESC) FILTER (WHERE s."hwDecoder" IS NOT NULL))[1] AS "hw",
                  MAX(s."playbackVerdict") AS "verdict", SUM(s."stallCount") AS "stalls",
                  SUM(CASE WHEN s."droppedFrames" IS NOT NULL AND s."decodedFrames" IS NOT NULL THEN s."droppedFrames" END) AS "dropped",
                  SUM(CASE WHEN s."droppedFrames" IS NOT NULL AND s."decodedFrames" IS NOT NULL THEN s."decodedFrames" END) AS "decoded"
           FROM playback_qoe_sessions s
           WHERE s."lastSeenAt" >= $1
           GROUP BY COALESCE(s."userId"::text || ':' || s."playbackId", s."sessionId")
           HAVING MAX(s."lastSeenAt") >= $2
           ORDER BY MAX(s."lastSeenAt") DESC"#,
        floor,
        since
    )
    .fetch_all(db)
    .await
}
