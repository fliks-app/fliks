//! Queries of the `media_issues` and `media_issue_comments` tables (`problems.md` SQL section).
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

/// Open and acknowledged: the states a report is still waiting on a fix.
pub const ACTIVE: [&str; 2] = ["open", "acknowledged"];

/// One report with the facts of its media, the columns every transition and notification reads.
#[derive(Debug, sqlx::FromRow)]
pub struct Row {
    pub id: i32,
    pub user_id: Option<i32>,
    pub media_id: i32,
    pub item_id: Option<i32>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub media_file_id: Option<i32>,
    pub kind: String,
    pub status: String,
    pub resolved_at: Option<DateTime<Utc>>,
    pub library_id: Option<i32>,
    pub media_type: String,
    pub title: String,
}

/// `SELECT`/`RETURNING` list of `Row`, over the aliases `i` (report) and `m` (media).
pub const ROW_COLS: &str = r#"i.id, i."userId" AS user_id, i."mediaId" AS media_id, i."itemId" AS item_id,
  i."seasonNumber" AS season_number, i."episodeNumber" AS episode_number, i."mediaFileId" AS media_file_id,
  i."issueKind" AS kind, i.status, i."resolvedAt" AS resolved_at,
  m."libraryId" AS library_id, m.type::text AS media_type, m.title"#;

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {ROW_COLS} FROM media_issues i JOIN media m ON m.id = i."mediaId" WHERE i.id = $1"#
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// The scope of a new report: a whole title, a season, or one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scope {
    pub item_id: Option<i32>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
}

/// The season and episode numbers of an item of `media`; `None` when the item belongs to another media.
pub async fn item_scope(
    db: &PgPool,
    media: i32,
    item: i32,
) -> sqlx::Result<Option<(Option<i32>, Option<i32>)>> {
    sqlx::query_as(
        r#"SELECT g.number, i.number FROM items i LEFT JOIN item_groups g ON g.id = i."groupId"
           WHERE i.id = $1 AND i."mediaId" = $2"#,
    )
    .bind(item)
    .bind(media)
    .fetch_optional(db)
    .await
}

/// The size of `file` when it belongs to `media` and, with an `item`, is one of its parts.
pub async fn file_size(
    db: &PgPool,
    media: i32,
    item: Option<i32>,
    file: i32,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(
        r#"SELECT f.size FROM media_files f WHERE f.id = $1 AND f."mediaId" = $2
             AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM item_parts p
                                             WHERE p."itemId" = $3 AND p."mediaFileId" = f.id))"#,
    )
    .bind(file)
    .bind(media)
    .bind(item)
    .fetch_optional(db)
    .await
}

/// The file a scope is made of when it has exactly one: an item's part, or a whole title's file.
/// A season has no pinned file.
pub async fn sole_file(db: &PgPool, media: i32, s: Scope) -> sqlx::Result<Option<(i32, i64)>> {
    if s.item_id.is_none() && (s.season_number.is_some() || s.episode_number.is_some()) {
        return Ok(None);
    }
    let files: Vec<(i32, i64)> = sqlx::query_as(
        r#"SELECT f.id, f.size FROM media_files f WHERE f."mediaId" = $1
             AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM item_parts p
                                             WHERE p."itemId" = $2 AND p."mediaFileId" = f.id))
           LIMIT 2"#,
    )
    .bind(media)
    .bind(s.item_id)
    .fetch_all(db)
    .await?;
    Ok(match files[..] {
        [one] => Some(one),
        _ => None,
    })
}

/// Same user, media, scope and kind already waiting on a fix; `except` leaves out the report being reopened.
pub async fn duplicate(
    tx: &mut PgConnection,
    user: i32,
    media: i32,
    s: Scope,
    kind: &str,
    except: Option<i32>,
) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_issues
             WHERE "userId" = $1 AND "mediaId" = $2 AND "itemId" IS NOT DISTINCT FROM $3
               AND "seasonNumber" IS NOT DISTINCT FROM $4 AND "episodeNumber" IS NOT DISTINCT FROM $5
               AND "issueKind" = $6 AND status = ANY($7) AND ($8::int IS NULL OR id <> $8))"#,
    )
    .bind(user)
    .bind(media)
    .bind(s.item_id)
    .bind(s.season_number)
    .bind(s.episode_number)
    .bind(kind)
    .bind(&ACTIVE[..])
    .bind(except)
    .fetch_one(tx)
    .await
}

pub async fn active_count(tx: &mut PgConnection, user: i32) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        r#"SELECT count(*) FROM media_issues WHERE "userId" = $1 AND status = ANY($2)"#,
    )
    .bind(user)
    .bind(&ACTIVE[..])
    .fetch_one(tx)
    .await
}

pub struct New<'a> {
    pub user: i32,
    pub media: i32,
    pub scope: Scope,
    pub file: Option<(i32, i64)>,
    pub kind: &'a str,
}

