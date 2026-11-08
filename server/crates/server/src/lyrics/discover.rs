//! Sidecar and embedded lyrics of a file (`docs/spec/music.md` rule 64).
use super::store::{self, New};
use crate::{settings::setting_value, state::AppState};
use fliks_domain::lyrics::{Format, Parsed, parse};
use std::path::Path;

const MAX_BYTES: u64 = 1 << 20;
const DEFAULT_ORDER: [&str; 5] = ["ttml", "elrc", "lrc", "srt", "txt"];

/// What the probe tags carried.
#[derive(Default, Clone)]
pub struct Embedded {
    pub lyrics: Option<String>,
    pub synced: Option<String>,
}

pub async fn sidecar_order(st: &AppState) -> Vec<String> {
    let set: Option<Vec<String>> = setting_value(&st.db, "lyrics.sidecars")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok());
    set.filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ORDER.iter().map(|s| (*s).to_owned()).collect())
}

/// `<lang>` of `song.<lang>.lrc`: two or three letters, a region after `-` dropped.
fn lang_infix(s: &str) -> Option<String> {
    let base = s.split('-').next()?.to_lowercase();
    ((2..=3).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_lowercase())).then_some(base)
}

/// The sidecar texts of `audio`: for each language, the first extension of `order` that exists.
pub async fn sidecars(audio: &Path, order: &[String]) -> Vec<(String, String, Format, String)> {
    let (Some(dir), Some(stem)) = (audio.parent(), audio.file_stem()) else {
        return vec![];
    };
    let stem = stem.to_string_lossy().to_lowercase();
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return vec![];
    };
    // (lang, extension rank, file name)
    let mut found: Vec<(String, usize, String)> = vec![];
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        let Some(rest) = lower.strip_prefix(&stem).and_then(|r| r.strip_prefix('.')) else {
            continue;
        };
        let (lang, ext) = match rest.rsplit_once('.') {
            Some((l, ext)) => match lang_infix(l) {
                Some(l) => (l, ext),
                None => continue,
            },
            None => ("und".to_owned(), rest),
        };
        if let Some(rank) = order.iter().position(|o| o == ext) {
            found.push((lang, rank, name));
        }
    }
    found.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    found.dedup_by(|b, a| a.0 == b.0);
    let mut out = vec![];
    for (lang, _, name) in found {
        let path = dir.join(&name);
        let ok = tokio::fs::metadata(&path)
            .await
            .is_ok_and(|m| m.len() <= MAX_BYTES);
        let Some(ext) = name.rsplit_once('.').map(|(_, e)| e.to_owned()) else {
            continue;
        };
        let (true, Some(format)) = (ok, Format::parse(&ext)) else {
            continue;
        };
        if let Ok(bytes) = tokio::fs::read(&path).await {
            out.push((
                lang,
                name,
                format,
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
    }
    out
}

fn lang_of(p: &Parsed, given: &str) -> String {
    if given != "und" {
        return given.to_owned();
    }
    p.lang
        .as_deref()
        .and_then(lang_infix)
        .unwrap_or_else(|| "und".into())
}

/// Stores what the file holds and removes the sidecar and embedded rows it no longer holds.
pub async fn file(
    st: &AppState,
    item: i32,
    file: i32,
    audio: &Path,
    duration_ms: Option<i32>,
    emb: &Embedded,
) -> sqlx::Result<()> {
    let order = sidecar_order(st).await;
    let mut kept: Vec<(String, String)> = vec![];
    for (lang, name, format, text) in sidecars(audio, &order).await {
        let Ok(p) = parse(format, &text) else {
            tracing::debug!("lyrics sidecar \"{name}\" not read");
            continue;
        };
        let lang = lang_of(&p, &lang);
        store::upsert(
            &st.db,
            &New {
                item,
                file: Some(file),
                kind: "main",
                lang: &lang,
                source: "sidecar",
                source_ref: Some(&name),
                parsed: &p,
                raw: Some(&text),
                duration_ms,
                reviewed: false,
            },
        )
        .await?;
        kept.push((lang, "sidecar".into()));
    }
    let embedded = [(&emb.synced, Format::Lrc), (&emb.lyrics, Format::Plain)]
        .into_iter()
        .filter_map(|(t, f)| t.as_deref().map(|t| (t, f)))
        .filter(|(t, _)| t.len() as u64 <= MAX_BYTES)
        .find_map(|(t, f)| parse(f, t).ok().map(|p| (p, t)));
    if let Some((p, text)) = embedded {
        let lang = lang_of(&p, "und");
        store::upsert(
            &st.db,
            &New {
                item,
                file: Some(file),
                kind: "main",
                lang: &lang,
                source: "embedded",
                source_ref: None,
                parsed: &p,
                raw: Some(text),
                duration_ms,
                reviewed: false,
            },
        )
        .await?;
        kept.push((lang, "embedded".into()));
    }
    let (langs, sources): (Vec<String>, Vec<String>) = kept.into_iter().unzip();
    sqlx::query(
        r#"DELETE FROM lyrics WHERE "mediaFileId" = $1 AND source IN ('sidecar', 'embedded')
             AND (lang, source) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))"#,
    )
    .bind(file)
    .bind(&langs)
    .bind(&sources)
    .execute(&st.db)
    .await?;
    Ok(())
}

/// The lyrics of the files just laid out, read from `(file id, path, probe tags)`.
pub async fn after_layout(st: &AppState, files: &[(i32, std::path::PathBuf, Embedded)]) {
    for (id, path, emb) in files {
        let row: Option<(i32, Option<i32>)> = sqlx::query_as(
            r#"SELECT ip."itemId", td."durationMs" FROM item_parts ip
               LEFT JOIN track_details td ON td."itemId" = ip."itemId"
               WHERE ip."mediaFileId" = $1 ORDER BY ip.version LIMIT 1"#,
        )
        .bind(id)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten();
        let Some((item, duration)) = row else {
            continue;
        };
        if let Err(e) = file(st, item, *id, path, duration, emb).await {
            tracing::warn!("lyrics of file #{id} not stored: {e}");
        }
    }
}
