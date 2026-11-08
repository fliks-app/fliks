//! `stream`, `download` and `getCoverArt` (`opensubsonic.md` rules 28-31).
use super::{
    Caller, Params, catalog,
    ids::Id,
    render::{Format, SubError, respond},
};
use crate::{
    images::{
        self,
        paths::{Size, Target, Variant},
    },
    state::AppState,
};
use axum::{
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, LOCATION},
    },
    response::{IntoResponse, Response},
};

/// A stream credential lives an hour: a player keeps one URL for the length of a track.
const STREAM_TTL_SECS: u64 = 3600;

/// The file a track plays: its first part of the highest version, when the caller reads the track.
async fn track_file(st: &AppState, c: &Caller, item: i32) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT f.id FROM items i JOIN editions e ON e.id = i."editionId"
           JOIN media m ON m.id = i."mediaId" AND m.type = 'album'
           JOIN LATERAL (SELECT ip."mediaFileId" AS id FROM item_parts ip WHERE ip."itemId" = i.id
             ORDER BY ip.version DESC, ip.position, ip."mediaFileId" LIMIT 1) f ON true
           WHERE i.id = $1 AND m."libraryId" = ANY($2) AND COALESCE(e."libraryId", m."libraryId") = ANY($2)"#,
    )
    .bind(item)
    .bind(&c.libraries)
    .fetch_optional(&st.db)
    .await
}

/// 302 to the engine's data plane with a stream credential, so the engine stays unchanged.
pub async fn redirect(
    st: &AppState,
    c: &Caller,
    p: &Params,
    download: bool,
) -> Result<Response, SubError> {
    let Some(Id::Track(item)) = Id::parse(p.required("id")?) else {
        return Err(SubError::not_found());
    };
    let file = track_file(st, c, item)
        .await?
        .ok_or_else(SubError::not_found)?;
    let token = st.jwt.sign_stream_for_device(
        c.user(),
        &c.a.user.username,
        c.token,
        file as u32,
        STREAM_TTL_SECS,
    )?;
    let location = format!(
        "/api/stream/{file}?token={}{}",
        token.token,
        if download { "&download=1" } else { "" }
    );
    Ok((
        StatusCode::FOUND,
        [
            (
                LOCATION,
                HeaderValue::from_str(&location).expect("a token is header-safe"),
            ),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response())
}

/// The smallest stored size that covers `px`; none given is the full image.
fn size_for(px: Option<u32>, thumb_width: u32) -> Size {
    match px {
        Some(n) if n <= thumb_width => Size::Thumb,
        Some(n) if n <= 500 => Size::Medium,
        _ => Size::Full,
    }
}

pub async fn cover_art(st: &AppState, c: &Caller, p: &Params, format: &Format) -> Response {
    let found = async {
        let px = p.get("size").and_then(|s| s.trim().parse::<u32>().ok());
        let (target, thumb) = match Id::parse(p.required("id")?) {
            Some(Id::Album(id)) => {
                if catalog::visible_albums(&st.db, &c.libraries, &[id])
                    .await?
                    .is_empty()
                {
                    return Err(SubError::not_found());
                }
                (Target::media(id, Variant::Poster), 185)
            }
            Some(Id::Track(item)) => {
                let media = catalog::visible_tracks(&st.db, &c.libraries, &[item])
                    .await?
                    .first()
                    .map(|t| t.1)
                    .ok_or_else(SubError::not_found)?;
                (Target::media(media, Variant::Poster), 185)
            }
            Some(Id::Artist(id)) => (Target::person(id), 45),
            _ => return Err(SubError::not_found()),
        };
        Ok(images::read(&target, size_for(px, thumb)).await)
    }
    .await;
    match found {
        Ok(Some(bytes)) => (
            [
                (CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
                (
                    CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=86400"),
                ),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => respond(format, Err(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_picks_the_smallest_stored_image_that_covers_it() {
        assert_eq!(size_for(None, 185), Size::Full);
        assert_eq!(size_for(Some(100), 185), Size::Thumb);
        assert_eq!(size_for(Some(185), 185), Size::Thumb);
        assert_eq!(size_for(Some(300), 185), Size::Medium);
        assert_eq!(size_for(Some(900), 185), Size::Full);
        assert_eq!(size_for(Some(100), 45), Size::Medium);
    }
}
