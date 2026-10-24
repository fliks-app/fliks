//! `/api/system/streams*` and `/api/system/transcode-cache*` (spec rules 32-37).
use super::engine_err;
use crate::{
    events::{SseEvent, event::PlayerAction},
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson, from_value},
    },
    presence::{self, Stream},
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::{AudioPlan, BitrateHint, JobStats, LiveMode, MediaInfo, SessionKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStream {
    session_id: String,
    user_id: Option<i32>,
    username: Option<String>,
    media_id: i32,
    media_file_id: u32,
    media_title: String,
    media_type: String,
    episode_id: Option<i32>,
    episode_label: Option<String>,
    poster_url: Option<String>,
    mode: SessionKind,
    quality: String,
    hw_accel: String,
    device: Option<String>,
    system_name: Option<String>,
    app_version: Option<String>,
    #[serde(with = "iso_ms")]
    started_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    last_activity: DateTime<Utc>,
    position_seconds: f64,
    duration_seconds: f64,
    container: Option<String>,
    video_codec: Option<String>,
    video_resolution: Option<String>,
    video_bitrate: Option<u32>,
    audio_codec: Option<String>,
    audio_channels: Option<String>,
    audio_language: Option<String>,
    output_container: Option<String>,
    output_bitrate: Option<u32>,
    audio_output_codec: Option<String>,
    audio_output_bitrate_bps: Option<u32>,
    audio_mode: &'static str,
    transcode_percent: Option<f64>,
    client_tonemap: bool,
    /// An offline-download session (pinned), not a playback.
    download: bool,
    video_reasons: Vec<String>,
    audio_reasons: Vec<String>,
    container_reasons: Vec<String>,
    qoe: Option<Value>,
    engine_status: crate::engine::Status,
    job: Option<JobStats>,
}

fn at(ms: f64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms as i64).unwrap_or_default()
}

/// `bucketResolutionLabel`: the canonical height step of a width x height pair.
fn resolution_label(w: u32, h: u32) -> Option<String> {
    if w == 0 && h == 0 {
        return None;
    }
    let bucket = match (w, h) {
        (w, h) if w <= 256 && h <= 192 => 144,
        (w, h) if w <= 426 && h <= 320 => 240,
        (w, h) if w <= 640 && h <= 432 => 360,
        (w, h) if w <= 854 && h <= 576 => 480,
        (w, h) if w <= 1280 && h <= 962 => 720,
        (w, h) if w <= 1920 && h <= 1440 => 1080,
        _ => 2160,
    };
    Some(if bucket == 2160 {
        "4K".into()
    } else {
        format!("{bucket}p")
    })
}

/// The decision's bitrates of the rung served; none for remux, direct play and an unknown rung.
pub(super) fn served_rung<'a>(
    mode: SessionKind,
    quality: &str,
    hdr_ladder: bool,
    by_quality: Option<&'a BTreeMap<String, BitrateHint>>,
) -> Option<&'a BitrateHint> {
    let by = by_quality.filter(|_| mode == SessionKind::Transcode)?;
    let hdr = if hdr_ladder && !quality.ends_with("-hdr") {
        format!("{quality}-hdr")
    } else {
        quality.to_owned()
    };
    by.get(&hdr).or_else(|| by.get(quality))
}

/// `deriveAudioOutput`: with a plan the plan decides; without, remux copies and the rest is direct.
fn audio_output(
    plan: Option<&AudioPlan>,
    mode: SessionKind,
    rung_audio_bps: Option<u32>,
) -> (&'static str, Option<String>, Option<u32>) {
    if mode == SessionKind::Directplay {
        return ("direct", None, None);
    }
    match plan {
        Some(AudioPlan::Copy {
            codec, bitrate_bps, ..
        }) => ("copy", Some(codec.clone()), *bitrate_bps),
        Some(AudioPlan::Transcode { codec, .. }) => (
            "transcode",
            serde_json::to_value(codec)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned)),
            rung_audio_bps,
        ),
        None => (
            if mode == SessionKind::Remux {
                "copy"
            } else {
                "direct"
            },
            None,
            None,
        ),
    }
}

struct FileRow {
    media_id: i32,
    episode_id: Option<i32>,
    relative_path: String,
    info: Option<MediaInfo>,
}

