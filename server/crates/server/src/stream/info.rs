//! `POST /api/stream/:id/playback-info` (spec rules 1-24): gathers what the engine needs, opens the
//! session and adds the app-side extras to the engine's decision. The host decides nothing itself.
use super::{
    burn_in, db, edl,
    file::{ResolvedFile, resolve_file},
    hardware, preroll, scan,
};
use crate::{
    engine::{EngineError, enc},
    http::{
        AppError,
        auth::StreamAuthed,
        validate::{PathParams, ValidJson, from_value},
    },
    presence::{Facts, LiveSession, Tags, kind_of, now_ms, parse_source_fps, to_tags},
    qoe::SessionRef,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use fliks_domain::edl::shift_ranges;
use fliks_engine_core::{
    api::{
        ClientInfo, DecideMedia, DecideRequest, DecideSelection, DeviceProfile, JobPriority,
        OpenSessionRequest, OpenSessionResponse,
    },
    jsnum,
};
use serde_json::{Value, json};

/// The query of the request, as the controller parsed it (rule 1-3).
#[derive(Debug, Default, PartialEq)]
pub struct Params {
    pub token_param: String,
    pub burn_in_subtitle_id: Option<i64>,
    pub audio_stream_index: Option<String>,
    pub start_quality: Option<String>,
    pub start_at: Option<f64>,
    pub download: bool,
}

/// JS `parseInt(v, 10)`: the leading integer, `None` for NaN.
pub(super) fn parse_int(raw: &str) -> Option<i64> {
    let t = raw.trim_start();
    let (neg, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    let n: i64 = digits[..end]
        .parse()
        .ok()
        .or((end > 0).then_some(i64::MAX))?;
    Some(if neg { -n } else { n })
}

/// C1: a `startAt` that is not a finite number is a 400, not `NaN` on the wire.
pub(super) fn parse_query(pairs: &[(String, String)]) -> Result<Params, AppError> {
    let first = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let token_param: Vec<String> = ["token", "sid"]
        .into_iter()
        .filter_map(|k| {
            first(k)
                .filter(|v| !v.is_empty())
                .map(|v| format!("{k}={}", enc(v)))
        })
        .collect();
    let start_at = match first("startAt") {
        None => None,
        Some(raw) => Some(
            jsnum::parse_float(raw)
                .filter(|n| n.is_finite())
                .ok_or_else(|| {
                    AppError::bad_request(vec![
                        "startAt must be a number conforming to the specified constraints",
                    ])
                })?,
        ),
    };
    Ok(Params {
        token_param: if token_param.is_empty() {
            String::new()
        } else {
            format!("?{}", token_param.join("&"))
        },
        burn_in_subtitle_id: first("burnInSubtitleId")
            .filter(|v| !v.is_empty())
            .and_then(parse_int),
        audio_stream_index: first("audioStreamIndex").map(str::to_owned),
        start_quality: first("startQuality").map(str::to_owned),
        start_at,
        download: first("download") == Some("1"),
    })
}

/// The requested audio track if the file has it, else `None` (first track).
fn audio_index(raw: Option<&str>, count: usize) -> Option<i32> {
    let n = jsnum::number(raw?)?;
    (n.fract() == 0.0 && n >= 0.0 && n < count as f64).then_some(n as i32)
}

/// `DeviceProfileDto`'s string bounds; the rest is the type.
fn device_profile(body: Value) -> Result<DeviceProfile, AppError> {
    let d: DeviceProfile = from_value(body)?;
    let too_long = |v: &Option<String>, max: usize, name: &str| {
        v.as_ref()
            .is_some_and(|s| s.chars().count() > max)
            .then(|| format!("{name} must be shorter than or equal to {max} characters"))
    };
    let errors: Vec<String> = [
        too_long(&d.system_name, 60, "systemName"),
        too_long(&d.app_version, 40, "appVersion"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if errors.is_empty() {
        Ok(d)
    } else {
        Err(AppError::bad_request(errors))
    }
}

fn unavailable(msg: &str) -> AppError {
    AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, msg.to_owned())
}

/// Step 14: `EngineError` 400 is the client's; everything else is the engine being unavailable.
fn open_error(e: EngineError) -> AppError {
    match e {
        EngineError::Http { status: 400, .. } => AppError::bad_request(e.to_string()),
        EngineError::NotRunning => unavailable(&e.to_string()),
        e => {
            tracing::warn!("engine session not opened: {e}");
            unavailable("The streaming engine is unavailable")
        }
    }
}

#[utoipa::path(post, path = "/api/stream/{mediaFileId}/playback-info", responses((status = 201)))]
pub async fn playback_info(
    State(st): State<AppState>,
    StreamAuthed(a): StreamAuthed,
    PathParams(id): PathParams<i64>,
    Query(pairs): Query<Vec<(String, String)>>,
    headers: HeaderMap,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let device = device_profile(body)?;
    let q = parse_query(&pairs)?;
    let header = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let out = run(
        &st,
        &a,
        id,
        device,
        q,
        header("x-fliks-sse-connection"),
        header("user-agent"),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(out)))
}

#[allow(clippy::too_many_arguments)]
async fn run(
    st: &AppState,
    a: &crate::http::auth::Authed,
    id: i64,
    device: DeviceProfile,
    q: Params,
    sse_connection: Option<String>,
    user_agent: Option<String>,
) -> Result<Value, AppError> {
    if st.engine.gateway_mismatch() {
        return Err(unavailable(
            "The saved engine URL is not the one this process forwards video to",
        ));
    }
    if !st.engine.runtime() {
        return Err(unavailable(
            if st.engine.status() == crate::engine::Status::Down {
                "The streaming engine is unreachable"
            } else {
                "Playback needs the streaming engine, which is not running"
            },
        ));
    }
    let mut file = resolve_file(st, Some(a), id).await?;
    let burn_in = match q.burn_in_subtitle_id.filter(|n| *n != 0) {
        None => None,
        Some(sub) => match i32::try_from(sub) {
            Ok(sub) => burn_in::resolve(st, sub, &file)
                .await
                .map_err(|e| tracing::warn!("Burn-in resolve failed for subtitle #{sub}: {e:?}"))
                .ok(),
            Err(_) => None,
        },
    };
    let settings = crate::engine::load_streaming(&st.db).await?;
    hardware::apply(st, &settings, false);

    let mut info = file.info.take();
    let held = scan::lookup(st, file.id, &file.absolute, info.as_mut()).await;
    let position = match q.start_at {
        Some(p) => p,
        None => match file.media_id {
            Some(media) => db::resume_position(
                &st.db,
                a.user.id,
                media,
                file.episode_id.filter(|e| *e != 0),
            )
            .await?
            .unwrap_or(0.0),
            None => 0.0,
        },
    };
    file.info = info;
    let renditions = if device.supports_hls_subtitles == Some(true) {
        Some(burn_in::renditions(st, &file).await)
    } else {
        None
    };
    let target = st.hub.target_id_for(sse_connection.as_deref());
    let attributed = st
        .hub
        .take_attribution(target.as_deref(), i64::from(file.id));
    let tags = to_tags(&Tags {
        username: Some(a.user.username.clone()),
        media_title: file.media_title.clone(),
        media_type: file.media_type.clone(),
        poster_url: file.poster_url.clone(),
        fanart_url: file.fanart_url.clone(),
        sse_connection_id: sse_connection.clone(),
        attributed_user_id: attributed,
    });
    let client = ClientInfo {
        device_name: device.device_name.clone(),
        system_name: device.system_name.clone(),
        app_version: device.app_version.clone(),
        user_agent,
    };
    let audio_count = file.info.as_ref().map_or(0, |i| i.audio.len());
    let request = OpenSessionRequest {
        decide: DecideRequest {
            media: DecideMedia {
                media_file_id: file.id as u32,
                path: file.absolute.to_string_lossy().into_owned(),
                ext: file.ext.clone(),
                content_type: file.content_type.to_owned(),
            },
            info: file.info.clone().unwrap_or_default(),
            scan: held.scan,
            device,
            selection: DecideSelection {
                token_param: Some(q.token_param),
                burn_in_subtitle_id: burn_in
                    .as_ref()
                    .and(q.burn_in_subtitle_id)
                    .and_then(|n| u32::try_from(n).ok()),
                burn_in_is_text: Some(burn_in.as_ref().is_some_and(|b| b.is_text)),
                requested_quality: q.start_quality.clone(),
                audio_stream_index: audio_index(q.audio_stream_index.as_deref(), audio_count),
            },
        },
        owner_id: Some(a.user.id.to_string()),
        client: client.clone(),
        tags: tags.clone(),
        start_at_s: Some(position),
        pinned: q.download,
        burn_in: burn_in.map(|b| b.spec),
        source_version: held.version,
        subtitle_renditions: renditions,
    };
    let open = match st.engine.open_session(&request).await {
        Ok(o) => o,
        Err(e) => {
            if let (Some(t), Some(u)) = (&target, attributed) {
                st.hub.claim_attribution(t, u, i64::from(file.id));
            }
            return Err(open_error(e));
        }
    };
    let response = &open.decision.response;
    let live = st.presence.create(LiveSession::from_facts(
        &Facts {
            session_id: &open.session_id,
            user_id: Some(a.user.id),
            media_file_id: file.id as u32,
            profile_hash: open.profile_hash.as_deref(),
            quality: q.start_quality.as_deref(),
            kind: kind_of(response.play_method),
            decision: &open.decision,
            client: &client,
            tags: &tags,
            position_s: position,
        },
        now_ms(),
    ));
    let live_ref = SessionRef::from(&live);
    st.qoe.register(&live_ref);
    // The engine's report and the domain's are one JSON shape.
    if let Some(p) = open
        .qoe_pipeline
        .as_ref()
        .and_then(|p| serde_json::from_value(serde_json::to_value(p).ok()?).ok())
    {
        st.qoe.set_pipeline(&live_ref, p);
    }
    rescan_hint(st, &open, &file);
    let fps = file
        .info
        .as_ref()
        .and_then(|i| i.video.first())
        .and_then(|v| v.frame_rate.as_deref())
        .and_then(parse_source_fps);
    let (markers, pre_roll, edl, _) = tokio::join!(
        async {
            let episode = file.episode_id.filter(|e| *e != 0)?;
            db::markers(&st.db, episode)
                .await
                .map_err(|e| tracing::warn!("markers not read for episode #{episode}: {e}"))
                .ok()
                .flatten()
        },
        preroll::pre_roll(
            st,
            a,
            file.id,
            file.media_id,
            file.episode_id.filter(|e| *e != 0)
        ),
        async {
            if a.user.edl_enabled {
                edl::read(st, &file.absolute, fps).await
            } else {
                None
            }
        },
        async {
            if let (false, Some(media)) = (q.download, file.media_id)
                && let Err(e) = db::mark_started(
                    &st.db,
                    a.user.id,
                    media,
                    file.id,
                    file.episode_id.filter(|e| *e != 0),
                )
                .await
            {
                tracing::warn!("Failed to mark session started: {e}");
            }
        },
    );
    Ok(assemble(&open, &file, markers, pre_roll, edl))
}

/// The engine's hints: a stale probe is re-probed (which chains the scan), else a missing scan is made.
fn rescan_hint(st: &AppState, open: &OpenSessionResponse, file: &ResolvedFile) {
    if open.hints.probe_stale {
        scan::spawn_stale_reprobe(st.clone(), file.id, file.absolute.clone());
    } else if open.hints.scan_missing {
        let (st, path, info, id) = (
            st.clone(),
            file.absolute.clone(),
            file.info.clone(),
            file.id,
        );
        tokio::spawn(async move {
            scan::schedule_if_needed(&st, id, &path, info, JobPriority::High).await;
        });
    }
}

/// Step 15: the decision plus the app-side keys; absent ones are omitted, `tonemapAlgo` and `profileHash` never.
fn assemble(
    open: &OpenSessionResponse,
    file: &ResolvedFile,
    markers: Option<db::Markers>,
    pre_roll: Option<Vec<preroll::Item>>,
    edl: Option<Vec<fliks_domain::edl::EdlRange>>,
) -> Value {
    let Value::Object(mut out) = serde_json::to_value(&open.decision.response).expect("decision")
    else {
        unreachable!("PlaybackInfo is an object")
    };
    let mut put = |k: &str, v: Value| {
        out.insert(k.to_owned(), v);
    };
    put("playUrl", open.play_path.clone().into());
    if let Some(e) = edl.filter(|e| !e.is_empty()) {
        put(
            "edl",
            json!(shift_ranges(
                &e,
                open.playback_clock_offset_s.unwrap_or(0.0)
            )),
        );
    }
    put("tonemapAlgo", json!(open.tonemap_algo));
    if let Some(c) = open.tonemap_curve {
        put("tonemapCurve", json!(c));
    }
    put(
        "durationSeconds",
        json!(
            file.info
                .as_ref()
                .and_then(|i| i.duration_seconds)
                .unwrap_or(0.0)
        ),
    );
    if let Some(m) = markers {
        put("markers", json!(m));
    }
    if let Some(c) = file
        .info
        .as_ref()
        .and_then(|i| i.chapters.as_ref())
        .filter(|c| !c.is_empty())
    {
        put("chapters", json!(c));
    }
    if let Some(p) = pre_roll {
        put("preRoll", json!(p));
    }
    put("sessionId", open.session_id.clone().into());
    put("profileHash", json!(open.profile_hash));
    Value::Object(out)
}
