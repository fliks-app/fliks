//! The EPUB reader routes (`docs/spec/books-reader.md`): a Readium manifest, the positions list and
//! the sanitised resources of an EPUB edition, read from the zip without extracting it.
mod manifest;
pub mod sanitize;

use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::books::archive::{EntryError, OPF_CAP, read_entry, rootfile},
    libraries::{accessible_library_ids, readable_file},
    state::AppState,
    stream::resolve_file,
};
use axum::{
    Router,
    http::{
        HeaderName, StatusCode,
        header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use fliks_domain::{
    acl::{Action, Subject},
    books::{opf, package},
};
use manifest::Class;
use std::{collections::HashSet, fs::File, io::BufReader, path::PathBuf};
use zip::ZipArchive;

const CORP: HeaderName = HeaderName::from_static("cross-origin-resource-policy");
const MARKUP_CAP: u64 = 8 * 1024 * 1024;
const ASSET_CAP: u64 = 32 * 1024 * 1024;
const RESOURCE_CSP: &str = "default-src 'none'; script-src 'none'; img-src 'self' data:; \
style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; sandbox";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/books/{itemId}/pub/{*path}", get(resource))
}

fn item_missing(item: i32) -> AppError {
    AppError::not_found(format!("Item #{item} not found"))
}

/// One lookup applies the ACL, so a hidden item costs what a missing one does and reads like it.
async fn epub_path(st: &AppState, a: &Authed, item: i32) -> Result<PathBuf, AppError> {
    let acl = accessible_library_ids(&st.db, a).await?;
    let file: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT mf.id FROM items i
           JOIN media m ON m.id = i."mediaId" AND m."libraryId" = ANY($2)
           JOIN editions e ON e.id = i."editionId" AND e.family = 'text'
           JOIN item_parts ip ON ip."itemId" = i.id
           JOIN media_files mf ON mf.id = ip."mediaFileId" AND lower(mf."relativePath") LIKE '%.epub'
           WHERE i.id = $1 AND {}
           ORDER BY ip.version DESC, ip.position, mf.id LIMIT 1"#,
        readable_file("$2", "mf.id")
    )))
    .bind(item)
    .bind(&acl)
    .fetch_optional(&st.db)
    .await?;
    let file = file.ok_or_else(|| item_missing(item))?;
    let file = resolve_file(st, None, i64::from(file)).await.map_err(|e| {
        if e.status() == StatusCode::NOT_FOUND {
            item_missing(item)
        } else {
            e
        }
    })?;
    Ok(file.absolute)
}

#[utoipa::path(get, path = "/api/books/{itemId}/pub/{path}", responses((status = 200)))]
pub async fn resource(
    axum::extract::State(st): axum::extract::State<AppState>,
    a: Authed,
    p: Result<PathParams<(i32, String)>, AppError>,
) -> Result<Response, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let PathParams((item, rest)) = p?;
    let path = epub_path(&st, &a, item).await?;
    let (content_type, body) = tokio::task::spawn_blocking(move || serve(&path, item, &rest))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    Ok((
        [
            (CONTENT_TYPE, content_type.as_str()),
            (CONTENT_SECURITY_POLICY, RESOURCE_CSP),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (CORP, "same-origin"),
            (CACHE_CONTROL, "private, no-cache"),
        ],
        body,
    )
        .into_response())
}

/// The request path is only a key into the manifest: nothing is opened by it.
fn safe(path: &str) -> bool {
    !path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

type Zip = ZipArchive<BufReader<File>>;

fn toc_of(
    zip: &mut Zip,
    opf_path: &str,
    pkg: &package::Package,
    res: &manifest::Resources,
) -> Vec<manifest::TocNode> {
    let find = |pred: &dyn Fn(&package::Item) -> bool| {
        pkg.items
            .iter()
            .find(|i| pred(i))
            .map(|i| opf::resolve_href(opf_path, &i.href))
    };
    let (doc, is_nav) = match find(&|i| i.properties.iter().any(|p| p == "nav")) {
        Some(d) => (d, true),
        None => match pkg.toc_id.as_deref().and_then(|id| pkg.item(id)) {
            Some(i) => (opf::resolve_href(opf_path, &i.href), false),
            None => return vec![],
        },
    };
    let Ok(bytes) = read_entry(zip, &doc, MARKUP_CAP) else {
        return vec![];
    };
    let entries = if is_nav {
        package::nav_toc(&bytes)
    } else {
        package::ncx_toc(&bytes)
    };
    manifest::resolve_toc(&entries, &doc, res)
}

fn serve(path: &std::path::Path, item: i32, rest: &str) -> Result<(String, Vec<u8>), AppError> {
    let missing = || item_missing(item);
    let file = File::open(path).map_err(|_| missing())?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|_| missing())?;
    let opf_path = rootfile(&mut zip).ok_or_else(missing)?;
    let opf_bytes = read_entry(&mut zip, &opf_path, OPF_CAP).map_err(|_| missing())?;
    let pkg = package::parse(&opf_bytes);
    let names: HashSet<String> = zip
        .file_names()
        .filter_map(Result::ok)
        .map(|n| n.into_owned())
        .collect();
    let res = manifest::resources(&opf_path, &pkg, |p| names.contains(p));
    let json = |v: serde_json::Value, ct: &str| (ct.to_owned(), v.to_string().into_bytes());
    match rest {
        "manifest.json" => {
            let toc = toc_of(&mut zip, &opf_path, &pkg, &res);
            let meta = opf::parse(&opf_bytes);
            Ok(json(
                manifest::manifest(item, &meta, &pkg, &res, &toc),
                "application/webpub+json",
            ))
        }
        "positions.json" => {
            let size = |p: &str| zip.by_name(p).map_or(0, |f| f.size()).min(MARKUP_CAP);
            Ok(json(
                manifest::positions(&pkg, &res, size),
                "application/vnd.readium.position-list+json",
            ))
        }
        _ => {
            let not_found = || AppError::not_found("Resource not found");
            let r = Some(rest)
                .filter(|p| safe(p))
                .and_then(|p| res.by_path(p))
                .ok_or_else(not_found)?;
            let kind = match r.class {
                Class::Markup(k) => Some(k),
                Class::Plain => None,
            };
            let cap = if kind.is_some() {
                MARKUP_CAP
            } else {
                ASSET_CAP
            };
            let bytes = read_entry(&mut zip, &r.path, cap).map_err(|e| match e {
                EntryError::Missing => not_found(),
                EntryError::TooLarge => AppError::payload_too_large("Resource too large"),
            })?;
            let body = if let Some(kind) = kind {
                sanitize::sanitize(&bytes, kind, cap as usize).map_err(|e| match e {
                    sanitize::Error::TooLarge => AppError::payload_too_large("Resource too large"),
                    sanitize::Error::Malformed => AppError::plain(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "Resource is not well-formed",
                    ),
                })?
            } else {
                bytes
            };
            Ok((r.content_type(), body))
        }
    }
}
