//! The media services behind `Ports`: TMDB, the image store, `importFromTmdb`, the media delete and the notifications.
use super::{Art, Fut, ImportSpec, PortError, Ports, Removed, TitleFacts};
use crate::{
    http::AppError,
    images::paths::{Target, Variant},
    ingest::fsx,
    media::write::{
        all_library_ids, import_for_request, media_dir_to_remove, remove_media, resolve_target_in,
    },
    metadata::{MediaKind, Provider, service::Details},
    notifications,
    state::AppState,
};
use serde_json::{Map, Value};

pub struct Services;

fn kind(media_type: &str) -> MediaKind {
    if media_type == "movie" {
        MediaKind::Movie
    } else {
        MediaKind::Series
    }
}

fn port(e: AppError) -> PortError {
    PortError {
        status: e.status().as_u16(),
        message: e.text(),
    }
}

async fn tmdb_details(st: &AppState, media_type: &str, tmdb_id: i32) -> Result<Value, String> {
    let lang = st
        .metadata
        .lang
        .resolve(None)
        .await
        .map_err(|e| e.to_string())?;
    st.metadata
        .details(Provider::Tmdb, kind(media_type), i64::from(tmdb_id), &lang)
        .await
        .map_err(|e| e.to_string())
}

impl Ports for Services {
    fn title_facts<'a>(
        &'a self,
        st: &'a AppState,
        media_type: &'a str,
        tmdb_id: i32,
    ) -> Fut<'a, Result<TitleFacts, String>> {
        Box::pin(async move {
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
        })
    }

    fn request_art<'a>(
        &'a self,
        st: &'a AppState,
        media_type: &'a str,
        tmdb_id: i32,
    ) -> Fut<'a, Result<Art, String>> {
        Box::pin(async move {
            let k = kind(media_type);
            let slots = [
                (Variant::Poster, "posterUrl"),
                (Variant::Fanart, "fanartUrl"),
            ];
            let mut details: Option<Details> = None;
            let mut out = [None, None];
            for (i, (variant, field)) in slots.into_iter().enumerate() {
                let t = Target::request(k, i64::from(tmdb_id), variant);
                if st.images.has_image(&t) {
                    out[i] = Some(t.api_path());
                    continue;
                }
                if details.is_none() {
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
        })
    }

    fn assert_import_target<'a>(
        &'a self,
        st: &'a AppState,
        media_type: &'a str,
        library_id: Option<i32>,
    ) -> Fut<'a, Result<(), PortError>> {
        Box::pin(async move {
            let all = all_library_ids(&st.db).await.map_err(|e| port(e.into()))?;
            resolve_target_in(st, &all, media_type, library_id)
                .await
                .map(drop)
                .map_err(port)
        })
    }

    fn import_from_tmdb<'a>(
        &'a self,
        st: &'a AppState,
        spec: ImportSpec,
        added_by: Option<i32>,
    ) -> Fut<'a, Result<i32, PortError>> {
        Box::pin(async move {
            let seasons = spec.seasons.map(|s| {
                s.into_iter()
                    .filter_map(|n| i32::try_from(n).ok())
                    .collect()
            });
            import_for_request(
                st,
                &spec.media_type,
                spec.tmdb_id,
                (spec.quality_profile_id, spec.language_profile_id),
                spec.library_id,
                added_by,
                seasons,
            )
            .await
            .map_err(port)
        })
    }

    fn remove_media<'a>(
        &'a self,
        st: &'a AppState,
        media_id: i32,
    ) -> Fut<'a, Result<Removed, PortError>> {
        Box::pin(async move {
            let guard = st.ingest.media.lock(media_id).await;
            let media = remove_media(st, &guard, media_id).await.map_err(port)?;
            let disk_path = match media_dir_to_remove(st, &media).await {
                Ok(dir) => dir.map(|d| d.to_string_lossy().into_owned()),
                Err(why) => {
                    tracing::warn!(
                        "Media #{} \"{}\": folder kept ({why})",
                        media.id,
                        media.title
                    );
                    None
                }
            };
            Ok(Removed {
                title: media.title,
                disk_path,
            })
        })
    }

    fn delete_media_folder<'a>(
        &'a self,
        _: &'a AppState,
        path: &'a str,
    ) -> Fut<'a, Result<(), String>> {
        Box::pin(async move {
            let dir = std::path::PathBuf::from(path);
            tokio::task::spawn_blocking(move || fsx::remove_media_dir(&dir))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())
        })
    }

    fn notify(&self, st: &AppState, event: &'static str, payload: Map<String, Value>) {
        let db = st.db.clone();
        tokio::spawn(async move {
            if let Err(e) = notifications::dispatch(&db, event, &payload).await {
                tracing::warn!("notification {event}: {e}");
            }
        });
    }
}
