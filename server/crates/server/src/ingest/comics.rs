//! Comic ingest (`docs/spec/comics.md`, ingest rules): files, the `image` edition, issues and parts of
//! a comic volume. One archive or PDF is one issue; a variant of a number is another version of it.
use super::{
    books::{Placed, Registered, Registration},
    library::file_name,
};
use crate::{comics::archive, media::items::lock_versions, state::AppState};
use fliks_domain::{
    comics::{
        info::{self, ComicInfo},
        name,
    },
    media::family::Family,
    metadata::field::Field,
};
use sqlx::{PgConnection, PgPool};
use std::path::Path;

const FORMATS: [&str; 4] = ["cbz", "cb7", "cbr", "pdf"];
/// The width of a stored cover.
const COVER_WIDTH: u32 = 1000;

/// The format of a comic file name: its extension when it is one of the four.
pub fn format_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    FORMATS.into_iter().find(|f| *f == ext)
}

pub fn is_comic_file(name: &str) -> bool {
    format_of(name).is_some()
}

/// Pages of an archive; `None` for a PDF (not paged by the server) or an archive that cannot be read.
async fn count_pages(abs: &Path, format: &str) -> Option<i32> {
    if format == "pdf" {
        return None;
    }
    let p = abs.to_path_buf();
    crate::comics::blocking_ingest(move || archive::page_count(&p))
        .await?
        .ok()
        .and_then(|n| i32::try_from(n).ok())
}

/// The `ComicInfo.xml` of an archive: one bounded read, ignored with a log when absent or unusable.
pub(crate) async fn read_info(abs: &Path, format: &str) -> Option<ComicInfo> {
    if format == "pdf" {
        return None;
    }
    let p = abs.to_path_buf();
    let read = crate::comics::blocking_ingest(move || archive::info(&p)).await?;
    let parsed = match read {
        Ok(Some(xml)) => info::parse(&xml),
        Ok(None) => return None,
        Err(e) => Err(format!("{e:?}")),
    };
    parsed
        .inspect_err(|e| tracing::warn!(file = %abs.display(), "ComicInfo.xml ignored: {e}"))
        .ok()
}

struct Row {
    file: i32,
    rel: String,
    format: &'static str,
    pages: Option<i32>,
    info: Option<ComicInfo>,
}

/// Inserts or updates the rows of `files`, then makes an issue of each (rules 17-20).
pub async fn register(st: &AppState, media: i32, files: &[Placed]) -> Result<Registration, String> {
    let mut rows = vec![];
    let mut conflicts = vec![];
    for f in files {
        let n = file_name(&f.abs);
        let Some(format) = format_of(&n) else {
            continue;
        };
        let meta = tokio::fs::metadata(&f.abs)
            .await
            .map_err(|e| format!("{n}: {e}"))?;
        let pages = count_pages(&f.abs, format).await;
        let info = read_info(&f.abs, format).await;
        let Some(file) = sqlx::query_scalar!(
            r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "mtimeMs")
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT ("folderId", "relativePath") DO UPDATE
               SET size = EXCLUDED.size, quality = EXCLUDED.quality, "mtimeMs" = EXCLUDED."mtimeMs"
               WHERE media_files."mediaId" = EXCLUDED."mediaId"
               RETURNING id"#,
            media,
            f.folder_id,
            f.rel,
            meta.len() as i64,
            format,
            super::rescan::mtime_ms(&meta)
        )
        .fetch_optional(&st.db)
        .await
        .map_err(|e| e.to_string())?
        else {
            conflicts.push(format!("{n}: file already linked to another media"));
            continue;
        };
        rows.push(Row {
            file,
            rel: f.rel.replace('\\', "/"),
            format,
            pages,
            info,
        });
    }
    if !rows.is_empty() {
        lay_out(&st.db, media, &rows)
            .await
            .map_err(|e| e.to_string())?;
        cover(st, media, files, &rows).await;
    }
    Ok(Registration {
        files: rows
            .into_iter()
            .map(|r| Registered {
                file_id: r.file,
                rel: r.rel,
                family: Family::Image,
                format: r.format.to_owned(),
            })
            .collect(),
        conflicts,
    })
}

