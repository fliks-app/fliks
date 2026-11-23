//! Metadata imports (rules 10-17, 19-22): the provider reads happen first, the rows in one
//! transaction; images and credits follow detached.
use super::{
    fields,
    identified::{Creation, TAKEN, create_identified},
    refresh,
};
use crate::media::{
    details::{set_release_dates, set_tmdb_collection},
    external_ids::{self, Ids},
    field_sources::merge_field_sources,
    items::{self, NewWant},
};
use crate::{
    events::DomainEvent,
    http::{AppError, auth::Authed},
    images::paths::{Target as Art, Variant},
    ingest::load_media,
    libraries::accessible_library_ids,
    metadata::service::{self, Found, Lookup},
    state::AppState,
};
use fliks_domain::{
    external_id::{Namespace, Namespaces},
    media::{kind::MediaKind, release::ReleaseKind, wants::WantSpec},
    metadata::{field::Field, limiter::Priority},
    naming::{self, MovieFolder, SeriesFolder, validate_folder_name},
};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool};
use std::path::PathBuf;

pub struct Target {
    pub id: i32,
    pub folder_id: Option<i32>,
    pub default_quality: Option<i32>,
    pub default_language: Option<i32>,
}

/// Rule 14: the library (or the sole one accepting `type`) among the caller's libraries.
pub async fn resolve_target(
    st: &AppState,
    a: &Authed,
    media_type: MediaKind,
    library_id: Option<i32>,
    folder_id: Option<i32>,
) -> Result<Target, AppError> {
    let libs = accessible_library_ids(&st.db, a).await?;
    resolve_target_in(st, &libs, media_type, library_id, folder_id).await
}

/// `resolveImportTarget` among `libs` (every library for a request approval, which has no caller ACL).
pub async fn resolve_target_in(
    st: &AppState,
    libs: &[i32],
    media_type: MediaKind,
    library_id: Option<i32>,
    folder_id: Option<i32>,
) -> Result<Target, AppError> {
    let rows = sqlx::query!(
        r#"SELECT l.id, l.name, df.path AS "path?", l."mediaTypes" AS types,
                  l."defaultQualityProfileId" AS dq, l."defaultLanguageProfileId" AS dl
           FROM libraries l LEFT JOIN library_default_folders df ON df."libraryId" = l.id
           WHERE l.id = ANY($1) ORDER BY l.name ASC, l.id ASC"#,
        libs
    )
    .fetch_all(&st.db)
    .await?;
    let accepts = |t: &Value| {
        t.as_array().is_some_and(|a| {
            a.iter()
                .any(|v| v.as_str().and_then(MediaKind::parse) == Some(media_type))
        })
    };
    let lib = match library_id {
        Some(id) => match rows.iter().find(|r| r.id == id) {
            Some(r) => r,
            // Unknown and outside the caller's libraries answer alike (no existence oracle).
            None => return Err(AppError::not_found(format!("Library #{id} not found"))),
        },
        None => {
            let ok: Vec<_> = rows.iter().filter(|r| accepts(&r.types)).collect();
            match ok.as_slice() {
                [one] => *one,
                [] => {
                    return Err(AppError::bad_request(format!(
                        "No library accepts {media_type}"
                    )));
                }
                _ => {
                    return Err(AppError::bad_request(format!(
                        "Several libraries accept {media_type} \u{2014} pass libraryId to choose one"
                    )));
                }
            }
        }
    };
    if !accepts(&lib.types) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" does not accept {media_type}",
            lib.name
        )));
    }
    if lib.path.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" has no root path configured",
            lib.name
        )));
    }
    if let Some(f) = folder_id {
        crate::libraries::assert_folder_in_library(&st.db, lib.id, f).await?;
    }
    Ok(Target {
        id: lib.id,
        folder_id,
        default_quality: lib.dq,
        default_language: lib.dl,
    })
}

