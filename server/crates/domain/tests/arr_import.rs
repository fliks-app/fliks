//! Golden importer-helper vectors (`fixtures/arr-import`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::arr_import::*;
use serde_json::{Value, json};

fn mappings(v: &Value) -> Vec<PathMapping> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|m| PathMapping {
            remote_path: m["remotePath"].as_str().unwrap().into(),
            local_library_id: m["localLibraryId"].as_i64().map(|n| n as i32),
            ignore: m["ignore"].as_bool().unwrap_or(false),
        })
        .collect()
}

fn items(v: &Value) -> Vec<RemoteItem> {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn arr_import_reproduces_expected() {
    replay("arr-import", 712, |i| match i["fn"].as_str().unwrap() {
        "applyPathMapping" => {
            match apply_path_mapping(i["path"].as_str(), &mappings(&i["mappings"])) {
                None => Value::Null,
                Some(Mapped::Ignore) => json!({"ignore": true}),
                Some(Mapped::Library {
                    library_id,
                    folder_name,
                }) => {
                    json!({"libraryId": library_id, "folderName": folder_name})
                }
            }
        }
        "suggestLocalLibraryId" => {
            let libs: Vec<(i32, Option<String>)> = i["libs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    (
                        l["id"].as_i64().unwrap() as i32,
                        l["path"].as_str().map(Into::into),
                    )
                })
                .collect();
            json!(suggest_local_library_id(
                i["remote"].as_str().unwrap(),
                &libs
            ))
        }
        "parseLanguageFromPath" => json!(parse_language_from_path(i["path"].as_str().unwrap())),
        "parseSubtitleTags" => {
            let tags = parse_subtitle_tags(i["path"].as_str().unwrap());
            json!({"tags": tags, "hearingImpaired": hearing_impaired_from_tags(&tags)})
        }
        "mapRemoteItems" => Value::Array(map_remote_items(&items(&i["items"]))),
        "resolveCutoff" => json!(resolve_cutoff(i["cutoffId"].as_i64(), &items(&i["items"]))),
        "findLocalQuality" => json!(find_local_quality(i["name"].as_str().unwrap()).map(|q| q.id)),
        _ => json!(map_status(i["request"].as_i64(), i["media"].as_i64())),
    });
}
