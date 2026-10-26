//! Channels for users and admins (`livetv-access.md` rules 8-20, 31-35): the one visibility predicate,
//! the user routes, the logo and prefs routes and the admin catalog.
use super::{
    access::{denied_groups, permissions},
    admin,
    dto::{Body, Opt, Query as Q, query_flag, query_int},
    model::{CHANNEL_COLS, Channel, ChannelItem, SOURCE_COLS, STREAM_COLS, Source, Stream},
};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed, StreamAuthed},
        validate::{PathParams, ValidJson, int_param},
    },
    images::paths::{Size, Target},
    paths::data_dir,
    state::AppState,
};
use axum::{
    Json,
    body::Body as AxumBody,
    extract::{Query, Request, State},
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use fliks_domain::{
    acl::{Action, Subject},
    livetv::names::normalize_group_name,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Live TV channel #{id} not found"))
}

/// `%` and `_` of a user's text are literal.
pub fn like_pattern(q: &str) -> String {
    let mut out = String::from("%");
    for c in q.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The denied-group predicate, both sides folded in SQL so every route agrees; `$2` is the raw denied list.
fn not_denied(alias: &str) -> String {
    format!(
        r#"(cardinality($2::text[]) = 0 OR {alias}."groupName" IS NULL
            OR lower(btrim({alias}."groupName")) <> ALL (SELECT lower(btrim(x)) FROM unnest($2::text[]) AS x))"#
    )
}

/// `$1` user, `$2` denied groups.
const VISIBLE_JOIN: &str = r#"FROM livetv_channels channel
    LEFT JOIN livetv_user_channel_prefs pref ON pref."channelId" = channel.id AND pref."userId" = $1"#;

pub struct Visible<'a> {
    pub user_id: i32,
    pub denied: &'a [String],
    pub group: Option<&'a str>,
    pub favorites_only: bool,
    pub query: Option<&'a str>,
    pub guide_channel_id: Option<&'a str>,
}

impl<'a> Visible<'a> {
    pub fn new(user_id: i32, denied: &'a [String]) -> Self {
        Self {
            user_id,
            denied,
            group: None,
            favorites_only: false,
            query: None,
            guide_channel_id: None,
        }
    }

    fn where_clause(&self) -> String {
        format!(
            r#"WHERE channel.enabled = true AND (pref.hidden IS NULL OR pref.hidden = false)
               AND {} AND ($3::text IS NULL OR channel."groupName" = $3)
               AND (NOT $4::bool OR pref.favorite = true)
               AND ($5::text IS NULL OR channel.name ILIKE $5 ESCAPE '\')
               AND ($6::text IS NULL OR channel."guideChannelId" = $6)"#,
            not_denied("channel")
        )
    }

    /// One page of the lineup, `None` for all of it, with the total.
    pub async fn list(
        &self,
        db: &PgPool,
        page: Option<(i64, i64)>,
    ) -> sqlx::Result<(Vec<ChannelItem>, i64)> {
        let (offset, limit) = page.map_or((0, i64::MAX), |(p, s)| ((p - 1).saturating_mul(s), s));
        let query = self.query.filter(|q| !q.is_empty()).map(like_pattern);
        let group = self.group.filter(|g| !g.is_empty());
        let items = sqlx::query_as::<_, ChannelItem>(sqlx::AssertSqlSafe(format!(
            r#"SELECT channel.id, channel.name, channel.number,
                      CASE WHEN channel."logoPath" LIKE '/api/livetv/channels/%' THEN channel."logoPath" END AS "logoPath",
                      channel."groupName", channel."guideChannelId", COALESCE(pref.favorite, false) AS favorite
               {VISIBLE_JOIN} {}
               ORDER BY COALESCE(pref.favorite, false) DESC, channel.number ASC NULLS LAST, channel."sortIndex" ASC,
                        channel.name ASC, channel.id ASC OFFSET $7 LIMIT $8"#,
            self.where_clause()
        )))
        .bind(self.user_id)
        .bind(self.denied)
        .bind(group)
        .bind(self.favorites_only)
        .bind(query.as_deref())
        .bind(self.guide_channel_id)
        .bind(offset)
        .bind(limit)
        .fetch_all(db)
        .await?;
        let total = self.count(db).await?;
        Ok((items, total))
    }

    pub async fn count(&self, db: &PgPool) -> sqlx::Result<i64> {
        let query = self.query.filter(|q| !q.is_empty()).map(like_pattern);
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) {VISIBLE_JOIN} {}",
            self.where_clause()
        )))
        .bind(self.user_id)
        .bind(self.denied)
        .bind(self.group.filter(|g| !g.is_empty()))
        .bind(self.favorites_only)
        .bind(query.as_deref())
        .bind(self.guide_channel_id)
        .fetch_one(db)
        .await
    }
}

