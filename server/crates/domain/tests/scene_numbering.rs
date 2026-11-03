use fliks_domain::release::{
    parsing::season_episode::{coverage_of, parse_season_episode},
    scene::{SceneMap, parse_havemap},
    scoring::{ReleaseCandidate, ScoreOptions, score_and_sort_releases},
};
use std::collections::BTreeMap;

fn json(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap()
}

fn map() -> SceneMap {
    SceneMap::from_xem(&json(include_str!(
        "../../../fixtures/scene-numbering/map-all.json"
    )))
    .unwrap()
}

fn aired(title: &str) -> (Option<i64>, Option<i64>, bool) {
    let p = map().translate(&parse_season_episode(title));
    (p.season, p.episode, p.is_full_season)
}

#[test]
fn aired_season_searches_its_scene_season() {
    assert_eq!(map().scene_units(3, None), vec![(4, None)]);
    assert_eq!(map().scene_units(1, None), vec![(1, None), (2, None)]);
    assert_eq!(map().scene_units(3, Some(1)), vec![(4, Some(1))]);
    assert_eq!(map().scene_units(1, Some(6)), vec![(2, Some(1))]);
}

#[test]
fn an_unmapped_aired_unit_searches_itself() {
    assert_eq!(map().scene_units(4, None), vec![(4, None)]);
    assert_eq!(map().scene_units(4, Some(2)), vec![(4, Some(2))]);
}

#[test]
fn scene_pack_resolves_to_the_aired_season() {
    assert_eq!(aired("Show.S03.FRENCH.1080p"), (Some(2), None, true));
    assert_eq!(aired("Show.S04.FRENCH.1080p"), (Some(3), None, true));
}

#[test]
fn scene_episode_resolves_per_episode() {
    assert_eq!(aired("Show.S02E01.1080p"), (Some(1), Some(6), false));
    assert_eq!(aired("Show.S04E08.1080p"), (Some(3), Some(8), false));
}

#[test]
fn split_scene_season_is_a_partial_pack() {
    assert_eq!(aired("Show.S02.1080p"), (Some(1), Some(6), false));
    let p = map().translate(&parse_season_episode("Show.S02.1080p"));
    assert_eq!((p.episode_end, p.is_full_season), (Some(10), false));
    // Both halves of aired season 1 together are the full season.
    assert_eq!(aired("Show.S01-S02.1080p"), (Some(1), None, true));
}

#[test]
fn an_unmapped_number_keeps_its_number() {
    assert_eq!(aired("Show.S05.1080p"), (Some(5), None, true));
    assert_eq!(aired("Show.S05E03.1080p"), (Some(5), Some(3), false));
    assert_eq!(aired("Show.S00E01.1080p"), (Some(0), Some(1), false));
}

#[test]
fn file_numbers_translate() {
    let p = parse_season_episode("Show.S04E01.mkv");
    let t = map().translate(&p);
    assert_eq!((t.season, t.episode), (Some(3), Some(1)));
}

#[test]
fn guard_rejects_a_library_with_other_season_counts() {
    let lib = |counts: &[(i64, i64)]| counts.iter().copied().collect::<BTreeMap<_, _>>();
    assert!(map().fits(&lib(&[(1, 10), (2, 7), (3, 8)])));
    assert!(map().fits(&lib(&[(0, 2), (1, 10), (2, 7), (3, 8), (4, 3)])));
    assert!(!map().fits(&lib(&[(1, 5), (2, 7), (3, 8)])));
    assert!(!map().fits(&lib(&[(1, 10), (2, 7)])));
}

#[test]
fn recorded_bodies_parse_and_failures_are_errors() {
    let ids = parse_havemap(&json(include_str!(
        "../../../fixtures/scene-numbering/havemap.json"
    )));
    assert_eq!(
        ids.unwrap().into_iter().collect::<Vec<_>>(),
        vec![70668, 70900, 71146, 71313, 375921]
    );
    let unknown = json(include_str!(
        "../../../fixtures/scene-numbering/map-unknown.json"
    ));
    assert!(SceneMap::from_xem(&unknown).is_err());
    assert!(SceneMap::from_xem(&json(r#"{"result":"success","data":[]}"#)).is_err());
}

#[test]
fn scene_pack_is_rejected_for_the_next_aired_season() {
    let opts = |scene: bool| -> ScoreOptions {
        let mut v = serde_json::json!({
            "allowed": [], "allowedLangs": [], "sizeByQuality": {}, "sourceMinSeeders": {},
            "sourceUnknownLang": {}, "runtimeMinutes": 0.0, "expectedSeason": 3
        });
        if scene {
            v["sceneMap"] = serde_json::to_value(map()).unwrap();
        }
        serde_json::from_value(v).unwrap()
    };
    let cand = |title: &str| ReleaseCandidate {
        title: title.into(),
        download_url: String::new(),
        source_id: 0,
        source_name: String::new(),
        size: 0.0,
        seeders: 1,
        leechers: 0,
        publish_date: None,
        flags: vec![],
    };
    let run = |title: &str, scene| {
        let o = opts(scene);
        let r = score_and_sort_releases(vec![cand(title)], &o, &|_, _| 0, &|_, _| false);
        r[0].rejections.iter().any(|j| j.code == "EPISODE_MISMATCH")
    };
    assert!(!run("Show.S04.FRENCH.1080p", true));
    assert!(run("Show.S03.FRENCH.1080p", true));
    assert!(run("Show.S04.FRENCH.1080p", false));
    assert_eq!(
        coverage_of(&parse_season_episode("Show.S03"))
            .seasons
            .unwrap()
            .from,
        3
    );
}
