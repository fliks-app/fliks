//! Lidarr: the connection test and root folders share the Radarr and Sonarr code (`Arr::Lidarr`); the import carries
//! the quality profiles, the monitored albums and the monitored artists over (`docs/spec/importers.md`).
use super::{arr::Arr, dto, fetch};
use crate::{
    http::{AppError, auth::Authed},
    media::{
        external_ids,
        write::{Creation, album_import::create_album_from, resolve_target_in},
    },
    metadata::music::target,
    outbound::{LIST_TIMEOUT, base_url},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use fliks_domain::{
    acl::{Action, Subject},
    arr_import::audio_quality_id,
    external_id::Namespace,
    media::{
        family::Family,
        kind::MediaKind,
        wants::{WantSpec, default_wants},
    },
    metadata::limiter::Priority,
    release::audio::quality::AUDIO_QUALITIES,
};
use serde_json::{Value, json};
use std::collections::HashMap;

type Res<T> = Result<T, AppError>;

async fn list(base: &str, key: &str, path: &str) -> Res<Vec<Value>> {
    let res = fetch(format!("{base}/api/v1/{path}"), key, LIST_TIMEOUT)
        .await
        .map_err(|e| AppError::bad_request(format!("Cannot connect to Lidarr: {e}")))?;
    if !res.status().is_success() {
        return Err(AppError::bad_request(format!(
            "Lidarr API returned {}",
            res.status().as_u16()
        )));
    }
    match res.json().await {
        Ok(Value::Array(a)) => Ok(a),
        _ => Err(AppError::bad_request(
            "Cannot connect to Lidarr: the answer is not a list",
        )),
    }
}

/// Every quality a Lidarr profile item allows, groups opened.
fn allowed(items: &[Value], out: &mut Vec<String>) {
    for i in items {
        if i["allowed"].as_bool() != Some(true) {
            continue;
        }
        match i["items"].as_array().filter(|g| !g.is_empty()) {
            Some(group) => allowed(group, out),
            None => out.extend(i["quality"]["name"].as_str().map(str::to_owned)),
        }
    }
}

/// The audio profile of a Lidarr quality profile, created under its name when none of that name exists.
async fn profile(st: &AppState, p: &Value, created: &mut Vec<String>) -> Res<Option<i32>> {
    let Some(name) = p["name"].as_str() else {
        return Ok(None);
    };
    if let Some(id) = sqlx::query_scalar(
        "SELECT id FROM quality_profiles WHERE name = $1 AND family = 'audio' ORDER BY id LIMIT 1",
    )
    .bind(name)
    .fetch_optional(&st.db)
    .await?
    {
        return Ok(Some(id));
    }
    let mut names = vec![];
    allowed(
        p["items"].as_array().map_or(&[][..], Vec::as_slice),
        &mut names,
    );
    let ids: Vec<u32> = names.iter().filter_map(|n| audio_quality_id(n)).collect();
    let Some(cutoff) = ids.iter().max().copied() else {
        return Ok(None);
    };
    let items: Vec<Value> = AUDIO_QUALITIES
        .iter()
        .filter(|q| q.source != "unknown")
        .map(|q| {
            json!({"quality": {"id": q.id, "name": q.name, "resolution": q.resolution, "source": q.source},
                   "allowed": ids.contains(&q.id)})
        })
        .collect();
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO quality_profiles (name, family, cutoff, items, "upgradeAllowed")
           VALUES ($1, 'audio', $2, $3, $4) RETURNING id"#,
    )
    .bind(name)
    .bind(cutoff as i32)
    .bind(Value::Array(items))
    .bind(p["upgradeAllowed"].as_bool().unwrap_or(false))
    .fetch_one(&st.db)
    .await?;
    created.push(name.to_owned());
    Ok(Some(id))
}

fn wants_of(profile: Option<i32>) -> Vec<WantSpec> {
    let mut w = default_wants(MediaKind::Album);
    for s in &mut w {
        s.quality_profile_id = profile.filter(|_| s.family == Family::Audio);
    }
    w
}

