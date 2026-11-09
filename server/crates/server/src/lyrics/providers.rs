//! Provider orchestration, negative cache, the fetch sweep and write-back (`docs/spec/music.md` rules 68-70).
use super::store::{self, New};
use crate::{
    metadata::{LyricsHit, LyricsQuery, MetadataProvider},
    settings::setting_value,
    state::AppState,
};
use fliks_domain::{
    lyrics::{self, Format, Parsed, Sync},
    metadata::limiter::Priority,
};
use std::{path::PathBuf, sync::Arc};
use tokio::io::AsyncWriteExt;

/// A miss or an instrumental answer is not asked again of the same provider for this long.
const MISS_DAYS: i32 = 30;

async fn flag(st: &AppState, key: &str, default: bool) -> bool {
    match setting_value(&st.db, key).await.ok().flatten().as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

async fn list(st: &AppState, key: &str) -> Vec<String> {
    setting_value(&st.db, key)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

/// The available lyrics providers in `lyrics.provider_order`, less those of `lyrics.disabled_providers`.
async fn providers(st: &AppState) -> Vec<Arc<dyn MetadataProvider>> {
    let off = list(st, "lyrics.disabled_providers").await;
    let mut all = st
        .metadata
        .lyrics_providers(&list(st, "lyrics.provider_order").await);
    all.retain(|p| !off.iter().any(|n| n == p.id().as_str()));
    all
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
pub async fn fetch(
    st: &AppState,
    item: i32,
    force: bool,
    priority: Priority,
) -> Result<(), String> {
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
    for p in providers(st).await {
        let ns = p.id().as_str().to_owned();
        if !force && lookup_fresh(st, item, &ns).await {
            continue;
        }
        let hit = match p.fetch_lyrics(&q, priority).await {
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
        if parsed.sync == Sync::None {
            fallback.get_or_insert((ns, hit, parsed));
            continue;
        }
        return stored(st, item, &ns, &hit, &parsed).await;
    }
    match fallback {
        Some((ns, hit, parsed)) => stored(st, item, &ns, &hit, &parsed).await,
        None => Ok(()),
    }
}

/// Keeps the hit and caches it as `found`; a hit that cannot be stored is cached as a `miss`, not retried at once.
async fn stored(
    st: &AppState,
    item: i32,
    ns: &str,
    hit: &LyricsHit,
    parsed: &Parsed,
) -> Result<(), String> {
    let r = keep(st, item, ns, hit, parsed).await;
    record(st, item, ns, if r.is_ok() { "found" } else { "miss" }).await;
    r
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
        .and_then(lyrics::lang_code)
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
    let Some(dir) = audio.parent() else { return };
    let order = super::discover::sidecar_order(st).await;
    let listing = super::discover::listing(dir).await;
    if super::discover::candidates(&audio, &listing, &order)
        .iter()
        .any(|(lang, _)| *lang == row.lang)
    {
        return;
    }
    // A language the discovery would not read back from a file name is not written.
    let infix = match row.lang.as_str() {
        "und" => String::new(),
        l => match lyrics::lang_infix(l) {
            Some(l) => format!(".{l}"),
            None => return,
        },
    };
    let Some(stem) = audio.file_stem() else {
        return;
    };
    let target = dir.join(format!("{}{infix}.{ext}", stem.to_string_lossy()));
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return,
        Err(e) => {
            tracing::warn!("lyrics not written to \"{}\": {e}", target.display());
            return;
        }
    };
    if let Err(e) = file.write_all(body.as_bytes()).await {
        tracing::warn!("lyrics not written to \"{}\": {e}", target.display());
    }
}

/// Rule 69: the tracks of `media` (every album when `None`) with a file, no synced main document and a provider
/// that has not answered within the negative cache, queued for the fetch worker.
pub async fn enqueue_missing(st: &AppState, media: Option<i32>) {
    if !flag(st, "lyrics.auto_fetch", true).await {
        return;
    }
    let ns: Vec<String> = providers(st)
        .await
        .iter()
        .map(|p| p.id().as_str().to_owned())
        .collect();
    if ns.is_empty() {
        return;
    }
    let items: Vec<i32> = sqlx::query_scalar(
        r#"SELECT i.id FROM items i JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
           WHERE ($1::int IS NULL OR i."mediaId" = $1)
             AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
             AND NOT EXISTS (SELECT 1 FROM lyrics l WHERE l."itemId" = i.id AND l.kind = 'main' AND l.sync <> 'none' AND l.source <> 'generated')
             AND EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE NOT EXISTS (
               SELECT 1 FROM lyrics_lookups k WHERE k."itemId" = i.id AND k.provider = p
                 AND k."checkedAt" > now() - make_interval(days => $3)))
           ORDER BY i.id"#,
    )
    .bind(media)
    .bind(&ns)
    .bind(MISS_DAYS)
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    super::queue::enqueue(st, items);
}
