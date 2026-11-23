//! `POST /api/media/import` for an album: a release of a music provider, or a group it picks a release in
//! (`docs/spec/music.md` rule 41).
use super::{
    body::Body,
    identified::{Creation, Row, TAKEN, announce, discard, insert_row, search_added},
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
        Asked, Create, Source, Written, aliases, classify, resolve,
        want::{self, Recording, Refused, Scope},
        write_album,
    },
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{
    external_id::Namespace,
    media::{
        kind::MediaKind,
        wants::{WantSpec, parse_wants_profiled},
    },
    metadata::{language::Resolved, limiter::Priority},
    naming,
};
use serde_json::Value;

const FIELDS: [&str; 7] = [
    "type",
    "provider",
    "externalId",
    "libraryId",
    "folderId",
    "wants",
    "monitoredRecordings",
];

/// The optional `wants` of the body: audio wants that each name a profile.
async fn body_wants(st: &AppState, b: &Body) -> Result<Option<Vec<WantSpec>>, AppError> {
    let Some(w) = b.0.get("wants").filter(|w| !w.is_null()) else {
        return Ok(None);
    };
    let specs =
        parse_wants_profiled(w, MediaKind::Album).map_err(|m| AppError::bad_request(vec![m]))?;
    wants::check_profiles(&st.db, &specs).await?;
    Ok(Some(specs))
}

/// The recordings that stay monitored, when the body names them.
fn body_recordings(b: &Body) -> Result<Option<Vec<String>>, AppError> {
    let bad =
        || AppError::bad_request(vec!["monitoredRecordings must be a list of ids".to_owned()]);
    match b.0.get("monitoredRecordings") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) if !a.is_empty() => a
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(bad),
        Some(_) => Err(bad()),
    }
}

pub(crate) async fn import_album(
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
    let (specs, recordings) = (body_wants(st, &b).await?, body_recordings(&b)?);
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
            wants: specs.as_deref(),
            prio: Priority::Interactive,
        },
    )
    .await?;
    if let Some(r) = recordings {
        let refs: Vec<Recording> = r.iter().map(|id| Recording::Mbid(id)).collect();
        if let Err(refused) = want::want_many(st, media, &refs, false).await {
            discard(st, media, MediaKind::Album).await;
            return Err(refused.app_error());
        }
    }
    search_added(st, media).await;
    let out = hydrate::detail(&st.db, media, paths_visible(&a.perms))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media))?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// The folder of a new album: the artist folder and the album folder of the naming settings, the artist's left
