//! Scorer and search-ranking vectors (`fixtures/subtitle-search/cases.json`).
mod common;

use common::replay;
use fliks_domain::{subtitle_flags::HiMode, subtitle_score::*};
use serde_json::{Value, json};
use std::collections::HashSet;

fn mode(v: &Value) -> Option<HiMode> {
    serde_json::from_value(v.clone()).ok()
}

#[test]
fn subtitle_search_reproduces_expected() {
    replay("subtitle-search", 560, |i| {
        if i["fn"] == "scoreSubtitle" {
            let (c, x) = (&i["candidate"], &i["context"]);
            let score = score_subtitle(
                &ScoreCandidate {
                    release_name: c["releaseName"].as_str(),
                    hash_matched: c["hashMatched"].as_bool().unwrap_or(false),
                    imdb_id: c["imdbId"].as_str(),
                    hearing_impaired: c["hearingImpaired"].as_bool().unwrap_or(false),
                },
                &ScoreContext {
                    kind: if x["kind"] == "episode" {
                        Kind::Episode
                    } else {
                        Kind::Movie
                    },
                    video_release_name: x["videoReleaseName"].as_str(),
                    title: x["title"].as_str().unwrap(),
                    year: x["year"].as_i64().map(|y| y as i32),
                    season: x["season"].as_i64(),
                    episode: x["episode"].as_i64(),
                    imdb_id: x["imdbId"].as_str(),
                    hi_mode: mode(&x["hearingImpairedMode"]),
                },
            );
            return json!(score);
        }
        let p = &i["params"];
        let all: Vec<Candidate> = ["opensubtitles", "subdl", "yify"]
            .iter()
            .flat_map(|t| i["results"][t].as_array().unwrap().clone())
            .map(|v| serde_json::from_value(v).unwrap())
            .collect();
        let blacklist: HashSet<String> = i["blacklist"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                format!(
                    "{}:{}",
                    b["providerType"].as_str().unwrap(),
                    b["providerFileId"].as_str().unwrap()
                )
            })
            .collect();
        let ranked = rank_candidates(
            all,
            &blacklist,
            &SearchParams {
                imdb_id: p["imdbId"].as_str().map(str::to_owned),
                title: p["title"].as_str().unwrap().to_owned(),
                year: p["year"].as_i64().map(|y| y as i32),
                season: p["season"].as_i64(),
                episode: p["episode"].as_i64(),
                language: p["language"].as_str().unwrap().to_owned(),
                video_release_name: p["videoReleaseName"].as_str().map(str::to_owned),
                forced: p["forced"].as_bool(),
                hi_mode: mode(&p["hearingImpairedMode"]),
            },
        );
        json!(ranked)
    });
}
