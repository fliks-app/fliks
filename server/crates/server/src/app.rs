use crate::http::{layers, static_files};
use crate::{
    auth, events, fs, images, importers, jobs, libraries, markers, media, media_servers, metadata,
    notifications, persons, playback, playlists, profiles, qoe, remote, roles, settings, social,
    state::AppState, system, users,
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
        system::health,
        system::restart,
        system::version,
        system::update,
        system::stats,
        system::backup_create,
        system::backup_list,
        system::backup_restore,
        system::backup_download,
        system::backup_delete,
        system::log_list,
        jobs::schedulers,
        jobs::list,
        jobs::trigger,
        jobs::clear_history,
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
        playlists::unsave,
        profiles::quality_list,
        profiles::quality_create,
        profiles::quality_get,
        profiles::quality_update,
        profiles::quality_delete,
        profiles::language_definitions,
        profiles::language_list,
        profiles::language_create,
        profiles::language_get,
        profiles::language_update,
        profiles::language_delete,
        profiles::format_list,
        profiles::format_create,
        profiles::format_test,
        profiles::format_get,
        profiles::format_update,
        profiles::format_delete,
        profiles::definitions_list,
        profiles::definitions_reset,
        profiles::definitions_update,
        media::write::create,
        media::write::update,
        media::write::patch_library,
        media::write::patch_profiles,
        media::write::bulk,
        media::write::patch_season,
        media::write::patch_episode,
        media::write::import_tmdb,
        media::write::import_media,
        media::write::identify,
        media::write::refresh,
        media::write::refresh_episode,
        media::write::rescan,
        media::write::analyze,
        media::write::remove,
        media::write::remove_file,
        media::write::remove_library,
        media::write::companions_list,
        media::write::companions_download,
        media::write::companions_delete,
        media::write::companions_edl,
        crate::ingest::disk::scan,
        crate::ingest::disk::preview,
        crate::ingest::disk::relink_batch,
        crate::ingest::disk::relink,
        metadata::search_movie,
        metadata::search_tv,
        metadata::trending_movie,
        metadata::popular_movie,
        metadata::upcoming_movie,
        metadata::trending_tv,
        metadata::popular_tv,
        metadata::upcoming_tv,
        metadata::genres_movie,
        metadata::genres_tv,
        metadata::discover_movie,
        metadata::discover_tv,
        metadata::details_movie,
        metadata::details_tv,
        metadata::seasons,
        metadata::season_stubs,
        metadata::legacy_movie,
        metadata::legacy_tv,
        metadata::legacy_seasons,
        persons::search,
        persons::detail,
        persons::provider_credits
    )
)]
pub struct ApiDoc;

/// `ApiDoc` plus the routes each S5 domain lists itself.
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut doc = ApiDoc::openapi();
    doc.merge(importers::Doc::openapi());
    doc.merge(media_servers::Doc::openapi());
    doc.merge(markers::Doc::openapi());
    doc
}

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
    let local = openapi()
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
        .merge(profiles::router())
        .merge(crate::ingest::disk::router())
        .merge(importers::router())
        .merge(media_servers::router())
        .merge(markers::router())
        .merge(metadata::router())
        .merge(persons::router())
        .merge(system::api())
        .merge(jobs::router())
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
