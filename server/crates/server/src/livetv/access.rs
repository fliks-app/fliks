//! Who may see which channel group (`livetv-access.md` rules 4-8, 21-30): the three settings and the
//! grants as one `State`, serialised by one mutex, and the admin routes over it.
use super::dto::Body;
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    settings::setting_value,
    state::AppState,
};
use axum::{Json, extract::State};
use fliks_domain::{
    acl::{Action, Subject},
    livetv::access::{
        EXEMPT_KEY, RESTRICTED_KEY, State as Groups, VANISHED_KEY, read_group_set, read_vanished,
        restricted_view, write_vanished,
    },
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;

/// One in-process mutex over every read-modify-write of the three keys and the grants (rule 7).
#[derive(Default)]
pub struct Access(tokio::sync::Mutex<()>);

/// The raw permission strings of a user: an admin has `manage:all` whatever the role says.
pub fn permissions(a: &Authed) -> Vec<String> {
    if a.user.is_admin {
        vec!["manage:all".into()]
    } else {
        a.role
            .as_ref()
            .map(|r| r.permissions.clone())
            .unwrap_or_default()
    }
}

async fn load(db: &PgPool) -> sqlx::Result<Groups> {
    let get = |k| async move { setting_value(db, k).await };
    let (restricted, exempt, vanished) = (
        get(RESTRICTED_KEY).await?,
        get(EXEMPT_KEY).await?,
        get(VANISHED_KEY).await?,
    );
    let grants: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT "userId", "groupName" FROM livetv_group_access WHERE "userId" IS NOT NULL"#,
    )
    .fetch_all(db)
    .await?;
    Ok(Groups {
        restricted: read_group_set(restricted.as_deref()),
        exempt: read_group_set(exempt.as_deref()),
        vanished: read_vanished(vanished.as_deref()),
        grants,
        written: vec![],
    })
}

async fn put_setting(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    value: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
           ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()"#,
    )
    .bind(key)
    .bind(value)
    .execute(&mut **tx)
    .await
    .map(drop)
}

