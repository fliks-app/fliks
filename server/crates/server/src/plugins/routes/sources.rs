//! The plugin source routes: list, create, update, delete, catalog, refresh and inspect.
use super::*;

pub(super) fn source_summary(s: &packages::Source) -> Value {
    json!({
        "id": s.id,
        "url": s.url,
        "enabled": s.enabled,
        "hasPinnedKey": s.public_key.is_some(),
        "lastRefreshedAt": s.last_refreshed_at.map(fliks_domain::js::iso),
        "lastRefreshError": s.last_refresh_error,
        "pluginCount": s.cached_catalog.as_ref().and_then(|c| c["plugins"].as_array()).map_or(0, Vec::len),
    })
}

pub(super) fn https_or_400(url: &str) -> Result<(), Bail> {
    match reqwest::Url::parse(url) {
        Err(_) => Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_INSECURE_URL",
            format!("\"{url}\" is not a valid URL"),
        ))),
        Ok(u) if u.scheme() != "https" => Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_INSECURE_URL",
            format!("source url \"{url}\" must be https"),
        ))),
        Ok(_) => Ok(()),
    }
}

pub(super) async fn unique_or_409(
    st: &AppState,
    url: &str,
    except: Option<i32>,
) -> Result<(), Bail> {
    if let Some(e) = packages::source_by_url(&st.db, url).await.map_err(db)?
        && Some(e.id) != except
    {
        return Err(inst(ie(
            StatusCode::CONFLICT,
            "PLUGIN_SOURCE_DUPLICATE_URL",
            format!("a source for \"{url}\" already exists"),
        )));
    }
    Ok(())
}

pub(super) fn public_key(v: &Value) -> Result<Option<Vec<u8>>, Bail> {
    let Some(s) = v.as_str() else { return Ok(None) };
    let key = base64_lenient(s);
    if key.len() != 32 {
        return Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_BAD_KEY",
            format!(
                "publicKey must be base64-encoded and decode to exactly 32 bytes, got {}",
                key.len()
            ),
        )));
    }
    Ok(Some(key))
}

/// `Buffer.from(s, 'base64')`: characters outside the alphabet are skipped, padding optional.
pub(super) fn base64_lenient(s: &str) -> Vec<u8> {
    use base64::Engine;
    let clean: String = s
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .take_while(|c| *c != '=')
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
        .collect();
    let usable = clean.len() - clean.len() % 4
        + if clean.len() % 4 > 1 {
            clean.len() % 4
        } else {
            0
        };
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&clean[..usable])
        .unwrap_or_default()
}

/// The DTO checks of `Create/UpdatePluginSourceDto` (`IsOptional` lets `null` through).
pub(super) fn source_dto(v: &Value, create: bool) -> Result<(), Bail> {
    let mut errs: Vec<String> = vec![];
    if let Some(o) = v.as_object() {
        for k in o
            .keys()
            .filter(|k| !["url", "publicKey", "enabled"].contains(&k.as_str()))
        {
            errs.push(format!("property {k} should not exist"));
        }
    }
    let url = &v["url"];
    if create || !url.is_null() {
        if url.as_str().is_none_or(str::is_empty) {
            errs.push("url should not be empty".into());
        }
        if !url.is_string() {
            errs.push("url must be a string".into());
        }
    }
    if !v["publicKey"].is_null() && !v["publicKey"].is_string() {
        errs.push("publicKey must be a string".into());
    }
    if !v["enabled"].is_null() && !v["enabled"].is_boolean() {
        errs.push("enabled must be a boolean value".into());
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(app(AppError::bad_request(errs)))
    }
}

