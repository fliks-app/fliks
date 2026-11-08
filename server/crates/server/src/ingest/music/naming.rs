//! The name of a track file at transfer (`docs/spec/music.md`, Naming): the track and multi-disc formats over the
//! tags of the file, so two discs with the same file names never collide.
use super::{separators_of, stem, tags::TrackTags};
use crate::{
    ingest::{library::file_name, probe},
    state::AppState,
};
use fliks_domain::naming::{AlbumNameTokens, NamingFormats, apply_album_format};
use std::path::Path;

/// Where and how `src` is named in the album `media`: the file name (without extension), `None` when its tags
/// give no track number so its own name is kept, and the disc folder to keep when the tags name no disc, so
/// `CD1/01` and `CD2/01` never meet. `Err` when the engine cannot read the file.
pub async fn track_base(
    st: &AppState,
    media: (i32, &str, Option<i32>),
    formats: &NamingFormats,
    src: &Path,
) -> Result<(Option<String>, Option<String>), String> {
    let (id, title, year) = media;
    let p = probe(st, src, false).await?;
    let seps = separators_of(st).await;
    let tagged = TrackTags::read(&p.info, &seps, stem(&file_name(src)));
    let t = tagged.clone().with_folder_disc(&src.to_string_lossy());
    let disc_dir = tagged
        .disc
        .is_none()
        .then(|| fliks_domain::music::group::disc_of_folder(&src.to_string_lossy()))
        .flatten()
        .and_then(|_| src.parent()?.file_name()?.to_str().map(str::to_owned));
    let Some(track) = t.track else {
        return Ok((None, disc_dir));
    };
    let artist: Option<String> = sqlx::query_scalar(
        r#"SELECT p.name FROM media_credits c JOIN persons p ON p.id = c."personId"
           WHERE c."mediaId" = $1 AND c.role = 'artist' ORDER BY c.position LIMIT 1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    let tokens = AlbumNameTokens {
        artist_name: artist.or_else(|| Some(t.artist_line()).filter(|a| !a.is_empty())),
        album_title: title.to_owned(),
        release_year: year.map(i64::from),
        medium: Some(i64::from(t.disc_number())),
        track: Some(i64::from(track)),
        track_title: t.title.clone(),
        track_artist: Some(
            t.artists
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        )
        .filter(|a| !a.is_empty()),
        ..Default::default()
    };
    let several = t.disc_total.unwrap_or(1) > 1 || t.disc_number() > 1;
    let format = if several {
        &formats.multi_disc_track
    } else {
        &formats.track
    };
    let name = apply_album_format(format, &tokens);
    Ok((Some(name).filter(|n| !n.is_empty()), disc_dir))
}