fn read(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Read, Subject::LiveTvChannel)
}

pub async fn denied_for(st: &AppState, a: &Authed) -> sqlx::Result<Vec<String>> {
    denied_groups(&st.db, a.user.id, &permissions(a)).await
}

type Raw = Query<Vec<(String, String)>>;

#[utoipa::path(get, path = "/api/livetv/status", responses((status = 200)))]
pub async fn status(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let denied = denied_for(&st, &a).await?;
    let n = Visible::new(a.user.id, &denied).count(&st.db).await?;
    Ok(Json(json!({"available": n > 0})))
}

/// The filters shared by the channel list and `on-now`: group and query as text, a repeated key is not text.
pub fn text_filter(
    q: &Q,
    errors: &mut Vec<String>,
    key: &str,
    max: Option<usize>,
) -> Option<String> {
    let repeated = q.0.iter().filter(|(k, _)| k == key).count() > 1;
    if repeated {
        errors.push(format!("{key} must be a string"));
        return None;
    }
    let v = q.get(key)?;
    if let Some(m) = max
        && v.encode_utf16().count() > m
    {
        errors.push(format!(
            "{key} must be shorter than or equal to {m} characters"
        ));
    }
    Some(v.to_owned())
}

#[utoipa::path(get, path = "/api/livetv/channels", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Raw,
) -> Result<Json<Vec<ChannelItem>>, AppError> {
    read(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["group", "favoritesOnly", "query"]);
    let group = text_filter(&q, &mut errors, "group", None);
    let query = text_filter(&q, &mut errors, "query", None);
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let denied = denied_for(&st, &a).await?;
    let v = Visible {
        group: group.as_deref(),
        query: query.as_deref(),
        favorites_only: query_flag(q.get("favoritesOnly")),
        ..Visible::new(a.user.id, &denied)
    };
    Ok(Json(v.list(&st.db, None).await?.0))
}

#[derive(sqlx::FromRow)]
struct Located {
    #[sqlx(rename = "groupName")]
    group_name: Option<String>,
}

/// A channel row the caller may see: `enabled_only` for play and prefs, any row for the logo; absent and denied are one answer.
pub async fn visible_channel(
    st: &AppState,
    a: &Authed,
    id: i32,
    enabled_only: bool,
) -> Result<Option<Option<String>>, AppError> {
    let denied = denied_for(st, a).await?;
    let row: Option<Located> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT c."groupName" FROM livetv_channels c WHERE c.id = $1 AND (NOT $3 OR c.enabled) AND {}"#,
        not_denied("c")
    )))
    .bind(id)
    .bind(&denied)
    .bind(enabled_only)
    .fetch_optional(&st.db)
    .await?;
    Ok(row.map(|r| r.group_name))
}

