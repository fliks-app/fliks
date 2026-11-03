//! `library.ingest` (`plugins.md` rule 32): every path under a granted root, then the S5 ingest.
use super::imports::host_err;
use super::runtime::{HostError, fliks::plugin::types as t};
use super::units;
use crate::ingest::{books, library, transfer::Method};
use crate::state::AppState;
use fliks_domain::language::parse_language_code;
use fliks_domain::media::{family::Family, kind::MediaKind};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// `realpath` of `raw`, which must sit under the `realpath` of one of `roots`.
pub fn contained(raw: &str, roots: &[String]) -> Result<PathBuf, HostError> {
    let real = dunce::canonicalize(raw).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            host_err(
                "ERR_NOT_FOUND",
                format!("library.ingest: \"{raw}\" does not exist"),
            )
        } else {
            host_err("ERR", format!("library.ingest: \"{raw}\": {e}"))
        }
    })?;
    let inside = roots
        .iter()
        .filter_map(|r| dunce::canonicalize(r).ok())
        .any(|root| real.starts_with(&root));
    if inside {
        Ok(real)
    } else {
        Err(host_err(
            "ERR_DENIED",
            format!("library.ingest: \"{raw}\" is outside every configured ingest root"),
        ))
    }
}

/// The guest's `/data/...` is the plugin's own data dir, an implicit ingest root: only plain
/// components, no symlink as the file, and the real path must stay inside the real dir.
fn in_data_dir(raw: &str, data: &Path) -> Option<Result<PathBuf, HostError>> {
    let rest = raw.strip_prefix("/data/")?;
    let denied = || {
        host_err(
            "ERR_DENIED",
            format!("library.ingest: \"{raw}\" is outside the plugin data dir"),
        )
    };
    if !Path::new(rest)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Some(Err(denied()));
    }
    let file = data.join(rest);
    let checked = match std::fs::symlink_metadata(&file) {
        Ok(m) if m.is_symlink() => return Some(Err(denied())),
        Ok(_) => dunce::canonicalize(&file).and_then(|f| Ok((f, dunce::canonicalize(data)?))),
        Err(e) => Err(e),
    };
    Some(match checked {
        Ok((file, root)) if file.starts_with(&root) => Ok(file),
        Ok(_) => Err(denied()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(host_err(
            "ERR_NOT_FOUND",
            format!("library.ingest: \"{raw}\" does not exist"),
        )),
        Err(e) => Err(host_err("ERR", format!("library.ingest: \"{raw}\": {e}"))),
    })
}

fn resolved(raw: &str, roots: &[String], data: &Path) -> Result<PathBuf, HostError> {
    contained(raw, roots).or_else(|e| in_data_dir(raw, data).unwrap_or(Err(e)))
}

