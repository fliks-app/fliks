//! OCR before an `ocr_then_drop` job: the SRT of each image track becomes an extra input of the remux.
use crate::{
    ingest::fsx,
    state::AppState,
    subtitles::{model, ocr},
};
use fliks_engine_core::api::MediaInfo;
use serde_json::{Value, json};
use std::time::Duration;

const POLL: Duration = Duration::from_secs(5);
const GIVE_UP: Duration = Duration::from_secs(4 * 3600);

/// Runs the OCR of the file's image tracks (reusing finished ones) and returns the SRTs, with the track's
/// language and title (the plan's `extraSubtitles`). A track whose OCR fails is left out, so it stays image-based in the output.
pub async fn extra_subtitles(
    st: &AppState,
    folder: &str,
    info: &MediaInfo,
    media_file_id: i32,
) -> Vec<Value> {
    let mut out = vec![];
    for t in info.subtitles.iter().filter(|s| s.is_image_based) {
        let Some(row) = existing_or_run(st, media_file_id, t.stream_index as i32).await else {
            continue;
        };
        let Some(abs) = row
            .file_path
            .as_deref()
            .and_then(|p| fsx::locate(folder, p))
        else {
            continue;
        };
        out.push(json!({"path": abs, "language": t.language, "title": t.title}));
    }
    out
}

async fn existing_or_run(st: &AppState, file: i32, stream: i32) -> Option<model::Row> {
    let done: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM subtitle_files WHERE "mediaFileId" = $1 AND "providerType" = 'ocr'
           AND "sourceStreamIndex" = $2 AND status = 'downloaded' AND "filePath" IS NOT NULL
           ORDER BY id DESC LIMIT 1"#,
    )
    .bind(file)
    .bind(stream)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten();
    let id = match done {
        Some(id) => id,
        None => start(st, file, stream).await?,
    };
    let mut waited = Duration::ZERO;
    loop {
        let row = model::by_id(&st.db, id).await.ok().flatten()?;
        match row.status.as_str() {
            "processing" if waited < GIVE_UP => {
                tokio::time::sleep(POLL).await;
                waited += POLL;
            }
            "downloaded" => return Some(row),
            _ => return None,
        }
    }
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
