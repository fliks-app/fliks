use super::{db, grants};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, from_value},
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::Value;

type Res<T> = Result<T, AppError>;

/// Raw JSON per field (`null` kept as `Some(Null)`): class-validator's messages are built in `Dto::parse`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDto {
    #[serde(default, deserialize_with = "present")]
    name: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    permissions: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    is_default: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    default_library_ids: Option<Value>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Default)]
struct Dto {
    name: Option<String>,
    permissions: Option<Vec<String>>,
    is_default: Option<bool>,
    default_library_ids: Option<Vec<i32>>,
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

impl Dto {
    /// `CreateRoleDto` (`create`: name and permissions required) / `UpdateRoleDto`.
    fn parse(body: Value, create: bool) -> Res<Self> {
        let raw: RawDto = from_value(body)?;
        let mut msgs = vec![];
        let mut dto = Self::default();

        match raw.name {
            Some(Value::String(s)) => dto.name = Some(s),
            None if !create => {}
            _ => msgs.push("name must be a string".to_owned()),
        }

        match raw.permissions {
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => {
                dto.permissions = Some(
                    a.into_iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect(),
                );
            }
            None if !create => {}
            // `each` on a non-array validates the value itself, so a lone string only fails IsArray.
            other => {
                if !matches!(other, Some(Value::String(_))) {
                    msgs.push("each value in permissions must be a string".into());
                }
                if !matches!(other, Some(Value::Array(_))) {
                    msgs.push("permissions must be an array".into());
                }
            }
        }

        match raw.is_default {
            Some(Value::Bool(b)) => dto.is_default = Some(b),
            None => {}
            // Nest reads a create's null as false; on update it would store NULL (C1: 400 instead).
            Some(Value::Null) if create => {}
            _ => msgs.push("isDefault must be a boolean value".into()),
        }

        match raw.default_library_ids {
            Some(Value::Array(a)) if a.iter().all(|v| int(v).is_some()) => {
                // An id outside i32 matches no library, like an unknown one.
                dto.default_library_ids = Some(
                    a.iter()
                        .filter_map(|v| int(v).and_then(|n| i32::try_from(n).ok()))
                        .collect(),
                );
            }
            None => {}
            Some(Value::Null) => dto.default_library_ids = Some(vec![]),
            other => {
                if !other.as_ref().is_some_and(|v| int(v).is_some()) {
                    msgs.push("each value in defaultLibraryIds must be an integer number".into());
                }
                if !matches!(other, Some(Value::Array(_))) {
                    msgs.push("defaultLibraryIds must be an array".into());
                }
            }
        }

        if msgs.is_empty() {
            Ok(dto)
        } else {
            Err(AppError::bad_request(msgs))
        }
    }
}

fn forbidden() -> AppError {
    AppError::bare(StatusCode::FORBIDDEN)
}

/// F12: added strings must come from `GET /roles/permissions`; adding `manage:all` needs an admin.
async fn check_permissions(st: &AppState, a: &Authed, perms: &[String]) -> Res<()> {
    let mut known = None;
    for p in perms {
        if p == "manage:all" {
            if !a.perms.can(Action::Manage, &Subject::All) {
                return Err(forbidden());
            }
            continue;
        }
        if known.is_none() {
            known = Some(grantable(st).await?);
        }
        if !known.as_deref().unwrap_or_default().contains(p) {
            return Err(AppError::bad_request(vec![
                "permissions contains invalid values",
            ]));
        }
    }
    Ok(())
}

async fn grantable(st: &AppState) -> Res<Vec<String>> {
    let mut out: Vec<String> = grants::PERMISSIONS.iter().map(|p| p.to_string()).collect();
    if std::env::var("FLIKS_PLUGINS_DISABLED").as_deref() != Ok("1") {
        out.extend(grants::plugin_grants(&db::plugin_manifests(&st.db).await?));
    }
    Ok(out)
}

pub async fn list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<db::Role>>> {
    a.require(Action::Read, Subject::Role)?;
    Ok(Json(db::list(&st.db).await?))
}

pub async fn permissions(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<String>>> {
    a.require(Action::Manage, Subject::Role)?;
    Ok(Json(grantable(&st).await?))
}

async fn one(st: &AppState, id: i32) -> Res<db::Role> {
    db::find(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Role #{id} not found")))
}

pub async fn get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<Json<db::Role>> {
    a.require(Action::Read, Subject::Role)?;
    Ok(Json(one(&st, id).await?))
}

const NAME_TAKEN: &str = "Role name already exists";

pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Role)?;
    let dto = Dto::parse(body, true)?;
    let (name, perms) = (
        dto.name.unwrap_or_default(),
        dto.permissions.unwrap_or_default(),
    );
    check_permissions(&st, &a, &perms).await?;
    if db::name_taken(&st.db, &name).await? {
        return Err(AppError::conflict(NAME_TAKEN));
    }
    let is_default = dto.is_default.unwrap_or(false);
    if is_default {
        db::clear_default(&st.db).await?;
    }
    let id = db::insert(&st.db, &name, &perms, is_default).await?;
    db::set_libraries(&st.db, id, &dto.default_library_ids.unwrap_or_default()).await?;
    let mut role = serde_json::to_value(one(&st, id).await?).unwrap_or_default();
    // Nest returns the freshly loaded libraries here without their profile-id columns (recorded `roles-create-ok`).
    for lib in role["defaultLibraries"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        if let Some(l) = lib.as_object_mut() {
            l.remove("defaultQualityProfileId");
            l.remove("defaultLanguageProfileId");
        }
    }
    Ok((StatusCode::CREATED, Json(role)))
}

pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<Value>,
) -> Res<Json<db::Role>> {
    a.require(Action::Manage, Subject::Role)?;
    let dto = Dto::parse(body, false)?;
    let role = one(&st, id).await?;
    if let Some(p) = &dto.permissions {
        // Grants already on the role (e.g. from a since-removed plugin) may be resent unchecked.
        let added: Vec<String> = p
            .iter()
            .filter(|x| !role.permissions.contains(x))
            .cloned()
            .collect();
        check_permissions(&st, &a, &added).await?;
    }
    let name = dto.name.filter(|n| *n != role.name);
    if let Some(n) = &name
        && db::name_taken(&st.db, n).await?
    {
        return Err(AppError::conflict(NAME_TAKEN));
    }
    if dto.is_default == Some(true) {
        db::clear_default(&st.db).await?;
    }
    db::update(
        &st.db,
        id,
        name.as_deref(),
        dto.permissions.as_deref(),
        dto.is_default,
    )
    .await?;
    if let Some(ids) = &dto.default_library_ids {
        db::set_libraries(&st.db, id, ids).await?;
    }
    Ok(Json(one(&st, id).await?))
}

pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Role)?;
    let role = one(&st, id).await?;
    let n = db::user_count(&st.db, id).await?;
    if n > 0 {
        return Err(AppError::conflict(format!(
            "Cannot delete role \"{}\": still assigned to {n} user(s)",
            role.name
        )));
    }
    db::delete(&st.db, id).await?;
    Ok(StatusCode::OK)
}
