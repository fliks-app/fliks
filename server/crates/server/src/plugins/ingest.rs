//! `library.ingest` (`plugins.md` rule 32): every path under a granted root, then the S5 ingest.
use super::imports::host_err;
use super::runtime::{HostError, fliks::plugin::types as t};
use crate::ingest::{library, transfer::Method};
use crate::state::AppState;
use serde_json::json;
use std::path::PathBuf;

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

pub async fn run(
    st: &AppState,
    id: &str,
    r: t::IngestRequest,
) -> Result<t::IngestResult, HostError> {
    let roots: Vec<String> = sqlx::query_scalar(
        r#"SELECT "ingestRoots" FROM plugin_registrations WHERE "pluginId" = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| host_err("ERR", e.to_string()))?
    .unwrap_or_default();
    if roots.is_empty() {
        return Err(host_err(
            "ERR_DENIED",
            format!("library.ingest: no ingestRoots configured for plugin \"{id}\""),
        ));
    }
    let files = r
        .paths
        .iter()
        .map(|p| {
            contained(p, &roots).map(|path| library::File {
                path,
                episode_id: None,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let media_id = r.media_id as i32;
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
        },
    )
    .await
    .map_err(|e| host_err("ERR", e))?;
    drop(guard);
    if out.imported.is_empty() && !out.errors.is_empty() {
        return Err(host_err("ERR", out.errors.join("; ")));
    }
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
            .map(|i| t::ImportedFile {
                media_file_id: i.file_id as u32,
                relative_path: i.relative_path.clone(),
                quality: i.quality.clone(),
            })
            .collect(),
        already_present: out.already_present.clone(),
        season_number: single.and_then(|i| i.season_number).map(|n| n as u32),
        episode_number: single.and_then(|i| i.episode_number).map(|n| n as u32),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

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