/// What an import persists besides the provider data.
pub struct Import {
    pub media_type: MediaKind,
    pub library_id: i32,
    pub folder_id: Option<i32>,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub added_by: Option<i32>,
    pub monitored_seasons: Option<Vec<i32>>,
    pub follow_new_seasons: Option<bool>,
    /// Ids linked to the new media before it is announced.
    pub links: Vec<(Namespace, String)>,
}

/// `importFromTmdb` / `importMedia` after validation (rules 11-17, 21-22), also the request
/// lifecycle's entry point (rule 25).
pub async fn import_title(
    st: &AppState,
    provider: Option<String>,
    external_id: String,
    imp: Import,
    prio: Priority,
) -> Result<i32, AppError> {
    let lookup = (
        st.metadata.require(&st.namespaces(), provider.as_deref())?,
        external_id.clone(),
    );
    let found = service::import(
        st,
        Lookup {
            media_type: imp.media_type,
            provider,
            external_id,
            library_id: imp.library_id,
        },
        prio,
    )
    .await?;
    let d = &found.details;
    let folder = folder_for(
        &st.db,
        imp.media_type,
        &FolderOf {
            title: &d.title,
            original_title: d.original_title.as_deref(),
            year: d.year.filter(|y| y.is_finite()).map(|y| y as i64),
            tmdb_id: d.tmdb_id.map(i64::from),
        },
    )
    .await?;
    let folder = validate_folder_name(&folder)
        .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{}\"", d.title)))?
        .to_owned();
    let mut tx = st.db.begin().await?;
    if let Some(f) = imp.folder_id {
        crate::libraries::assert_folder_in_library(&mut *tx, imp.library_id, f).await?;
    }
    let (id, free) = insert_media(&mut tx, &st.namespaces(), &imp, &found, &lookup, &folder)
        .await
        .map_err(|e| {
            if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") {
                AppError::conflict(TAKEN)
            } else {
                e.into()
            }
        })?;
    if !free {
        return Err(AppError::conflict(TAKEN));
    }
    let mut stills = vec![];
    if imp.media_type.has_seasons() {
        let scope = imp.monitored_seasons.clone().filter(|s| !s.is_empty());
        for sd in &found.seasons {
            let n = sd.season_number;
            let (sid, _) = crate::media::items::ensure_group(&mut tx, id, n).await?;
            if let Some(s) = &scope {
                sqlx::query!(
                    "UPDATE item_groups SET monitored = $2 WHERE id = $1 AND monitored IS DISTINCT FROM $2",
                    sid,
                    s.contains(&n)
                )
                .execute(&mut *tx)
                .await?;
            }
            stills.push((
                sid,
                refresh::apply_season(&mut tx, sid, sd).await?,
                sd.poster_url.clone(),
            ));
        }
    }
    let external_ids = external_ids::refs(&mut *tx, id).await?;
    tx.commit().await?;
    tracing::info!(
        "Imported \"{}\" (#{id}) into library #{}",
        d.title,
        imp.library_id
    );
    let (st2, details) = (st.clone(), found.details.clone());
    tokio::spawn(async move {
        refresh::download_media_images(&st2, id, &details, &[]).await;
        for (sid, stills, poster) in stills {
            refresh::download_season_images(&st2, sid, stills, poster).await;
        }
    });
    if let Some(m) = load_media(&st.db, id).await? {
        crate::requests::Lifecycle::of(st)
            .on_media_imported(m.lifecycle_ref(), imp.added_by)
            .await;
    }
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        external_ids,
        media_type: imp.media_type,
        library_id: Some(i64::from(imp.library_id)),
        added_by_user_id: imp.added_by.map(i64::from),
    });
    let (st2, details, provider) = (st.clone(), d.clone(), found.provider.0);
    tokio::spawn(async move {
        if let Err(e) =
            service::persist_credits(&st2, id, imp.media_type, provider, &details, &[]).await
        {
            tracing::warn!("cast/metadata persist of media #{id} failed: {e}");
        }
    });
    Ok(id)
}

