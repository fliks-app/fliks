//! A source sync (`livetv-sources.md` rules 33-44): single-flight, fetched, classified, upserted in one
//! transaction, then the account, adult-guard, vanished-group and logo passes.
use super::{
    access, lineup,
    model::{SOURCE_COLS, Source},
    net::Validators,
};
use crate::{
    events::Hub,
    jobs::{Command, Trigger, execute, insert_queued_with_body, mark_running},
    notifications,
    state::AppState,
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use fliks_domain::livetv::{
    access::iso,
    sync::{
        AccountState, ChannelRow, Classified, Entry, GroupPattern, PatternField, StreamRow,
        account_state, classify_entries, plan_upsert,
    },
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, Transaction};

/// A refresh returning less than this share of the known lineup is a truncated response.
const SHRINK_RATIO: f64 = 0.5;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub ok: bool,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub channel_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SyncResult {
    fn failed(channel_count: i32, error: String) -> Self {
        Self {
            ok: false,
            added: 0,
            updated: 0,
            removed: 0,
            channel_count,
            error: Some(error),
        }
    }
}

#[derive(Debug)]
pub enum SyncError {
    /// 409 `errors.already_running`.
    Running,
    NotFound(i32),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// Registers the activity `<kind>:<id>` for the life of the guard: the single-flight gate of rule 33.
pub struct Flight {
    hub: Hub,
    id: String,
}

impl Flight {
    pub fn claim(st: &AppState, kind: &str, id: i32) -> Option<Self> {
        let name = format!("{kind}:{id}");
        st.hub
            .activity()
            .claim(&name, kind, None, None, None, None)
            .then(|| Self {
                hub: st.hub.clone(),
                id: name,
            })
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        self.hub.activity().remove(&self.id);
    }
}

/// `Prefer: respond-async` among the request's preferences.
pub fn wants_async(headers: &HeaderMap) -> bool {
    headers
        .get_all("prefer")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|p| {
            p.split(';')
                .next()
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("respond-async"))
        })
}

/// Runs a claimed sync detached under a queued `commands` row; the claim is held until it ends.
pub async fn detach<F, Fut>(
    st: &AppState,
    flight: Flight,
    name: &'static str,
    body: Value,
    work: F,
) -> sqlx::Result<Command>
where
    F: FnOnce(AppState) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    let cmd = insert_queued_with_body(&st.db, name, Trigger::Manual, Some(body)).await?;
    let (st, id) = (st.clone(), cmd.id);
    tokio::spawn(async move {
        if let Err(e) = mark_running(&st.db, id).await {
            tracing::error!("Command {name}: cannot record running: {e}");
        }
        execute(&st, id, name, "failed", work(st.clone())).await;
        drop(flight);
    });
    Ok(cmd)
}

/// A sync that ended `ok:false` is a failed command, like a thrown one.
pub fn outcome(r: Result<(bool, Option<String>), SyncError>) -> Result<(), String> {
    match r {
        Ok((true, _)) => Ok(()),
        Ok((false, error)) => Err(error.unwrap_or_default()),
        Err(e) => Err(format!("{e:?}")),
    }
}

/// The 202 of a `Prefer: respond-async` sync.
pub fn accepted(cmd: Command) -> Response {
    (
        StatusCode::ACCEPTED,
        [("preference-applied", "respond-async")],
        Json(cmd),
    )
        .into_response()
}

