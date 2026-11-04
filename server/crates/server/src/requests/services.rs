//! The media services the request flows call: the metadata providers, the image store, `importFromTmdb`, the media delete and the notifications.
use super::{Art, ImportSpec, PortError, Removed, TitleFacts, TitleKey};
use crate::{
    http::{AppError, auth::load_users},
    images::paths::{Target, Variant},
    libraries::library_ids_of,
    media::write::{
        all_library_ids, import_book_for_request, import_in, remove_media_with_dir,
        resolve_target_in,
    },
    metadata::{books::ANCHOR, service::Details},
    notifications,
    state::AppState,
};
use fliks_domain::{
    acl::{Action, Permissions, Subject},
    media::kind::MediaKind,
    metadata::limiter::Priority,
};
use serde_json::{Map, Value};

fn port(e: AppError) -> PortError {
    PortError {
        status: e.status().as_u16(),
        message: e.text(),
    }
}

async fn details_of(st: &AppState, key: &TitleKey) -> Result<Value, String> {
    st.metadata
        .require(Some(key.provider.as_str()))
        .map_err(|e| e.text())?;
    let lang = st
        .metadata
        .lang
        .resolve(None)
        .await
        .map_err(|e| e.to_string())?;
    st.metadata
        .of(key.provider)
        .fetch_work(
            key.media_type,
            &key.external_id,
            &lang,
            Priority::Interactive,
        )
        .await
        .map_err(|e| e.to_string())
}

/// The provider's details of a title; an error fails the auto-approval criteria that need them closed.
/// `genreIds` is read when the provider serves them, else the genre criteria cannot match.
pub async fn title_facts(st: &AppState, key: &TitleKey) -> Result<TitleFacts, String> {
    let d = details_of(st, key).await?;
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
    if media_type == MediaKind::Book {
        return book_art(st, key).await;
    }
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
            details = Some(Details::from_value(&details_of(st, key).await?));
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

/// The cover of a book's work, as the poster; a book has no fanart.
async fn book_art(st: &AppState, key: &TitleKey) -> Result<Art, String> {
    let Some(t) = Target::request(
        key.media_type,
        key.provider,
        &key.external_id,
        Variant::Poster,
    ) else {
        return Ok(Art::default());
    };
    if st.images.has_image(&t) {
        return Ok(Art {
            poster: Some(t.api_path()),
            fanart: None,
        });
    }
    let lang = st
        .metadata
        .lang
        .resolve(None)
        .await
        .map_err(|e| e.to_string())?;
    let record = st
        .metadata
        .work(
            ANCHOR,
            key.media_type,
            &key.external_id,
            &lang,
            Priority::Interactive,
        )
        .await
        .map_err(|e| format!("{e:?}"))?;
    let url = record
        .get("posterUrl")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty());
    let poster = match url {
        Some(u) => st.images.download_and_store(u, &t).await,
        None => None,
    };
    Ok(Art {
        poster,
        fanart: None,
    })
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

/// The libraries a user reaches: the requester's, or the approver's when the request has no requester.
pub(super) async fn libraries_of(st: &AppState, user: i32) -> Result<Vec<i32>, sqlx::Error> {
    let Some((row, role)) = load_users(&st.db, Some(user), false).await?.pop() else {
        return Ok(vec![]);
    };
    let perms = Permissions::from(
        role.as_ref().map_or(&[][..], |r| &r.permissions),
        row.is_admin,
    );
    library_ids_of(&st.db, user, perms.can(Action::Manage, &Subject::All)).await
}

/// `importFromTmdb`, or the book import of a book request (it calls `Lifecycle::on_media_imported` itself
/// for a video title); answers the media id.
pub async fn import_title(
    st: &AppState,
    spec: ImportSpec,
    (added_by, approver): (Option<i32>, i32),
) -> Result<i32, PortError> {
    if spec.title.media_type == MediaKind::Book {
        let readable = libraries_of(st, added_by.filter(|u| *u != 0).unwrap_or(approver))
            .await
            .map_err(|e| port(e.into()))?;
        return import_book_for_request(
            st,
            &spec.title.external_id,
            spec.wants.as_deref().unwrap_or_default(),
            (spec.library_id, spec.folder_id),
            (added_by, &readable),
        )
        .await
        .map_err(port);
    }
    let seasons = spec.seasons.map(|s| {
        s.into_iter()
            .filter_map(|n| i32::try_from(n).ok())
            .collect()
    });
    import_in(
        st,
        spec.title.media_type,
        (spec.title.provider, &spec.title.external_id),
        (spec.quality_profile_id, spec.language_profile_id),
        (spec.library_id, spec.folder_id),
        added_by,
        (seasons, vec![]),
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