/// The stored folder format, else the import's own default (not the naming service's, rule 13).
pub(super) async fn folder_format(
    db: &sqlx::PgPool,
    media_type: MediaKind,
) -> Result<String, sqlx::Error> {
    let key = naming::setting_key(
        if media_type == MediaKind::Comic {
            MediaKind::Book
        } else {
            media_type
        },
        naming::Scope::Folder,
    );
    let default = match media_type {
        MediaKind::Movie => "{Original Title} ({Release Year})",
        MediaKind::Series => "{Series Title}",
        MediaKind::Book | MediaKind::Comic | MediaKind::Album => "{Title}",
    };
    let stored = match key {
        Some(k) => crate::settings::text(db, k).await?,
        None => None,
    };
    Ok(stored.unwrap_or_else(|| default.to_owned()))
}

/// What a folder format reads from a title.
pub(crate) struct FolderOf<'a> {
    pub title: &'a str,
    pub original_title: Option<&'a str>,
    pub year: Option<i64>,
    pub tmdb_id: Option<i64>,
}

/// The folder name of a media of `kind` from `format`: the one derivation import, relink and
/// transfer share (an album's is `album_folder`).
pub(crate) fn folder_name(format: &str, kind: MediaKind, t: &FolderOf<'_>) -> String {
    let (title, original_title) = (t.title.to_owned(), t.original_title.map(str::to_owned));
    match kind {
        MediaKind::Movie => naming::apply_movie_folder_format(
            format,
            &MovieFolder {
                title,
                original_title,
                year: t.year,
                tmdb_id: t.tmdb_id,
            },
        ),
        MediaKind::Series => naming::apply_series_folder_format(
            format,
            &SeriesFolder {
                series_title: title,
                original_title,
                year: t.year,
                tmdb_id: t.tmdb_id,
            },
        ),
        MediaKind::Book | MediaKind::Comic | MediaKind::Album => naming::apply_book_format(
            format,
            &naming::BookNameTokens {
                title,
                year: t.year,
                ..Default::default()
            },
        ),
    }
}

/// The folder of an album from the artist and album folder formats; the artist's is left out when unknown.
pub(crate) fn album_folder(
    f: &naming::NamingFormats,
    artist: Option<&str>,
    title: &str,
    year: Option<i64>,
) -> String {
    let (artist_dir, album_dir) = naming::album_folder_parts(
        f,
        &naming::AlbumNameTokens {
            artist_name: artist.map(str::to_owned),
            album_title: title.to_owned(),
            release_year: year,
            ..Default::default()
        },
    );
    naming::album_folder_path(&artist_dir, &album_dir)
}

/// `folder_name` with the stored format, else the import default.
pub(crate) async fn folder_for(
    db: &sqlx::PgPool,
    kind: MediaKind,
    t: &FolderOf<'_>,
) -> Result<String, sqlx::Error> {
    Ok(folder_name(&folder_format(db, kind).await?, kind, t))
}

/// `mapTmdbStatusToMediaStatus`.
pub fn map_status(media_type: MediaKind, status: &str) -> &'static str {
    let s = status.to_lowercase();
    match media_type {
        MediaKind::Movie => match s.as_str() {
            "released" => "released",
            "planned" | "in production" | "post production" => "announced",
            "canceled" | "cancelled" => "ended",
            _ => "tba",
        },
        MediaKind::Series => match s.as_str() {
            "continuing" => "continuing",
            "ended" => "ended",
            "announced" => "announced",
            _ => "tba",
        },
        MediaKind::Book | MediaKind::Comic | MediaKind::Album => "released",
    }
}

fn day(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(10).collect())
}

