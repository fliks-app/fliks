//! `readEdlSidecar` (spec rule 41): the file read around `fliks_domain::edl`.
use crate::state::AppState;
use fliks_domain::edl::{EdlRange, MAX_EDL_BYTES, edl_path_for, find_case_insensitive, parse_edl};
use std::{io::ErrorKind, path::Path, time::UNIX_EPOCH};
use tokio::io::AsyncReadExt;

const MAX_LOGGED_REJECTS: usize = 5;
const MAX_WARNED: usize = 1000;

fn warn_once(st: &AppState, key: String, msg: String) {
    let mut w = st
        .stream
        .edl_warned
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if w.len() >= MAX_WARNED {
        w.clear();
    }
    if w.insert(key) {
        tracing::warn!("{msg}");
    }
}

/// The sidecar as it exists on disk (any letter case), if any.
pub(crate) async fn find(video: &str) -> String {
    let exact = edl_path_for(video);
    if tokio::fs::symlink_metadata(&exact).await.is_ok() {
        return exact;
    }
    let path = Path::new(&exact);
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return exact;
    };
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return exact;
    };
    let mut names = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        names.push(e.file_name().to_string_lossy().into_owned());
    }
    match find_case_insensitive(&name.to_string_lossy(), &names) {
        Some(hit) => dir.join(hit).to_string_lossy().into_owned(),
        None => exact,
    }
}

/// Parsed ranges on the container timeline; `None` when absent or unusable.
pub async fn read(st: &AppState, video: &Path, fps: Option<f64>) -> Option<Vec<EdlRange>> {
    let path = find(&video.to_string_lossy()).await;
    let fail = |e: std::io::Error| {
        if !matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) {
            warn_once(
                st,
                format!("{path}:err:{:?}", e.kind()),
                format!("Cannot read {path}: {e}"),
            );
        }
        None
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(e) => return fail(e),
    };
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| {
            d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6
        });
    if meta.len() > MAX_EDL_BYTES {
        warn_once(
            st,
            format!("{path}:{mtime}:size"),
            format!(
                "Ignoring {path}: {} bytes exceeds {MAX_EDL_BYTES}",
                meta.len()
            ),
        );
        return None;
    }
    let hit = st
        .stream
        .edl
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&path, fps, mtime, meta.len())
        .map(<[EdlRange]>::to_vec);
    if hit.is_some() {
        return hit;
    }
    let mut buf = Vec::new();
    if let Err(e) = (&mut file).take(MAX_EDL_BYTES).read_to_end(&mut buf).await {
        return fail(e);
    }
    let parsed = parse_edl(&String::from_utf8_lossy(&buf), fps);
    if !parsed.rejected.is_empty() {
        let shown: Vec<String> = parsed
            .rejected
            .iter()
            .take(MAX_LOGGED_REJECTS)
            .map(|r| format!("line {}: {}", r.line, r.reason))
            .collect();
        warn_once(
            st,
            format!("{path}:{mtime}:rejects"),
            format!(
                "{path}: {} line(s) rejected ({})",
                parsed.rejected.len(),
                shown.join(", ")
            ),
        );
    }
    st.stream.edl.lock().unwrap_or_else(|e| e.into_inner()).put(
        &path,
        fps,
        mtime,
        meta.len(),
        parsed.ranges.clone(),
    );
    Some(parsed.ranges)
}
