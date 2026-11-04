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

/// Marks `fields` as set by hand: no provider, not locked, so a provider refresh still replaces them
/// and a file merge leaves them alone.
pub async fn set_by_hand(c: &mut PgConnection, media: i32, fields: &[Field]) -> sqlx::Result<()> {
    let names: Vec<&str> = fields.iter().map(|f| f.as_str()).collect();
    sqlx::query(
        r#"INSERT INTO media_field_sources ("mediaId", field, provider)
           SELECT $1, f, NULL FROM UNNEST($2::text[]) AS t(f)
           ON CONFLICT ("mediaId", field) DO UPDATE SET provider = NULL, "updatedAt" = now()
           WHERE NOT media_field_sources.locked"#,
    )
    .bind(media)
    .bind(&names)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// The fields a file merge must leave alone: locked, set by hand or by a provider.
pub async fn not_from_file(c: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Vec<Field>> {
    let names = sqlx::query_scalar::<_, String>(
        r#"SELECT field FROM media_field_sources
           WHERE "mediaId" = $1 AND (locked OR provider IS DISTINCT FROM 'file')"#,
    )
    .bind(media)
    .fetch_all(c)
    .await?;
    Ok(names.iter().filter_map(|n| Field::parse(n)).collect())
}