async fn file_rows(st: &AppState, ids: &[i32]) -> sqlx::Result<HashMap<i32, FileRow>> {
    let rows = sqlx::query!(
        r#"SELECT id, "mediaId" AS media_id, "episodeId" AS episode_id, "relativePath" AS relative_path,
                  "streamInfo" AS stream_info
           FROM media_files WHERE id = ANY($1)"#,
        ids
    )
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.id,
                FileRow {
                    media_id: r.media_id.unwrap_or(0),
                    episode_id: r.episode_id,
                    relative_path: r.relative_path,
                    info: r.stream_info.and_then(|v| serde_json::from_value(v).ok()),
                },
            )
        })
        .collect())
}

fn row_of(
    s: &Stream,
    host_hw: &str,
    file: Option<&FileRow>,
    qoe: Option<Value>,
    st: &AppState,
) -> ActiveStream {
    let live = &s.live;
    let info = file.and_then(|f| f.info.as_ref());
    let (v, au) = (
        info.and_then(|i| i.video.first()),
        info.and_then(|i| i.audio.first()),
    );
    let (mode, quality) = (s.mode(), s.quality());
    let rung = served_rung(
        mode,
        &quality,
        live.hdr_ladder,
        live.bitrate_by_quality.as_ref(),
    );
    let (audio_mode, audio_codec_out, audio_bps) = audio_output(
        live.audio_plan.as_ref(),
        mode,
        rung.map(|r| r.audio_bitrate_bps),
    );
    let (output_container, output_bitrate) = match mode {
        SessionKind::Transcode => (Some("HLS".to_owned()), rung.map(|r| r.video_bitrate_bps)),
        SessionKind::Remux => (
            Some("HLS".to_owned()),
            Some(
                v.and_then(|v| v.bit_rate).unwrap_or(0) + au.and_then(|a| a.bit_rate).unwrap_or(0),
            )
            .filter(|n| *n != 0),
        ),
        SessionKind::Directplay => (None, None),
    };
    let source_label = v.and_then(|v| {
        let (w, h) = (v.width.unwrap_or(0), v.height.unwrap_or(0));
        (w != 0 && h != 0).then(|| resolution_label(w, h).unwrap_or_else(|| format!("{w}x{h}")))
    });
    let engine = s
        .engine
        .as_ref()
        .filter(|_| mode != SessionKind::Directplay);
    let reasons = |prefix: &str| -> Vec<String> {
        engine.map_or_else(Vec::new, |e| {
            e.decision
                .response
                .transcode_reasons
                .iter()
                .filter(|r| r.flag.starts_with(prefix))
                .map(|r| r.message.clone())
                .collect()
        })
    };
    ActiveStream {
        session_id: live.session_id.clone(),
        user_id: live.user_id,
        username: live.username.clone(),
        media_id: file.map_or(0, |f| f.media_id),
        media_file_id: live.media_file_id,
        media_title: live.media_title.clone().unwrap_or_default(),
        media_type: live.media_type.clone().unwrap_or_default(),
        episode_id: file.and_then(|f| f.episode_id),
        episode_label: None,
        poster_url: live.poster_url.clone(),
        mode,
        hw_accel: s.hw_accel(host_hw),
        device: live.device_label.clone(),
        system_name: live.system_name.clone(),
        app_version: live.app_version.clone(),
        started_at: at(live.started_at),
        last_activity: at(s.last_activity_ms()),
        position_seconds: live.position,
        duration_seconds: info.and_then(|i| i.duration_seconds).unwrap_or(0.0),
        container: file
            .map(|f| {
                super::file::extname(&f.relative_path)
                    .trim_start_matches('.')
                    .to_owned()
            })
            .filter(|c| !c.is_empty()),
        video_codec: v.map(|v| v.codec.to_uppercase()),
        video_resolution: if mode == SessionKind::Transcode && quality != "original" {
            Some(quality.clone())
        } else {
            source_label
        },
        video_bitrate: v.and_then(|v| v.bit_rate),
        audio_codec: au.map(|a| a.codec.to_uppercase()),
        audio_channels: au.and_then(|a| {
            a.channel_layout
                .clone()
                .or_else(|| a.channels.filter(|c| *c != 0).map(|c| format!("{c}ch")))
        }),
        audio_language: au.map(|a| a.language.clone()),
        output_container,
        output_bitrate,
        audio_output_codec: audio_codec_out,
        audio_output_bitrate_bps: audio_bps,
        audio_mode,
        transcode_percent: engine
            .and_then(|e| e.job.as_ref())
            .map(|j| j.transcode_percent),
        client_tonemap: live.client_tonemap,
        video_reasons: reasons("Video"),
        audio_reasons: reasons("Audio"),
        container_reasons: reasons("Container"),
        qoe,
        engine_status: st.engine.status(),
        download: s.engine.as_ref().is_some_and(|e| e.pinned),
        job: s.engine.as_ref().and_then(|e| e.job.clone()),
        quality,
    }
}