#[utoipa::path(get, path = "/api/livetv/channels/{id}/logo", responses((status = 200), (status = 404)))]
pub async fn logo(
    State(st): State<AppState>,
    StreamAuthed(a): StreamAuthed,
    id: PathParams<String>,
    Query(raw): Raw,
    req: Request,
) -> Result<Response, AppError> {
    read(&a)?;
    let id = int_param(&id.0)?;
    if visible_channel(&st, &a, id, false).await?.is_none() {
        return Err(not_found(id));
    }
    let size = match Q(&raw).get("size") {
        Some("thumb") => Size::Thumb,
        Some("medium") => Size::Medium,
        _ => Size::Full,
    };
    let t = Target::livetv(id);
    let (mut path, mut served) = (t.file(data_dir(), size), size);
    if size != Size::Full && tokio::fs::metadata(&path).await.is_err() {
        (path, served) = (t.file(data_dir(), Size::Full), Size::Full);
    }
    if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_file()) {
        return Err(AppError::bare(StatusCode::NOT_FOUND));
    }
    let mut res = ServeFile::new(path)
        .oneshot(req)
        .await
        .expect("infallible")
        .map(AxumBody::new)
        .into_response();
    let h = res.headers_mut();
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    if served != size {
        h.insert("x-image-size-served", HeaderValue::from_static("full"));
    }
    Ok(res)
}

#[utoipa::path(put, path = "/api/livetv/channels/{id}/prefs", responses((status = 200)))]
pub async fn set_prefs(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<StatusCode, AppError> {
    read(&a)?;
    let id = int_param(&id.0)?;
    let mut b = Body::new(&body, &["favorite", "hidden"]);
    let (favorite, hidden) = (b.opt_bool("favorite"), b.opt_bool("hidden"));
    b.finish()?;
    if visible_channel(&st, &a, id, true).await?.is_none() {
        return Err(not_found(id));
    }
    sqlx::query(
        r#"INSERT INTO livetv_user_channel_prefs ("userId", "channelId", favorite, hidden)
           VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false))
           ON CONFLICT ("userId", "channelId") DO UPDATE SET
             favorite = COALESCE($3, livetv_user_channel_prefs.favorite),
             hidden = COALESCE($4, livetv_user_channel_prefs.hidden)"#,
    )
    .bind(a.user.id)
    .bind(id)
    .bind(favorite.val())
    .bind(hidden.val())
    .execute(&st.db)
    .await?;
    Ok(StatusCode::OK)
}

// ---- admin ---------------------------------------------------------------------------------

/// Case-insensitive name, then the name itself: what `localeCompare` gives for the usual text.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

struct AdminFilter {
    source_id: Option<i64>,
    group: Option<String>,
    enabled: Option<bool>,
    query: Option<String>,
}

const ADMIN_WHERE: &str = r#"WHERE ($1::text IS NULL OR c."groupName" = $1) AND ($2::bool IS NULL OR c.enabled = $2)
    AND ($3::text IS NULL OR c.name ILIKE $3)
    AND ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = c.id AND s2."sourceId" = $4))"#;