pub(super) async fn import(
    st: &AppState,
    a: Authed,
    body: Value,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Create, Subject::Settings)?;
    let b = dto::import_body(body)?;
    let arr = Arr::Lidarr;
    let key = super::resolve_key(
        st,
        b.api_key.clone(),
        &b.url,
        arr.key_setting(),
        arr.url_setting(),
    )
    .await?;
    let library = super::db::libraries(&st.db)
        .await?
        .into_iter()
        .find(|l| l.id == b.target_library_id)
        .ok_or_else(|| {
            AppError::bad_request(format!("Library #{} not found", b.target_library_id))
        })?;
    if !library.media_types.contains(&MediaKind::Album) {
        return Err(AppError::bad_request(format!(
            "Library \"{}\" does not accept album",
            library.name
        )));
    }
    let base = base_url(&b.url, true);
    let mut created = vec![];
    let mut profiles: HashMap<i64, i32> = HashMap::new();
    for p in list(&base, &key, "qualityprofile").await? {
        if let (Some(id), Some(local)) = (p["id"].as_i64(), profile(st, &p, &mut created).await?) {
            profiles.insert(id, local);
        }
    }
    let artists = list(&base, &key, "artist").await?;
    let albums = list(&base, &key, "album").await?;
    let wanted: Vec<(String, Option<i32>, bool)> = albums
        .iter()
        .filter_map(|al| {
            let id = Namespace::MUSICBRAINZ
                .core()?
                .normalize(al["foreignAlbumId"].as_str()?)?;
            let local = al["artist"]["qualityProfileId"]
                .as_i64()
                .and_then(|p| profiles.get(&p).copied());
            Some((id, local, al["monitored"].as_bool().unwrap_or(true)))
        })
        .collect();
    let followed: Vec<(String, Option<i32>)> = artists
        .iter()
        .filter(|ar| ar["monitored"].as_bool() == Some(true))
        .filter_map(|ar| {
            let id = Namespace::MUSICBRAINZ
                .core()?
                .normalize(ar["foreignArtistId"].as_str()?)?;
            let local = ar["qualityProfileId"]
                .as_i64()
                .and_then(|p| profiles.get(&p).copied());
            Some((id, local))
        })
        .collect();
    let queued = wanted.len();
    let target =
        resolve_target_in(st, &[library.id], MediaKind::Album, Some(library.id), None).await?;
    let (st2, user) = (st.clone(), a.user.id);
    // MusicBrainz answers one request a second: a library's worth of albums is read in the background.
    tokio::spawn(async move {
        for (id, local, monitored) in wanted {
            match external_ids::find(&st2.db, MediaKind::Album, Namespace::MUSICBRAINZ, &id).await {
                Ok(None) => {}
                Ok(Some(_)) => continue,
                Err(e) => {
                    tracing::warn!("Lidarr import: {e}");
                    continue;
                }
            }
            let specs = wants_of(local);
            let made = create_album_from(
                &st2,
                &Creation {
                    kind: MediaKind::Album,
                    id: (Namespace::MUSICBRAINZ, &id),
                    target: &target,
                    profiles: (None, None),
                    user: Some(user),
                    links: vec![],
                    seasons: None,
                    wants: Some(&specs),
                    prio: Priority::Background,
                },
            )
            .await;
            match made {
                Ok(media) if !monitored => {
                    if let Err(e) =
                        crate::media::write::set_media_monitored(&st2, &[media], false).await
                    {
                        tracing::warn!("Lidarr import: album #{media} stays monitored: {e}");
                    }
                }
                Ok(media) => {
                    if let Err(e) = target::ensure(&st2, media, Priority::Background).await {
                        tracing::warn!(
                            "Lidarr import: album #{media} has no target yet: {}",
                            e.text()
                        );
                    }
                }
                Err(e) => tracing::warn!("Lidarr import: album {id}: {}", e.text()),
            }
        }
        for (mbid, local) in followed {
            let specs = serde_json::to_value(wants_of(local)).unwrap_or_default();
            if let Err(e) = sqlx::query(
                r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants)
                   SELECT $1, x."personId", 'artist', $2, $3 FROM person_external_ids x
                    WHERE x.provider = 'musicbrainz' AND x.value = $4
                   ON CONFLICT DO NOTHING"#,
            )
            .bind(user)
            .bind(target.id)
            .bind(specs)
            .bind(&mbid)
            .execute(&st2.db)
            .await
            {
                tracing::warn!("Lidarr import: artist {mbid} not followed: {e}");
            }
        }
        tracing::info!("Lidarr API import done");
    });
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "imported": queued,
            "errors": [],
            "rootFoldersCreated": [],
            "qualityProfilesCreated": created,
            "subtitlesImported": 0,
        })),
    ))
}