async fn episode_labels(st: &AppState, ids: &[i32]) -> sqlx::Result<HashMap<i32, String>> {
    let rows = sqlx::query!(
        r#"SELECT e.id, e."episodeNumber" AS number, e.title, s."seasonNumber" AS "season?"
           FROM episodes e LEFT JOIN seasons s ON s.id = e."seasonId" WHERE e.id = ANY($1)"#,
        ids
    )
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let season = r.season.map_or("?".to_owned(), |s| s.to_string());
            let label = format!("S{season}:E{}", r.number);
            let label = match r.title.filter(|t| !t.is_empty()) {
                Some(t) => format!("{label} - {t}"),
                None => label,
            };
            (r.id, label)
        })
        .collect())
}

/// Live TV viewers, one row each; the engine knows them all except the source's name.
async fn live_tv_rows(st: &AppState, host_hw: &str) -> Vec<ActiveStream> {
    let Ok(snaps) = st.engine.list_live(None).await else {
        return vec![];
    };
    snaps
        .into_iter()
        .map(|s| {
            let tag = |k: &str| s.tags.get(k).filter(|v| !v.is_empty()).cloned();
            let mode = match s.mode {
                LiveMode::Direct => SessionKind::Directplay,
                LiveMode::Remux => SessionKind::Remux,
                LiveMode::Transcode => SessionKind::Transcode,
            };
            ActiveStream {
                qoe: live_summary(st, &s.session_id),
                session_id: s.session_id,
                user_id: s.owner_id.and_then(|o| o.parse().ok()),
                username: tag("username"),
                media_id: s.channel_id.parse().unwrap_or(0),
                media_file_id: 0,
                media_title: s.tags.get("channelName").cloned().unwrap_or_default(),
                media_type: "livetv".into(),
                episode_id: None,
                episode_label: None,
                poster_url: None,
                mode,
                quality: "Live".into(),
                hw_accel: host_hw.to_owned(),
                device: tag("device"),
                system_name: None,
                app_version: None,
                started_at: at(s.opened_at_ms),
                last_activity: at(s.last_seen_ms),
                position_seconds: 0.0,
                duration_seconds: 0.0,
                container: Some(s.container.clone()),
                video_codec: s.video_codec,
                video_resolution: None,
                video_bitrate: None,
                audio_codec: s.audio_codec,
                audio_channels: None,
                audio_language: None,
                output_container: Some(s.container),
                output_bitrate: None,
                audio_output_codec: None,
                audio_output_bitrate_bps: None,
                audio_mode: if mode == SessionKind::Transcode {
                    "transcode"
                } else {
                    "copy"
                },
                transcode_percent: None,
                client_tonemap: false,
                download: false,
                video_reasons: vec![],
                audio_reasons: vec![],
                container_reasons: vec![],
                engine_status: st.engine.status(),
                job: None,
            }
        })
        .collect()
}

