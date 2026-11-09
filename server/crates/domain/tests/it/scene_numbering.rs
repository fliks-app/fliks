use fliks_domain::release::{
    parsing::season_episode::parse_season_episode,
    scene::{Entry, SceneMap},
    scoring::{ReleaseCandidate, ScoreOptions, score_and_sort_releases},
};
use std::collections::BTreeMap;

fn pairs(p: &[(i64, i64, i64, i64)]) -> SceneMap {
    let entries = p
        .iter()
        .map(|&(scene_season, scene_episode, season, episode)| Entry {
            scene_season,
            scene_episode,
            season,
            episode,
        })
        .collect();
    SceneMap { entries }
}

fn map() -> SceneMap {
    serde_json::from_str(include_str!(
        "../../../../fixtures/scene-numbering/map.json"
    ))
    .unwrap()
}

fn aired(title: &str) -> (Option<i64>, Option<i64>, bool) {
    let p = map().translate(&parse_season_episode(title)).unwrap();
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
    let p = map()
        .translate(&parse_season_episode("Show.S02.1080p"))
        .unwrap();
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
    let t = map().translate(&p).unwrap();
    assert_eq!((t.season, t.episode), (Some(3), Some(1)));
}

#[test]
fn guard_rejects_a_library_with_other_season_counts() {
    let lib = |counts: &[(i64, i64)]| counts.iter().copied().collect::<BTreeMap<_, _>>();
    assert!(map().fits(&lib(&[(1, 10), (2, 7), (3, 8)])));
    assert!(map().fits(&lib(&[(0, 2), (1, 10), (2, 7), (3, 8), (4, 3)])));
    assert!(!map().fits(&lib(&[(1, 5), (2, 7), (3, 8)])));
    assert!(!map().fits(&lib(&[(1, 10), (2, 7)])));
    // Only the last mapped season may hold episodes the mapping lacks.
    assert!(map().fits(&lib(&[(1, 10), (2, 7), (3, 9)])));
    assert!(!map().fits(&lib(&[(1, 11), (2, 7), (3, 8)])));
    // A season the mapping leaves as it is does not count.
    let identity = pairs(&[(1, 1, 1, 1)]);
    assert!(identity.fits(&lib(&[(1, 12)])));
}

fn codes(title: &str, patch: serde_json::Value) -> Vec<String> {
    let mut v = serde_json::json!({
        "allowed": [], "allowedLangs": [], "sizeByQuality": {}, "sourceMinSeeders": {},
        "sourceUnknownLang": {}, "runtimeMinutes": 0.0, "expectedSeason": 3
    });
    v.as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    let o: ScoreOptions = serde_json::from_value(v).unwrap();
    let cand = ReleaseCandidate {
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
    let r = score_and_sort_releases(vec![cand], &o, &|_, _| 0, &|_, _| false);
    r[0].rejections
        .iter()
        .map(|j| j.code.clone())
        .filter(|c| c != "QUALITY_NOT_ALLOWED")
        .collect()
}

fn mapped() -> serde_json::Value {
    serde_json::json!({ "sceneMap": serde_json::to_value(map()).unwrap() })
}

#[test]
fn scene_pack_is_rejected_for_the_next_aired_season() {
    let none = Vec::<String>::new();
    let mismatch = vec!["EPISODE_MISMATCH".to_string()];
    let with = |t| codes(t, mapped());
    assert_eq!(with("Show.S04.FRENCH.1080p"), none);
    assert_eq!(with("Show.S03.FRENCH.1080p"), mismatch);
    assert_eq!(
        codes("Show.S04.FRENCH.1080p", serde_json::json!({})),
        mismatch
    );
}

#[test]
fn an_unknown_or_ambiguous_mapping_rejects_numbered_releases() {
    let unresolved = ["SCENE_UNRESOLVED".to_string()];
    let unknown = serde_json::json!({ "sceneUnknown": true });
    let s = |c: Vec<String>| c.contains(&unresolved[0]);
    assert!(s(codes("Show.S04.FRENCH.1080p", unknown.clone())));
    assert!(!s(codes("Show.FRENCH.1080p", unknown)));
    let ambiguous =
        serde_json::json!({ "sceneMap": serde_json::to_value(ambiguous_map()).unwrap() });
    assert!(s(codes("Show.S02E01.1080p", ambiguous.clone())));
    assert!(!s(codes("Show.S01E01.1080p", ambiguous)));
}

fn ambiguous_map() -> SceneMap {
    serde_json::from_str(include_str!(
        "../../../../fixtures/scene-numbering/map-ambiguous.json"
    ))
    .unwrap()
}

#[test]
fn a_double_episode_translates_and_a_cross_season_split_is_refused() {
    let m = ambiguous_map();
    let t = |title| m.translate(&parse_season_episode(title));
    let double = t("Show.S01E01.1080p").unwrap();
    assert_eq!(
        (double.season, double.episode, double.episode_end),
        (Some(1), Some(1), Some(2))
    );
    assert!(t("Show.S02E01.1080p").is_none());
    assert_eq!(t("Show.S03E01.1080p").unwrap().episode, Some(2));
    // The middle episode of a range is checked too, not only its ends.
    assert!(t("Show.S03E01-E03.1080p").is_none());
    assert!(t("Show.S03.1080p").is_none());
    let pack = t("Show.S01.1080p").unwrap();
    assert_eq!(
        (pack.season, pack.episode, pack.episode_end),
        (Some(1), Some(1), Some(2))
    );
}

#[test]
fn season_zero_is_left_out_of_a_pack_range() {
    let m = pairs(&[(1, 1, 1, 1), (2, 1, 0, 1), (2, 2, 2, 1)]);
    let p = m
        .translate(&parse_season_episode("Show.S01-S02.1080p"))
        .unwrap();
    assert_eq!((p.season, p.season_end), (Some(1), Some(2)));
    assert_eq!(m.scene_units(0, None), vec![(0, None)]);
    assert_eq!(m.scene_units(0, Some(1)), vec![(0, Some(1))]);
}
