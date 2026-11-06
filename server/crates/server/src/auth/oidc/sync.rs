//! From provider claims to a Fliks user: account resolution, provisioning and the access synced
//! from groups (`docs/spec/auth.md`, OpenID Connect).
use super::{Provider, db, groups_at, username_base};
use crate::{state::AppState, users};
use axum::http::StatusCode;
use serde_json::Value;
use sqlx::PgConnection;

/// Why a login or a link is refused; the client translates the kind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Expired,
    Idp,
    NotAllowed,
    NoAccount,
    Disabled,
    AlreadyLinked,
    Pkce,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Expired => "expired",
            Kind::Idp => "idp",
            Kind::NotAllowed => "not_allowed",
            Kind::NoAccount => "no_account",
            Kind::Disabled => "disabled",
            Kind::AlreadyLinked => "already_linked",
            Kind::Pkce => "pkce",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Kind::NotAllowed | Kind::NoAccount | Kind::Disabled => StatusCode::FORBIDDEN,
            Kind::AlreadyLinked => StatusCode::CONFLICT,
            Kind::Expired | Kind::Idp | Kind::Pkce => StatusCode::BAD_REQUEST,
        }
    }
}

pub enum Fail {
    Kind(Kind),
    Db(sqlx::Error),
}

impl From<Kind> for Fail {
    fn from(k: Kind) -> Self {
        Fail::Kind(k)
    }
}

impl From<sqlx::Error> for Fail {
    fn from(e: sqlx::Error) -> Self {
        Fail::Db(e)
    }
}

/// What the claims say about the person.
#[derive(Debug, Clone)]
pub struct Profile {
    pub sub: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub username: Option<String>,
    pub groups: Vec<String>,
}

pub fn profile(p: &Provider, claims: &Value) -> Profile {
    let text = |k: &str| {
        claims
            .get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let verified = match claims.get("email_verified") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    };
    Profile {
        sub: text("sub").unwrap_or_default(),
        email: text("email"),
        email_verified: verified,
        username: super::claim_at(claims, &p.username_claim)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        groups: p
            .groups_claim
            .as_deref()
            .map(|g| groups_at(claims, g))
            .unwrap_or_default(),
    }
}

/// The allowed-groups gate; it applies to linked users too.
pub fn allowed(p: &Provider, prof: &Profile) -> bool {
    p.allowed_groups.is_empty() || prof.groups.iter().any(|g| p.allowed_groups.contains(g))
}

/// The parts of a user's access the provider's groups decide.
#[derive(Default, Debug, PartialEq)]
pub struct Plan {
    pub is_admin: Option<bool>,
    pub role_id: Option<Option<i32>>,
    pub library_ids: Option<Vec<i32>>,
}

/// Only with a groups claim; each part only when it is configured.
async fn plan(c: &mut PgConnection, p: &Provider, groups: &[String]) -> Result<Plan, sqlx::Error> {
    let mut out = Plan::default();
    if p.groups_claim.is_none() {
        return Ok(out);
    }
    if !p.admin_groups.is_empty() {
        out.is_admin = Some(groups.iter().any(|g| p.admin_groups.contains(g)));
    }
    let mappings = db::role_mappings(&mut *c, p.id).await?;
    if !mappings.is_empty() {
        let role = match mappings.iter().find(|(g, _)| groups.contains(g)) {
            Some((_, r)) => Some(*r),
            None => db::default_role(&mut *c).await?,
        };
        out.role_id = Some(role);
        out.library_ids = match role {
            Some(r) => Some(users::default_libraries(&mut *c, r).await?),
            None => None,
        };
    }
    Ok(out)
}

pub struct Signed {
    pub user_id: i32,
    /// Role, admin flag or libraries changed: the caller drops the user's streams.
    pub access_changed: bool,
}

/// A candidate username for the `n`th try: `name`, `name-2`, ... within 255 characters.
fn candidate(base: &str, n: u32) -> String {
    if n == 1 {
        return base.to_owned();
    }
    let suffix = format!("-{n}");
    let room = 255 - suffix.len();
    format!("{}{suffix}", base.chars().take(room).collect::<String>())
}