/// `buildMediaFieldsFromTmdb` plus the import's own columns (rule 21).
async fn insert_media(
    tx: &mut PgConnection,
    known: &Namespaces,
    imp: &Import,
    found: &Found,
    (lookup, lookup_id): &(Namespace, String),
    folder: &str,
) -> Result<(i32, bool), sqlx::Error> {
    let d = &found.details;
    let scope = imp.monitored_seasons.as_ref().filter(|s| !s.is_empty());
    let latest = found.seasons.iter().map(|s| s.season_number).max();
    let follow = imp
        .follow_new_seasons
        .unwrap_or_else(|| scope.is_none_or(|s| latest.is_none_or(|l| s.contains(&l))));
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, "originalTitle", "alternativeTitles", year, type,
             overview, status, "posterUrl", "fanartUrl", "logoUrl", rating, genres, runtime,
             monitored, "monitorNewSeasons", "metadataRefreshedAt", "languageProfileId", "libraryId",
             "folderName", "addedById")
           VALUES ($1, $2, $3, $4, $5, $6, $7::text::media_status_enum, $8, $9,
             $10, $11, $12, $13,
             true, $18, now(), $14, $15, NULLIF($16, ''), $17)
           RETURNING id"#,
        d.title,
        d.original_title.clone().unwrap_or_else(|| d.title.clone()),
        json!(d.alternative_titles),
        d.year.filter(|y| y.is_finite()).map(|y| y as i32),
        imp.media_type.as_str(),
        d.overview,
        map_status(imp.media_type, &d.status),
        d.poster_url,
        d.fanart_url,
        d.logo_url,
        d.rating,
        json!(d.genres),
        d.runtime,
        imp.language_profile_id,
        imp.library_id,
        folder,
        imp.added_by.filter(|u| *u != 0),
        follow
    )
    .fetch_one(&mut *tx)
    .await?;
    set_release_dates(
        tx,
        id,
        &[
            (ReleaseKind::Release, day(&d.release_date)),
            (ReleaseKind::Cinema, day(&d.in_cinemas)),
            (ReleaseKind::Digital, day(&d.digital_release)),
            (ReleaseKind::Physical, day(&d.physical_release)),
        ],
        false,
    )
    .await?;
    set_tmdb_collection(tx, id, d.tmdb_collection()).await?;
    let want = NewWant {
        quality_profile_id: imp.quality_profile_id,
        folder_id: imp.folder_id,
    };
    items::create_shell(tx, id, imp.media_type, want).await?;
    let ids = Ids {
        tmdb: d.tmdb_id,
        tvdb: d.tvdb_id,
        imdb: d.imdb_id.clone(),
    };
    let free = ids.fill(tx, id, imp.media_type).await?.taken.is_empty();
    // A plugin's id is not one of the three of `Ids`: link the one the title was looked up by and
    // the one that served it, and pin the media to the plugin when it served the lookup.
    let (served, served_id) = &found.provider;
    for (ns, v) in [(lookup, lookup_id), (served, served_id)] {
        if ns.core().is_none() {
            external_ids::link(tx, known, id, imp.media_type, *ns, v).await?;
        }
    }
    for (ns, v) in imp.links.iter().filter(|(n, _)| n != lookup && n != served) {
        external_ids::link(tx, known, id, imp.media_type, *ns, v).await?;
    }
    if lookup.core().is_none() && served == lookup {
        sqlx::query(r#"UPDATE media SET "preferredProvider" = $2 WHERE id = $1"#)
            .bind(id)
            .bind(lookup.as_str())
            .execute(&mut *tx)
            .await?;
    }
    merge_field_sources(tx, id, &found.provenance).await?;
    Ok((id, free))
}

pub async fn all_library_ids(db: &sqlx::PgPool) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT id AS "id!" FROM libraries ORDER BY id"#)
        .fetch_all(db)
        .await
}

/// `importFromTmdb` for a request approval (rules 11, 25): no caller ACL, the requester is `addedBy`, for an id
/// of any namespace a provider serves.
pub async fn import_in(
    st: &AppState,
    media_type: MediaKind,
    (ns, value): (Namespace, &str),
    profiles: (Option<i32>, Option<i32>),
    (library_id, folder_id): (Option<i32>, Option<i32>),
    added_by: Option<i32>,
    (seasons, links): (Option<Vec<i32>>, Vec<(Namespace, String)>),
) -> Result<i32, AppError> {
    if matches!(ns, Namespace::TMDB | Namespace::TVDB) && !media_type.is_video() {
        return Err(AppError::bad_request("the provider describes video only"));
    }
    st.metadata.require(&st.namespaces(), Some(ns.as_str()))?;
    duplicate_ref(st, media_type, ns, value).await?;
    let all = all_library_ids(&st.db).await?;
    let target = resolve_target_in(st, &all, media_type, library_id, folder_id).await?;
    create_identified(
        st,
        &Creation {
            kind: media_type,
            id: (ns, value),
            target: &target,
            profiles,
            user: added_by,
            links,
            seasons,
            follow_new_seasons: None,
            wants: None,
            prio: Priority::Interactive,
        },
    )
    .await
}