#[utoipa::path(get, path = "/api/livetv/admin/channels", responses((status = 200)))]
pub async fn admin_list(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Raw,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["sourceId", "group", "enabled", "query", "page", "pageSize"]);
    let source_id = query_int(&mut errors, "sourceId", q.get("sourceId"), None, None);
    let group = text_filter(&q, &mut errors, "group", None);
    let query = text_filter(&q, &mut errors, "query", None);
    let page = query_int(&mut errors, "page", q.get("page"), Some(1), None)
        .unwrap_or(1)
        .max(1);
    let size = query_int(&mut errors, "pageSize", q.get("pageSize"), Some(1), None)
        .unwrap_or(50)
        .max(1);
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let f = AdminFilter {
        source_id,
        group: group.filter(|g| !g.is_empty()),
        enabled: q.get("enabled").map(|v| v == "true"),
        query: query.filter(|v| !v.is_empty()).map(|v| format!("%{v}%")),
    };
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM livetv_channels c {ADMIN_WHERE}"
    )))
    .bind(f.group.as_deref())
    .bind(f.enabled)
    .bind(f.query.as_deref())
    .bind(f.source_id)
    .fetch_one(&st.db)
    .await?;
    let channels: Vec<Channel> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {CHANNEL_COLS} FROM livetv_channels c {ADMIN_WHERE} ORDER BY c.name ASC, c.id ASC OFFSET $5 LIMIT $6"
    )))
    .bind(f.group.as_deref())
    .bind(f.enabled)
    .bind(f.query.as_deref())
    .bind(f.source_id)
    .bind((page - 1).saturating_mul(size))
    .bind(size)
    .fetch_all(&st.db)
    .await?;
    let ids: Vec<i32> = channels.iter().map(|c| c.id).collect();
    let streams: Vec<Stream> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {STREAM_COLS} FROM livetv_channel_streams s WHERE s."channelId" = ANY($1) ORDER BY s.priority, s.id"#
    )))
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    let source_ids: Vec<i32> = streams.iter().filter_map(|s| s.source_id).collect();
    let sources: Vec<Source> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SOURCE_COLS} FROM livetv_sources WHERE id = ANY($1)"
    )))
    .bind(&source_ids)
    .fetch_all(&st.db)
    .await?;
    let items: Vec<Value> = channels
        .iter()
        .map(|c| {
            let mut v = serde_json::to_value(c).expect("channel");
            v["streams"] = streams
                .iter()
                .filter(|s| s.channel_id == Some(c.id))
                .map(|s| {
                    let mut sv = serde_json::to_value(s).expect("stream");
                    sv["source"] = sources
                        .iter()
                        .find(|x| Some(x.id) == s.source_id)
                        .map_or(Value::Null, |x| serde_json::to_value(x).expect("source"));
                    sv
                })
                .collect();
            v
        })
        .collect();
    let mut groups: Vec<(Option<String>, i64)> = sqlx::query_as(
        r#"SELECT c."groupName", count(*) FROM livetv_channels c
           WHERE ($1::bigint IS NULL OR EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = c.id AND s2."sourceId" = $1))
           GROUP BY c."groupName""#,
    )
    .bind(f.source_id)
    .fetch_all(&st.db)
    .await?;
    groups.sort_by(|x, y| locale_cmp(x.0.as_deref().unwrap_or(""), y.0.as_deref().unwrap_or("")));
    let groups: Vec<Value> = groups
        .into_iter()
        .map(|(name, count)| json!({"name": name, "count": count}))
        .collect();
    Ok(Json(
        json!({"items": items, "total": total, "groups": groups}),
    ))
}

