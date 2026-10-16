use crate::http::{layers, static_files};
use crate::{
    auth, events, fs, images, libraries, media, notifications, playback, playlists, qoe, remote,
    roles, settings, social, state::AppState, system, users,
};
use axum::{
    Router,
    extract::{Request, State},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{any, any_service},
};
use fliks_engine::gateway::{self, RouteTable, Upstream};
use std::path::PathBuf;
use tower::ServiceExt;
use utoipa::OpenApi;

/// Nest's default JSON limit (`bootstrap.md` rule 10).
pub const BODY_LIMIT_BYTES: usize = 100 * 1024;

/// A route is ported iff it is listed here (plan §4.3).
#[derive(OpenApi)]
#[openapi(
    info(title = "Fliks", version = "1"),
    paths(
        system::liveness,
        auth::login,
        auth::refresh,
        auth::logout,
        auth::register,
        auth::me,
        auth::users_public,
        auth::cast_info,
        auth::stream_token,
        auth::pairing_request,
        auth::pairing_status,
        auth::pairing_pending,
        auth::pairing_approve,
        auth::pairing_deny,
        roles::list,
        roles::create,
        roles::permissions,
        roles::get,
        roles::update,
        roles::remove,
        settings::list,
        settings::put_bulk,
        settings::get_one,
        settings::put_one,
        fs::browse,
        events::events,
        events::activity,
        qoe::sessions,
        qoe::session,
        qoe::summary,
        qoe::events,
        users::list,
        users::create,
        users::get_one,
        users::update,
        users::remove,
        users::stats,
        users::set_avatar,
        users::clear_avatar,
        crate::engine::remote::get_remote,
        crate::engine::remote::put_remote,
        crate::engine::remote::test_remote,
        crate::engine::resolve::resolve,
        remote::targets,
        remote::register,
        remote::commands,
        remote::command,
        remote::grant_code,
        remote::grant_claim,
        remote::grants,
        remote::revoke,
        playback::recommendations,
        playback::dismiss,
        playback::dismissed_count,
        playback::dismissed_reset,
        playback::watched_ids,
        playback::continue_watching,
        playback::history,
        playback::watched_episodes,
        playback::episode_progress,
        playback::resume_info,
        playback::get_state,
        playback::heartbeat,
        playback::delete_state,
        playback::hide,
        playback::toggle_watched,
        playback::toggle_series_watched,
        playback::toggle_season_watched,
        crate::stream::playback_info,
        crate::stream::qualities,
        crate::stream::hw_accel,
        crate::stream::tonemap_algos,
        crate::stream::effective_settings,
        crate::stream::gpus,
        crate::stream::edl,
        crate::stream::delete_session,
        crate::stream::streams,
        crate::stream::command,
        crate::stream::stats,
        crate::stream::purge_all,
        crate::stream::purge_file,
        libraries::mine,
        libraries::list,
        libraries::get_one,
        libraries::create,
        libraries::update,
        libraries::access_get,
        libraries::access_put,
        images::without_variant,
        images::with_variant,
        media::find,
        media::recent,
        media::count,
        media::count_by_library,
        media::quality_table,
        media::genre_list,
        media::collection_list,
        media::calendar_entries,
        media::track,
        media::get_media,
        media::similar_media,
        media::media_collection,
        media::media_cast,
        media::media_crew,
        media::media_streams,
        notifications::list,
        notifications::create,
        notifications::events,
        notifications::get_one,
        notifications::update,
        notifications::remove,
        notifications::test,
        social::likes_list,
        social::like_state,
        social::like_add,
        social::like_remove,
        social::search,
        social::connectable,
        social::following_popular,
        social::recommend,
        social::received,
        social::sent,
        social::dismiss,
        social::requests,
        social::follow,
        social::unfollow,
        social::accept,
        social::reject,
        social::followers,
        social::following,
        social::profile,
        social::stats,
        playlists::list,
        playlists::create,
        playlists::get_one,
        playlists::update,
        playlists::remove,
        playlists::items,
        playlists::add_item,
        playlists::remove_item,
        playlists::remove_by_media,
        playlists::reorder,
        playlists::members,
        playlists::add_member,
        playlists::remove_member,
        playlists::save,
        playlists::unsave
    )
)]
pub struct ApiDoc;

/// Rust-owned routes and static files get the layers; the forwarded paths do not, as Nest sets its own CORS headers.
pub fn router(
    state: AppState,
    nest: Upstream,
    client_dir: Option<PathBuf>,
    cast_dir: PathBuf,
    cors_origin: Option<String>,
) -> Router {
    let forwarder = gateway::router(
        RouteTable::from_json("[]").expect("empty table"),
        nest,
        None,
    );
    let local = system::router()
        .merge(api().with_state(state))
        .route("/internal", any(internal_404))
        .route("/internal/", any(internal_404))
        .route("/internal/{*rest}", any(internal_404))
        .fallback_service(static_files::router(client_dir, cast_dir));
    // Preflights of owned paths stay with the Rust CORS layer, so they answer while Nest is down.
    let cors = layers::apply(Router::new(), cors_origin.clone(), BODY_LIMIT_BYTES);
    let unowned = forwarder
        .clone()
        .layer(from_fn_with_state(cors, preflight_here));
    // Merged after the layers so Nest answers the methods Rust does not own, unlayered instead of a 405.
    let local = layers::apply(local, cors_origin, BODY_LIMIT_BYTES);
    // axum would send this literal to `/api/media/{id}` (400); it stays Nest's until subtitles move.
    let local = local.route("/api/media/sync-queue", any_service(unowned.clone()));
    let local = ApiDoc::openapi()
        .paths
        .paths
        .keys()
        .fold(local, |r, p| r.route(p, any_service(unowned.clone())));
    ["/api", "/api/", "/api/{*rest}"]
        .into_iter()
        .fold(local, |r, p| r.route(p, any_service(forwarder.clone())))
}

/// Ported domain routers are merged here, one `.merge(...)` per domain.
fn api() -> Router<AppState> {
    Router::new()
        .merge(crate::auth::router())
        .merge(crate::roles::router())
        .merge(crate::settings::router())
        .merge(crate::fs::router())
        .merge(crate::engine::router())
        .merge(users::router())
        .merge(events::router())
        .merge(remote::router())
        .merge(playback::router())
        .merge(qoe::router())
        .merge(crate::stream::router())
        .merge(libraries::router())
        .merge(images::router())
        .merge(media::router())
        .merge(notifications::router())
        .merge(social::router())
        .merge(playlists::router())
}

async fn preflight_here(State(cors): State<Router>, req: Request, next: Next) -> Response {
    if layers::is_preflight(&req) {
        return cors.oneshot(req).await.into_response();
    }
    next.run(req).await
}

async fn internal_404(req: Request) -> Response {
    static_files::cannot(&req)
}
