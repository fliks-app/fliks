//! The pure rules: criteria matching (rule 29) and request scope coverage (rule 41).
use super::{
    db::Ep,
    lifecycle::scope_covered,
    rules::{Ctx, matches, reads_metadata},
};
use fliks_domain::media::{family::Family, kind::MediaKind, wants::WantSpec};
use serde_json::json;

fn ctx() -> Ctx {
    Ctx {
        user_id: 7,
        role_id: Some(3),
        media_type: MediaKind::Series,
        library_id: Some(2),
        genre_ids: vec![16, 35],
        year: Some(2015),
        season_count: Some(2),
        wants: vec![],
    }
}

#[test]
fn an_empty_criteria_matches_everything() {
    assert!(matches(&json!({}), &ctx()));
    assert!(!matches(&json!([]), &ctx()), "array criteria fail closed");
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
    movie.media_type = MediaKind::Movie;
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

fn ep(season: i32, number: i32, file: bool, monitored: bool) -> Ep {
    Ep {
        season_number: season,
        season_monitored: true,
        number,
        monitored,
        has_file: file,
    }
}

#[test]
fn every_monitored_episode_needs_a_file() {
    let eps = [ep(1, 1, true, true), ep(1, 2, true, true)];
    assert!(scope_covered(Some(&[1]), &eps));
    let eps = [ep(1, 1, true, true), ep(1, 2, false, true)];
    assert!(!scope_covered(Some(&[1]), &eps));
}

#[test]
fn scope_limits_the_seasons_that_are_checked() {
    let eps = [ep(1, 1, true, true), ep(2, 1, false, true)];
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
        !scope_covered(Some(&[5]), &[ep(1, 1, true, true)]),
        "scope past the library"
    );
    assert!(
        !scope_covered(None, &[ep(1, 1, false, false)]),
        "everything unmonitored"
    );
    let mut e = ep(1, 1, false, true);
    e.season_monitored = false;
    assert!(!scope_covered(None, &[e]), "unmonitored season");
}

#[test]
fn only_the_criteria_that_need_tmdb_read_metadata() {
    assert!(!reads_metadata(
        &json!({"mediaType": "series", "userIds": [1]}),
        false
    ));
    assert!(reads_metadata(&json!({"genreIds": [16]}), true));
    assert!(reads_metadata(&json!({"yearFrom": 2000}), true));
    assert!(reads_metadata(&json!({"maxSeasons": 2}), false));
    assert!(
        !reads_metadata(&json!({"maxSeasons": 2}), true),
        "a requested scope is the count"
    );
}

#[sqlx::test(migrations = false)]
async fn a_reclaimed_namespace_ignores_the_requests_of_the_earlier_claim(pool: sqlx::PgPool) {
    use crate::plugins::namespaces::{Declared, claim, delete_data};
    use fliks_domain::external_id::Namespace;

    crate::db::migrate(&pool).await.unwrap();
    let ns = Declared {
        name: "org.x:a",
        label: "L",
        id_pattern: "^.+$",
        case: "preserve",
    };
    claim(&pool, "org.x", Some("k1"), &[ns])
        .await
        .unwrap()
        .unwrap();
    let key = super::TitleKey {
        media_type: MediaKind::Book,
        provider: Namespace::parse("org.x:a").unwrap(),
        external_id: "7".into(),
    };
    let wants = [WantSpec {
        family: Family::Text,
        language: None,
        quality_profile_id: None,
    }];
    let new = |key| super::db::New {
        user_id: 1,
        kind: "add",
        title_key: key,
        title: "t",
        seasons: None,
        status: "pending",
        approved_by: None,
        quality_profile_id: None,
        language_profile_id: None,
        library_id: None,
        folder_id: None,
        media_id: None,
        poster_url: None,
        fanart_url: None,
        wants: Some(&wants),
    };
    sqlx::query("INSERT INTO users (id, username, \"isAdmin\") VALUES (1, 'u', true)")
        .execute(&pool)
        .await
        .unwrap();
    super::db::insert(&pool, new(&key)).await.unwrap();
    assert_eq!(super::db::active_adds(&pool, &key).await.unwrap().len(), 1);

    delete_data(&pool, "org.x").await.unwrap();
    let ns = Declared {
        name: "org.x:a",
        label: "L",
        id_pattern: "^.+$",
        case: "preserve",
    };
    claim(&pool, "org.x", Some("k2"), &[ns])
        .await
        .unwrap()
        .unwrap();
    let key = super::TitleKey {
        provider: Namespace::parse("org.x:a").unwrap(),
        ..key
    };
    assert_eq!(super::db::active_adds(&pool, &key).await.unwrap().len(), 0);
}

#[test]
fn family_and_language_criteria_hold_for_every_want() {
    let want = |family, language: Option<&str>| WantSpec {
        family,
        language: language.map(Into::into),
        quality_profile_id: None,
    };
    let mut c = ctx();
    c.media_type = MediaKind::Book;
    let rule = json!({"families": ["text"], "languages": ["fr"]});
    assert!(!matches(&rule, &c), "a title with no wants cannot answer");
    c.wants = vec![want(Family::Text, Some("fr"))];
    assert!(matches(&rule, &c));
    c.wants.push(want(Family::Audio, Some("fr")));
    assert!(!matches(&rule, &c), "one want outside the families fails");
    c.wants = vec![want(Family::Text, None)];
    assert!(
        !matches(&rule, &c),
        "an any-language want fails a language criterion"
    );
    assert!(matches(&json!({"families": ["text"]}), &c));
}
