//! The plugin host's Rust-only tests (`plugins.md` Vectors/parity, "Rust-only tests"), against
//! real components. Needs `S8_PG_ADMIN_URL` (a superuser URL of the maintenance database) and the
//! built fixture components (`FLIKS_TEST_WASM_DIR`, default `$CARGO_TARGET_DIR/wasm32-wasip2/release`);
//! skipped otherwise.
mod api;
mod harness;
mod net;
mod roles;
mod runtime;
mod sql;

/// The spec's WIT block and the SDK's WIT file are one text (`plugins.md` WIT section).
#[test]
fn wit_sync() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let spec = std::fs::read_to_string(root.join("docs/spec/plugins.md")).unwrap();
    let block = spec
        .split("```wit\n")
        .nth(1)
        .unwrap()
        .split("```")
        .next()
        .unwrap();
    let wit = std::fs::read_to_string(root.join("crates/plugin-sdk/wit/fliks.wit")).unwrap();
    assert_eq!(block, wit);
}
