//! `POST /api/media/import` for an album: a release group of a music provider (`docs/spec/music.md` rule 31).
use super::{
    body::Body,
    identified::{Creation, Row, TAKEN, announce, discard, insert_row},
    import::{resolve_target, resolve_target_in},
};
use crate::{
    http::{AppError, auth::Authed},
    libraries::{accessible_library_ids, paths_visible},
    media::{
        external_ids::{self, Link},
        hydrate, wants,
    },
    metadata::music::{
        Written, fetch, target,
        want::{self, Recording, Refused},
        write_album,
    },
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{
    external_id::Namespace,
    media::{kind::MediaKind, wants::WantSpec},
    metadata::limiter::Priority,
    naming,
};
use serde_json::Value;

const FIELDS: [&str; 5] = ["type", "provider", "externalId", "libraryId", "folderId"];

pub(super) async fn import_album(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &FIELDS)?;
    let name = b.required(b.str("provider")?, "provider", "must be a string")?;
    let external = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    let known = st.namespaces();
    let ns = known
        .parse(&name)
        .filter(|n| st.metadata.serves(*n, MediaKind::Album))
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "provider must be one of the following values: {name}"
            ))
        })?;
    let id = known
        .normalize(ns, &external)
        .ok_or_else(|| AppError::bad_request(vec![format!("externalId is not a {name} id")]))?;
    if external_ids::find(&st.db, MediaKind::Album, ns, &id)
        .await?
        .is_some()
    {
        return Err(AppError::conflict(TAKEN));
    }
    let target = resolve_target(st, a, MediaKind::Album, library, folder).await?;
    let media = create_album_from(
        st,
        &Creation {
            kind: MediaKind::Album,
            id: (ns, &id),
            target: &target,
            profiles: (None, None),
            user: Some(a.user.id).filter(|u| *u != 0),
            links: vec![],
            seasons: None,
            wants: None,
            prio: Priority::Interactive,
        },
    )
    .await?;
    let acl = accessible_library_ids(&st.db, a).await?;
    let out = hydrate::detail_for(&st.db, media, paths_visible(&a.perms), Some(&acl))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media))?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// A folder component: no dot or space at the ends.
fn component(s: &str) -> String {
    s.trim().trim_matches('.').trim().to_owned()
}

/// The folder of a new album: the artist folder and the album folder of the naming settings, the artist's left
/// out when the album has none; a taken name takes the first characters of the release group id, 409 when that
/// one is taken too.
async fn album_folder(
    st: &AppState,
    library: i32,
    album: &fliks_domain::music::provider::Album,
) -> Result<String, AppError> {
    let formats = crate::ingest::naming_formats(&st.db).await?;
    let artist = album.artists.first();
    let tokens = naming::AlbumNameTokens {
        artist_name: artist.map(|a| a.name.clone()),
        artist_sort_name: artist.and_then(|a| a.sort_name.clone()),
        album_title: album.title.clone(),
        release_year: album.year.map(i64::from),
        album_type: album.primary_type.map(str::to_owned),
        ..Default::default()
    };
    let artist_dir = component(&naming::apply_album_format(&formats.artist_folder, &tokens));
    let album_dir = component(&naming::apply_album_format(&formats.album_folder, &tokens));
    let invalid = || AppError::bad_request(format!("Invalid folder name for \"{}\"", album.title));
    let join = |album_dir: &str| {
        let path = if artist_dir.is_empty() {
            album_dir.to_owned()
        } else {
            format!("{artist_dir}/{album_dir}")
        };
        naming::validate_folder_path(&path)
            .map(str::to_owned)
            .map_err(|_| invalid())
    };
    let taken = |folder: String| async move {
        sqlx::query_scalar::<_, i32>(
            r#"SELECT id FROM media WHERE type = 'album' AND "libraryId" = $1 AND "folderName" = $2 LIMIT 1"#,
        )
        .bind(library)
        .bind(folder)
        .fetch_optional(&st.db)
        .await
    };
    let folder = join(&album_dir)?;
    if taken(folder.clone()).await?.is_none() {
        return Ok(folder);
    }
    let id: String = album.external_id.chars().take(8).collect();
    let suffixed = join(&format!("{album_dir} [{id}]"))?;
    if taken(suffixed.clone()).await?.is_some() {
        return Err(AppError::conflict(format!(
            "{TAKEN}: a folder of that name exists"
        )));
    }
    Ok(suffixed)
}

/// Creates the album from its release group; a failure after the row exists deletes it.
pub(crate) async fn create_album_from(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    create_album(st, c, true).await
}