#[utoipa::path(get, path = "/api/system/streams", responses((status = 200)))]
pub async fn streams(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<ActiveStream>>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let host_hw = st.stream.hardware.hw_accel();
    let live = presence::streams(&st).await;
    let mut ids: Vec<i32> = live.iter().map(|s| s.live.media_file_id as i32).collect();
    ids.sort_unstable();
    ids.dedup();
    let files = if ids.is_empty() {
        HashMap::new()
    } else {
        file_rows(&st, &ids).await?
    };
    let mut rows: Vec<ActiveStream> = live
        .iter()
        .map(|s| {
            let qoe = live_summary(&st, &s.live.session_id);
            row_of(
                s,
                &host_hw,
                files.get(&(s.live.media_file_id as i32)),
                qoe,
                &st,
            )
        })
        .collect();
    let mut eps: Vec<i32> = rows
        .iter()
        .filter_map(|r| r.episode_id)
        .filter(|e| *e != 0)
        .collect();
    eps.sort_unstable();
    eps.dedup();
    if !eps.is_empty() {
        let labels = episode_labels(&st, &eps).await?;
        for r in &mut rows {
            r.episode_label = r.episode_id.and_then(|e| labels.get(&e).cloned());
        }
    }
    rows.extend(live_tv_rows(&st, &host_hw).await);
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct Command {
    action: PlayerAction,
    #[serde(default)]
    message: Option<String>,
}

#[utoipa::path(post, path = "/api/system/streams/{sessionId}/command", responses((status = 201)))]
pub async fn command(
    State(st): State<AppState>,
    a: Authed,
    Path(sid): Path<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let live = st
        .presence
        .peek(&sid)
        .filter(|l| l.user_id.is_some())
        .ok_or_else(|| AppError::bad_request("Session not found"))?;
    let user = live.user_id.expect("filtered");
    let cmd: Command = from_value(body)?;
    let event = SseEvent::PlayerCommand {
        session_id: sid.clone(),
        media_file_id: i64::from(live.media_file_id),
        user_id: i64::from(user),
        action: cmd.action,
        message: cmd.message,
    };
    match live
        .sse_connection_id
        .as_deref()
        .filter(|c| st.hub.has_connection(c))
    {
        Some(c) => {
            st.hub.emit_to_connection(user, c, event);
        }
        // Clients without a bound connection: every tab of the user gets it and filters on the sid.
        None => st.hub.emit_to_user(user, event),
    }
    if cmd.action == PlayerAction::Stop {
        if let Some(stopped) = st.presence.stop(&sid) {
            st.qoe.end_session(&stopped.session_id).await;
        }
        if st.engine.runtime() {
            tokio::spawn(async move {
                if let Err(e) = st.engine.delete_session(&sid, None).await {
                    tracing::warn!("engine session {sid} not deleted: {e}");
                }
            });
        }
    }
    Ok((axum::http::StatusCode::CREATED, Json(json!({"ok": true}))))
}

#[utoipa::path(get, path = "/api/system/transcode-cache", responses((status = 200)))]
pub async fn stats(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    if !st.engine.runtime() {
        return Ok(Json(json!({"entries": 0, "bytes": 0})));
    }
    let c = st.engine.cache().await.map_err(engine_err)?;
    Ok(Json(
        json!({"entries": c.entries.len(), "bytes": c.used_bytes}),
    ))
}

/// Purges the engine's cache (live entries stay); the answer is computed from the read before.
async fn purge(st: &AppState, file: Option<u32>, owner: Option<String>) -> Result<Value, AppError> {
    if !st.engine.runtime() {
        return Ok(json!({"ok": true, "entries": 0, "bytes": 0}));
    }
    let cache = st.engine.cache().await.map_err(engine_err)?;
    let gone: Vec<_> = cache
        .entries
        .iter()
        .filter(|e| {
            !e.live
                && file.is_none_or(|f| e.media_file_id == f)
                && owner
                    .as_ref()
                    .is_none_or(|o| e.owner_id.as_ref() == Some(o))
        })
        .collect();
    st.engine
        .purge_cache(file, owner.as_deref())
        .await
        .map_err(engine_err)?;
    Ok(
        json!({"ok": true, "entries": gone.len(), "bytes": gone.iter().map(|e| e.bytes).sum::<f64>()}),
    )
}

#[utoipa::path(delete, path = "/api/system/transcode-cache", responses((status = 200)))]
pub async fn purge_all(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    Ok(Json(purge(&st, None, None).await?))
}

#[derive(Deserialize)]
pub struct OwnerQuery {
    #[serde(rename = "userId")]
    user_id: Option<String>,
}

#[utoipa::path(delete, path = "/api/system/transcode-cache/{mediaFileId}", responses((status = 200)))]
pub async fn purge_file(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i64>,
    Query(q): Query<OwnerQuery>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    // `parseInt`: a non-numeric `userId` is ignored and purges every owner of the file.
    let owner = q
        .user_id
        .as_deref()
        .and_then(super::info::parse_int)
        .map(|n| n.to_string());
    let Ok(file) = u32::try_from(id) else {
        return Ok(Json(json!({"ok": true, "entries": 0, "bytes": 0})));
    };
    Ok(Json(purge(&st, Some(file), owner).await?))
}

fn live_summary(st: &AppState, sid: &str) -> Option<Value> {
    st.qoe
        .live_summary(sid)
        .and_then(|s| serde_json::to_value(s).ok())
}
