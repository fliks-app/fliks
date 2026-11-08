//! Provider orchestration, negative cache, auto-fetch and write-back (`docs/spec/music.md` rules 68-70).
use super::store::{self, New};
use crate::{
    metadata::{LyricsHit, LyricsQuery},
    settings::setting_value,
    state::AppState,
};
use fliks_domain::{
    lyrics::{self, Format, Parsed, Sync},
    metadata::limiter::Priority,
};
use std::path::PathBuf;

/// A miss or an instrumental answer is not asked again of the same provider for this long.
const MISS_DAYS: i32 = 30;

async fn flag(st: &AppState, key: &str, default: bool) -> bool {
    match setting_value(&st.db, key).await.ok().flatten().as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

async fn order(st: &AppState) -> Vec<String> {
    setting_value(&st.db, "lyrics.provider_order")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

#[derive(sqlx::FromRow)]
struct Facts {
    title: Option<String>,
    album: String,
    artist: Option<String>,
    duration: Option<i32>,
    recording: Option<String>,
    isrc: Option<String>,
}

async fn facts(st: &AppState, item: i32) -> sqlx::Result<Option<Facts>> {
    sqlx::query_as(
        r#"SELECT i.title, m.title AS album, td."durationMs" AS duration, td."recordingMbid"::text AS recording,
             td.isrc,
             COALESCE(
               (SELECT string_agg(p.name, ', ' ORDER BY c.position) FROM item_credits c
                  JOIN persons p ON p.id = c."personId" WHERE c."itemId" = i.id AND c.role = 'artist'),
               (SELECT string_agg(p.name, ', ' ORDER BY c.position) FROM media_credits c
                  JOIN persons p ON p.id = c."personId" WHERE c."mediaId" = m.id AND c.role = 'artist')) AS artist
           FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
             JOIN track_details td ON td."itemId" = i.id
           WHERE i.id = $1"#,
    )
    .bind(item)
    .fetch_optional(&st.db)
    .await
}

async fn lookup_fresh(st: &AppState, item: i32, provider: &str) -> bool {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM lyrics_lookups WHERE "itemId" = $1 AND provider = $2
             AND status <> 'found' AND "checkedAt" > now() - make_interval(days => $3))"#,
    )
    .bind(item)
    .bind(provider)
    .bind(MISS_DAYS)
    .fetch_one(&st.db)
    .await
    .unwrap_or(false)
}

async fn record(st: &AppState, item: i32, provider: &str, status: &str) {
    let _ = sqlx::query(
        r#"INSERT INTO lyrics_lookups ("itemId", provider, status) VALUES ($1, $2, $3)
           ON CONFLICT ("itemId", provider) DO UPDATE SET status = EXCLUDED.status, "checkedAt" = now()"#,
    )
    .bind(item)
    .bind(provider)
    .bind(status)
    .execute(&st.db)
    .await;
}

/// Asks the providers for one track until one gives a synced document (a plain one is kept as the fallback).
/// `force` ignores the negative cache and an existing synced document.
pub async fn fetch(st: &AppState, item: i32, force: bool) -> Result<(), String> {
    if !force
        && store::has_synced_main(&st.db, item)
            .await
            .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let Some(f) = facts(st, item).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let (Some(title), Some(artist)) = (f.title.clone(), f.artist.clone()) else {
        return Ok(());
    };
    let q = LyricsQuery {
        title,
        artist,
        album: Some(f.album).filter(|a| !a.is_empty()),
        duration_ms: f.duration.and_then(|d| u32::try_from(d).ok()),
        recording_id: f.recording,
        isrc: f.isrc,
        language: None,
    };
    let mut fallback: Option<(String, LyricsHit, Parsed)> = None;
    for p in st.metadata.lyrics_providers(&order(st).await) {
        let ns = p.id().as_str().to_owned();
        if !force && lookup_fresh(st, item, &ns).await {
            continue;
        }
        let hit = match p.fetch_lyrics(&q, Priority::Background).await {
            Ok(h) => h,
            Err(e) => {
                tracing::debug!("lyrics provider {ns}: {e}");
                continue;
            }
        };
        let Some(hit) = hit else {
            record(st, item, &ns, "miss").await;
            continue;
        };
        if hit.instrumental {
            record(st, item, &ns, "instrumental").await;
            return Ok(());
        }
        let parsed = Format::parse(&hit.format)
            .ok_or("unknown format")
            .and_then(|f| lyrics::parse(f, &hit.document).map_err(|_| "unreadable"));
        let Ok(parsed) = parsed else {
            tracing::warn!("lyrics provider {ns} answered a document that does not parse");
            continue;
        };
        record(st, item, &ns, "found").await;
        if parsed.sync == Sync::None {
            fallback.get_or_insert((ns, hit, parsed));
            continue;
        }
        return keep(st, item, &ns, &hit, &parsed).await;
    }
    match fallback {
        Some((ns, hit, parsed)) => keep(st, item, &ns, &hit, &parsed).await,
        None => Ok(()),
    }
}