#[utoipa::path(get, path = "/api/plugins/sources", responses((status = 200)))]
pub async fn sources_list(State(st): State<AppState>, a: Authed) -> Res {
    need(&a, Action::Read)?;
    let s = packages::sources(&st.db, false).await.map_err(db)?;
    Ok(Json(s.iter().map(source_summary).collect::<Vec<_>>()).into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources", responses((status = 201)))]
pub async fn sources_create(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let v = json_body(&headers, &body).await?;
    source_dto(&v, true)?;
    let url = v["url"].as_str().unwrap_or_default();
    https_or_400(url)?;
    unique_or_409(&st, url, None).await?;
    let key = public_key(&v["publicKey"])?;
    let id: i32 = sqlx::query_scalar(r#"INSERT INTO plugin_sources (url, enabled, "publicKey") VALUES ($1, $2, $3) RETURNING id"#)
        .bind(url)
        .bind(v["enabled"].as_bool().unwrap_or(true))
        .bind(key)
        .fetch_one(&st.db)
        .await
        .map_err(db)?;
    let s = packages::source(&st.db, id)
        .await
        .map_err(db)?
        .expect("inserted");
    Ok((StatusCode::CREATED, Json(source_summary(&s))).into_response())
}

pub(super) async fn source_or_404(st: &AppState, id: i32) -> Result<packages::Source, Bail> {
    packages::source(&st.db, id)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            app(AppError::not_found(format!(
                "Plugin source #{id} not found"
            )))
        })
}

#[utoipa::path(put, path = "/api/plugins/sources/{id}", responses((status = 200)))]
pub async fn sources_update(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let v = json_body(&headers, &body).await?;
    source_dto(&v, false)?;
    let mut s = source_or_404(&st, id).await?;
    let mut clear = false;
    if let Some(url) = v.get("url")
        && url.as_str() != Some(&s.url)
    {
        let url = url
            .as_str()
            .map_or_else(|| "null".to_owned(), str::to_owned);
        https_or_400(&url)?;
        unique_or_409(&st, &url, Some(id)).await?;
        s.url = url;
        clear = true;
    }
    if let Some(k) = v.get("publicKey") {
        let key = public_key(k)?;
        clear |= key != s.public_key;
        s.public_key = key;
    }
    if let Some(e) = v["enabled"].as_bool() {
        s.enabled = e;
    }
    sqlx::query(
        r#"UPDATE plugin_sources SET url = $2, "publicKey" = $3, enabled = $4, "updatedAt" = now(),
             "cachedCatalog" = CASE WHEN $5 THEN NULL ELSE "cachedCatalog" END,
             "lastRefreshedAt" = CASE WHEN $5 THEN NULL ELSE "lastRefreshedAt" END,
             "lastRefreshError" = CASE WHEN $5 THEN NULL ELSE "lastRefreshError" END
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(&s.url)
    .bind(&s.public_key)
    .bind(s.enabled)
    .bind(clear)
    .execute(&st.db)
    .await
    .map_err(db)?;
    let s = source_or_404(&st, id).await?;
    Ok(Json(source_summary(&s)).into_response())
}

#[utoipa::path(delete, path = "/api/plugins/sources/{id}", responses((status = 204)))]
pub async fn sources_delete(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    source_or_404(&st, id).await?;
    sqlx::query("DELETE FROM plugin_sources WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await
        .map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(get, path = "/api/plugins/sources/{id}/catalog", responses((status = 200)))]
pub async fn sources_catalog(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Read)?;
    let id = int_param(&id).map_err(app)?;
    let s = source_or_404(&st, id).await?;
    Ok(Json(json!({
        "cachedCatalog": s.cached_catalog,
        "lastRefreshedAt": s.last_refreshed_at.map(fliks_domain::js::iso),
        "lastRefreshError": s.last_refresh_error,
    }))
    .into_response())
}

const LOGO_CAP: usize = 512 << 10;
const LOGO_CACHE_MAX: usize = 256;
type CachedLogo = (&'static str, Vec<u8>);
static LOGOS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, CachedLogo>>> =
    std::sync::LazyLock::new(Default::default);

/// The image type of safe logo bytes: PNG, JPEG, WebP, or an SVG without script content.
fn logo_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        crate::plugins::archive::sniff_logo("logo.svg", b)
            .is_none()
            .then_some("image/svg+xml")
    }
}

#[utoipa::path(get, path = "/api/plugins/sources/{id}/catalog/{pluginId}/logo", responses((status = 200)))]
pub async fn sources_catalog_logo(
    State(st): State<AppState>,
    a: Authed,
    Path((id, plugin)): Path<(String, String)>,
) -> Res {
    need(&a, Action::Read)?;
    let id = int_param(&id).map_err(app)?;
    let s = source_or_404(&st, id).await?;
    let not_found = || app(AppError::bare(StatusCode::NOT_FOUND));
    let url = s
        .cached_catalog
        .as_ref()
        .and_then(|c| c["plugins"].as_array())
        .into_iter()
        .flatten()
        .find(|p| p["id"] == plugin.as_str())
        .and_then(|p| p["logo"].as_str())
        .ok_or_else(not_found)?
        .to_owned();
    let cached = LOGOS.lock().expect("logo cache").get(&url).cloned();
    let (ct, bytes) = match cached {
        Some(l) => l,
        None => {
            let bytes = st
                .plugins
                .opts
                .fetch
                .logo(&url, &s.url, LOGO_CAP)
                .await
                .map_err(|_| app(AppError::bare(StatusCode::BAD_GATEWAY)))?;
            let ct = logo_type(&bytes).ok_or_else(not_found)?;
            let mut c = LOGOS.lock().expect("logo cache");
            if c.len() >= LOGO_CACHE_MAX {
                c.clear();
            }
            c.insert(url, (ct, bytes.clone()));
            (ct, bytes)
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, ct),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, "sandbox"),
        ],
        bytes,
    )
        .into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources/{id}/refresh", responses((status = 201)))]
pub async fn sources_refresh(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let s = source_or_404(&st, id).await?;
    let r = st.plugins.refresh_source(&s).await.map_err(db)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources/{id}/inspect", responses((status = 201)))]
pub async fn sources_inspect(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let v = json_body(&headers, &body).await?;
    let mut errs: Vec<String> = vec![];
    if let Some(o) = v.as_object() {
        for k in o.keys().filter(|k| *k != "pluginId" && *k != "version") {
            errs.push(format!("property {k} should not exist"));
        }
    }
    for k in ["pluginId", "version"] {
        if v[k].as_str().is_none_or(str::is_empty) {
            errs.push(format!("{k} should not be empty"));
        }
        if !v[k].is_string() {
            errs.push(format!("{k} must be a string"));
        }
    }
    if !errs.is_empty() {
        return Err(app(AppError::bad_request(errs)));
    }
    let s = source_or_404(&st, id).await?;
    let r = st
        .plugins
        .inspect_from_catalog(
            &s,
            v["pluginId"].as_str().unwrap_or_default(),
            v["version"].as_str().unwrap_or_default(),
        )
        .await
        .map_err(inst)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}
