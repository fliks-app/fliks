//! `POST /engine/resolve` (`engine-glue.md` section F): the engine asks whether a credential may read
//! a media file, and where it is; `live` asks the live TV sessions.
use crate::{
    http::{
        AppError,
        auth::{UserRow, load_enabled},
        cookies::{ACCESS_COOKIE, cookie_value},
        validate::ValidJson,
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
};
use fliks_domain::acl::{Action, Permissions, Subject};
use fliks_engine_core::{
    api::{
        ResolveCredentialSource, ResolveMediaId, ResolvePurpose, ResolveRequest, ResolveResponse,
    },
    jsnum,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use subtle::ConstantTimeEq;

const TTL_S: f64 = 60.0;
const PURPOSES: &str = "stream, download, sprite, subtitle, live";
const SOURCES: &str = "cookie, bearer, query, path, basic";
const KEYS: [&str; 6] = [
    "mediaId",
    "credential",
    "credentialSource",
    "purpose",
    "subtitleId",
    "streamIndex",
];

/// `Authorization` is exactly `Bearer <token>`, compared in constant time.
pub(super) fn bearer_is(headers: &HeaderMap, token: &str) -> bool {
    let digest = |s: &str| Sha256::digest(s.as_bytes());
    let got = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    digest(got)
        .ct_eq(&digest(&format!("Bearer {token}")))
        .into()
}

/// `EngineHostGuard`: only the engine, presenting the per-process host token, gets through.
pub struct HostAuth;

impl FromRequestParts<AppState> for HostAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, AppError> {
        if bearer_is(&parts.headers, st.engine.host_token()) {
            Ok(Self)
        } else {
            Err(AppError::bare(StatusCode::UNAUTHORIZED))
        }
    }
}

/// Why a request is not answered with an allow: a refusal the routes would give as a 4xx, or a host fault.
enum Fail {
    Denied,
    Fault(AppError),
}

impl From<sqlx::Error> for Fail {
    fn from(e: sqlx::Error) -> Self {
        Self::Fault(e.into())
    }
}

fn deny() -> ResolveResponse {
    ResolveResponse {
        allow: false,
        path: None,
        owner_id: None,
        format: None,
        ttl_s: Some(TTL_S),
        parts: vec![],
    }
}

/// A live denial names the known user so the engine ends only that owner's viewer.
fn denied_for(req: &ResolveRequest, user_id: i32) -> ResolveResponse {
    ResolveResponse {
        owner_id: (req.purpose == ResolvePurpose::Live).then(|| user_id.to_string()),
        ..deny()
    }
}

#[utoipa::path(post, path = "/engine/resolve", responses((status = 200)))]
pub async fn resolve(
    State(st): State<AppState>,
    _guard: HostAuth,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<ResolveResponse>, AppError> {
    let request = parse(&body).map_err(AppError::bad_request)?;
    let Some((user, perms, raw, bound, file)) = user_for(&st, &request.credential).await? else {
        return Ok(Json(deny()));
    };
    // A live token opens its own viewer's data plane only; a bare denial ends nobody's viewer.
    if bound.is_some_and(|b| request.media_id != ResolveMediaId::Live(b)) {
        return Ok(Json(deny()));
    }
    // A file-bound stream token opens its own file only (sprites and subtitles are of that file too).
    if file.is_some_and(|mf| request.media_id != ResolveMediaId::File(mf)) {
        return Ok(Json(deny()));
    }
    match locate(&st, &user, &perms, &raw, &request).await {
        Ok(found) => Ok(Json(ResolveResponse {
            allow: true,
            owner_id: Some(user.id.to_string()),
            ttl_s: Some(found.ttl_s.unwrap_or(TTL_S)),
            ..found
        })),
        Err(Fail::Denied) => Ok(Json(denied_for(&request, user.id))),
        Err(Fail::Fault(e)) => Err(e),
    }
}

/// The DTO checks of `ResolveRequestDto` under `forbidNonWhitelisted`, with class-validator style messages.
/// `mediaId` is normalized: a file id for the file purposes, the viewer's session id for `live`; a
/// `mediaId` that is neither is `u32::MAX`, which no file has (the routes answered 400, a denial).
fn parse(body: &Value) -> Result<ResolveRequest, Vec<String>> {
    let empty = serde_json::Map::new();
    let obj = body.as_object().unwrap_or(&empty);
    let mut errors: Vec<String> = obj
        .keys()
        .filter(|k| !KEYS.contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    let media_id = obj.get("mediaId").filter(|v| !v.is_null());
    if media_id.is_none() {
        errors.push("mediaId should not be null or undefined".into());
    }
    let credential = obj.get("credential").and_then(Value::as_str);
    if credential.is_none() {
        errors.push("credential must be a string".into());
    }
    let purpose = obj
        .get("purpose")
        .and_then(Value::as_str)
        .and_then(|p| serde_json::from_value::<ResolvePurpose>(p.into()).ok());
    if purpose.is_none() {
        errors.push(format!(
            "purpose must be one of the following values: {PURPOSES}"
        ));
    }
    let credential_source = obj
        .get("credentialSource")
        .filter(|v| !v.is_null())
        .and_then(|v| {
            let source = serde_json::from_value::<ResolveCredentialSource>(v.clone()).ok();
            if source.is_none() {
                errors.push(format!(
                    "credentialSource must be one of the following values: {SOURCES}"
                ));
            }
            source
        });
    let mut optional_int = |key: &str| -> Option<u32> {
        let v = obj.get(key).filter(|v| !v.is_null())?;
        let n = v.as_f64().filter(|_| v.is_number());
        if n.is_none_or(|n| n < 0.0) {
            errors.push(format!("{key} must not be less than 0"));
        }
        if n.is_none_or(|n| n.fract() != 0.0) {
            errors.push(format!("{key} must be an integer number"));
        }
        // Beyond u32 no row exists: the same denial the database lookup gave.
        n.map(|n| {
            if n <= f64::from(u32::MAX) {
                n as u32
            } else {
                u32::MAX
            }
        })
    };
    let subtitle_id = optional_int("subtitleId");
    let stream_index = optional_int("streamIndex");
    let (Some(media_id), Some(credential), Some(purpose), true) =
        (media_id, credential, purpose, errors.is_empty())
    else {
        return Err(errors);
    };
    Ok(ResolveRequest {
        media_id: normalize(media_id, purpose),
        credential: credential.to_owned(),
        purpose,
        subtitle_id,
        stream_index,
        credential_source,
    })
}

fn normalize(media_id: &Value, purpose: ResolvePurpose) -> ResolveMediaId {
    if purpose == ResolvePurpose::Live {
        return ResolveMediaId::Live(match media_id {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.as_f64().map_or_else(String::new, jsnum::js_string),
            _ => String::new(),
        });
    }
    let id = match media_id {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => jsnum::number(s),
        _ => None,
    };
    ResolveMediaId::File(
        id.filter(|n| n.fract() == 0.0 && *n > 0.0 && *n < f64::from(u32::MAX))
            .map_or(u32::MAX, |n| n as u32),
    )
}

/// `tokenOf`: `Bearer <jwt>`, else the `fliks_access` of a cookie header, else the bare token.
fn token_of(credential: &str) -> Option<String> {
    let c = credential.trim();
    let words: Vec<&str> = c.split_whitespace().collect();
    let token = if let [scheme, token] = words[..]
        && scheme.eq_ignore_ascii_case("bearer")
    {
        token.to_owned()
    } else if c.contains('=') {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_bytes(c.as_bytes()).ok()?);
        cookie_value(&headers, ACCESS_COOKIE)?
    } else {
        c.to_owned()
    };
    (!token.is_empty()).then_some(token)
}

/// Same rules as `Authed` (signature, expiry, user still enabled) except that a `scope` claim is accepted:
/// players carry stream tokens in their URLs.
async fn user_for(
    st: &AppState,
    credential: &str,
) -> Result<
    Option<(
        UserRow,
        Permissions,
        Vec<String>,
        Option<String>,
        Option<u32>,
    )>,
    AppError,
> {
    let Some(claims) = token_of(credential).and_then(|t| st.jwt.verify(&t)) else {
        return Ok(None);
    };
    let (live, file) = (claims.live, claims.mf);
    Ok(load_enabled(&st.db, claims.sub).await?.map(|(user, role)| {
        let granted = role.map(|r| r.permissions).unwrap_or_default();
        let perms = Permissions::from(&granted, user.is_admin);
        // `User.permissions`: an admin holds `manage:all` whatever the role says.
        let raw = if user.is_admin {
            vec!["manage:all".to_owned()]
        } else {
            granted
        };
        (user, perms, raw, live, file)
    }))
}

async fn locate(
    st: &AppState,
    user: &UserRow,
    perms: &Permissions,
    raw_perms: &[String],
    req: &ResolveRequest,
) -> Result<ResolveResponse, Fail> {
    let found = |path: Option<String>, format: Option<&str>| ResolveResponse {
        allow: true,
        path,
        owner_id: None,
        format: format.map(str::to_owned),
        ttl_s: None,
        parts: vec![],
    };
    let id = match &req.media_id {
        ResolveMediaId::Live(viewer) => return live(st, viewer, user.id, raw_perms).await,
        ResolveMediaId::File(id) if *id != u32::MAX => *id,
        ResolveMediaId::File(_) => return Err(Fail::Denied),
    };
    if req.purpose == ResolvePurpose::Subtitle
        && let Some(subtitle_id) = req.subtitle_id
    {
        let file = subtitle_on_disk(st, user, perms, subtitle_id).await?;
        let format = file
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        return Ok(found(
            Some(file.to_string_lossy().into_owned()),
            Some(&format),
        ));
    }
    let file = resolve_file(st, user, perms, id).await?;
    let file = file.to_string_lossy().into_owned();
    match req.purpose {
        ResolvePurpose::Sprite => {
            let sprite = crate::paths::cache_dir()
                .join("thumbnails")
                .join(id.to_string())
                .join("sprite.jpg");
            Ok(found(Some(sprite.to_string_lossy().into_owned()), None))
        }
        ResolvePurpose::Subtitle if req.stream_index.is_none() => Err(Fail::Denied),
        ResolvePurpose::Subtitle => Ok(found(Some(file), Some("embedded"))),
        _ => Ok(found(Some(file), None)),
    }
}

/// A live viewer's data plane: allowed while the channel stays playable for its owner, re-checked on every request.
async fn live(
    st: &AppState,
    viewer: &str,
    user_id: i32,
    perms: &[String],
) -> Result<ResolveResponse, Fail> {
    match crate::livetv::session::resolve_live(st, viewer, user_id, perms).await {
        Ok(true) => Ok(ResolveResponse {
            allow: true,
            path: None,
            owner_id: None,
            format: None,
            ttl_s: Some(0.0),
            parts: vec![],
        }),
        Ok(false) => Err(Fail::Denied),
        Err(e) => Err(Fail::Fault(e)),
    }
}

/// Where a file row sits: its library, its folder root and the path stored under that root.
struct Located {
    library_id: Option<i32>,
    folder_path: String,
    stored: String,
}

/// Where a subtitle row sits: its library and the path stored under the folder root.
struct SubLocated {
    library_id: Option<i32>,
    stored: Option<String>,
}

/// A media file the user may read, as its absolute path: library ACL, then the path must stay under the
/// folder root, exist, and not escape it through a symlink. Every refusal is a 404 to the routes.
async fn resolve_file(
    st: &AppState,
    user: &UserRow,
    perms: &Permissions,
    id: u32,
) -> Result<PathBuf, Fail> {
    let id = i32::try_from(id).map_err(|_| Fail::Denied)?;
    let row = sqlx::query_as!(
        Located,
        r#"SELECT m."libraryId" AS library_id, lf.path AS folder_path, mf."relativePath" AS stored
           FROM media_files mf
           LEFT JOIN media m ON m."id" = mf."mediaId"
           JOIN library_folders lf ON lf."id" = mf."folderId"
           WHERE mf."id" = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or(Fail::Denied)?;
    check_library(st, user, perms, row.library_id).await?;
    let absolute = crate::ingest::fsx::locate(&row.folder_path, &row.stored).ok_or(Fail::Denied)?;
    tokio::fs::metadata(&absolute)
        .await
        .map_err(|_| Fail::Denied)?;
    let real = dunce::canonicalize(&absolute).map_err(|_| Fail::Denied)?;
    let root = dunce::canonicalize(&row.folder_path).map_err(|_| Fail::Denied)?;
    if !real.starts_with(&root) {
        return Err(Fail::Denied);
    }
    Ok(real)
}

/// An external subtitle's file: under the media directory by realpath, a regular file, never a link.
async fn subtitle_on_disk(
    st: &AppState,
    user: &UserRow,
    perms: &Permissions,
    id: u32,
) -> Result<PathBuf, Fail> {
    let id = i32::try_from(id).map_err(|_| Fail::Denied)?;
    let row = sqlx::query_as!(
        SubLocated,
        r#"SELECT m."libraryId" AS library_id, sf."filePath" AS stored
           FROM subtitle_files sf
           LEFT JOIN media m ON m."id" = sf."mediaId"
           WHERE sf."id" = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or(Fail::Denied)?;
    check_library(st, user, perms, row.library_id).await?;
    let stored = row
        .stored
        .filter(|s| !s.trim().is_empty())
        .ok_or(Fail::Denied)?;
    // The real parent stays under the media directory and the file is a regular one.
    let (media_id, file_id): (Option<i32>, Option<i32>) =
        sqlx::query_as(r#"SELECT "mediaId", "mediaFileId" FROM subtitle_files WHERE id = $1"#)
            .bind(id)
            .fetch_one(&st.db)
            .await?;
    let media =
        crate::subtitles::files::load_media_of(&st.db, media_id.ok_or(Fail::Denied)?, file_id)
            .await?
            .ok_or(Fail::Denied)?;
    let dirs = media.dirs("no root").map_err(|_| Fail::Denied)?;
    let absolute = dirs.resolve_file(stored.trim()).map_err(|_| Fail::Denied)?;
    dunce::canonicalize(&absolute).map_err(|_| Fail::Denied)
}

/// `getAccessibleLibraryIds`: every library for an admin or `manage:all`, else the user's grants; a media
/// outside a library is denied to everyone.
async fn check_library(
    st: &AppState,
    user: &UserRow,
    perms: &Permissions,
    library_id: Option<i32>,
) -> Result<(), Fail> {
    let Some(library) = library_id else {
        return Err(Fail::Denied);
    };
    if perms.can(Action::Manage, &Subject::All) {
        return Ok(());
    }
    let granted = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM library_user_access WHERE "userId" = $1 AND "libraryId" = $2) AS "granted!""#,
        user.id,
        library
    )
    .fetch_one(&st.db)
    .await?;
    granted.then_some(()).ok_or(Fail::Denied)
}

/// `path.resolve(base, rel)` without touching the disk: `rel` wins when absolute, `.` and `..` fold.
pub(crate) fn lexical_resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.join(rel).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_come_as_bearer_cookie_or_bare_token() {
        for (c, want) in [
            ("Bearer abc", Some("abc")),
            ("  bearer   abc ", Some("abc")),
            ("fliks_access=abc; other=1", Some("abc")),
            ("other=1; fliks_access=a%20b", Some("a b")),
            ("abc", Some("abc")),
            ("Bearer a b", Some("Bearer a b")),
            ("Bearer", Some("Bearer")),
            ("other=1", None),
            ("fliks_access=", None),
            ("", None),
        ] {
            assert_eq!(token_of(c).as_deref(), want, "{c:?}");
        }
    }

    #[test]
    fn lexical_resolve_folds_dots_and_lets_absolute_paths_win() {
        let root = Path::new("/m/Movie");
        assert_eq!(
            lexical_resolve(root, "a/../b.mkv"),
            Path::new("/m/Movie/b.mkv")
        );
        assert_eq!(lexical_resolve(root, ""), Path::new("/m/Movie"));
        assert_eq!(lexical_resolve(root, "/etc/x"), Path::new("/etc/x"));
        let escaped = lexical_resolve(root, "../Other/x.mkv");
        assert!(!escaped.starts_with(root));
        assert!(
            !lexical_resolve(Path::new("/m/Movie"), "../Movie2/x").starts_with(root),
            "a sibling sharing the prefix is outside"
        );
    }

    #[test]
    fn body_validation_matches_the_dto() {
        let msgs = |v: Value| parse(&v).err().unwrap();
        assert_eq!(
            msgs(json!({})),
            [
                "mediaId should not be null or undefined",
                "credential must be a string",
                "purpose must be one of the following values: stream, download, sprite, subtitle, live",
            ]
        );
        assert_eq!(
            msgs(json!({"mediaId": 1, "credential": "x", "purpose": "stream", "extra": 1})),
            ["property extra should not exist"]
        );
        assert_eq!(
            msgs(
                json!({"mediaId": 1, "credential": "x", "purpose": "stream", "credentialSource": "url"})
            ),
            [format!(
                "credentialSource must be one of the following values: {SOURCES}"
            )]
        );
        assert_eq!(
            msgs(
                json!({"mediaId": 1, "credential": "x", "purpose": "stream", "subtitleId": -1, "streamIndex": 1.5})
            ),
            [
                "subtitleId must not be less than 0",
                "streamIndex must be an integer number"
            ]
        );
        assert_eq!(
            msgs(json!({"mediaId": null, "credential": 1, "purpose": "x"})).len(),
            3
        );
        let ok = parse(
            &json!({"mediaId": "12", "credential": "c", "purpose": "download", "subtitleId": null}),
        )
        .unwrap();
        assert_eq!(
            (ok.media_id, ok.subtitle_id),
            (ResolveMediaId::File(12), None)
        );
        let sourced = parse(
            &json!({"mediaId": 1, "credential": "c", "credentialSource": "path", "purpose": "stream"}),
        )
        .unwrap();
        assert_eq!(
            sourced.credential_source,
            Some(ResolveCredentialSource::Path)
        );
    }

    #[test]
    fn media_ids_are_files_or_viewers() {
        let id = |v: Value, p| normalize(&v, p);
        use ResolvePurpose::{Live, Stream};
        assert_eq!(id(json!(7), Stream), ResolveMediaId::File(7));
        assert_eq!(id(json!(" 7 "), Stream), ResolveMediaId::File(7));
        for bad in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("x"),
            json!(true),
            json!(1e12),
        ] {
            assert_eq!(id(bad, Stream), ResolveMediaId::File(u32::MAX));
        }
        assert_eq!(id(json!("abc"), Live), ResolveMediaId::Live("abc".into()));
        assert_eq!(id(json!(5), Live), ResolveMediaId::Live("5".into()));
    }
}
