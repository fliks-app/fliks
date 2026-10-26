use crate::http::{layers, static_files};
use crate::{
    auth, cleanup, events, fs, images, importers, jobs, libraries, livetv, markers, media,
    media_servers, metadata, notifications, persons, playback, playlists, profiles, qoe, remote,
    requests, roles, settings, social, state::AppState, subtitles, system, users,
};
use axum::{Router, extract::Request, response::Response, routing::any};
use std::path::PathBuf;
use utoipa::OpenApi;

/// The 4.x default JSON body limit (`bootstrap.md` rule 10).
pub const BODY_LIMIT_BYTES: usize = 100 * 1024;

/// With the per-domain docs merged by `openapi()`, every route the server answers.
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
        auth::setup_status,
        auth::setup,
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
        events::event_ticket,
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
        crate::party::time,
        crate::party::create,
        crate::party::list,
        crate::party::show,
        crate::party::by_token,
        crate::party::patch,
        crate::party::end,
        crate::party::join,
        crate::party::start,
        crate::party::leave,
        crate::party::intent,
        crate::party::status,
        crate::party::message,
        crate::party::reaction,
        crate::party::voice,
        crate::party::signal,
        crate::party::ice,
        crate::party::reactions,
        crate::party::kick,
        crate::party::transfer,
        crate::party::invite,
        crate::party::decline,
        crate::party::queue,
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
        media::sidebar_counts,
        crate::settings::checklist::list,
        crate::settings::checklist::dismiss,
        crate::settings::checklist::undismiss,
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
        persons::provider_credits,
        requests::create,
        requests::list,
        requests::title_state,
        requests::get_one,
        requests::update,
        requests::remove,
        requests::approve,
        requests::decline,
        requests::comment_create,
        requests::comments_list,
        requests::comment_remove,
        requests::rule_list,
        requests::rule_create,
        requests::rule_get,
        requests::rule_update,
        requests::rule_remove,
        cleanup::rule_list,
        cleanup::rule_create,
        cleanup::rule_get,
        cleanup::rule_update,
        cleanup::rule_remove,
        cleanup::rule_preview,
        cleanup::candidate_list,
        cleanup::recommendation_list,
        cleanup::candidate_delete_now,
        cleanup::candidate_bulk,
        cleanup::rule_export,
        cleanup::rule_import,
        cleanup::exclusion_add,
        cleanup::exclusion_remove,
        cleanup::leaving_soon,
        livetv::channels::status,
        livetv::channels::list,
        livetv::guide::on_now,
        livetv::channels::logo,
        livetv::channels::set_prefs,
        livetv::session::play,
        livetv::session::leave,
        livetv::session::heartbeat,
        livetv::guide::window,
        livetv::guide::program,
        livetv::guide::search,
        livetv::sources::list,
        livetv::sources::create,
        livetv::sources::test,
        livetv::sources::upload,
        livetv::sources::update,
        livetv::sources::remove,
        livetv::sources::sync_route,
        livetv::channels::admin_list,
        livetv::channels::bulk_update,
        livetv::channels::merge,
        livetv::channels::update_channel,
        livetv::guide::list,
        livetv::guide::create,
        livetv::guide::update,
        livetv::guide::remove,
        livetv::guide::sync_route,
        livetv::guide::match_report,
        livetv::access::restricted_groups,
        livetv::access::set_restricted_groups,
        livetv::access::users,
        livetv::access::grants,
        livetv::access::set_grants
    )
)]
pub struct ApiDoc;

/// `ApiDoc` plus the routes each S5 domain lists itself.
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut doc = ApiDoc::openapi();
    doc.merge(importers::Doc::openapi());
    doc.merge(media_servers::Doc::openapi());
    doc.merge(markers::Doc::openapi());
    doc.merge(subtitles::Doc::openapi());
    doc.merge(crate::plugins::routes::Doc::openapi());
    doc
}

/// Unmatched `/api` paths and undeclared methods on owned paths get the 4.x `Cannot <METHOD>` 404, never a 405.
pub fn router(
    state: AppState,
    client_dir: Option<PathBuf>,
    cast_dir: PathBuf,
    cors_origin: Option<String>,
) -> Router {
    let local = system::router()
        .merge(api().with_state(state))
        .route(crate::http::csp::REPORT_PATH, crate::http::csp::route())
        .route("/api", any(unowned))
        .route("/api/", any(unowned))
        .route("/api/{*rest}", any(unowned))
        .nest("/api/emoji", static_files::emoji(cast_dir.join("emoji")))
        .method_not_allowed_fallback(unowned)
        .fallback_service(static_files::router(client_dir, cast_dir));
    let exempt = crate::plugins::routes::reads_own_body;
    layers::apply(local, cors_origin, BODY_LIMIT_BYTES, exempt)
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
        .merge(crate::party::router())
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
        .merge(requests::router())
        .merge(cleanup::router())
        .merge(subtitles::router())
        .merge(livetv::router())
        .merge(crate::plugins::routes::router())
}

async fn unowned(req: Request) -> Response {
    static_files::cannot(&req)
}
