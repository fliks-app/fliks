use super::follows;
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, assert_media_accessible},
    media::{params::Reader, wants, write::body::Body},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use fliks_domain::{
    acl::{Action, Subject},
    media::{kind::MediaKind, wants::parse_wants},
};
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/media/{id}/wants", get(wants_get).put(wants_put))
        .route("/api/wanted", get(wanted))
        .route("/api/follows", get(follows::follows))
        .route(
            "/api/persons/{id}/follow",
            get(follows::follow_get)
                .put(follows::follow_put)
                .delete(follows::follow_delete),
        )
        .route(
            "/api/collections/{id}/watch",
            get(follows::watch_get)
                .put(follows::watch_put)
                .delete(follows::watch_delete),
        )
}

type Res = Result<Json<Value>, AppError>;

async fn wants_body(st: &AppState, media: i32) -> Res {
    Ok(Json(json!({"wants": wants::list(&st.db, media).await?})))
}

#[utoipa::path(get, path = "/api/media/{id}/wants", responses((status = 200)))]
pub async fn wants_get(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    assert_media_accessible(&st.db, id, &accessible_library_ids(&st.db, &a).await?).await?;
    wants_body(&st, id).await
}

#[utoipa::path(put, path = "/api/media/{id}/wants", responses((status = 200)))]
pub async fn wants_put(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Res {
    a.require(Action::Update, Subject::Media)?;
    let id = id?.0;
    assert_media_accessible(&st.db, id, &accessible_library_ids(&st.db, &a).await?).await?;
    let b = Body::new(v, &["wants"])?;
    let list =
        b.0.get("wants")
            .ok_or_else(|| AppError::bad_request(vec!["wants must be an array"]))?;
    let kind: String = sqlx::query_scalar("SELECT type FROM media WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let specs =
        parse_wants(list, crate::db::kind(&kind)?).map_err(|m| AppError::bad_request(vec![m]))?;
    wants::check_profiles(&st.db, &specs).await?;
    let mut tx = st.db.begin().await?;
    wants::replace(&mut tx, id, &specs)
        .await
        .map_err(|e| wants::write_error(e, id))?;
    tx.commit().await?;
    wants_body(&st, id).await
}

#[utoipa::path(get, path = "/api/wanted", responses((status = 200)))]
pub async fn wanted(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let mut r = Reader::new(&q, &["type", "released", "page", "limit"]);
    let kind: Option<MediaKind> = r.kind("type");
    let released = r
        .one_of("released", &["true", "false"])
        .map(|v| v == "true");
    let (page, limit) = (r.int("page"), r.int("limit"));
    r.finish()?;
    if page.is_some_and(|p| p < 1) {
        return Err(AppError::bad_request(vec!["page must not be less than 1"]));
    }
    let limit = i64::from(limit.unwrap_or(25).clamp(1, 100));
    let offset = (i64::from(page.unwrap_or(1)) - 1) * limit;
    let libraries = accessible_library_ids(&st.db, &a).await?;
    let (data, total) = wants::wanted(
        &st.db,
        &libraries,
        &a.kinds.names(),
        kind,
        released,
        offset,
        limit,
    )
    .await?;
    Ok(Json(json!({"data": data, "total": total})))
}
