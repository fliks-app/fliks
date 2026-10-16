//! Embedded tracks (`subtitle-files.md` rule 25): the stored rows follow what the engine probes.
use super::{
    events, files,
    model::{self, New},
};
use crate::{ingest::fsx, state::AppState};
use fliks_domain::language::normalize_language_code;
use std::collections::HashSet;

/// Refreshes the embedded rows of one file; a probe that failed keeps the stored ones.
pub async fn detect_and_store(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
) -> Vec<i32> {
    match detect(st, media_id, file_id, episode_id).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!("Embedded subtitles of file #{file_id} not refreshed: {e}");
            vec![]
        }
    }
}

async fn detect(
    st: &AppState,
    media_id: i32,
    file_id: i32,
    episode_id: Option<i32>,
) -> Result<Vec<i32>, String> {
    let sql = |e: sqlx::Error| e.to_string();
    let media = files::load_media(&st.db, media_id).await.map_err(sql)?;
    let file = files::file_by_id(&st.db, file_id).await.map_err(sql)?;
    let (Some(media), Some(file)) = (media, file) else {
        return Ok(vec![]);
    };
    let Ok(dirs) = media.dirs("no root") else {
        return Ok(vec![]);
    };
    let Some(rel) = fsx::safe_rel(&file.relative_path) else {
        return Ok(vec![]);
    };
    let video = dirs.m.join(rel);
    let probe = st
        .engine
        .probe(&video.to_string_lossy(), false, false, false)
        .await
        .map_err(|e| e.to_string())?;
    let Some(info) = probe.info.filter(|_| probe.ok) else {
        tracing::warn!(
            "Keeping stored embedded subtitles for file #{file_id}: the probe could not read it"
        );
        return Ok(vec![]);
    };
    let skip: HashSet<i32> = if crate::settings::setting_value(&st.db, "subtitle_ocr_delete_source")
        .await
        .map_err(sql)?
        .as_deref()
        == Some("true")
    {
        sqlx::query_scalar::<_, Option<i32>>(
            r#"SELECT "sourceStreamIndex" FROM subtitle_files
               WHERE "mediaFileId" = $1 AND "providerType" = 'ocr' AND status = 'downloaded'"#,
        )
        .bind(file_id)
        .fetch_all(&st.db)
        .await
        .map_err(sql)?
        .into_iter()
        .flatten()
        .collect()
    } else {
        HashSet::new()
    };
    let mut tx = st.db.begin().await.map_err(sql)?;
    let removed = sqlx::query(
        r#"DELETE FROM subtitle_files WHERE "mediaFileId" = $1 AND "providerType" = 'embedded'"#,
    )
    .bind(file_id)
    .execute(&mut *tx)
    .await
    .map_err(sql)?
    .rows_affected();
    let mut ids = vec![];
    for s in info
        .subtitles
        .iter()
        .filter(|s| !(s.is_image_based && skip.contains(&(s.stream_index as i32))))
    {
        let n = New {
            media_id,
            media_file_id: file_id,
            episode_id,
            language: normalize_language_code(Some(&s.language)),
            forced: s.forced,
            hearing_impaired: s.hearing_impaired,
            provider_type: "embedded".into(),
            status: "embedded".into(),
            score: 100,
            stream_index: Some(s.stream_index as i32),
            codec: Some(s.codec.clone()),
            ..New::default()
        };
        ids.push(model::insert(&mut *tx, &n).await.map_err(sql)?.id);
    }
    tx.commit().await.map_err(sql)?;
    if !ids.is_empty() || removed > 0 {
        events::list_changed(st, media_id).await;
    }
    Ok(ids)
}
