//! `/api/engine/remote*` (`engine-glue.md` section G), and `POST /engine/resolve`.
use super::{
    resolve,
    store::{self, TokenWrite},
    urls_differ,
};
use crate::{
    http::{AppError, auth::Authed, validate::ValidJson},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::PathMapping;
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/engine/remote", get(get_remote).put(put_remote))
        .route("/api/engine/remote/test", post(test_remote))
        .route("/engine/resolve", post(resolve::resolve))
}

/// Field-level checks of the DTOs with class-validator style messages (all of them, not the first).
struct Check<'a> {
    obj: &'a serde_json::Map<String, Value>,
    errors: Vec<String>,
}

impl<'a> Check<'a> {
    /// `forbidNonWhitelisted` first, as the pipe reports it.
    fn new(body: &'a Value, known: &[&str], prefix: &str) -> Self {
        static EMPTY: std::sync::LazyLock<serde_json::Map<String, Value>> =
            std::sync::LazyLock::new(Default::default);
        let obj = body.as_object().unwrap_or(&EMPTY);
        let errors = obj
            .keys()
            .filter(|k| !known.contains(&k.as_str()))
            .map(|k| format!("{prefix}property {k} should not exist"))
            .collect();
        Self { obj, errors }
    }

    /// `@IsString` (or `@IsOptional @IsString` with `optional`): the text, or `None` with the message recorded.
    fn text(&mut self, key: &str, prefix: &str, optional: bool) -> Option<&'a str> {
        match self.obj.get(key) {
            Some(Value::String(s)) => Some(s),
            Some(Value::Null) | None if optional => None,
            _ => {
                self.errors.push(format!("{prefix}{key} must be a string"));
                None
            }
        }
    }
}

struct PutDto {
    url: String,
    token: TokenWrite,
    path_mappings: Vec<PathMapping>,
}

fn parse_put(body: &Value) -> Result<PutDto, Vec<String>> {
    let mut c = Check::new(body, &["url", "token", "pathMappings"], "");
    let url = c.text("url", "", false);
    let token = match c.obj.get("token") {
        None => TokenWrite::Keep,
        Some(Value::String(t)) if t.is_empty() => TokenWrite::Keep,
        Some(Value::String(t)) => TokenWrite::Set(Some(t.clone())),
        Some(Value::Null) => TokenWrite::Set(None),
        _ => {
            c.errors.push("token must be a string".into());
            TokenWrite::Keep
        }
    };
    let mut mappings = vec![];
    match c.obj.get("pathMappings") {
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                let prefix = format!("pathMappings.{i}.");
                let mut m = Check::new(item, &["from", "to"], &prefix);
                let (from, to) = (m.text("from", &prefix, false), m.text("to", &prefix, false));
                c.errors.append(&mut m.errors);
                if let (Some(from), Some(to)) = (from, to) {
                    mappings.push(PathMapping {
                        from: from.to_owned(),
                        to: to.to_owned(),
                    });
                }
            }
        }
        _ => c.errors.push("pathMappings must be an array".into()),
    }
    match (url, c.errors.is_empty()) {
        (Some(url), true) => Ok(PutDto {
            url: url.to_owned(),
            token,
            path_mappings: mappings,
        }),
        _ => Err(c.errors),
    }
}

/// The GET shape: the token is never returned, `secretsSet` says whether one is stored.
async fn snapshot(st: &AppState) -> Result<Value, AppError> {
    let v = store::values(
        &st.db,
        &[store::URL_KEY, store::TOKEN_KEY, store::MAPPINGS_KEY],
    )
    .await?;
    let url = v.get(store::URL_KEY).cloned().unwrap_or_default();
    let status = st.engine.status();
    let process_url = st.cfg.engine_url.clone();
    let mut out = json!({
        "url": url,
        "pathMappings": store::parse_path_mappings(v.get(store::MAPPINGS_KEY).map(String::as_str)),
        "status": status,
        "processUrl": process_url,
    });
    if v.get(store::TOKEN_KEY).is_some_and(|t| !t.is_empty()) {
        out["secretsSet"] = json!([store::TOKEN_KEY]);
    }
    if urls_differ(&url, &process_url) {
        out["mismatch"] = true.into();
    }
    if status == super::Status::Down {
        out["error"] = "The streaming engine is unreachable".into();
    }
    Ok(out)
}

#[utoipa::path(get, path = "/api/engine/remote", responses((status = 200)))]
pub async fn get_remote(
    State(st): State<AppState>,
    authed: Authed,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    snapshot(&st).await.map(Json)
}

/// Saves the three keys, then reconnects to the engine.
#[utoipa::path(put, path = "/api/engine/remote", responses((status = 200)))]
pub async fn put_remote(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let dto = parse_put(&body).map_err(AppError::bad_request)?;
    let mappings = store::sanitize(dto.path_mappings);
    let keys = store::write_engine_settings(&st.db, &dto.url, dto.token, &mappings).await?;
    st.engine.reconfigure().await;
    crate::settings::notify_changed(&st, &keys, None).await;
    snapshot(&st).await.map(Json)
}

#[utoipa::path(post, path = "/api/engine/remote/test", responses((status = 201)))]
pub async fn test_remote(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<super::ConnectionTest>), AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let mut c = Check::new(&body, &["url", "token", "probePath"], "");
    let url = c.text("url", "", false);
    let token = c.text("token", "", true);
    let probe = c.text("probePath", "", true);
    let Some(url) = url.filter(|_| c.errors.is_empty()) else {
        return Err(AppError::bad_request(c.errors));
    };
    let result = st
        .engine
        .test_connection(url, token.unwrap_or(""), probe)
        .await;
    Ok((StatusCode::CREATED, Json(result)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_body_checks_report_every_field_like_the_pipe() {
        let msgs = |v: Value| parse_put(&v).err().unwrap();
        assert_eq!(
            msgs(json!({"url": 5, "token": 1, "pathMappings": [{"from": 1, "x": 0}], "y": 1})),
            [
                "property y should not exist",
                "url must be a string",
                "token must be a string",
                "pathMappings.0.property x should not exist",
                "pathMappings.0.from must be a string",
                "pathMappings.0.to must be a string",
            ]
        );
        assert_eq!(msgs(json!({"url": ""})), ["pathMappings must be an array"]);
        let ok = |t: Value| {
            let mut b = json!({"url": " u ", "pathMappings": [{"from": "a", "to": "b"}]});
            b["token"] = t;
            parse_put(&b).ok().unwrap()
        };
        assert!(matches!(ok(json!("")).token, TokenWrite::Keep));
        assert!(matches!(ok(json!(null)).token, TokenWrite::Set(None)));
        let set = ok(json!("t"));
        assert!(matches!(set.token, TokenWrite::Set(Some(ref t)) if t == "t"));
        assert_eq!((set.url.as_str(), set.path_mappings.len()), (" u ", 1));
        let absent = parse_put(&json!({"url": "", "pathMappings": []}))
            .ok()
            .unwrap();
        assert!(matches!(absent.token, TokenWrite::Keep));
    }
}
