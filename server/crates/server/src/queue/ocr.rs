//! OCR before an `ocr_then_drop` job: the SRT of each image track becomes an extra input of the remux.
use crate::{
    ingest::fsx,
    state::AppState,
    subtitles::{model, ocr},
};
use fliks_engine_core::api::{ExtraSubtitle, MediaInfo};

/// What the image tracks' OCR gives right now.
pub struct Ocr {
    /// The SRTs of the finished runs, by track.
    pub done: Vec<(u32, ExtraSubtitle)>,
    /// Some run was started or is still going: the job waits for it.
    pub pending: bool,
}

/// Looks at the OCR of the file's image tracks, starting what has not run (never waiting for it). A track
/// whose last run failed is left out and stays image-based; `retry` runs it again.
pub async fn extra_subtitles(
    st: &AppState,
    folder: &str,
    info: &MediaInfo,
    media_file_id: i32,
    retry: bool,
) -> Ocr {
    let mut out = Ocr {
        done: vec![],
        pending: false,
    };
    for t in info.subtitles.iter().filter(|s| s.is_image_based) {
        let row = match latest(st, media_file_id, t.stream_index as i32).await {
            Some(r) if r.status == "downloaded" => r,
            Some(r) if r.status == "processing" => {
                out.pending = true;
                continue;
            }
            Some(_) if !retry => continue,
            _ => {
                out.pending |= start(st, media_file_id, t.stream_index as i32)
                    .await
                    .is_some();
                continue;
            }
        };
        let Some(abs) = row
            .file_path
            .as_deref()
            .and_then(|p| fsx::locate(folder, p))
        else {
            continue;
        };
        out.done.push((
            t.stream_index,
            ExtraSubtitle {
                path: abs.to_string_lossy().into_owned(),
                language: Some(t.language.clone()),
                title: t.title.clone(),
                default: None,
            },
        ));
    }
    out
}

/// The newest OCR row of a track: a failed run is remembered by its row, which goes with the file's content.
async fn latest(st: &AppState, file: i32, stream: i32) -> Option<model::Row> {
    let id: i32 = sqlx::query_scalar(
        r#"SELECT id FROM subtitle_files WHERE "mediaFileId" = $1 AND "providerType" = 'ocr'
           AND "sourceStreamIndex" = $2 ORDER BY id DESC LIMIT 1"#,
    )
    .bind(file)
    .bind(stream)
    .fetch_optional(&st.db)
    .await
    .ok()??;
    model::by_id(&st.db, id).await.ok().flatten()
}

/// The placeholder row of a new OCR run on the embedded row of that track.
async fn start(st: &AppState, file: i32, stream: i32) -> Option<i32> {
    let source: i32 = sqlx::query_scalar(
        r#"SELECT id FROM subtitle_files WHERE "mediaFileId" = $1 AND "providerType" = 'embedded'
           AND "streamIndex" = $2 LIMIT 1"#,
    )
    .bind(file)
    .bind(stream)
    .fetch_optional(&st.db)
    .await
    .ok()??;
    let placeholder = ocr::start(st, source, None, true).await.ok()?;
    placeholder.get("id")?.as_i64().map(|i| i as i32)
}