/// The folder a book or comic created from a provider record gets, by the naming layout of its kind.
pub(super) async fn creation_folder(
    st: &AppState,
    kind: MediaKind,
    title: &str,
    year: Option<i64>,
) -> Result<String, AppError> {
    let name = folder_for(
        &st.db,
        kind,
        &FolderOf {
            title,
            original_title: None,
            year,
            tmdb_id: None,
        },
    )
    .await?;
    naming::validate_folder_path(&name)
        .map(str::to_owned)
        .map_err(|_| AppError::bad_request(format!("Invalid folder name for \"{title}\"")))
}

/// `createUnmatched` input (rule 19): a title found on disk with no provider id.
pub struct Unmatched {
    pub title: String,
    pub year: Option<i32>,
    pub media_type: MediaKind,
    pub library_id: i32,
    pub folder_id: Option<i32>,
    pub folder_name: String,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_default_quality: Option<i32>,
    pub library_default_language: Option<i32>,
    /// What the files say (`metadata-orchestrator.md` rule 39), merged once the shell exists.
    pub record: Option<Map<String, Value>>,
    /// The title or year was typed by the caller: it is locked.
    pub lock_title: bool,
    pub lock_year: bool,
    /// Book only: the wants, one per family when unset.
    pub wants: Option<Vec<WantSpec>>,
    pub artwork: Artwork,
}

#[derive(Default)]
pub struct Artwork {
    pub poster: Option<PathBuf>,
    pub fanart: Option<PathBuf>,
    pub logo: Option<PathBuf>,
}

/// `createUnmatched` (rules 19-20): `monitored = false`, no lifecycle hook (no `tmdbId`).
pub async fn create_unmatched(st: &AppState, u: Unmatched, added_by: i32) -> Result<i32, AppError> {
    let q = resolve_profile(
        &st.db,
        false,
        u.quality_profile_id,
        u.library_default_quality,
    )
    .await?;
    let l = resolve_profile(
        &st.db,
        true,
        u.language_profile_id,
        u.library_default_language,
    )
    .await?;
    let title = u.title;
    let mut tx = st.db.begin().await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media (title, "originalTitle", year, type, status, monitored, "monitorNewSeasons", "alternativeTitles",
             genres, "libraryId", "folderName", "languageProfileId", "addedById")
           VALUES ($1, $1, $2, $3, 'released', false, false, '[]', '[]', $4, $5, $6, $7)
           RETURNING id"#,
        title,
        u.year,
        u.media_type.as_str(),
        u.library_id,
        u.folder_name,
        l,
        Some(added_by).filter(|u| *u != 0)
    )
    .fetch_one(&mut *tx)
    .await?;
    // The shell's values come from the files, so a later file merge may replace them.
    let from_file: Vec<_> = [Field::Title, Field::OriginalTitle]
        .into_iter()
        .chain(u.year.map(|_| Field::Year))
        .map(|f| (f, Namespace::FILE))
        .collect();
    crate::media::field_sources::merge_field_sources(&mut tx, id, &from_file).await?;
    for (typed, field) in [(u.lock_title, Field::Title), (u.lock_year, Field::Year)] {
        if typed {
            crate::media::field_sources::lock(&mut *tx, id, field).await?;
        }
    }
    // A book's file record is merged by its settle, with the credits and the series.
    if let Some(mut record) = u.record.filter(|_| u.media_type != MediaKind::Book) {
        record.insert("title".into(), title.clone().into());
        match u.year {
            Some(y) => record.insert("year".into(), y.into()),
            None => record.remove("year"),
        };
        fields::merge_files(&mut tx, id, u.media_type, &[record]).await?;
    }
    if let Some(f) = u.folder_id {
        crate::libraries::assert_folder_in_library(&mut *tx, u.library_id, f).await?;
    }
    let want = NewWant {
        quality_profile_id: q,
        folder_id: u.folder_id,
    };
    items::create_shell(&mut tx, id, u.media_type, want).await?;
    if let Some(w) = &u.wants {
        crate::media::wants::replace(&mut tx, id, w)
            .await
            .map_err(|e| crate::media::wants::write_error(e, id))?;
    }
    tx.commit().await?;
    store_local_artwork(st, id, &u.artwork).await;
    st.hub.emit_domain(DomainEvent::MediaImported {
        media_id: i64::from(id),
        external_ids: vec![],
        media_type: u.media_type,
        library_id: Some(i64::from(u.library_id)),
        added_by_user_id: Some(i64::from(added_by)).filter(|u| *u != 0),
    });
    Ok(id)
}