/// out when the album has none; a taken name takes the first characters of the release id, 409 when that
/// one is taken too.
async fn album_folder(
    st: &AppState,
    library: i32,
    album: &fliks_domain::music::provider::Album,
    release: &str,
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
    let (artist_dir, album_dir) = naming::album_folder_parts(&formats, &tokens);
    let invalid = || AppError::bad_request(format!("Invalid folder name for \"{}\"", album.title));
    let join = |album_dir: &str| {
        let path = naming::album_folder_path(&artist_dir, album_dir);
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
    let id: String = release.chars().take(8).collect();
    let suffixed = join(&format!("{album_dir} [{id}]"))?;
    if taken(suffixed.clone()).await?.is_some() {
        return Err(AppError::conflict(format!(
            "{TAKEN}: a folder of that name exists"
        )));
    }
    Ok(suffixed)
}

/// What creating an album answered: the new album, or the one of the library that already is that release.
pub(crate) enum Created {
    New(i32),
    Held(i32),
}

/// Creates the album from its release, an `externalId` being a release or a group (`create_from`); a library
/// that holds it already answers 409.
pub(crate) async fn create_album_from(st: &AppState, c: &Creation<'_>) -> Result<i32, AppError> {
    create_album(st, c, true).await
}

/// `create_album_or_held` where a held album is a 409. An album left unmonitored has its tracks unmonitored.
pub(crate) async fn create_album(
    st: &AppState,
    c: &Creation<'_>,
    monitored: bool,
) -> Result<i32, AppError> {
    match create_album_or_held(st, c, monitored).await? {
        Created::New(id) => Ok(id),
        Created::Held(_) => Err(AppError::conflict(TAKEN)),
    }
}

/// Reads the release `c.id` names in the library of `c.target`, then `create_from`.
pub(crate) async fn create_album_or_held(
    st: &AppState,
    c: &Creation<'_>,
    monitored: bool,
) -> Result<Created, AppError> {
    let (ns, id) = c.id;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let profile = crate::libraries::metadata_profile(&st.db, c.target.id).await?;
    let src = resolve(st, ns, id, &lang, &profile, c.prio).await?;
    create_from(st, c, &src, &lang, monitored).await
}

/// The album of `library` that already is the release `src` (its id, or an alias of a merged one), or a
/// release of the same group with the same recordings.
async fn held_release(st: &AppState, src: &Source, library: i32) -> Result<Option<i32>, AppError> {
    if let Some(held) = aliases::album_of(&st.db, src.release()).await? {
        let own: Option<Option<i32>> =
            sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
                .bind(held)
                .fetch_optional(&st.db)
                .await?;
        return match own.flatten() == Some(library) {
            true => Ok(Some(held)),
            false => Err(AppError::conflict(TAKEN)),
        };
    }
    let mut recordings: Vec<String> = src
        .edition
        .tracks
        .iter()
        .filter_map(|t| t.recording_id.clone())
        .collect();
    recordings.sort_unstable();
    recordings.dedup();
    if recordings.is_empty() {
        return Ok(None);
    }
    Ok(sqlx::query_scalar(
        r#"SELECT m.id FROM media m JOIN album_details ad ON ad."mediaId" = m.id
            WHERE m.type = 'album' AND m."libraryId" = $1 AND ad."releaseGroupMbid" = $2::uuid
              AND (SELECT COALESCE(array_agg(DISTINCT td."recordingMbid"::text ORDER BY td."recordingMbid"::text),
                                   '{}') FROM track_details td
                    WHERE td."mediaId" = m.id AND td."recordingMbid" IS NOT NULL) = $3
            ORDER BY m.id LIMIT 1"#,
    )
    .bind(library)
    .bind(&src.fetched.album.external_id)
    .bind(&recordings)
    .fetch_optional(&st.db)
    .await?)
}

/// Creates the album that is the release `src`, with its edition and tracks (monitored as the album is); a
/// failure after the row exists deletes it. The id asked, when it is neither the release nor its group, was
/// merged upstream: it becomes an alias.
pub(crate) async fn create_from(
    st: &AppState,
    c: &Creation<'_>,
    src: &Source,
    lang: &Resolved,
    monitored: bool,
) -> Result<Created, AppError> {
    let (ns, asked) = c.id;
    if let Some(held) = held_release(st, src, c.target.id).await? {
        return Ok(Created::Held(held));
    }
    let album = &src.fetched.album;
    let title = album.title.clone();
    let folder = album_folder(st, c.target.id, album, src.release()).await?;
    let row = Row {
        kind: MediaKind::Album,
        title: &title,
        year: album.year,
        folder: &folder,
        overview: None,
        provider: Some(ns),
        refreshed: false,
        monitored,
    };
    let canonical = src.release().to_owned();
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
    let create = if monitored {
        Create::AsAlbum
    } else {
        Create::Unmonitored
    };
    match write_album(st, media, ns, src, &canonical, lang, (create, c.prio)).await {
        Ok(Written::Done) => {}
        Ok(Written::Folded(into)) => return Ok(Created::Held(into)),
        Err(e) => {
            discard(st, media, MediaKind::Album).await;
            return Err(e);
        }
    }
    if asked != canonical
        && asked != album.external_id
        && let Err(e) = sqlx::query(
            r#"INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value) VALUES ($1, 'album', $2, $3)
               ON CONFLICT DO NOTHING"#,
        )
        .bind(media)
        .bind(ns.as_str())
        .bind(asked)
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
    Ok(Created::New(media))
}

/// The album of a request, and whether this call created it: the release in the request's library, or the
/// held album (403 outside `readable`) given the want. `scoped` creates it with every track unmonitored.
pub async fn import_album_for_request(
    st: &AppState,
    release: &str,
    wants: &[WantSpec],
    scoped: bool,
    (library, folder): (Option<i32>, Option<i32>),
    (added_by, readable): (Option<i32>, &[i32]),
) -> Result<(i32, bool), AppError> {
    let ns = Namespace::MUSICBRAINZ;
    let held = async || external_ids::find(&st.db, MediaKind::Album, ns, release).await;
    let add_to = async |id: i32| {
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
        Ok((id, false))
    };
    if let Some(id) = held().await? {
        return add_to(id).await;
    }
    let all = super::all_library_ids(&st.db).await?;
    let target = resolve_target_in(st, &all, MediaKind::Album, library, folder).await?;
    let created = create_album_or_held(
        st,
        &Creation {
            kind: MediaKind::Album,
            id: (ns, release),
            target: &target,
            profiles: (None, None),
            user: added_by.filter(|u| *u != 0),
            links: vec![],
            seasons: None,
            wants: Some(wants),
            prio: Priority::Interactive,
        },
        !scoped,
    )
    .await;
    match created {
        Ok(Created::New(id)) => Ok((id, true)),
        Ok(Created::Held(id)) => add_to(id).await,
        Err(e) if e.status() == StatusCode::CONFLICT => match held().await? {
            Some(id) => add_to(id).await,
            None => Err(e),
        },
        Err(e) => Err(e),
    }
}

const WANT_FIELDS: [&str; 6] = [
    "provider",
    "externalId",
    "albumExternalId",
    "libraryId",
    "folderId",
    "wants",
];

/// `POST /api/music/want-recording` (`docs/spec/music.md` rule 73): one track of a release wanted.
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
    let specs = body_wants(st, &b).await?;
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
    let readable = accessible_library_ids(&st.db, a).await?;
    let recording = Recording::Mbid(&recording);
    let looked: Vec<i32> = match library {
        Some(l) => Some(l)
            .filter(|l| readable.contains(l))
            .into_iter()
            .collect(),
        None => readable,
    };
    let scope = Scope {
        media: None,
        libraries: Some(&looked),
    };
    let (media, item) = match want::item_of(&st.db, scope, recording, false).await? {
        Some((media, item)) => {
            want::monitor(&st.db, media, &[item], false).await?;
            (media, item)
        }
        None => {
            let target = resolve_target(st, a, MediaKind::Album, library, folder).await?;
            let c = Creation {
                kind: MediaKind::Album,
                id: (ns, &group),
                target: &target,
                profiles: (None, None),
                user: Some(a.user.id).filter(|u| *u != 0),
                links: vec![],
                seasons: None,
                wants: specs.as_deref(),
                prio: Priority::Interactive,
            };
            want_new(st, &c, recording).await?
        }
    };
    search_added(st, media).await;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"mediaId": media, "itemId": item})),
    ))
}

