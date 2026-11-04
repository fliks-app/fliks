//! Every integration test in one binary: each file would otherwise link the whole server on its own.
mod auth;
mod auth_routes;
mod backup_restore;
mod books_api;
mod books_reader;
mod burn_in;
mod cleanup_bulk;
mod comics_api;
mod comics_pages;
mod device_tokens;
mod email_devices;
mod events_ticket;
mod fakes;
mod heartbeat;
mod importers;
mod items;
mod kobo;
mod kosync;
mod libraries;
mod media;
mod media_servers;
mod metadata;
mod migrations;
mod notifications;
mod opds;
mod parity;
mod party;
mod playback;
mod playlists;
mod plugins;
mod profiles;
mod remote;
mod requests;
mod roles;
mod routes;
mod settings;
mod social;
mod topology;
mod users;

/// The server binary read at run time: a nextest archive runs it where `env!` baked another path.
fn server_bin() -> std::path::PathBuf {
    std::env::var_os("CARGO_BIN_EXE_fliks-server")
        .expect("cargo and nextest set CARGO_BIN_EXE_fliks-server")
        .into()
}

/// The comic archive child of the tests is the server binary Cargo built: nextest runs from an
/// extracted archive and gives the remapped path at run time, the compile-time one is the fallback.
#[cfg(target_os = "linux")]
pub(crate) fn comic_child() {
    let path = [
        "NEXTEST_BIN_EXE_fliks-server",
        "NEXTEST_BIN_EXE_fliks_server",
    ]
    .iter()
    .find_map(|k| std::env::var_os(k))
    .unwrap_or_else(|| env!("CARGO_BIN_EXE_fliks-server").into());
    fliks_server::comics::sandbox::set_exe(std::path::PathBuf::from(path));
}