pub async fn find_source(db: &PgPool, id: i32) -> sqlx::Result<Option<Source>> {
    sqlx::query_as(&format!(
        "SELECT {SOURCE_COLS}, password FROM livetv_sources WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn setting_int(db: &PgPool, key: &str, default: i64) -> sqlx::Result<i64> {
    let raw = crate::settings::setting_value(db, key).await?;
    Ok(raw
        .as_deref()
        .and_then(fliks_domain::js::parse_int)
        .unwrap_or(default))
}

pub async fn sync(st: &AppState, id: i32) -> Result<SyncResult, SyncError> {
    let Some(_flight) = Flight::claim(st, "LiveTvSourceSync", id) else {
        return Err(SyncError::Running);
    };
    run(st, id).await
}

/// The async twin of `sync` (C164): the queued row of a sync that runs on.
pub async fn start(st: &AppState, id: i32) -> Result<Command, SyncError> {
    let Some(flight) = Flight::claim(st, "LiveTvSourceSync", id) else {
        return Err(SyncError::Running);
    };
    find_source(&st.db, id)
        .await?
        .ok_or(SyncError::NotFound(id))?;
    let work =
        move |st: AppState| async move { outcome(run(&st, id).await.map(|r| (r.ok, r.error))) };
    Ok(detach(
        st,
        flight,
        "LiveTvSourceSync",
        json!({"sourceId": id}),
        work,
    )
    .await?)
}

async fn mark(db: &PgPool, id: i32, ok: bool, error: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE livetv_sources SET "lastSyncAt" = now(), "lastSyncStatus" = $2, "lastSyncError" = $3 WHERE id = $1"#)
        .bind(id)
        .bind(if ok { "ok" } else { "error" })
        .bind(error)
        .execute(db)
        .await
        .map(drop)
}

fn pattern(raw: &Option<String>, side: &str, source: &Source) -> Option<GroupPattern> {
    let p = raw.as_deref().filter(|p| !p.is_empty())?;
    match GroupPattern::compile(p) {
        Ok(g) => Some(g),
        Err(_) => {
            let outcome = if side == "include" {
                "every group imports"
            } else {
                "nothing is excluded"
            };
            tracing::warn!(
                "Source #{} {side}GroupsPattern is invalid, ignoring it ({outcome})",
                source.id
            );
            None
        }
    }
}

/// Patterns as the sync reads them: an invalid one, or one that hits the backtrack limit, is ignored for the run.
fn classify(source: &Source, entries: Vec<Entry>) -> Classified {
    let mut include = pattern(&source.include_groups_pattern, "include", source);
    let mut exclude = pattern(&source.exclude_groups_pattern, "exclude", source);
    loop {
        match classify_entries(entries.clone(), include.as_ref(), exclude.as_ref()) {
            Ok(c) => return c,
            Err((field, msg)) => {
                tracing::warn!(
                    "Source #{} group pattern gave up ({msg}), ignoring it",
                    source.id
                );
                match field {
                    PatternField::Include => include = None,
                    PatternField::Exclude => exclude = None,
                }
            }
        }
    }
}

async fn run(st: &AppState, id: i32) -> Result<SyncResult, SyncError> {
    let db = &st.db;
    let source = find_source(db, id).await?.ok_or(SyncError::NotFound(id))?;
    let conn = lineup::Conn {
        kind: source.kind.clone(),
        url: source.url.clone(),
        username: source.username.clone(),
        password: source.password.clone(),
        user_agent: source.user_agent.clone(),
        referer: source.referer.clone(),
    };
    let validators = Validators {
        etag: source.playlist_etag.as_deref(),
        last_modified: source.playlist_last_modified.as_deref(),
    };
    let fetched = match lineup::fetch(&conn, &validators, false).await {
        Ok(f) => f,
        Err(message) => {
            mark(db, id, false, Some(&message)).await?;
            tracing::warn!("Sync \"{}\" failed: {message}", source.name);
            return Ok(SyncResult::failed(source.channel_count, message));
        }
    };
    let lineup::Fetched::Lineup(fetched) = fetched else {
        mark(db, id, true, None).await?;
        tracing::info!("Sync \"{}\": not modified, lineup unchanged", source.name);
        maybe_expire_vanished(st).await;
        return Ok(SyncResult {
            ok: true,
            added: 0,
            updated: 0,
            removed: 0,
            channel_count: source.channel_count,
            error: None,
        });
    };
    let Classified {
        live,
        on_demand_count,
        groups,
    } = classify(&source, fetched.entries.clone());
    if source.channel_count > 0
        && (live.len() as f64) < f64::from(source.channel_count) * SHRINK_RATIO
    {
        let message = format!(
            "refresh returned {} live entries against {} known: treating it as a truncated response and keeping the current lineup",
            live.len(),
            source.channel_count
        );
        mark(db, id, false, Some(&message)).await?;
        tracing::warn!("Sync \"{}\" refused: {message}", source.name);
        return Ok(SyncResult::failed(source.channel_count, message));
    }
    let stale_days = setting_int(db, "livetv_stale_stream_days", 7).await?;
    let now = Utc::now();
    let new_expires = fetched.expires_at.or(source.expires_at);
    let new_status = fetched
        .account_status
        .clone()
        .or(source.account_status.clone());
    let mut tx = db.begin().await?;
    let counts = upsert(&mut tx, &source, &live, now, stale_days).await?;
    notify_account(st, &source, new_expires, new_status.as_deref());
    let max_streams = match fetched.max_connections {
        Some(n) if n != 0 && !source.max_streams_is_manual => n,
        _ => source.max_streams,
    };
    // Xtream guide urls carry the panel password: they are derived on demand, never stored (F71).
    let guide_urls = if source.kind == "xtream" {
        vec![]
    } else {
        fetched.guide_urls.clone()
    };
    sqlx::query(
        r#"UPDATE livetv_sources SET "lastSyncAt" = $2, "lastSyncStatus" = 'ok', "lastSyncError" = NULL,
           "channelCount" = $3, "guideUrls" = $4, "playlistEtag" = $5, "playlistLastModified" = $6,
           "expiresAt" = $7, "accountStatus" = $8, "maxStreams" = $9 WHERE id = $1"#,
    )
    .bind(id)
    .bind(now)
    .bind(live.len() as i32)
    .bind(sqlx::types::Json(guide_urls))
    .bind(&fetched.playlist_etag)
    .bind(&fetched.playlist_last_modified)
    .bind(new_expires)
    .bind(new_status)
    .bind(max_streams)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(
        "Sync \"{}\": added={} updated={} removed={} (live={} onDemandSkipped={on_demand_count})",
        source.name,
        counts.0,
        counts.1,
        counts.2,
        live.len()
    );
    adult_guard(st, &source, groups.iter().map(|g| g.name.clone()).collect()).await;
    maybe_expire_vanished(st).await;
    let st = st.clone();
    tokio::spawn(async move { super::logos::cache_source(&st, id).await });
    Ok(SyncResult {
        ok: true,
        added: counts.0,
        updated: counts.1,
        removed: counts.2,
        channel_count: live.len() as i32,
        error: None,
    })
}

type Counts = (usize, usize, usize);

/// Rule 38: the plan of `plan_upsert`, written set-based inside the caller's transaction.
async fn upsert(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    entries: &[Entry],
    now: DateTime<Utc>,
    stale_days: i64,
) -> sqlx::Result<Counts> {
    type StreamRaw = (i32, Option<i32>, String, Option<DateTime<Utc>>);
    let existing: Vec<StreamRaw> = sqlx::query_as(
        r#"SELECT id, "channelId", "externalId", "lastSeenAt" FROM livetv_channel_streams WHERE "sourceId" = $1"#,
    )
    .bind(source.id)
    .fetch_all(&mut **tx)
    .await?;
    let streams: Vec<StreamRow> = existing
        .into_iter()
        .filter_map(|(id, channel, external_id, last_seen_at)| {
            Some(StreamRow {
                id,
                channel_id: channel?,
                external_id,
                last_seen_at,
            })
        })
        .collect();
    type ChannelRaw = (i32, String, Option<String>, String, Option<String>);
    let chans: Vec<ChannelRaw> = sqlx::query_as(
        r#"SELECT id, name, "groupName", "groupNameSource", "guideChannelId" FROM livetv_channels ORDER BY id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    let links: Vec<(Option<i32>, Option<i32>)> =
        sqlx::query_as(r#"SELECT "channelId", "sourceId" FROM livetv_channel_streams"#)
            .fetch_all(&mut **tx)
            .await?;
    let mut total: std::collections::HashMap<i32, usize> = Default::default();
    let mut mine: std::collections::HashSet<i32> = Default::default();
    for (channel, src) in links {
        let Some(channel) = channel else { continue };
        *total.entry(channel).or_default() += 1;
        if src == Some(source.id) {
            mine.insert(channel);
        }
    }
    let channels: Vec<ChannelRow> = chans
        .into_iter()
        .map(
            |(id, name, group_name, group_source, guide_channel_id)| ChannelRow {
                id,
                name,
                group_name,
                group_is_manual: group_source == "manual",
                guide_channel_id,
                stream_count: total.get(&id).copied().unwrap_or(0),
                has_stream_of_source: mine.contains(&id),
            },
        )
        .collect();
    let plan = plan_upsert(entries, &streams, &channels, now, stale_days);

    let e = |i: usize| &entries[i];
    // New channels first: their ids pair with the entries by row order.
    let new_ids: Vec<i32> = if plan.new_channels.is_empty() {
        vec![]
    } else {
        let pick = |f: fn(&Entry) -> Option<String>| {
            plan.new_channels
                .iter()
                .map(|i| f(e(*i)))
                .collect::<Vec<_>>()
        };
        sqlx::query_scalar(
            r#"INSERT INTO livetv_channels (name, number, "logoPath", "groupName", enabled, "guideChannelId", "guideMatchKind", "guideShiftMinutes")
               SELECT t.name, t.number, t.logo, t.grp, false, t.guide, NULL, t.shift
               FROM UNNEST($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::int[]) WITH ORDINALITY
                    AS t(name, number, logo, grp, guide, shift, ord)
               ORDER BY t.ord RETURNING id"#,
        )
        .bind(plan.new_channels.iter().map(|i| e(*i).name.clone()).collect::<Vec<_>>())
        .bind(plan.new_channels.iter().map(|i| e(*i).number).collect::<Vec<_>>())
        .bind(pick(|x| x.logo.clone()))
        .bind(plan.new_channels.iter().map(|i| e(*i).group_name.clone()).collect::<Vec<_>>())
        .bind(pick(|x| x.tvg_id.clone()))
        .bind(plan.new_channels.iter().map(|i| e(*i).shift_minutes).collect::<Vec<_>>())
        .fetch_all(&mut **tx)
        .await?
    };
    // (channel, entry, priority) of every stream added: the folds first, then one per new channel.
    let mut added: Vec<(i32, usize, i32)> = plan.folds.clone();
    added.extend(
        new_ids
            .iter()
            .zip(&plan.new_channels)
            .map(|(c, i)| (*c, *i, 0)),
    );
    if !added.is_empty() {
        sqlx::query(
            r#"INSERT INTO livetv_channel_streams ("channelId", "sourceId", "externalId", url, priority, "qualityLabel", "providerName", "userAgent", referer, "lastSeenAt")
               SELECT t.channel, $1, t.ext, t.url, t.priority, t.quality, t.name, t.ua, t.referer, $2
               FROM UNNEST($3::int[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[])
                    AS t(channel, ext, url, priority, quality, name, ua, referer)"#,
        )
        .bind(source.id)
        .bind(now)
        .bind(added.iter().map(|a| a.0).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).external_id.clone()).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).url.clone()).collect::<Vec<_>>())
        .bind(added.iter().map(|a| a.2).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).quality_label.clone()).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).name.clone()).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).user_agent.clone()).collect::<Vec<_>>())
        .bind(added.iter().map(|a| e(a.1).referer.clone()).collect::<Vec<_>>())
        .execute(&mut **tx)
        .await?;
    }
    if !plan.updates.is_empty() {
        sqlx::query(
            r#"UPDATE livetv_channel_streams s SET url = t.url, "providerName" = t.name, "qualityLabel" = t.quality,
                      "userAgent" = t.ua, referer = t.referer, "lastSeenAt" = $1
               FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                    AS t(id, url, name, quality, ua, referer)
               WHERE s.id = t.id"#,
        )
        .bind(now)
        .bind(plan.updates.iter().map(|u| u.0).collect::<Vec<_>>())
        .bind(plan.updates.iter().map(|u| e(u.1).url.clone()).collect::<Vec<_>>())
        .bind(plan.updates.iter().map(|u| e(u.1).name.clone()).collect::<Vec<_>>())
        .bind(plan.updates.iter().map(|u| e(u.1).quality_label.clone()).collect::<Vec<_>>())
        .bind(plan.updates.iter().map(|u| e(u.1).user_agent.clone()).collect::<Vec<_>>())
        .bind(plan.updates.iter().map(|u| e(u.1).referer.clone()).collect::<Vec<_>>())
        .execute(&mut **tx)
        .await?;
    }
    if !plan.patches.is_empty() {
        sqlx::query(
            r#"UPDATE livetv_channels c SET "guideChannelId" = t.guide, "groupName" = t.grp
               FROM UNNEST($1::int[], $2::text[], $3::text[]) AS t(id, guide, grp) WHERE c.id = t.id"#,
        )
        .bind(plan.patches.iter().map(|p| p.0).collect::<Vec<_>>())
        .bind(plan.patches.iter().map(|p| p.1.clone()).collect::<Vec<_>>())
        .bind(plan.patches.iter().map(|p| p.2.clone()).collect::<Vec<_>>())
        .execute(&mut **tx)
        .await?;
    }
    if !plan.removed_streams.is_empty() {
        sqlx::query("DELETE FROM livetv_channel_streams WHERE id = ANY($1)")
            .bind(&plan.removed_streams)
            .execute(&mut **tx)
            .await?;
        delete_orphans(tx, &plan.affected_channels).await?;
    }
    Ok((plan.added(), plan.updates.len(), plan.removed_streams.len()))
}

