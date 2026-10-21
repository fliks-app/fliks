//! Golden recommendation vectors (`fixtures/recommend/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::recommend::*;
use serde_json::Value;
use std::collections::HashSet;

fn ids(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_i64().unwrap())
        .collect()
}

/// The history window as the database would return it: completed, newest first, 15 rows.
fn window(i: &Value) -> Vec<Option<HistoryMedia>> {
    let mut h: Vec<&Value> = i["history"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|h| h["completed"] == true)
        .collect();
    h.sort_by_key(|h| std::cmp::Reverse(h["lastPlayedAt"].as_i64().unwrap()));
    h.iter()
        .take(15)
        .map(|h| serde_json::from_value(h["media"].clone()).unwrap())
        .collect()
}

fn recommendations(i: &Value, taste: &Taste) -> Value {
    let libs = ids(&i["libs"]);
    let excluded: HashSet<i64> = taste
        .kept_ids()
        .chain(ids(&i["startedMediaIds"]))
        .chain(ids(&i["dismissedMediaIds"]))
        .collect();
    // The candidate query: genres non-empty, not excluded, in the accessible libraries.
    let candidates: Vec<Candidate> = i["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            let has_genres = c["genres"].as_array().is_some_and(|g| !g.is_empty());
            has_genres
                && !excluded.contains(&c["id"].as_i64().unwrap())
                && libs.contains(&c["libraryId"].as_i64().unwrap())
        })
        .map(|c| serde_json::from_value(c.clone()).unwrap())
        .collect();
    let top = stratify(
        taste.score(candidates),
        i["limit"].as_u64().map(|l| l as usize),
    );
    let available: HashSet<i64> = i["availableRows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| match &r["mediaId"] {
            Value::String(s) => s.parse().unwrap(),
            v => v.as_i64().unwrap(),
        })
        .collect();
    serde_json::to_value(taste.items(top, &available)).unwrap()
}

#[test]
fn recommend_reproduces_expected() {
    replay("recommend", 74, |i| {
        let Some(taste) = Taste::from_history(&window(i)) else {
            return Value::Array(vec![]);
        };
        if i["fn"] == "getTopGenres" {
            let limit = i["topLimit"].as_u64().map_or(8, |l| l as usize);
            return serde_json::to_value(taste.top_genres(limit)).unwrap();
        }
        if i["libs"].as_array().unwrap().is_empty() {
            return Value::Array(vec![]);
        }
        recommendations(i, &taste)
    });
}

#[test]
fn orders_equal_scores_by_media_id() {
    let cand = |id| Candidate {
        id,
        title: format!("T{id}"),
        kind: "movie".into(),
        year: None,
        poster_url: None,
        fanart_url: None,
        additional_fanart_urls: None,
        genres: Some(vec!["Action".into()]),
    };
    let history = [Some(HistoryMedia {
        id: 1,
        title: "W".into(),
        genres: Some(vec!["Action".into()]),
    })];
    let taste = Taste::from_history(&history).unwrap();
    let mut scored = taste.score(vec![cand(30), cand(10), cand(20)]);
    assert_eq!(
        scored.iter().map(|s| s.media.id).collect::<Vec<_>>(),
        [30, 10, 20]
    );
    rank_by_score(&mut scored);
    assert_eq!(
        scored.iter().map(|s| s.media.id).collect::<Vec<_>>(),
        [10, 20, 30]
    );
}
