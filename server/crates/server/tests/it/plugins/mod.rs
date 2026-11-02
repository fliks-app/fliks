//! The plugin host's tests against real components (`plugins.md` Vectors/parity).
//! Need `S8_PG_ADMIN_URL` and the fixture wasm (`FLIKS_TEST_WASM_DIR`); skipped otherwise.
mod api;
mod create;
mod harness;
mod net;
mod provider;
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