/// Rule 20: copies found beside the files go to the data dir (never a library write).
async fn store_local_artwork(st: &AppState, id: i32, a: &Artwork) {
    let mut urls: [Option<String>; 3] = Default::default();
    for (i, (p, v)) in [
        (&a.poster, Variant::Poster),
        (&a.fanart, Variant::Fanart),
        (&a.logo, Variant::Logo),
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(p) = p {
            urls[i] = st.images.store_from_disk(p, &Art::media(id, v)).await;
            if urls[i].is_none() {
                tracing::warn!("local {v} of media #{id} not stored: \"{}\"", p.display());
            }
        }
    }
    if urls.iter().all(Option::is_none) {
        return;
    }
    let [p, f, l] = urls;
    if let Err(e) = sqlx::query!(
        r#"UPDATE media SET "posterUrl" = COALESCE($2, "posterUrl"), "fanartUrl" = COALESCE($3, "fanartUrl"),
             "logoUrl" = COALESCE($4, "logoUrl") WHERE id = $1"#,
        id,
        p,
        f,
        l
    )
    .execute(&st.db)
    .await
    {
        tracing::warn!("local artwork of media #{id}: {e}");
    }
}

/// Rule 15: a requested id must exist, else the library default when it still exists, else the lowest id.
pub async fn resolve_profile(
    db: &PgPool,
    language: bool,
    requested: Option<i32>,
    library_default: Option<i32>,
) -> Result<Option<i32>, AppError> {
    let exists = |id: i32| async move {
        if language {
            sqlx::query_scalar!("SELECT id FROM language_profiles WHERE id = $1", id)
                .fetch_optional(db)
                .await
        } else {
            sqlx::query_scalar!("SELECT id FROM quality_profiles WHERE id = $1", id)
                .fetch_optional(db)
                .await
        }
    };
    if let Some(id) = requested {
        let what = if language { "Language" } else { "Quality" };
        return exists(id)
            .await?
            .map(Some)
            .ok_or_else(|| AppError::bad_request(format!("{what} profile #{id} not found")));
    }
    if let Some(id) = library_default
        && let Some(id) = exists(id).await?
    {
        return Ok(Some(id));
    }
    Ok(if language {
        sqlx::query_scalar!("SELECT id FROM language_profiles ORDER BY id LIMIT 1")
            .fetch_optional(db)
            .await?
    } else {
        sqlx::query_scalar!("SELECT id FROM quality_profiles ORDER BY id LIMIT 1")
            .fetch_optional(db)
            .await?
    })
}

/// 409 when exactly one library title holds the id.
pub(crate) async fn duplicate_ref(
    st: &AppState,
    media_type: MediaKind,
    ns: Namespace,
    value: &str,
) -> Result<(), AppError> {
    let held = match media_type {
        MediaKind::Book => super::book_import::held_book(&st.db, ns, value).await?,
        _ => external_ids::holder(&st.db, media_type, ns, value).await?,
    };
    match held {
        Some(_) => Err(AppError::conflict(TAKEN)),
        None => Ok(()),
    }
}
