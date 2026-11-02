//! The media services the request flows call: TMDB, the image store, `importFromTmdb`, the media delete and the notifications.
use super::{Art, ImportSpec, PortError, Removed, TitleFacts, TitleKey};
use crate::{
    http::AppError,
    images::paths::{Target, Variant},
    media::write::{all_library_ids, import_for_request, remove_media_with_dir, resolve_target_in},
    metadata::service::Details,
    notifications,
    state::AppState,
};
use fliks_domain::{
    external_id::ExternalProvider, media::kind::MediaKind, metadata::limiter::Priority,
};
use serde_json::{Map, Value};

fn port(e: AppError) -> PortError {
    PortError {
        status: e.status().as_u16(),
        message: e.text(),
    }
}

async fn tmdb_details(st: &AppState, media_type: MediaKind, tmdb_id: i32) -> Result<Value, String> {
    if !st.metadata.available(ExternalProvider::Tmdb) {
        return Err("TMDB API key is not configured".into());
    }
    let lang = st
        .metadata
        .lang
        .resolve(None)
        .await
        .map_err(|e| e.to_string())?;
    st.metadata
        .of(ExternalProvider::Tmdb)
        .fetch_work(
            media_type,
            &tmdb_id.to_string(),
            &lang,
            Priority::Interactive,
        )
        .await
        .map_err(|e| e.to_string())
}

/// TMDB details of a title; an error fails the auto-approval criteria that need them closed.
pub async fn title_facts(
    st: &AppState,
    media_type: MediaKind,
    tmdb_id: i32,
) -> Result<TitleFacts, String> {
    let d = tmdb_details(st, media_type, tmdb_id).await?;
    let n = |k: &str| {
        d.get(k)
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok())
    };
    Ok(TitleFacts {
        genre_ids: d
            .get("genreIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_i64)
                    .filter_map(|n| i32::try_from(n).ok())
                    .collect()
            })
            .unwrap_or_default(),
        year: n("year"),
        season_count: n("seasonCount"),
    })
}

/// Stores the art of a title (`request/<key>`) unless already stored; best effort.
pub async fn request_art(st: &AppState, key: &TitleKey) -> Result<Art, String> {
    let media_type = key.media_type;
    let slots = [
        (Variant::Poster, "posterUrl"),
        (Variant::Fanart, "fanartUrl"),
    ];
    let mut details: Option<Details> = None;
    let mut out = [None, None];
    for (i, (variant, field)) in slots.into_iter().enumerate() {
        let Some(t) = Target::request(media_type, key.provider, &key.external_id, variant) else {
            return Ok(Art::default());
        };
        if st.images.has_image(&t) {
            out[i] = Some(t.api_path());
            continue;
        }
        if details.is_none() {
            let tmdb_id = key
                .tmdb_id()
                .ok_or_else(|| format!("no metadata provider for {}", key.provider))?;
            details = Some(Details::from_value(
                &tmdb_details(st, media_type, tmdb_id).await?,
            ));
        }
        let d = details.as_ref().expect("read above");
        let url = if field == "posterUrl" {
            &d.poster_url
        } else {
            &d.fanart_url
        };
        if let Some(u) = url.as_deref().filter(|u| !u.is_empty()) {
            out[i] = st.images.download_and_store(u, &t).await;
        }
    }
    let [poster, fanart] = out;
    Ok(Art { poster, fanart })
}

/// `resolveImportTarget` over every library: 400 when the title has no library to land in.
pub async fn assert_import_target(
    st: &AppState,
    media_type: MediaKind,
    library_id: Option<i32>,
) -> Result<(), PortError> {
    let all = all_library_ids(&st.db).await.map_err(|e| port(e.into()))?;
    resolve_target_in(st, &all, media_type, library_id, None)
        .await
        .map(drop)
        .map_err(port)
}

/// `importFromTmdb` (it calls `Lifecycle::on_media_imported` itself); answers the media id.
pub async fn import_from_tmdb(
    st: &AppState,
    spec: ImportSpec,
    added_by: Option<i32>,
) -> Result<i32, PortError> {
    let seasons = spec.seasons.map(|s| {
        s.into_iter()
            .filter_map(|n| i32::try_from(n).ok())
            .collect()
    });
    let tmdb_id = spec.title.tmdb_id().ok_or_else(|| PortError {
        status: 400,
        message: format!("No metadata provider for {}", spec.title.provider),
    })?;
    import_for_request(
        st,
        spec.title.media_type,
        tmdb_id,
        (spec.quality_profile_id, spec.language_profile_id),
        (spec.library_id, spec.folder_id),
        added_by,
        seasons,
    )
    .await
    .map_err(port)
}

/// `MediaService.remove` (it calls `Lifecycle::on_media_removed` itself); the media lock stays held in
/// `Removed` until its folder is deleted.
pub async fn remove_media(st: &AppState, media_id: i32) -> Result<Removed, PortError> {
    let lock = st.ingest.media.lock(media_id).await;
    let (media, dirs) = remove_media_with_dir(st, &lock, media_id)
        .await
        .map_err(port)?;
    Ok(Removed {
        title: media.title,
        disk_paths: dirs,
        lock,
    })
}

/// `NotificationsService.dispatch`: fire and forget.
pub fn notify(st: &AppState, event: &'static str, payload: Map<String, Value>) {
    let db = st.db.clone();
    tokio::spawn(async move {
        if let Err(e) = notifications::dispatch(&db, event, &payload).await {
            tracing::warn!("notification {event}: {e}");
        }
    });
}