/// An album left unmonitored picks no target edition: nothing wants its tracks.
pub(crate) async fn create_album(
    st: &AppState,
    c: &Creation<'_>,
    monitored: bool,
) -> Result<i32, AppError> {
    let (ns, id) = c.id;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let fetched = fetch(st, ns, id, &lang, c.prio).await?;
    let title = fetched.album.title.clone();
    let folder = album_folder(st, c.target.id, &fetched.album).await?;
    let row = Row {
        kind: MediaKind::Album,
        title: &title,
        year: fetched.album.year,
        folder: &folder,
        overview: None,
        provider: Some(ns),
        refreshed: false,
        monitored,
    };
    // The canonical id is what the album is linked to: a merged id the caller asked for becomes an alias.
    let canonical = fetched.album.external_id.clone();
    let (media, mut tx) = insert_row(st, &row, c.target, c.user, &c.links, c.wants).await?;
    if external_ids::link(
        &mut tx,
        &st.namespaces(),
        media,
        MediaKind::Album,
        ns,
        &canonical,
    )
    .await?
        != Link::Linked
    {
        return Err(AppError::conflict(TAKEN));
    }
    tx.commit().await?;
    match write_album(st, media, ns, &fetched, &canonical, &lang, c.prio).await {
        Ok(Written::Done) => {}
        Ok(Written::Folded(_)) => {}
        Err(e) => {
            discard(st, media, MediaKind::Album).await;
            return Err(e);
        }
    }
    if canonical != id
        && let Err(e) = sqlx::query(
            r#"INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value) VALUES ($1, 'album', $2, $3)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(media)
        .bind(ns.as_str())
        .bind(id)
        .execute(&st.db)
        .await
    {
        tracing::warn!("alias of album #{media} not kept: {e}");
    }
    announce(
        st,
        (media, MediaKind::Album, &title),
        c.target.id,
        (c.user, None),
    )
    .await?;
    if monitored && let Err(e) = target::ensure(st, media, c.prio).await {
        tracing::warn!("album #{media}: no target edition yet: {}", e.text());
    }
    Ok(media)
}

/// The album of a request: the release group in the request's library with its audio want, or the want
/// added to the album the library already holds (403 when that one sits in a library outside `readable`).
pub async fn import_album_for_request(
    st: &AppState,
    group: &str,
    wants: &[WantSpec],
    (library, folder): (Option<i32>, Option<i32>),
    (added_by, readable): (Option<i32>, &[i32]),
) -> Result<i32, AppError> {
    let ns = Namespace::MUSICBRAINZ;
    let held = async || external_ids::find(&st.db, MediaKind::Album, ns, group).await;
    if let Some(id) = held().await? {
        let own: Option<Option<i32>> =
            sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
                .bind(id)
                .fetch_optional(&st.db)
                .await?;
        if !own.flatten().is_some_and(|l| readable.contains(&l)) {
            return Err(AppError::forbidden(
                "You do not have access to the library holding this title",
            ));
        }
        let mut tx = st.db.begin().await?;
        wants::add(&mut tx, id, wants)
            .await
            .map_err(|e| wants::write_error(e, id))?;
        tx.commit().await?;
        return Ok(id);
    }
    let all = super::all_library_ids(&st.db).await?;
    let target = resolve_target_in(st, &all, MediaKind::Album, library, folder).await?;
    let created = create_album_from(
        st,
        &Creation {
            kind: MediaKind::Album,
            id: (ns, group),
            target: &target,
            profiles: (None, None),
            user: added_by.filter(|u| *u != 0),
            links: vec![],
            seasons: None,
            wants: Some(wants),
            prio: Priority::Interactive,
        },
    )
    .await;
    match created {
        Err(e) if e.status() == StatusCode::CONFLICT => held().await?.ok_or(e),
        r => r,
    }
}

const WANT_FIELDS: [&str; 5] = [
    "provider",
    "externalId",
    "albumExternalId",
    "libraryId",
    "folderId",
];

/// `POST /api/music/want-recording` (`docs/spec/music.md` rule 73): one track of a release group wanted.
pub(crate) async fn want_recording(
    st: &AppState,
    a: &Authed,
    v: Value,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let b = Body::new(v, &WANT_FIELDS)?;
    let name = b.required(b.str("provider")?, "provider", "must be a string")?;
    let recording = b.required(b.str("externalId")?, "externalId", "must be a string")?;
    let group = b.required(
        b.str("albumExternalId")?,
        "albumExternalId",
        "must be a string",
    )?;
    let (library, folder) = (b.id("libraryId")?.flatten(), b.id("folderId")?.flatten());
    let known = st.namespaces();
    let ns = known
        .parse(&name)
        .filter(|n| st.metadata.serves(*n, MediaKind::Album))
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "provider must be one of the following values: {name}"
            ))
        })?;
    let id = |field: &str, value: &str| {
        known
            .normalize(ns, value)
            .ok_or_else(|| AppError::bad_request(vec![format!("{field} is not a {name} id")]))
    };
    let (recording, group) = (
        id("externalId", &recording)?,
        id("albumExternalId", &group)?,
    );
    let acl = accessible_library_ids(&st.db, a).await?;
    let held = external_ids::find(&st.db, MediaKind::Album, ns, &group).await?;
    let (media, created) = match held {
        Some(media) => {
            let own: Option<Option<i32>> =
                sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
                    .bind(media)
                    .fetch_optional(&st.db)
                    .await?;
            if !own.flatten().is_some_and(|l| acl.contains(&l)) {
                return Err(AppError::conflict(TAKEN));
            }
            (media, false)
        }
        None => {
            let target = resolve_target(st, a, MediaKind::Album, library, folder).await?;
            let media = create_album_from(
                st,
                &Creation {
                    kind: MediaKind::Album,
                    id: (ns, &group),
                    target: &target,
                    profiles: (None, None),
                    user: Some(a.user.id).filter(|u| *u != 0),
                    links: vec![],
                    seasons: None,
                    wants: None,
                    prio: Priority::Interactive,
                },
            )
            .await?;
            (media, true)
        }
    };
    let item = want::want(st, media, Recording::Mbid(&recording), !created)
        .await
        .map_err(|e| match e {
            Refused::NoTrack => AppError::not_found("The album has no track of that recording"),
            Refused::Unavailable => AppError::with_message(
                StatusCode::SERVICE_UNAVAILABLE,
                "The album's releases are not available yet",
            ),
            Refused::Db(e) => e.into(),
        })?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"mediaId": media, "itemId": item})),
    ))
}