/// The first page of the lowest issue becomes the poster of a volume that has none.
async fn cover(st: &AppState, media: i32, files: &[Placed], rows: &[Row]) {
    let has = sqlx::query_scalar!(
        r#"SELECT "posterUrl" IS NOT NULL AS "has!" FROM media WHERE id = $1"#,
        media
    )
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
    .unwrap_or(true);
    if has {
        return;
    }
    let mut paged: Vec<(f64, &Placed)> = rows
        .iter()
        .filter(|r| r.format != "pdf")
        .filter_map(|r| {
            let f = files.iter().find(|f| f.rel.replace('\\', "/") == r.rel)?;
            let n = name::parse_path(&file_name(&f.abs));
            Some((n.sort.and_then(|s| s.parse().ok()).unwrap_or(f64::MAX), f))
        })
        .collect();
    paged.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (_, f) in paged {
        let p = f.abs.clone();
        let jpeg = crate::comics::blocking_ingest(move || {
            let first = archive::page(&p, 0).ok()?;
            crate::comics::cover(&first, COVER_WIDTH)
        })
        .await
        .flatten();
        if let Some(b) = jpeg {
            super::books::store_cover(st, media, &b).await;
            return;
        }
    }
}

/// The volume's `image` edition, created when it has none.
async fn edition(c: &mut PgConnection, media: i32) -> sqlx::Result<i32> {
    if let Some(e) = sqlx::query_scalar!(
        r#"SELECT id FROM editions WHERE "mediaId" = $1 AND family = 'image' ORDER BY id LIMIT 1"#,
        media
    )
    .fetch_optional(&mut *c)
    .await?
    {
        return Ok(e);
    }
    sqlx::query_scalar!(
        r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'image') RETURNING id"#,
        media
    )
    .fetch_one(&mut *c)
    .await
}

/// One issue per `(kind, sort)`: a file of a number the volume has joins that issue as a version.
async fn lay_out(db: &PgPool, media: i32, rows: &[Row]) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    lock_versions(&mut tx, media).await?;
    sqlx::query(
        r#"INSERT INTO comic_details ("mediaId") VALUES ($1) ON CONFLICT ("mediaId") DO NOTHING"#,
    )
    .bind(media)
    .execute(&mut *tx)
    .await?;
    let edition = edition(&mut tx, media).await?;
    let locked = crate::media::field_sources::locked_fields(&mut *tx, media).await?;
    let free = |f: Field| !locked.contains(&f);
    for r in rows {
        let placed: bool = sqlx::query_scalar(
            r#"SELECT EXISTS (SELECT 1 FROM item_parts WHERE "mediaFileId" = $1)"#,
        )
        .bind(r.file)
        .fetch_one(&mut *tx)
        .await?;
        if placed {
            continue;
        }
        let n = name::parse_path(r.rel.rsplit('/').next().unwrap_or(&r.rel));
        let n = info::resolve(&n, r.info.as_ref());
        sqlx::query(
            r#"UPDATE comic_details SET publisher = COALESCE(publisher, $2),
                 "startYear" = COALESCE("startYear", $3), volume = COALESCE(volume, $4) WHERE "mediaId" = $1"#,
        )
        .bind(media)
        .bind(n.publisher.as_deref().filter(|_| free(Field::Publisher)))
        .bind(n.start_year.filter(|_| free(Field::Year)))
        .bind(n.volume_no.filter(|_| free(Field::Details)))
        .execute(&mut *tx)
        .await?;
        let item: Option<i32> = sqlx::query_scalar(
            r#"SELECT "itemId" FROM comic_issues WHERE "mediaId" = $1 AND kind = $2
               AND CASE WHEN $3::text IS NULL THEN label = $4 ELSE "sortNumber" = $3::text::numeric END
               ORDER BY "itemId" LIMIT 1"#,
        )
        .bind(media)
        .bind(n.kind)
        .bind(&n.sort)
        .bind(&n.label)
        .fetch_optional(&mut *tx)
        .await?;
        let item = match item {
            Some(i) => {
                sqlx::query(r#"UPDATE comic_issues SET "pageCount" = $2 WHERE "itemId" = $1"#)
                    .bind(i)
                    .bind(r.pages)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    r#"UPDATE items i SET
                         title = CASE WHEN 'title' = ANY(ci."lockedFields") THEN i.title ELSE COALESCE(i.title, $2) END,
                         overview = CASE WHEN 'overview' = ANY(ci."lockedFields") THEN i.overview ELSE COALESCE(i.overview, $3) END,
                         "airDate" = CASE WHEN 'releaseDate' = ANY(ci."lockedFields") THEN i."airDate"
                           ELSE COALESCE(i."airDate", $4::text::date) END
                       FROM comic_issues ci WHERE ci."itemId" = i.id AND i.id = $1"#,
                )
                .bind(i)
                .bind(&n.title)
                .bind(&n.summary)
                .bind(&n.release_date)
                .execute(&mut *tx)
                .await?;
                i
            }
            None => {
                let i: i32 = sqlx::query_scalar(
                    r#"INSERT INTO items ("mediaId", "editionId", monitored, title, overview, "airDate")
                       VALUES ($1, $2, true, $3, $4, $5::text::date) RETURNING id"#,
                )
                .bind(media)
                .bind(edition)
                .bind(&n.title)
                .bind(&n.summary)
                .bind(&n.release_date)
                .fetch_one(&mut *tx)
                .await?;
                sqlx::query(
                    r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label, "pageCount")
                       VALUES ($1, $2, $3, COALESCE($4::text::numeric,
                         (SELECT GREATEST(COALESCE(max("sortNumber"), 0), 99999) + 1 FROM comic_issues
                          WHERE "mediaId" = $2 AND kind = $3)), $5, $6)"#,
                )
                .bind(i)
                .bind(media)
                .bind(n.kind)
                .bind(&n.sort)
                .bind(&n.label)
                .bind(r.pages)
                .execute(&mut *tx)
                .await?;
                i
            }
        };
        sqlx::query(
            r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
               VALUES ($1, $2, $3, (SELECT COALESCE(max(version) + 1, 0) FROM item_parts WHERE "itemId" = $1), 0)"#,
        )
        .bind(item)
        .bind(r.file)
        .bind(media)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        r#"UPDATE editions SET format = (SELECT CASE WHEN count(DISTINCT f.quality) = 1 THEN min(f.quality) END
             FROM item_parts p JOIN media_files f ON f.id = p."mediaFileId"
             JOIN items i ON i.id = p."itemId" WHERE i."editionId" = $1) WHERE id = $1"#,
    )
    .bind(edition)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Reads the page count again of the files whose size or mtime changed; the number updated.
