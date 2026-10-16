//! Golden catalog vectors (`fixtures/media-{search-query,similarity,path}`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::media::{path::media_path, search::prefix_tsquery, similarity::*};
use serde_json::{Value, json};

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

#[test]
fn search_query_reproduces_expected() {
    replay("media-search-query", 55, |i| {
        let tsq = prefix_tsquery(i["q"].as_str().unwrap());
        let f = if tsq.is_empty() {
            "plainto_tsquery"
        } else {
            "to_tsquery"
        };
        json!({"tsq": tsq, "fn": f})
    });
}

#[test]
fn similarity_reproduces_expected() {
    replay("media-similarity", 316, |i| {
        let side = |s: &Value| {
            (
                strings(&s["genres"]),
                s["year"].as_i64(),
                strings(&s["keywords"]),
            )
        };
        let ((sg, sy, sk), (cg, cy, ck)) = (side(&i["source"]), side(&i["candidate"]));
        json!(score_similarity(
            Signals {
                genres: &sg,
                year: sy,
                keywords: &sk
            },
            Signals {
                genres: &cg,
                year: cy,
                keywords: &ck
            },
            i["sameDirector"].as_bool().unwrap()
        ))
    });
}

#[test]
fn path_reproduces_expected() {
    replay("media-path", 117, |i| {
        json!(media_path(
            i["libraryPath"].as_str(),
            i["folderName"].as_str()
        ))
    });
}
