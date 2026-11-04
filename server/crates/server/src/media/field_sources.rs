//! Where each field of a media came from, and which are locked (`metadata-orchestrator.md` rules 34-37).
use fliks_domain::{external_id::Namespace, metadata::field::Field};
use sqlx::{PgConnection, PgExecutor};

/// The fields locked on `media`.
pub async fn locked_fields(c: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Vec<Field>> {
    let names = sqlx::query_scalar!(
        r#"SELECT field FROM media_field_sources WHERE "mediaId" = $1 AND locked"#,
        media
    )
    .fetch_all(c)
    .await?;
    Ok(names.iter().filter_map(|n| Field::parse(n)).collect())
}

/// Replaces the rows of `media` that are not locked by `provenance`; a locked row stays as it is.
pub async fn set_field_sources(
    c: &mut PgConnection,
    media: i32,
    provenance: &[(Field, Namespace)],
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM media_field_sources WHERE "mediaId" = $1 AND NOT locked"#,
        media
    )
    .execute(&mut *c)
    .await?;
    let fields: Vec<&str> = provenance.iter().map(|(f, _)| f.as_str()).collect();
    let providers: Vec<&str> = provenance.iter().map(|(_, p)| p.as_str()).collect();
    sqlx::query!(
        r#"INSERT INTO media_field_sources ("mediaId", field, provider)
           SELECT $1, f, p FROM UNNEST($2::text[], $3::text[]) AS t(f, p)
           ON CONFLICT DO NOTHING"#,
        media,
        &fields as &[&str],
        &providers as &[&str]
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Replaces the unlocked rows of the fields `provenance` names; the rows of other fields stay, so a
/// provider that wrote less than the one before does not erase what the latter wrote.
pub async fn merge_field_sources(
    c: &mut PgConnection,
    media: i32,
    provenance: &[(Field, Namespace)],
) -> sqlx::Result<()> {
    let fields: Vec<&str> = provenance.iter().map(|(f, _)| f.as_str()).collect();
    let providers: Vec<&str> = provenance.iter().map(|(_, p)| p.as_str()).collect();
    sqlx::query(
        r#"DELETE FROM media_field_sources WHERE "mediaId" = $1 AND NOT locked AND field = ANY($2)"#,
    )
    .bind(media)
    .bind(&fields)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"INSERT INTO media_field_sources ("mediaId", field, provider)
           SELECT $1, f, p FROM UNNEST($2::text[], $3::text[]) AS t(f, p)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(media)
    .bind(&fields)
    .bind(&providers)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Locks `field` as a manual value: the next merge leaves it alone.
pub async fn lock(c: impl PgExecutor<'_>, media: i32, field: Field) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES ($1, $2, NULL, true)
           ON CONFLICT ("mediaId", field) DO UPDATE SET provider = NULL, locked = true"#,
    )
    .bind(media)
    .bind(field.as_str())
    .execute(c)
    .await?;
    Ok(())
}