/// Channels of `ids` left with no stream at all (their prefs cascade).
pub async fn delete_orphans(tx: &mut Transaction<'_, Postgres>, ids: &[i32]) -> sqlx::Result<()> {
    sqlx::query(
        r#"DELETE FROM livetv_channels c WHERE c.id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM livetv_channel_streams s WHERE s."channelId" = c.id)"#,
    )
    .bind(ids)
    .execute(&mut **tx)
    .await
    .map(drop)
}

/// Only a change to `expired` or `expiring` is told, never a repeat of the same state.
fn notify_account(
    st: &AppState,
    source: &Source,
    expires: Option<DateTime<Utc>>,
    status: Option<&str>,
) {
    let now = Utc::now();
    let before = account_state(source.expires_at, source.account_status.as_deref(), now);
    let after = account_state(expires, status, now);
    if before == after {
        return;
    }
    let event = match after {
        AccountState::Expired => "livetv.account_expired",
        AccountState::Expiring => "livetv.account_expiring",
        AccountState::Ok => return,
    };
    dispatch(
        st,
        event,
        json!({"sourceName": source.name, "expiresAt": expires.map(iso)}),
    );
}

/// Fire and forget: a failing sender never touches the sync.
pub fn dispatch(st: &AppState, event: &'static str, payload: Value) {
    let db = st.db.clone();
    tokio::spawn(async move {
        let map: Map<String, Value> = payload.as_object().cloned().unwrap_or_default();
        if let Err(e) = notifications::dispatch(&db, event, &map).await {
            tracing::warn!("notification {event} not sent: {e}");
        }
    });
}

