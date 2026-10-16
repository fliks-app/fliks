//! The pure rules: criteria matching (rule 29) and request scope coverage (rule 41).
use super::{
    db::Ep,
    lifecycle::scope_covered,
    rules::{Ctx, matches},
};
use serde_json::json;

fn ctx() -> Ctx {
    Ctx {
        user_id: 7,
        role_id: Some(3),
        media_type: "series".into(),
        library_id: Some(2),
        genre_ids: vec![16, 35],
        year: Some(2015),
        season_count: Some(2),
    }
}

#[test]
fn an_empty_criteria_matches_everything() {
    assert!(matches(&json!({}), &ctx()));
    assert!(
        !matches(&json!([]), &ctx()),
        "array criteria fail closed (C114)"
    );
}

#[test]
fn users_and_roles_are_alternatives() {
    assert!(matches(&json!({"userIds": [7]}), &ctx()));
    assert!(matches(&json!({"userIds": [1], "roleIds": [3]}), &ctx()));
    assert!(!matches(&json!({"userIds": [1], "roleIds": [4]}), &ctx()));
    let mut c = ctx();
    c.role_id = None;
    assert!(!matches(&json!({"roleIds": [3]}), &c));
}

#[test]
fn media_type_library_and_genres_all_have_to_hold() {
    assert!(!matches(&json!({"mediaType": "movie"}), &ctx()));
    assert!(matches(&json!({"libraryIds": [2, 5]}), &ctx()));
    assert!(!matches(&json!({"libraryIds": [5]}), &ctx()));
    assert!(matches(&json!({"genreIds": [99, 35]}), &ctx()));
    assert!(!matches(&json!({"genreIds": [99]}), &ctx()));
    let mut c = ctx();
    c.library_id = None;
    assert!(
        !matches(&json!({"libraryIds": [2]}), &c),
        "no library cannot satisfy a library criterion"
    );
}

#[test]
fn unanswerable_criteria_fail_the_rule() {
    let mut c = ctx();
    (c.year, c.season_count, c.genre_ids) = (None, None, vec![]);
    for criteria in [
        json!({"yearFrom": 2000}),
        json!({"yearTo": 2030}),
        json!({"maxSeasons": 3}),
        json!({"genreIds": [16]}),
    ] {
        assert!(!matches(&criteria, &c), "{criteria}");
    }
}

#[test]
fn year_bounds_and_the_season_cap() {
    assert!(matches(&json!({"yearFrom": 2015, "yearTo": 2015}), &ctx()));
    assert!(!matches(&json!({"yearFrom": 2016}), &ctx()));
    assert!(!matches(&json!({"yearTo": 2014}), &ctx()));
    assert!(matches(&json!({"maxSeasons": 2}), &ctx()));
    assert!(!matches(&json!({"maxSeasons": 1}), &ctx()));
    let mut movie = ctx();
    movie.media_type = "movie".into();
    movie.season_count = None;
    assert!(
        matches(&json!({"maxSeasons": 1}), &movie),
        "a movie ignores the cap"
    );
}

#[test]
fn null_criteria_are_not_set() {
    assert!(matches(
        &json!({"userIds": null, "mediaType": null, "yearFrom": null}),
        &ctx()
    ));
}

fn ep(season: i32, number: i32, end: Option<i32>, file: bool, monitored: bool) -> Ep {
    Ep {
        season_number: season,
        season_monitored: true,
        number,
        end_number: end,
        monitored,
        has_file: file,
    }
}

#[test]
fn a_multi_episode_file_covers_its_range() {
    let eps = [
        ep(1, 1, Some(3), true, true),
        ep(1, 2, None, false, true),
        ep(1, 3, None, false, true),
    ];
    assert!(scope_covered(Some(&[1]), &eps));
    let eps = [
        ep(1, 1, Some(2), true, true),
        ep(1, 2, None, false, true),
        ep(1, 3, None, false, true),
    ];
    assert!(!scope_covered(Some(&[1]), &eps));
}

#[test]
fn scope_limits_the_seasons_that_are_checked() {
    let eps = [ep(1, 1, None, true, true), ep(2, 1, None, false, true)];
    assert!(scope_covered(Some(&[1]), &eps));
    assert!(!scope_covered(Some(&[2]), &eps));
    assert!(
        !scope_covered(None, &eps),
        "the whole show needs season 2 too"
    );
}

#[test]
fn nothing_to_check_is_not_covered() {
    assert!(
        !scope_covered(Some(&[5]), &[ep(1, 1, None, true, true)]),
        "scope past the library"
    );
    assert!(
        !scope_covered(None, &[ep(1, 1, None, false, false)]),
        "everything unmonitored"
    );
    let mut e = ep(1, 1, None, false, true);
    e.season_monitored = false;
    assert!(!scope_covered(None, &[e]), "unmonitored season");
}