/// Creates the album a recording is wanted on and wants it (rule 73): `c.id` is the release it names, or the
/// group whose releases that hold the recording are picked from. The tracks of a new album stay unmonitored but
/// the recording's; a refusal deletes the album this call made.
pub(crate) async fn want_new(
    st: &AppState,
    c: &Creation<'_>,
    recording: Recording<'_>,
) -> Result<(i32, i32), AppError> {
    let (ns, id) = c.id;
    let lang = crate::metadata::library_language(st, c.target.id).await?;
    let profile = crate::libraries::metadata_profile(&st.db, c.target.id).await?;
    let asked = classify(st, ns, id, &lang, c.prio).await?;
    let among = match &asked {
        Asked::Group(group) => Some(
            want::holders(st, group, recording, &lang, c.prio)
                .await
                .map_err(Refused::app_error)?,
        ),
        Asked::Release(_) => None,
    };
    let src = asked
        .pick(st, ns, &lang, &profile, among.as_deref(), c.prio)
        .await?;
    let (media, existed) = match create_from(st, c, &src, &lang, false).await? {
        Created::New(media) => (media, false),
        Created::Held(media) => (media, true),
    };
    match want::want(st, media, recording, existed).await {
        Ok(item) => Ok((media, item)),
        Err(refused) => {
            if !existed {
                discard(st, media, MediaKind::Album).await;
            }
            Err(refused.app_error())
        }
    }
}
