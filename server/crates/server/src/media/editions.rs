//! The facts, provenance and release date of an edition (`docs/spec/books.md` rules 5, 8 and 9).
use fliks_domain::{
    external_id::Namespace,
    media::{family::Family, release::ReleaseKind},
    metadata::field::Field,
};
use sqlx::{PgConnection, PgExecutor};

/// What an edition merge says; a `None` fact keeps its column.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub language: Option<String>,
    /// `Some(None)` clears the title (it equals the work's), `None` keeps it.
    pub title: Option<Option<String>>,
    pub format: Option<String>,
    pub publisher: Option<String>,
    pub duration_seconds: Option<i32>,
    pub page_count: Option<i32>,
}

/// The work and family of an edition.
pub async fn of(db: impl PgExecutor<'_>, edition: i32) -> sqlx::Result<Option<(i32, Family)>> {
    let row = sqlx::query!(
        r#"SELECT "mediaId", family FROM editions WHERE id = $1"#,
        edition
    )
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|r| Some((r.mediaId, Family::parse(&r.family)?))))
}

/// The media of the edition holding `value` for `provider`.
pub async fn media_of_id(
    db: &sqlx::PgPool,
    provider: Namespace,
    value: &str,
) -> sqlx::Result<Option<i32>> {
    match super::external_ids::find_edition(db, provider, value).await? {
        Some(e) => Ok(of(db, e).await?.map(|(media, _)| media)),
        None => Ok(None),
    }
}

/// The fields locked on `edition`.
pub async fn locked_fields(c: impl PgExecutor<'_>, edition: i32) -> sqlx::Result<Vec<Field>> {
    let names = sqlx::query_scalar!(
        r#"SELECT field FROM edition_field_sources WHERE "editionId" = $1 AND locked"#,
        edition
    )
    .fetch_all(c)
    .await?;
    Ok(names.iter().filter_map(|n| Field::parse(n)).collect())
}

/// Replaces the unlocked rows of the fields `provenance` names; the rows of other fields stay, so a
/// provider that wrote less than the one before does not erase what the latter wrote.
pub async fn merge_field_sources(
    c: &mut PgConnection,
    edition: i32,
    provenance: &[(Field, Namespace)],
) -> sqlx::Result<()> {
    let fields: Vec<&str> = provenance.iter().map(|(f, _)| f.as_str()).collect();
    let providers: Vec<&str> = provenance.iter().map(|(_, p)| p.as_str()).collect();
    sqlx::query(
        r#"DELETE FROM edition_field_sources
           WHERE "editionId" = $1 AND NOT locked AND field = ANY($2)"#,
    )
    .bind(edition)
    .bind(&fields)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"INSERT INTO edition_field_sources ("editionId", field, provider)
           SELECT $1, f, p FROM UNNEST($2::text[], $3::text[]) AS t(f, p)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(edition)
    .bind(&fields)
    .bind(&providers)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Writes the facts; a row they leave as it is is not written.
pub async fn set_facts(c: &mut PgConnection, edition: i32, f: &Facts) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE editions SET language = COALESCE($2, language), format = COALESCE($3, format),
             publisher = COALESCE($4, publisher), "durationSeconds" = COALESCE($5, "durationSeconds"),
             "pageCount" = COALESCE($6, "pageCount"), title = CASE WHEN $7 THEN $8 ELSE title END
           WHERE id = $1 AND (language IS DISTINCT FROM COALESCE($2, language)
             OR format IS DISTINCT FROM COALESCE($3, format)
             OR publisher IS DISTINCT FROM COALESCE($4, publisher)
             OR "durationSeconds" IS DISTINCT FROM COALESCE($5, "durationSeconds")
             OR "pageCount" IS DISTINCT FROM COALESCE($6, "pageCount")
             OR ($7 AND title IS DISTINCT FROM $8))"#,
        edition,
        f.language,
        f.format,
        f.publisher,
        f.duration_seconds,
        f.page_count,
        f.title.is_some(),
        f.title.clone().flatten()
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Sets the `release` date of an edition (text Postgres reads as a date); `None` keeps it.
pub async fn set_release_date(
    c: &mut PgConnection,
    media: i32,
    edition: i32,
    date: Option<&str>,
) -> sqlx::Result<()> {
    let Some(date) = date else { return Ok(()) };
    sqlx::query!(
        r#"INSERT INTO media_release_dates ("mediaId", "editionId", kind, date)
           VALUES ($1, $2, $3, $4::text::date)
           ON CONFLICT ON CONSTRAINT "UQ_media_release_dates" DO UPDATE SET date = EXCLUDED.date
           WHERE media_release_dates.date IS DISTINCT FROM EXCLUDED.date"#,
        media,
        edition,
        ReleaseKind::Release.as_str(),
        date
    )
    .execute(c)
    .await?;
    Ok(())
}