pub async fn run(
    st: &AppState,
    id: &str,
    data: &Path,
    r: t::IngestRequest,
) -> Result<t::IngestResult, HostError> {
    let family = super::served(r.family)?;
    if family == Family::Video && r.language.is_some() {
        return Err(host_err(
            "ERR_VALIDATION",
            "library.ingest: a video ingest has no language",
        ));
    }
    let language = r.language.as_deref().and_then(parse_language_code);
    if r.language.is_some() && language.is_none() {
        return Err(host_err(
            "ERR_VALIDATION",
            "library.ingest: language is not a language code",
        ));
    }
    let roots: Vec<String> = sqlx::query_scalar(
        r#"SELECT "ingestRoots" FROM plugin_registrations WHERE "pluginId" = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| host_err("ERR", e.to_string()))?
    .unwrap_or_default();
    if roots.is_empty() && (r.paths.is_empty() || r.paths.iter().any(|p| !p.starts_with("/data/")))
    {
        return Err(host_err(
            "ERR_DENIED",
            format!("library.ingest: no ingestRoots configured for plugin \"{id}\""),
        ));
    }
    let files = r
        .paths
        .iter()
        .map(|p| {
            resolved(p, &roots, data).map(|path| library::File {
                path,
                episode_id: None,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let media_id = r.media_id as i32;
    let not_found = || host_err("ERR_NOT_FOUND", format!("Media #{media_id} not found"));
    let kind: Option<String> = sqlx::query_scalar("SELECT type FROM media WHERE id = $1")
        .bind(media_id)
        .fetch_optional(&st.db)
        .await
        .map_err(db_err)?;
    let kind = kind
        .as_deref()
        .and_then(MediaKind::parse)
        .ok_or_else(not_found)?;
    if !kind.families().contains(&family) {
        return Err(host_err(
            "ERR_VALIDATION",
            format!("library.ingest: a {kind} is not wished in family \"{family}\""),
        ));
    }
    let video_edition = if family == Family::Video {
        match crate::media::items::video_edition(&st.db, media_id).await {
            Ok(edition) => Some(edition),
            Err(sqlx::Error::RowNotFound) => return Err(not_found()),
            Err(e) => return Err(db_err(e)),
        }
    } else {
        if let Some(f) = files.iter().find(|f| {
            books::classify(&library::file_name(&f.path)).is_none_or(|(of, _)| of != family)
        }) {
            return Err(host_err(
                "ERR_VALIDATION",
                format!(
                    "library.ingest: \"{}\" is not a {family} book file",
                    library::file_name(&f.path)
                ),
            ));
        }
        None
    };
    let guard = st.ingest.media.lock(media_id).await;
    let out = library::ingest(
        st,
        &guard,
        library::Request {
            media_id,
            files,
            transfer: match r.transfer {
                t::TransferMode::Copy => Method::Copy,
                t::TransferMode::Move => Method::Move,
            },
            fallback_quality: r.fallback_quality.clone(),
            release_name: Some(r.source_label.clone()),
            force: false,
            uniquify_on_collision: false,
            replace_existing: true,
            language: language.clone(),
        },
    )
    .await
    .map_err(|e| host_err("ERR", e))?;
    if out.imported.is_empty() && !out.errors.is_empty() {
        return Err(host_err("ERR", out.errors.join("; ")));
    }
    drop(guard);
    let mut items = placed(st, &out.imported).await?;
    if let Some(first) = out.imported.first() {
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM media WHERE id = $1")
            .bind(media_id)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
        if let Some(title) = title {
            let payload =
                json!({"title": title, "quality": first.quality, "sourceTitle": r.source_label});
            let notify = st.clone();
            tokio::spawn(async move {
                crate::subtitles::events::notify(&notify, "download.complete", payload).await
            });
            crate::media_servers::dispatch_detached(st, "download.complete");
        }
    }
    let single =
        (out.imported.len() == 1 && out.imported[0].episode_id.is_some()).then(|| &out.imported[0]);
    Ok(t::IngestResult {
        imported: out
            .imported
            .iter()
            .map(|i| {
                let (edition, item_ids) = match (items.remove(&i.file_id), video_edition) {
                    (Some(p), _) => p,
                    (None, Some(edition)) => (edition, vec![]),
                    (None, None) => {
                        return Err(host_err(
                            "ERR",
                            format!("library.ingest: \"{}\" has no item", i.relative_path),
                        ));
                    }
                };
                Ok(t::ImportedFile {
                    media_file_id: i.file_id as u32,
                    relative_path: i.relative_path.clone(),
                    quality: i.quality.clone(),
                    edition_id: video_edition.unwrap_or(edition) as u32,
                    item_ids,
                })
            })
            .collect::<Result<_, HostError>>()?,
        already_present: out.already_present.clone(),
        unit: single.and_then(|i| units::unit_ref(i.season_number, i.episode_number)),
    })
}

fn db_err(e: sqlx::Error) -> HostError {
    host_err("ERR", e.to_string())
}

/// Per imported file, the edition and the items its parts play.
async fn placed(
    st: &AppState,
    imported: &[library::Imported],
) -> Result<HashMap<i32, (i32, Vec<u32>)>, HostError> {
    let files: Vec<i32> = imported.iter().map(|i| i.file_id).collect();
    let rows: Vec<(i32, i32, i32)> = sqlx::query_as(
        r#"SELECT p."mediaFileId", i."editionId", i.id FROM item_parts p JOIN items i ON i.id = p."itemId"
            WHERE p."mediaFileId" = ANY($1) ORDER BY p."mediaFileId", i.id"#,
    )
    .bind(&files)
    .fetch_all(&st.db)
    .await
    .map_err(db_err)?;
    let mut items: HashMap<i32, (i32, Vec<u32>)> = HashMap::new();
    for (file, edition, item) in rows {
        items
            .entry(file)
            .or_insert((edition, vec![]))
            .1
            .push(item as u32);
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;
    use std::path::Path;

    struct Shelf {
        st: AppState,
        dl: PathBuf,
        data: PathBuf,
    }

    /// A book (1) wished in text and audio, a plugin `p` allowed to ingest from `dl`.
    async fn shelf(db: PgPool) -> Shelf {
        crate::db::migrate(&db).await.unwrap();
        let dir = std::env::temp_dir().join(format!(
            "fliks-plugin-books-{}",
            crate::config::random_hex(6)
        ));
        let (books, dl, data) = (dir.join("books"), dir.join("dl"), dir.join("data"));
        for d in [&books, &dl, &data] {
            std::fs::create_dir_all(d).unwrap();
        }
        sqlx::query(
            r#"WITH l AS (INSERT INTO libraries (name, "mediaTypes") VALUES ('B', '["book"]') RETURNING id),
                    f AS (INSERT INTO library_folders ("libraryId", path) SELECT id, $1 FROM l)
               INSERT INTO media (id, title, type, "libraryId", "folderName") SELECT 1, 'Mirelune', 'book', id, 'Mirelune' FROM l"#,
        )
        .bind(books.to_string_lossy().as_ref())
        .execute(&db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        crate::media::items::create_shell(&mut c, 1, MediaKind::Book, Default::default())
            .await
            .unwrap();
        drop(c);
        sqlx::query(r#"INSERT INTO plugin_registrations ("pluginId", "ingestRoots", scopes, manifest) VALUES ('p', $1, '{}', '{}')"#)
            .bind(vec![dl.to_string_lossy().into_owned()])
            .execute(&db)
            .await
            .unwrap();
        let st = AppState::new(
            db,
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        Shelf { st, dl, data }
    }

    fn request(
        s: &Shelf,
        family: t::Family,
        language: Option<&str>,
        file: &str,
    ) -> t::IngestRequest {
        let path = s.dl.join(file);
        std::fs::write(&path, b"book").unwrap();
        t::IngestRequest {
            idempotency_key: "k".into(),
            media_id: 1,
            family,
            language: language.map(str::to_owned),
            paths: vec![path.to_string_lossy().into_owned()],
            transfer: t::TransferMode::Copy,
            fallback_quality: None,
            source_label: "Mirelune.EPUB-GRP".into(),
        }
    }

    #[sqlx::test(migrations = false)]
    async fn an_ebook_is_ingested_into_its_edition_and_satisfies_its_want(db: PgPool) {
        let s = shelf(db).await;
        let r = run(
            &s.st,
            "p",
            &s.data,
            request(&s, t::Family::Text, Some("fr"), "dl.epub"),
        )
        .await
        .unwrap();
        let [file] = &r.imported[..] else {
            panic!("one file: {r:?}")
        };
        assert_eq!(file.quality, "epub");
        assert_eq!(file.item_ids.len(), 1);
        assert!(r.unit.is_none() && r.already_present.is_empty());
        let (family, language): (String, Option<String>) =
            sqlx::query_as("SELECT family, language FROM editions WHERE id = $1")
                .bind(file.edition_id as i32)
                .fetch_one(&s.st.db)
                .await
                .unwrap();
        assert_eq!((family.as_str(), language.as_deref()), ("text", Some("fr")));
        let wants = crate::media::wants::list(&s.st.db, 1).await.unwrap();
        let state: Vec<_> = wants
            .iter()
            .map(|w| (w.family.as_str(), w.satisfied))
            .collect();
        assert_eq!(state, [("audio", false), ("text", true)]);
        let again = run(
            &s.st,
            "p",
            &s.data,
            request(&s, t::Family::Text, Some("fr"), "dl.epub"),
        )
        .await
        .unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(
            again.already_present.len(),
            1,
            "a retry lands in alreadyPresent"
        );
    }

    async fn editions(s: &Shelf, family: &str) -> Vec<(Option<String>, i64)> {
        sqlx::query_as(
            r#"SELECT e.language, count(p."mediaFileId") FROM editions e LEFT JOIN items i ON i."editionId" = e.id
               LEFT JOIN item_parts p ON p."itemId" = i.id WHERE e.family = $1 GROUP BY e.id ORDER BY e.id"#,
        )
        .bind(family)
        .fetch_all(&s.st.db)
        .await
        .unwrap()
    }

    async fn satisfied(s: &Shelf) -> Vec<(String, Option<String>, bool)> {
        let wants = crate::media::wants::list(&s.st.db, 1).await.unwrap();
        wants
            .into_iter()
            .map(|w| (w.family, w.language, w.satisfied))
            .collect()
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_language_of_a_family_lands_in_its_own_edition(db: PgPool) {
        let s = shelf(db).await;
        run(
            &s.st,
            "p",
            &s.data,
            request(&s, t::Family::Text, None, "dl.epub"),
        )
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO wants ("mediaId", family, language) VALUES (1, 'text', 'fr')"#)
            .execute(&s.st.db)
            .await
            .unwrap();
        let text = |l: Option<&str>, sat| ("text".to_owned(), l.map(str::to_owned), sat);
        assert_eq!(
            satisfied(&s).await[1..],
            [text(None, true), text(Some("fr"), false)]
        );
        let fr = run(
            &s.st,
            "p",
            &s.data,
            request(&s, t::Family::Text, Some("fr"), "dl.epub"),
        )
        .await
        .unwrap();
        let [file] = &fr.imported[..] else {
            panic!("one file: {fr:?}")
        };
        assert_eq!(
            editions(&s, "text").await,
            [(None, 1), (Some("fr".into()), 1)],
            "the first edition is untouched"
        );
        let held: Option<String> =
            sqlx::query_scalar("SELECT language FROM editions WHERE id = $1")
                .bind(file.edition_id as i32)
                .fetch_one(&s.st.db)
                .await
                .unwrap();
        assert_eq!(held.as_deref(), Some("fr"));
        assert_eq!(
            satisfied(&s).await[1..],
            [text(None, true), text(Some("fr"), true)]
        );
        let again = run(
            &s.st,
            "p",
            &s.data,
            request(&s, t::Family::Text, Some("fr"), "dl.epub"),
        )
        .await
        .unwrap();
        assert!(again.imported.is_empty() && again.already_present.len() == 1);
        let files: i64 = sqlx::query_scalar("SELECT count(*) FROM media_files")
            .fetch_one(&s.st.db)
            .await
            .unwrap();
        assert_eq!(
            files, 2,
            "a retry imports nothing, the other language kept its file"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_ingest_refuses_what_is_not_its_family_or_media(db: PgPool) {
        let s = shelf(db).await;
        let code = |r: Result<t::IngestResult, HostError>| r.unwrap_err().code;
        let epub = request(&s, t::Family::Audio, None, "a.epub");
        assert_eq!(code(run(&s.st, "p", &s.data, epub).await), "ERR_VALIDATION");
        let epub = request(&s, t::Family::Video, None, "b.epub");
        assert_eq!(code(run(&s.st, "p", &s.data, epub).await), "ERR_VALIDATION");
        let language = request(&s, t::Family::Video, Some("fr"), "c.epub");
        assert_eq!(
            code(run(&s.st, "p", &s.data, language).await),
            "ERR_VALIDATION"
        );
        let bad = request(&s, t::Family::Text, Some("zz zz"), "d.epub");
        assert_eq!(code(run(&s.st, "p", &s.data, bad).await), "ERR_VALIDATION");
        let image = request(&s, t::Family::Image, None, "e.epub");
        assert_eq!(
            code(run(&s.st, "p", &s.data, image).await),
            "unsupported-family"
        );
        let mut gone = request(&s, t::Family::Text, None, "f.epub");
        gone.media_id = 99;
        assert_eq!(code(run(&s.st, "p", &s.data, gone).await), "ERR_NOT_FOUND");
        let mut outside = request(&s, t::Family::Text, None, "g.epub");
        outside.paths = vec![std::env::temp_dir().to_string_lossy().into_owned()];
        assert_eq!(code(run(&s.st, "p", &s.data, outside).await), "ERR_DENIED");
        let none: i64 = sqlx::query_scalar("SELECT count(*) FROM media_files")
            .fetch_one(&s.st.db)
            .await
            .unwrap();
        assert_eq!(none, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn a_file_in_the_plugin_data_dir_is_ingested_and_moved(db: PgPool) {
        let s = shelf(db).await;
        std::fs::write(s.data.join("dl.epub"), b"book").unwrap();
        sqlx::query(r#"UPDATE plugin_registrations SET "ingestRoots" = '{}'"#)
            .execute(&s.st.db)
            .await
            .unwrap();
        let mut req = request(&s, t::Family::Text, None, "unused.epub");
        req.paths = vec!["/data/dl.epub".into()];
        req.transfer = t::TransferMode::Move;
        let r = run(&s.st, "p", &s.data, req).await.unwrap();
        assert_eq!(r.imported.len(), 1);
        assert!(
            !s.data.join("dl.epub").exists(),
            "a move empties the scratch"
        );
        let mut out = request(&s, t::Family::Text, None, "x.epub");
        out.paths = vec!["/data/../dl/x.epub".into()];
        assert_eq!(
            run(&s.st, "p", &s.data, out).await.unwrap_err().code,
            "ERR_DENIED"
        );
        let mut host = request(&s, t::Family::Text, None, "y.epub");
        host.paths = vec![s.dl.join("y.epub").to_string_lossy().into_owned()];
        assert_eq!(
            run(&s.st, "p", &s.data, host).await.unwrap_err().code,
            "ERR_DENIED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_data_dir_root_refuses_escapes() {
        let base = std::env::temp_dir().join(format!("fliks-ingest-data-{}", std::process::id()));
        let (data, outside) = (base.join("data"), base.join("outside"));
        std::fs::create_dir_all(data.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(data.join("sub/a.epub"), b"x").unwrap();
        std::fs::write(outside.join("b.epub"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.join("b.epub"), data.join("file.epub")).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("dir")).unwrap();
        std::os::unix::fs::symlink(data.join("sub/a.epub"), data.join("inner.epub")).unwrap();
        let code = |p: &str| in_data_dir(p, &data).unwrap().unwrap_err().code;
        assert!(in_data_dir("/data/sub/a.epub", &data).unwrap().is_ok());
        assert_eq!(code("/data/file.epub"), "ERR_DENIED");
        assert_eq!(code("/data/inner.epub"), "ERR_DENIED");
        assert_eq!(code("/data/dir/b.epub"), "ERR_DENIED");
        assert_eq!(code("/data/../outside/b.epub"), "ERR_DENIED");
        assert_eq!(code("/data/sub/../../outside/b.epub"), "ERR_DENIED");
        assert_eq!(code("/data//sub/./a.epub"), "ERR_DENIED");
        assert_eq!(code("/data/nope.epub"), "ERR_NOT_FOUND");
        assert!(in_data_dir("/dataX/a.epub", &data).is_none());
        assert!(in_data_dir("/data", &data).is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn containment_follows_symlinks() {
        let base = std::env::temp_dir().join(format!("fliks-ingest-roots-{}", std::process::id()));
        let (root, outside) = (base.join("root"), base.join("outside"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.mkv"), b"x").unwrap();
        std::fs::write(outside.join("b.mkv"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("b.mkv"), root.join("link.mkv")).unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let p = |n: &Path| n.to_string_lossy().into_owned();
        assert!(contained(&p(&root.join("a.mkv")), &roots).is_ok());
        assert_eq!(
            contained(&p(&outside.join("b.mkv")), &roots)
                .unwrap_err()
                .code,
            "ERR_DENIED"
        );
        #[cfg(unix)]
        assert_eq!(
            contained(&p(&root.join("link.mkv")), &roots)
                .unwrap_err()
                .code,
            "ERR_DENIED"
        );
        assert_eq!(
            contained(&p(&root.join("nope.mkv")), &roots)
                .unwrap_err()
                .code,
            "ERR_NOT_FOUND"
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