/// Writes what the operation changed: the settings it touched and the grants that differ, in one transaction.
async fn save(st: &AppState, before: &Groups, after: &Groups) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    let mut keys: Vec<&'static str> = vec![];
    for k in &after.written {
        if keys.contains(k) {
            continue;
        }
        keys.push(k);
        let value = match *k {
            RESTRICTED_KEY => json!(after.restricted).to_string(),
            EXEMPT_KEY => json!(after.exempt).to_string(),
            _ => write_vanished(&after.vanished),
        };
        put_setting(&mut tx, k, &value).await?;
    }
    let was: HashSet<_> = before.grants.iter().collect();
    let is: HashSet<_> = after.grants.iter().collect();
    for (user, group) in was.difference(&is) {
        sqlx::query(r#"DELETE FROM livetv_group_access WHERE "userId" = $1 AND "groupName" = $2"#)
            .bind(user)
            .bind(group)
            .execute(&mut *tx)
            .await?;
    }
    for (user, group) in is.difference(&was) {
        sqlx::query(r#"INSERT INTO livetv_group_access ("userId", "groupName") VALUES ($1, $2) ON CONFLICT DO NOTHING"#)
            .bind(user)
            .bind(group)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Runs `op` on the loaded state under the mutex and saves the result.
async fn locked<T>(st: &AppState, op: impl FnOnce(&mut Groups) -> T) -> sqlx::Result<T> {
    let _held = st.livetv.access.0.lock().await;
    let before = load(&st.db).await?;
    let mut after = before.clone();
    let out = op(&mut after);
    save(st, &before, &after).await?;
    Ok(out)
}

/// A newly seen adult group starts restricted; the resulting set.
pub async fn restrict_adult_groups(st: &AppState, names: &[String]) -> Result<Vec<String>, String> {
    locked(st, |g| g.restrict_adult(names))
        .await
        .map_err(|e| e.to_string())
}

/// Groups no source carries a channel for any more lose their restriction after the grace; the expired names.
pub async fn expire_vanished_groups(st: &AppState, live: &[String]) -> Result<Vec<String>, String> {
    let grace = super::sync::setting_int(&st.db, "livetv_stale_stream_days", 7)
        .await
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now();
    let expired = locked(st, |g| g.expire(live, grace, now))
        .await
        .map_err(|e| e.to_string())?;
    if !expired.is_empty() {
        tracing::warn!(
            "Dropped Live TV access for vanished channel group(s): {}",
            expired.join(", ")
        );
    }
    Ok(expired)
}

/// The groups a user must not see: every restricted group they were not granted. One settings read when none is.
pub async fn denied_groups(
    db: &PgPool,
    user_id: i32,
    permissions: &[String],
) -> sqlx::Result<Vec<String>> {
    let restricted = read_group_set(setting_value(db, RESTRICTED_KEY).await?.as_deref());
    if restricted.is_empty() {
        return Ok(vec![]);
    }
    let granted: Vec<String> =
        sqlx::query_scalar(r#"SELECT "groupName" FROM livetv_group_access WHERE "userId" = $1"#)
            .bind(user_id)
            .fetch_all(db)
            .await?;
    Ok(fliks_domain::livetv::access::denied_groups(
        &restricted,
        &granted,
        permissions,
    ))
}

fn admin(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Settings)
}

#[utoipa::path(get, path = "/api/livetv/admin/access/restricted-groups", responses((status = 200)))]
pub async fn restricted_groups(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let g = load(&st.db).await?;
    let grace = super::sync::setting_int(&st.db, "livetv_stale_stream_days", 7).await?;
    Ok(Json(json!({
        "groups": restricted_view(&g.restricted, &g.vanished, grace),
        "exempt": g.exempt,
    })))
}

fn groups_body(body: &Value) -> Result<Vec<String>, AppError> {
    let mut b = Body::new(body, &["groups"]);
    let groups = b.strings("groups", 500, 255);
    b.finish()?;
    Ok(groups.unwrap_or_default())
}

#[utoipa::path(put, path = "/api/livetv/admin/access/restricted-groups", responses((status = 200)))]
pub async fn set_restricted_groups(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Vec<String>>, AppError> {
    admin(&a)?;
    let groups = groups_body(&body)?;
    Ok(Json(locked(&st, |g| g.set_restricted(&groups)).await?))
}

#[utoipa::path(get, path = "/api/livetv/admin/access/users", responses((status = 200)))]
pub async fn users(State(st): State<AppState>, a: Authed) -> Result<Json<Vec<Value>>, AppError> {
    admin(&a)?;
    let users = crate::http::auth::load_users(&st.db, None, false).await?;
    let rows: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT "userId", "groupName" FROM livetv_group_access WHERE "userId" IS NOT NULL"#,
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        users
            .into_iter()
            .map(|(u, role)| {
                let perms: Vec<String> = if u.is_admin {
                    vec!["manage:all".into()]
                } else {
                    role.map(|r| r.permissions).unwrap_or_default()
                };
                let groups: Vec<&String> = rows
                    .iter()
                    .filter(|(id, _)| *id == u.id)
                    .map(|(_, g)| g)
                    .collect();
                let full = fliks_domain::livetv::access::ADMIN_PERMISSIONS
                    .iter()
                    .any(|p| perms.iter().any(|q| q == p));
                json!({"id": u.id, "username": u.username, "groups": groups, "hasFullAccess": full})
            })
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/livetv/admin/access/users/{userId}", responses((status = 200)))]
pub async fn grants(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<Vec<String>>, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let rows =
        sqlx::query_scalar(r#"SELECT "groupName" FROM livetv_group_access WHERE "userId" = $1"#)
            .bind(id)
            .fetch_all(&st.db)
            .await?;
    Ok(Json(rows))
}

#[utoipa::path(put, path = "/api/livetv/admin/access/users/{userId}", responses((status = 200)))]
pub async fn set_grants(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let groups = groups_body(&body)?;
    // C135: an unknown user is a 404 before any write.
    let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    if !known && groups.iter().any(|g| !g.trim().is_empty()) {
        let restricted = read_group_set(setting_value(&st.db, RESTRICTED_KEY).await?.as_deref());
        let (matched, _) = fliks_domain::livetv::access::plan_grants(&groups, &restricted);
        if !matched.is_empty() {
            return Err(AppError::not_found(format!("User #{id} not found")));
        }
    }
    let (stored, ignored) = locked(&st, |g| g.set_grants(id, &groups)).await?;
    super::session::revoke_lost_access(&st, id).await;
    Ok(Json(json!({"groups": stored, "ignored": ignored})))
}
