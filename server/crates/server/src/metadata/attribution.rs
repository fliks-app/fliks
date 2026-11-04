//! What the media detail says of its sources, for every kind (`metadata-orchestrator.md` rule 42).
use super::comics::describe;
use fliks_domain::external_id::ExternalProvider;
use serde_json::{Map, Value, json};
use sqlx::PgPool;

/// The providers behind a media that owe or deserve a mention: plugin namespaces with their link,
/// and the unofficial book sources, that hold an id or a field of it.
pub async fn providers(db: &PgPool, media: i32) -> sqlx::Result<Vec<Value>> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"SELECT provider::text FROM media_external_ids WHERE "mediaId" = $1
           UNION SELECT provider::text FROM media_field_sources WHERE "mediaId" = $1 AND provider IS NOT NULL
           UNION SELECT x.provider::text FROM edition_external_ids x JOIN editions e ON e.id = x."editionId"
             WHERE e."mediaId" = $1
           UNION SELECT s.provider::text FROM edition_field_sources s JOIN editions e ON e.id = s."editionId"
             WHERE e."mediaId" = $1 AND s.provider IS NOT NULL"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    let mut out = describe(db, &names).await?;
    for p in [ExternalProvider::Audible, ExternalProvider::Audnexus] {
        if names.iter().any(|n| n == p.as_str()) {
            out.push(
                json!({"provider": p.as_str(), "name": p.label(), "url": null, "unofficial": true}),
            );
        }
    }
    Ok(out)
}

/// `{field: provider}` of the media, `null` for a field edited by hand.
pub async fn field_sources(db: &PgPool, media: i32) -> sqlx::Result<Value> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"SELECT field::text, provider::text FROM media_field_sources WHERE "mediaId" = $1 ORDER BY field"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    Ok(Value::Object(
        rows.into_iter()
            .map(|(f, p)| (f, p.map_or(Value::Null, Value::from)))
            .collect::<Map<_, _>>(),
    ))
}