async fn adult_guard(st: &AppState, source: &Source, groups: Vec<String>) {
    let error = match access::restrict_adult_groups(st, &groups).await {
        Ok(_) => None,
        Err(e) => {
            tracing::error!(
                "Adult-group restriction pass failed for \"{}\": {e}",
                source.name
            );
            dispatch(
                st,
                "livetv.adult_guard_failed",
                json!({"sourceName": source.name}),
            );
            Some(e)
        }
    };
    if error.is_none() && source.last_adult_guard_error.is_none() {
        return;
    }
    let _ = sqlx::query(r#"UPDATE livetv_sources SET "lastAdultGuardError" = $2 WHERE id = $1"#)
        .bind(source.id)
        .bind(error)
        .execute(&st.db)
        .await;
}

/// The sweep runs only when every enabled source last synced fine: a partial view must never look like a vanished group.
pub async fn maybe_expire_vanished(st: &AppState) {
    let go = async {
        let statuses: Vec<String> =
            sqlx::query_scalar(r#"SELECT "lastSyncStatus" FROM livetv_sources WHERE enabled"#)
                .fetch_all(&st.db)
                .await
                .map_err(|e| e.to_string())?;
        if statuses.is_empty() || statuses.iter().any(|s| s != "ok") {
            return Ok::<_, String>(());
        }
        let live: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT "groupName" FROM livetv_channels c
               WHERE EXISTS (SELECT 1 FROM livetv_channel_streams s WHERE s."channelId" = c.id) AND "groupName" IS NOT NULL"#,
        )
        .fetch_all(&st.db)
        .await
        .map_err(|e| e.to_string())?;
        access::expire_vanished_groups(st, &live).await.map(drop)
    };
    if let Err(e) = go.await {
        tracing::warn!("Vanished-group cleanup pass failed: {e}");
    }
}