#[utoipa::path(patch, path = "/api/livetv/admin/channels/bulk", responses((status = 200)))]
pub async fn bulk_update(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let mut b = Body::new(&body, &["selection", "enabled", "groupName", "startNumber"]);
    let selection = body.get("selection").filter(|s| s.as_object().is_some());
    if selection.is_none() {
        b.reject("selection must be a non-empty object");
        b.reject("selection must be an object");
    }
    let empty = Value::Object(Default::default());
    let mut sel = Body::new(
        selection.unwrap_or(&empty),
        &["channelIds", "group", "sourceId", "namePattern"],
    );
    let channel_ids = sel.opt_int_list("channelIds");
    let group = sel.opt_string("group");
    let source_id = sel.opt_int("sourceId", None);
    let name_pattern = sel.opt_string("namePattern");
    b.errors
        .extend(sel.errors.into_iter().map(|e| format!("selection.{e}")));
    let enabled = b.opt_bool("enabled");
    let group_name = b.opt_string("groupName");
    let start_number = b.opt_int("startNumber", None);
    // A null the columns cannot take is a 400.
    for (key, null) in [
        ("enabled", enabled == Opt::Null),
        ("startNumber", start_number == Opt::Null),
    ] {
        if null {
            b.reject(format!("{key} must not be null"));
        }
    }
    b.finish()?;
    let ids: Option<Vec<i32>> = channel_ids
        .val()
        .filter(|v| !v.is_empty())
        .map(|v| v.iter().map(|n| *n as i32).collect());
    let text = |o: Opt<String>| o.val().filter(|s| !s.is_empty());
    let (group, pattern) = (text(group), text(name_pattern).map(|p| format!("%{p}%")));
    let mut tx = st.db.begin().await?;
    let matched: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT c.id, c.name FROM livetv_channels c
           WHERE ($1::int[] IS NULL OR c.id = ANY($1)) AND ($2::text IS NULL OR c."groupName" = $2)
             AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM livetv_channel_streams s2 WHERE s2."channelId" = c.id AND s2."sourceId" = $3))
             AND ($4::text IS NULL OR c.name ILIKE $4)"#,
    )
    .bind(ids.as_deref())
    .bind(group.as_deref())
    .bind(source_id.val())
    .bind(pattern.as_deref())
    .fetch_all(&mut *tx)
    .await?;
    if matched.is_empty() {
        return Ok(Json(json!({"affected": 0})));
    }
    let matched_ids: Vec<i32> = matched.iter().map(|m| m.0).collect();
    if let Some(on) = enabled.val() {
        sqlx::query("UPDATE livetv_channels SET enabled = $2 WHERE id = ANY($1)")
            .bind(&matched_ids)
            .bind(on)
            .execute(&mut *tx)
            .await?;
    }
    if group_name.present() {
        let name = normalize_group_name(group_name.val().as_deref());
        sqlx::query(r#"UPDATE livetv_channels SET "groupName" = $2, "groupNameSource" = 'manual' WHERE id = ANY($1)"#)
            .bind(&matched_ids)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(start) = start_number.val() {
        let ordered: Vec<i32> = match &ids {
            Some(requested) => requested
                .iter()
                .copied()
                .filter(|i| matched_ids.contains(i))
                .collect(),
            None => {
                let mut by_name = matched.clone();
                by_name.sort_by(|x, y| locale_cmp(&x.1, &y.1));
                by_name.into_iter().map(|m| m.0).collect()
            }
        };
        renumber(&mut tx, &ordered, start).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"affected": matched_ids.len()})))
}