pub async fn refresh(
    st: &AppState,
    base: &Path,
    rows: &[&super::books::KnownFile],
) -> Result<i64, String> {
    let mut updated = 0;
    for r in rows {
        let abs = base.join(r.rel.replace('\\', "/"));
        let Ok(meta) = tokio::fs::metadata(&abs).await else {
            continue;
        };
        let mtime = super::rescan::mtime_ms(&meta);
        if r.size == meta.len() as i64 && mtime.is_some() && r.mtime_ms == mtime {
            continue;
        }
        sqlx::query!(
            r#"UPDATE media_files SET size = $2, "mtimeMs" = $3 WHERE id = $1"#,
            r.id,
            meta.len() as i64,
            mtime
        )
        .execute(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(format) = format_of(&file_name(&abs)) {
            let pages = count_pages(&abs, format).await;
            sqlx::query(
                r#"UPDATE comic_issues SET "pageCount" = $2
                   WHERE "itemId" IN (SELECT p."itemId" FROM item_parts p WHERE p."mediaFileId" = $1
                     AND p.version = (SELECT max(version) FROM item_parts WHERE "itemId" = p."itemId"))"#,
            )
            .bind(r.id)
            .bind(pages)
            .execute(&st.db)
            .await
            .map_err(|e| e.to_string())?;
        }
        updated += 1;
    }
    Ok(updated)
}

/// Whether `kind` registers its files in one batch through `register_files`.
pub fn registers(kind: fliks_domain::media::kind::MediaKind) -> bool {
    use fliks_domain::media::kind::MediaKind::{Book, Comic};
    matches!(kind, Book | Comic)
}

/// `books::register_language` for a book, `register` for a comic.
pub async fn register_files(
    st: &AppState,
    kind: fliks_domain::media::kind::MediaKind,
    media: i32,
    files: &[Placed],
    language: Option<&str>,
) -> Result<Registration, String> {
    match kind {
        fliks_domain::media::kind::MediaKind::Comic => register(st, media, files).await,
        _ => super::books::register_language(st, media, files, language).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_formats() {
        assert_eq!(format_of("A 1.CBR"), Some("cbr"));
        assert_eq!(format_of("a.cb7"), Some("cb7"));
        assert_eq!(format_of("a.epub"), None);
        assert_eq!(format_of("cbz"), None);
    }
}
