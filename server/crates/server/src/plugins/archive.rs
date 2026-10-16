//! Minimal `.fkplugin` reader for the spike: entry set, hashes, component preamble.
// ponytail: rule 13's full guard list and the signature check land with the S8 port.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

pub const PREAMBLE: [u8; 8] = [0, b'a', b's', b'm', 0x0d, 0x00, 0x01, 0x00];
const ENTRIES: [&str; 5] = [
    "plugin.json",
    "plugin.json.sig",
    "plugin.wasm",
    "logo.svg",
    "logo.png",
];

pub struct Package {
    pub manifest: Value,
    pub wasm: Vec<u8>,
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

pub fn read(archive: &[u8]) -> Result<Package, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|e| format!("PLUGIN_MALFORMED_ARCHIVE: {e}"))?;
    if zip.len() > 4 {
        return Err("PLUGIN_TOO_MANY_ENTRIES".into());
    }
    let mut manifest = None;
    let mut wasm = None;
    let mut hashes = serde_json::Map::new();
    for i in 0..zip.len() {
        let mut f = zip
            .by_index(i)
            .map_err(|e| format!("PLUGIN_MALFORMED_ARCHIVE: {e}"))?;
        let name = f
            .name()
            .map_err(|e| format!("PLUGIN_MALFORMED_ARCHIVE: {e}"))?
            .into_owned();
        if !ENTRIES.contains(&name.as_str()) {
            return Err(format!("PLUGIN_UNEXPECTED_ENTRY: {name}"));
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes)
            .map_err(|e| format!("PLUGIN_MALFORMED_ARCHIVE: {e}"))?;
        match name.as_str() {
            "plugin.json" => manifest = Some(bytes),
            "plugin.json.sig" => {}
            n => {
                hashes.insert(n.to_owned(), Value::String(sha256_hex(&bytes)));
                if n == "plugin.wasm" {
                    wasm = Some(bytes);
                }
            }
        }
    }
    let manifest: Value =
        serde_json::from_slice(&manifest.ok_or("PLUGIN_BAD_MANIFEST: no plugin.json")?)
            .map_err(|e| format!("PLUGIN_BAD_MANIFEST: {e}"))?;
    let wasm = wasm.ok_or("PLUGIN_TIER_VIOLATION: no plugin.wasm")?;
    if manifest["files"] != Value::Object(hashes) {
        return Err("PLUGIN_FILE_SET_MISMATCH".into());
    }
    if !wasm.starts_with(&PREAMBLE) {
        return Err("PLUGIN_BAD_WASM".into());
    }
    Ok(Package { manifest, wasm })
}

/// Builds an unsigned store-only archive: the template plus `version` and `files`.
pub fn pack(template: &Value, version: &str, wasm: &[u8]) -> Vec<u8> {
    let mut manifest = template.clone();
    manifest["version"] = Value::String(version.into());
    manifest["files"] = serde_json::json!({ "plugin.wasm": sha256_hex(wasm) });
    let mut out = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut out);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        z.start_file("plugin.json", opts).expect("in memory");
        z.write_all(manifest.to_string().as_bytes())
            .expect("in memory");
        z.start_file("plugin.wasm", opts).expect("in memory");
        z.write_all(wasm).expect("in memory");
        z.finish().expect("in memory");
    }
    out.into_inner()
}
