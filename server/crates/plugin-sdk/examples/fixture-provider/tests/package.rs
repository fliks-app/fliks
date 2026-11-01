#![cfg(not(target_arch = "wasm32"))]
//! A provider component packages and verifies. Needs the release component
//! (`cargo xtask build examples/fixture-provider`).

use fliks_plugin_sdk::build::{self, Crate};
use std::path::Path;

#[test]
fn a_provider_packages_and_verifies() {
    let c = Crate::at(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (name, archive) = c.package(None).unwrap();
    assert_eq!(name, "org.example.anime-0.1.0.fkplugin");
    let i = build::verify(&archive, vec![], build::MAX_WASM).unwrap();
    assert!(i.manifest["provider"].is_object());
    let wasm = std::fs::read(c.wasm_path()).unwrap();
    build::check_world(&wasm, true).unwrap();
    let err = build::check_world(&wasm, false).unwrap_err();
    assert!(err.contains("metadata-provider"), "{err}");
}