async fn renumber(
    tx: &mut Transaction<'_, Postgres>,
    ordered: &[i32],
    start: i64,
) -> Result<(), AppError> {
    if ordered.is_empty() {
        return Ok(());
    }
    let numbers: Vec<i64> = (0..ordered.len() as i64).map(|i| start + i).collect();
    if numbers.iter().any(|n| i32::try_from(*n).is_err()) {
        return Err(AppError::bad_request(
            "startNumber must not be greater than 2147483647",
        ));
    }
    sqlx::query(
        "UPDATE livetv_channels c SET number = t.n::int FROM UNNEST($1::int[], $2::bigint[]) AS t(id, n) WHERE c.id = t.id",
    )
    .bind(ordered)
    .bind(&numbers)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[utoipa::path(post, path = "/api/livetv/admin/channels/merge", responses((status = 201)))]
pub async fn merge(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<StatusCode, AppError> {
    admin(&a)?;
    let mut b = Body::new(&body, &["targetChannelId", "sourceChannelIds"]);
    let target = b.int("targetChannelId", None);
    let sources = b.int_list("sourceChannelIds");
    b.finish()?;
    let (Some(target), Some(sources)) = (target, sources) else {
        return Ok(StatusCode::CREATED);
    };
    let target = i32::try_from(target)
        .map_err(|_| AppError::not_found(format!("Live TV channel #{target} not found")))?;
    let ids: Vec<i32> = sources
        .iter()
        .filter_map(|s| i32::try_from(*s).ok())
        .filter(|s| *s != target)
        .collect();
    if ids.is_empty() {
        return Ok(StatusCode::CREATED);
    }
    let mut tx = st.db.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM livetv_channels WHERE id = $1)")
            .bind(target)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(not_found(target));
    }
    let own: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM livetv_channel_streams WHERE "channelId" = $1"#)
            .bind(target)
            .fetch_one(&mut *tx)
            .await?;
    let moving: Vec<i32> = sqlx::query_scalar(
        r#"SELECT id FROM livetv_channel_streams WHERE "channelId" = ANY($1) ORDER BY priority, id"#,
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    if !moving.is_empty() {
        let priorities: Vec<i32> = (0..moving.len() as i64).map(|i| (own + i) as i32).collect();
        sqlx::query(
            r#"UPDATE livetv_channel_streams s SET "channelId" = $1, priority = t.p
               FROM UNNEST($2::int[], $3::int[]) AS t(id, p) WHERE s.id = t.id"#,
        )
        .bind(target)
        .bind(&moving)
        .bind(&priorities)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM livetv_channels WHERE id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

#[utoipa::path(patch, path = "/api/livetv/admin/channels/{id}", responses((status = 200)))]
pub async fn update_channel(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Channel>, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let mut b = Body::new(
        &body,
        &[
            "name",
            "number",
            "groupName",
            "enabled",
            "guideShiftMinutes",
            "guideChannelId",
        ],
    );
    let name = b.opt_string("name");
    let number = b.opt_int("number", None);
    let group = b.opt_string("groupName");
    let enabled = b.opt_bool("enabled");
    let shift = b.opt_int("guideShiftMinutes", None);
    let guide = b.opt_string("guideChannelId");
    // A null on a NOT NULL column is a 400.
    for (key, null) in [
        ("name", name == Opt::Null),
        ("enabled", enabled == Opt::Null),
        ("guideShiftMinutes", shift == Opt::Null),
    ] {
        if null {
            b.reject(format!("{key} must not be null"));
        }
    }
    for (key, v) in [("number", &number), ("guideShiftMinutes", &shift)] {
        if v.clone().val().is_some_and(|n| i32::try_from(n).is_err()) {
            b.reject(format!("{key} must be a 32-bit integer"));
        }
    }
    b.finish()?;
    // A null group is the sentinel, as for any text that normalises to nothing.
    let manual_group = group.present();
    let group = manual_group.then(|| normalize_group_name(group.val().as_deref()));
    let guide_set = guide.present();
    let row: Option<Channel> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"UPDATE livetv_channels c SET
             name = COALESCE($2, c.name),
             number = CASE WHEN $3 THEN $4 ELSE c.number END,
             "groupName" = COALESCE($5, c."groupName"),
             "groupNameSource" = CASE WHEN $6 THEN 'manual' ELSE c."groupNameSource" END,
             enabled = COALESCE($7, c.enabled),
             "guideShiftMinutes" = COALESCE($8, c."guideShiftMinutes"),
             "guideChannelId" = CASE WHEN $9 THEN $10 ELSE c."guideChannelId" END,
             "guideMatchKind" = CASE WHEN $9 THEN 'manual' ELSE c."guideMatchKind" END
           WHERE c.id = $1 RETURNING {CHANNEL_COLS}"#
    )))
    .bind(id)
    .bind(name.val())
    .bind(number.present())
    .bind(number.val().map(|n| n as i32))
    .bind(group)
    .bind(manual_group)
    .bind(enabled.val())
    .bind(shift.val().map(|n| n as i32))
    .bind(guide_set)
    .bind(guide.val())
    .fetch_optional(&st.db)
    .await?;
    row.map(Json).ok_or_else(|| not_found(id))
}

pub async fn find_playable_row(
    db: &PgPool,
    id: i32,
) -> sqlx::Result<Option<(String, Option<String>)>> {
    sqlx::query_as(r#"SELECT name, "groupName" FROM livetv_channels WHERE id = $1 AND enabled"#)
        .bind(id)
        .fetch_optional(db)
        .await
}
