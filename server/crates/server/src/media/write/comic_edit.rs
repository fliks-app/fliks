//! Manual edits of a comic volume and its issues (`docs/spec/comics.md`, rules 35-37).
use super::body::Body;
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, assert_media_accessible},
    media::comics,
    state::AppState,
};
use axum::{Json, extract::State};
use fliks_domain::{
    acl::{Action, Subject},
    media::kind::MediaKind,
    metadata::field::Field,
};
use serde_json::Value;

const KINDS: [&str; 3] = ["issue", "annual", "special"];

/// `title` and `number` cannot be cleared; the other text fields clear on `null` or `""`.
fn text(b: &Body, k: &str, clearable: bool) -> Result<Option<Option<String>>, AppError> {
    b.str(k)?
        .map(|v| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()))
        .map(|v| {
            if v.is_none() && !clearable {
                Err(AppError::bad_request(vec![format!(
                    "{k} should not be empty"
                )]))
            } else {
                Ok(v)
            }
        })
        .transpose()
}

/// `PATCH /api/media/:id/comic`: `title`, `overview`, `publisher`, `startYear`, `volume`. Each edited
/// field is locked, so a scan never fills it again.
#[utoipa::path(patch, path = "/api/media/{id}/comic", responses((status = 200)))]
pub async fn patch_volume(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams(id) = id?;
    let libs = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, id, &libs).await?;
    let b = Body::new(
        v,
        &["title", "overview", "publisher", "startYear", "volume"],
    )?;
    let (title, overview, publisher) = (
        text(&b, "title", false)?,
        text(&b, "overview", true)?,
        text(&b, "publisher", true)?,
    );
    let start = b.int("startYear")?;
    let volume = b.int("volume")?;
    if start.flatten().is_some_and(|y| !(1..=9999).contains(&y)) {
        return Err(AppError::bad_request(vec![
            "startYear must not be greater than 9999".to_owned(),
        ]));
    }
    if volume.flatten().is_some_and(|n| n < 0) {
        return Err(AppError::bad_request(vec![
            "volume must not be less than 0".to_owned(),
        ]));
    }
    let mut tx = st.db.begin().await?;
    let kind: Option<String> =
        sqlx::query_scalar(r#"SELECT type FROM media WHERE id = $1 FOR UPDATE"#)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if kind.as_deref() != Some(MediaKind::Comic.as_str()) {
        return Err(AppError::bad_request(vec![format!(
            "Media #{id} is not a comic"
        )]));
    }
    let mut locks: Vec<Field> = vec![];
    if let Some(t) = &title {
        sqlx::query(r#"UPDATE media SET title = $2 WHERE id = $1"#)
            .bind(id)
            .bind(t)
            .execute(&mut *tx)
            .await?;
        locks.push(Field::Title);
    }
    if let Some(o) = &overview {
        sqlx::query(r#"UPDATE media SET overview = $2 WHERE id = $1"#)
            .bind(id)
            .bind(o)
            .execute(&mut *tx)
            .await?;
        locks.push(Field::Overview);
    }
    if let Some(y) = &start {
        sqlx::query(r#"UPDATE media SET year = $2 WHERE id = $1"#)
            .bind(id)
            .bind(y)
            .execute(&mut *tx)
            .await?;
        locks.push(Field::Year);
    }
    sqlx::query(
        r#"INSERT INTO comic_details ("mediaId") VALUES ($1) ON CONFLICT ("mediaId") DO NOTHING"#,
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if let Some(p) = &publisher {
        sqlx::query(r#"UPDATE comic_details SET publisher = $2 WHERE "mediaId" = $1"#)
            .bind(id)
            .bind(p)
            .execute(&mut *tx)
            .await?;
        locks.push(Field::Publisher);
    }
    if let Some(y) = &start {
        sqlx::query(r#"UPDATE comic_details SET "startYear" = $2 WHERE "mediaId" = $1"#)
            .bind(id)
            .bind(y)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(n) = &volume {
        sqlx::query(r#"UPDATE comic_details SET volume = $2 WHERE "mediaId" = $1"#)
            .bind(id)
            .bind(n)
            .execute(&mut *tx)
            .await?;
        locks.push(Field::Details);
    }
    for f in locks {
        sqlx::query(
            r#"INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES ($1, $2, NULL, true)
               ON CONFLICT ("mediaId", field) DO UPDATE SET provider = NULL, locked = true, "updatedAt" = now()"#,
        )
        .bind(id)
        .bind(f.as_str())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(comics::detail(&st.db, id, a.user.id, &libs).await?))
}

/// `PATCH /api/comics/issues/:itemId`: `number` (the label), `sort`, `kind`, `title`, `overview`,
/// `releaseDate`. Each edited field is locked on the issue.
#[utoipa::path(patch, path = "/api/comics/issues/{itemId}", responses((status = 200)))]
pub async fn patch_issue(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Update, Subject::Media)?;
    let PathParams(item) = id?;
    let media: i32 =
        sqlx::query_scalar(r#"SELECT "mediaId" FROM comic_issues WHERE "itemId" = $1"#)
            .bind(item)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| AppError::not_found(format!("Item #{item} not found")))?;
    let libs = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, media, &libs).await?;
    let b = Body::new(
        v,
        &["number", "sort", "kind", "title", "overview", "releaseDate"],
    )?;
    let number = text(&b, "number", false)?.flatten();
    let kind = b.one_of("kind", &KINDS)?.flatten();
    let sort = b
        .num("sort")?
        .map(|s| {
            s.filter(|n| n.is_finite() && n.abs() < 10_000.0)
                .map(|n| format!("{n}"))
                .ok_or_else(|| {
                    AppError::bad_request(vec![
                        "sort must be a number between -9999 and 9999".to_owned(),
                    ])
                })
        })
        .transpose()?;
    let title = text(&b, "title", true)?;
    let overview = text(&b, "overview", true)?;
    let date = b.date("releaseDate")?;
    let release = date
        .as_ref()
        .map(|d| {
            d.as_deref()
                .map(|s| {
                    chrono::NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d")
                        .map(|d| d.to_string())
                        .map_err(|_| {
                            AppError::bad_request(vec![
                                "releaseDate must be a YYYY-MM-DD date".to_owned(),
                            ])
                        })
                })
                .transpose()
        })
        .transpose()?;
    let mut locked: Vec<&str> = vec![];
    for (k, on) in [
        ("label", number.is_some()),
        ("sort", sort.is_some()),
        ("kind", kind.is_some()),
        ("title", title.is_some()),
        ("overview", overview.is_some()),
        ("releaseDate", release.is_some()),
    ] {
        if on {
            locked.push(k);
        }
    }
    let mut tx = st.db.begin().await?;
    sqlx::query(r#"SELECT 1 FROM media WHERE id = $1 FOR UPDATE"#)
        .bind(media)
        .execute(&mut *tx)
        .await?;
    let done = sqlx::query(
        r#"UPDATE comic_issues SET label = COALESCE($2, label), kind = COALESCE($3, kind),
             "sortNumber" = COALESCE($4::text::numeric, "sortNumber"),
             "lockedFields" = ARRAY(SELECT DISTINCT unnest("lockedFields" || $5::text[]))
           WHERE "itemId" = $1"#,
    )
    .bind(item)
    .bind(&number)
    .bind(&kind)
    .bind(&sort)
    .bind(&locked)
    .execute(&mut *tx)
    .await;
    match done {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::conflict(
                "The volume already has an issue with this kind and sort".to_owned(),
            ));
        }
        r => r?,
    };
    sqlx::query(
        r#"UPDATE items SET title = CASE WHEN $2 THEN $3 ELSE title END,
             overview = CASE WHEN $4 THEN $5 ELSE overview END,
             "airDate" = CASE WHEN $6 THEN $7::text::date ELSE "airDate" END WHERE id = $1"#,
    )
    .bind(item)
    .bind(title.is_some())
    .bind(title.clone().flatten())
    .bind(overview.is_some())
    .bind(overview.clone().flatten())
    .bind(release.is_some())
    .bind(release.clone().flatten())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(comics::detail(&st.db, media, a.user.id, &libs).await?))
}