async fn provision(
    c: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prof: &Profile,
    plan: &Plan,
) -> Result<i32, Fail> {
    let base = username_base(prof.username.as_deref(), prof.email.as_deref(), &prof.sub);
    for n in 1..=100 {
        let name = candidate(&base, n);
        if db::username_exists(&mut *c, &name).await? {
            continue;
        }
        let mut sp = sqlx::Acquire::begin(&mut *c).await?;
        let made = users::create_user(
            &mut sp,
            users::NewUser {
                username: name,
                email: prof.email.clone().filter(|_| prof.email_verified),
                password_hash: None,
                role_id: plan.role_id.flatten(),
                is_admin: plan.is_admin.unwrap_or(false),
                enabled: true,
                library_ids: plan.library_ids.clone(),
            },
        )
        .await;
        match made {
            Ok(id) => {
                sp.commit().await?;
                return Ok(id);
            }
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => sp.rollback().await?,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Fail::Db(sqlx::Error::Protocol("no free username".into())))
}

/// The user a provider login is for: linked identity, else a verified-email match, else a new
/// account, then the access the groups decide.
pub async fn login_user(st: &AppState, p: &Provider, prof: &Profile) -> Result<Signed, Fail> {
    if !allowed(p, prof) {
        return Err(Kind::NotAllowed.into());
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("oidc:{}:{}", p.id, prof.sub))
        .execute(&mut *tx)
        .await?;
    let enabled = sqlx::query_scalar!(
        r#"SELECT enabled FROM oidc_providers WHERE id = $1 FOR SHARE"#,
        p.id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if enabled != Some(true) {
        return Err(Kind::Expired.into());
    }
    let plan = plan(&mut tx, p, &prof.groups).await?;
    let known = match db::identity_user(&mut tx, p.id, &prof.sub).await? {
        Some(u) => Some(u),
        None => match prof
            .email
            .as_deref()
            .filter(|_| p.match_by_email && prof.email_verified)
        {
            Some(email) => match db::adoptable_by_email(&mut tx, email).await?.as_slice() {
                [only] => {
                    db::insert_identity(&mut tx, *only, p.id, &prof.sub, prof.email.as_deref())
                        .await?;
                    Some(*only)
                }
                _ => None,
            },
            None => None,
        },
    };
    let (user_id, access_changed) = match known {
        Some(id) => {
            let enabled = sqlx::query_scalar!(r#"SELECT enabled FROM users WHERE id = $1"#, id)
                .fetch_one(&mut *tx)
                .await?;
            if !enabled {
                return Err(Kind::Disabled.into());
            }
            (id, apply(&mut tx, id, plan).await?)
        }
        None if p.auto_register => {
            let id = provision(&mut tx, prof, &plan).await?;
            db::insert_identity(&mut tx, id, p.id, &prof.sub, prof.email.as_deref()).await?;
            (id, false)
        }
        None => return Err(Kind::NoAccount.into()),
    };
    tx.commit().await?;
    db::touch_identity(&st.db, p.id, &prof.sub, prof.email.as_deref()).await?;
    Ok(Signed {
        user_id,
        access_changed,
    })
}

/// Writes the planned parts; the last enabled admin is never demoted. True when something changed.
async fn apply(c: &mut PgConnection, id: i32, mut plan: Plan) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT id FROM users WHERE id = $1 FOR UPDATE"#, id)
        .fetch_one(&mut *c)
        .await?;
    let before = db::current_access(&mut *c, id).await?;
    if plan.is_admin == Some(false) && before.1 && users::is_last_enabled_admin(&mut *c, id).await?
    {
        tracing::warn!(user = id, "sso group sync kept the last enabled admin");
        plan.is_admin = None;
    }
    users::apply_access(
        &mut *c,
        id,
        users::Access {
            role_id: plan.role_id,
            is_admin: plan.is_admin,
            library_ids: plan.library_ids,
        },
    )
    .await?;
    Ok(db::current_access(c, id).await? != before)
}

/// Links the identity to `user_id`, the caller's own account.
pub async fn link(st: &AppState, p: &Provider, prof: &Profile, user_id: i32) -> Result<(), Fail> {
    if !allowed(p, prof) {
        return Err(Kind::NotAllowed.into());
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("oidc:{}:{}", p.id, prof.sub))
        .execute(&mut *tx)
        .await?;
    match db::identity_user(&mut tx, p.id, &prof.sub).await? {
        Some(u) if u == user_id => {}
        Some(_) => return Err(Kind::AlreadyLinked.into()),
        None => {
            let other = sqlx::query_scalar!(
                r#"SELECT 1 AS "one!" FROM user_identities WHERE "userId" = $1 AND "providerId" = $2"#,
                user_id,
                p.id
            )
            .fetch_optional(&mut *tx)
            .await?;
            if other.is_some() {
                return Err(Kind::AlreadyLinked.into());
            }
            db::insert_identity(&mut tx, user_id, p.id, &prof.sub, prof.email.as_deref()).await?;
        }
    }
    tx.commit().await?;
    db::touch_identity(&st.db, p.id, &prof.sub, prof.email.as_deref()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clash_adds_a_counter_inside_the_length_limit() {
        assert_eq!(candidate("ann", 1), "ann");
        assert_eq!(candidate("ann", 2), "ann-2");
        let long = "x".repeat(255);
        let c = candidate(&long, 12);
        assert_eq!(c.chars().count(), 255);
        assert!(c.ends_with("-12"));
    }
}