pub async fn insert(tx: &mut PgConnection, n: &New<'_>) -> sqlx::Result<i32> {
    sqlx::query_scalar(
        r#"INSERT INTO media_issues ("userId", "mediaId", "itemId", "seasonNumber", "episodeNumber",
             "mediaFileId", "fileSize", "issueKind")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id"#,
    )
    .bind(n.user)
    .bind(n.media)
    .bind(n.scope.item_id)
    .bind(n.scope.season_number)
    .bind(n.scope.episode_number)
    .bind(n.file.map(|f| f.0))
    .bind(n.file.map(|f| f.1))
    .bind(n.kind)
    .fetch_one(tx)
    .await
}

/// A system report of a file the health scan found corrupt; none while one is already active for it.
pub async fn insert_system(db: &PgPool, file: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"INSERT INTO media_issues ("source", "mediaId", "mediaFileId", "fileSize", "issueKind")
           SELECT 'health', f."mediaId", f.id, f.size, 'other' FROM media_files f
           WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM media_issues i
             WHERE i."source" = 'health' AND i."mediaFileId" = f.id AND i.status = ANY($2))
           RETURNING id"#,
    )
    .bind(file)
    .bind(&ACTIVE[..])
    .fetch_optional(db)
    .await
}

/// Moves a report out of one of the `from` states; false when it was not in any (a concurrent change).
pub async fn transition(
    tx: &mut PgConnection,
    id: i32,
    from: &[&str],
    to: &str,
    by: Option<i32>,
) -> sqlx::Result<bool> {
    let done = sqlx::query(
        r#"UPDATE media_issues SET status = $3, "resolvedById" = $4, "autoResolved" = false,
             "resolvedAt" = CASE WHEN $3 IN ('resolved', 'closed') THEN now() END
           WHERE id = $1 AND status = ANY($2)"#,
    )
    .bind(id)
    .bind(from)
    .bind(to)
    .bind(by)
    .execute(tx)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// A reopened report watches the file as it is now, so the replacement that was judged broken
/// does not resolve it again.
pub async fn repin(tx: &mut PgConnection, id: i32, file: Option<(i32, i64)>) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE media_issues SET "mediaFileId" = $2, "fileSize" = $3 WHERE id = $1"#)
        .bind(id)
        .bind(file.map(|f| f.0))
        .bind(file.map(|f| f.1))
        .execute(tx)
        .await?;
    Ok(())
}

pub async fn delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM media_issues WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Filters of the list and the detail; every field is optional.
#[derive(Default)]
pub struct Filter<'a> {
    pub id: Option<i32>,
    pub user: Option<i32>,
    pub libraries: Option<&'a [i32]>,
    pub statuses: Option<Vec<String>>,
    pub media: Option<i32>,
    pub kinds: Vec<String>,
}

const WHERE: &str = r#"WHERE ($1::int IS NULL OR i.id = $1) AND ($2::int IS NULL OR i."userId" = $2)
  AND ($3::int[] IS NULL OR m."libraryId" = ANY($3)) AND ($4::text[] IS NULL OR i.status = ANY($4))
  AND ($5::int IS NULL OR i."mediaId" = $5) AND m.type::text = ANY($6)"#;

const PERSON: &str =
    "jsonb_build_object('id', {u}.id, 'username', {u}.username, 'avatar', {u}.avatar)";

fn person(alias: &str) -> String {
    PERSON.replace("{u}", alias)
}

/// Reports newest first, in the wire shape (`problems.md` rule 12).
pub async fn rows(
    db: &PgPool,
    f: &Filter<'_>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Value>> {
    let (u, r, cu) = (person("u"), person("r"), person("cu"));
    let sql = format!(
        r#"SELECT jsonb_build_object('id', i.id, 'createdAt', iso_ms(i."createdAt"), 'updatedAt', iso_ms(i."updatedAt"),
  'status', i.status, 'kind', i."issueKind", 'itemId', i."itemId", 'seasonNumber', i."seasonNumber",
  'episodeNumber', i."episodeNumber", 'fileSize', i."fileSize", 'autoResolved', i."autoResolved",
  'resolvedAt', iso_ms(i."resolvedAt"), 'source', i.source,
  'media', jsonb_build_object('id', m.id, 'type', m.type::text, 'title', m.title,
    'posterUrl', CASE WHEN m."posterUrl" IS NULL THEN NULL ELSE '/api/images/media/' || m.id || '/poster?size=medium' END),
  'file', CASE WHEN fl.id IS NULL THEN NULL ELSE jsonb_build_object('id', fl.id,
    'name', regexp_replace(fl."relativePath", '^.*/', ''), 'quality', fl.quality, 'size', fl.size) END,
  'user', CASE WHEN u.id IS NULL THEN NULL ELSE {u} END, 'resolvedBy', CASE WHEN r.id IS NULL THEN NULL ELSE {r} END,
  'commentCount', (SELECT count(*) FROM media_issue_comments c WHERE c."issueId" = i.id),
  'lastReply', (SELECT jsonb_build_object('message', c.message, 'createdAt', iso_ms(c."createdAt"),
      'user', CASE WHEN cu.id IS NULL THEN NULL ELSE {cu} END)
    FROM media_issue_comments c LEFT JOIN users cu ON cu.id = c."userId"
    WHERE c."issueId" = i.id AND c."userId" IS DISTINCT FROM i."userId"
    ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1)) AS json
FROM media_issues i JOIN media m ON m.id = i."mediaId" LEFT JOIN users u ON u.id = i."userId"
  LEFT JOIN media_files fl ON fl.id = i."mediaFileId" LEFT JOIN users r ON r.id = i."resolvedById"
{WHERE} ORDER BY i."createdAt" DESC, i.id DESC LIMIT $7 OFFSET $8"#
    );
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(f.id)
        .bind(f.user)
        .bind(f.libraries)
        .bind(f.statuses.as_deref())
        .bind(f.media)
        .bind(&f.kinds)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await
}