async fn keep(
    st: &AppState,
    item: i32,
    ns: &str,
    hit: &LyricsHit,
    parsed: &Parsed,
) -> Result<(), String> {
    let source = format!("provider:{ns}");
    let lang = hit
        .lang
        .as_deref()
        .map(str::to_lowercase)
        .filter(|l| (1..=8).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphanumeric()))
        .or_else(|| parsed.lang.clone())
        .unwrap_or_else(|| "und".into());
    let file: Option<(i32, Option<i32>)> = sqlx::query_as(
        r#"SELECT ip."mediaFileId", td."durationMs" FROM item_parts ip
           JOIN track_details td ON td."itemId" = ip."itemId"
           WHERE ip."itemId" = $1 ORDER BY ip.version LIMIT 1"#,
    )
    .bind(item)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let id = store::upsert(
        &st.db,
        &New {
            item,
            file: file.map(|f| f.0),
            kind: "main",
            lang: &lang,
            source: &source,
            source_ref: hit.source_ref.as_deref(),
            parsed,
            raw: Some(&hit.document),
            duration_ms: file.and_then(|f| f.1),
            reviewed: false,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    write_back(st, id).await;
    Ok(())
}

/// Rule 70: the row next to its file when the setting asks for it, never over an existing sidecar.
pub async fn write_back(st: &AppState, id: i32) {
    if !flag(st, "lyrics.write_back", false).await {
        return;
    }
    let Ok(Some(row)) = store::get(&st.db, id).await else {
        return;
    };
    if row.kind != "main" || !(row.source == "user" || row.source.starts_with("provider:")) {
        return;
    }
    let path: Option<(String, String)> = sqlx::query_as(
        r#"SELECT lf.path, mf."relativePath" FROM lyrics l JOIN media_files mf ON mf.id = l."mediaFileId"
           JOIN library_folders lf ON lf.id = mf."folderId" WHERE l.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten();
    let Some((folder, rel)) = path else { return };
    let audio = PathBuf::from(folder).join(rel);
    let sync = Sync::parse(&row.sync).unwrap_or_default();
    let (ext, body) = match sync {
        Sync::Word => ("elrc", lyrics::to_lrc(&row.doc.0, row.offset_ms, true)),
        Sync::Line => ("lrc", lyrics::to_lrc(&row.doc.0, row.offset_ms, false)),
        Sync::None => (
            "txt",
            row.doc
                .0
                .lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    };
    let taken = super::discover::sidecars(&audio, &super::discover::sidecar_order(st).await).await;
    if taken.iter().any(|(lang, ..)| *lang == row.lang) {
        return;
    }
    let target = audio.with_extension(ext);
    if let Err(e) = tokio::fs::write(&target, body).await {
        tracing::warn!("lyrics not written to \"{}\": {e}", target.display());
    }
}

/// Rule 69: every track of the album with a file and no synced main document, one at a time.
pub async fn auto_fetch(st: &AppState, media: i32) {
    if !flag(st, "lyrics.auto_fetch", true).await {
        return;
    }
    let items: Vec<i32> = sqlx::query_scalar(
        r#"SELECT i.id FROM items i WHERE i."mediaId" = $1
             AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
             AND NOT EXISTS (SELECT 1 FROM lyrics l WHERE l."itemId" = i.id AND l.kind = 'main' AND l.sync <> 'none')
           ORDER BY i.id"#,
    )
    .bind(media)
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    for item in items {
        if let Err(e) = fetch(st, item, false).await {
            tracing::warn!("lyrics of track #{item} not fetched: {e}");
        }
    }
}