pub async fn count(db: &PgPool, f: &Filter<'_>) -> sqlx::Result<i64> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM media_issues i JOIN media m ON m.id = i.\"mediaId\" {WHERE}"
    )))
    .bind(f.id)
    .bind(f.user)
    .bind(f.libraries)
    .bind(f.statuses.as_deref())
    .bind(f.media)
    .bind(&f.kinds)
    .fetch_one(db)
    .await
}

/// Open reports in `libraries` (every library for `None`) of the kinds the client declared.
pub async fn open_count(
    db: &PgPool,
    libraries: Option<&[i32]>,
    kinds: &[String],
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        r#"SELECT count(*) FROM media_issues i JOIN media m ON m.id = i."mediaId"
           WHERE i.status = 'open' AND ($1::int[] IS NULL OR m."libraryId" = ANY($1))
             AND m.type::text = ANY($2)"#,
    )
    .bind(libraries)
    .bind(kinds)
    .fetch_one(db)
    .await
}

/// The reporter's latest playback of the pinned file that started before the report: the QoE a manager reads.
pub async fn playback(
    db: &PgPool,
    r: &Row,
    created_at: DateTime<Utc>,
) -> sqlx::Result<Option<Value>> {
    let Some(file) = r.media_file_id else {
        return Ok(None);
    };
    sqlx::query_scalar(
        r#"SELECT jsonb_build_object('sessionId', q."sessionId", 'startedAt', iso_ms(q."startedAt"),
             'deviceLabel', q."deviceLabel", 'systemName', q."systemName", 'appVersion', q."appVersion",
             'playMethod', q."playMethod", 'quality', q.quality, 'transcodeReasons', q."transcodeReasons",
             'videoCodec', q."videoCodec", 'width', q.width, 'height', q.height, 'watchedMs', q."watchedMs",
             'stallCount', q."stallCount", 'stallMs', q."stallMs", 'errorCount', q."errorCount",
             'unrecoveredError', q."unrecoveredError", 'verdict', q.verdict, 'reasons', q.reasons)
           FROM playback_qoe_sessions q
           WHERE q."userId" = $1 AND q."mediaFileId" = $2 AND q."startedAt" <= $3
           ORDER BY q."startedAt" DESC LIMIT 1"#,
    )
    .bind(r.user_id)
    .bind(file)
    .bind(created_at)
    .fetch_optional(db)
    .await
}

pub async fn created_at(db: &PgPool, id: i32) -> sqlx::Result<DateTime<Utc>> {
    sqlx::query_scalar(r#"SELECT "createdAt" FROM media_issues WHERE id = $1"#)
        .bind(id)
        .fetch_one(db)
        .await
}

const COMMENT_JSON: &str = r#"jsonb_build_object('id', c.id, 'createdAt', iso_ms(c."createdAt"),
  'updatedAt', iso_ms(c."updatedAt"), 'issueId', c."issueId", 'userId', c."userId",
  'user', CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) END,
  'message', c.message)"#;

/// Comments of a report with their authors, oldest first.
pub async fn comments(db: &PgPool, issue: i32) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT {COMMENT_JSON} FROM media_issue_comments c LEFT JOIN users u ON u.id = c."userId"
           WHERE c."issueId" = $1 ORDER BY c."createdAt", c.id"#
    )))
    .bind(issue)
    .fetch_all(db)
    .await
}

pub async fn comment_insert(
    tx: &mut PgConnection,
    issue: i32,
    user: i32,
    message: &str,
) -> sqlx::Result<Value> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"WITH c AS (INSERT INTO media_issue_comments ("issueId", "userId", message) VALUES ($1, $2, $3)
             RETURNING *)
           SELECT {COMMENT_JSON} FROM c LEFT JOIN users u ON u.id = c."userId""#
    )))
    .bind(issue)
    .bind(user)
    .bind(message)
    .fetch_one(tx)
    .await
}

/// The author and report of a comment.
pub async fn comment_find(db: &PgPool, id: i32) -> sqlx::Result<Option<(Option<i32>, i32)>> {
    sqlx::query_as(r#"SELECT "userId", "issueId" FROM media_issue_comments WHERE id = $1"#)
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn comment_delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM media_issue_comments WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
