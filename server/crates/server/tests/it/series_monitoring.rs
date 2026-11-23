//! A series' monitoring is derived from its seasons (`items.md` rule 31): triggers, guard and policy.
use sqlx::PgPool;

async fn setup(pool: &PgPool) {
    fliks_server::db::migrate(pool).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO libraries (id, name) VALUES (1, 'l');
         INSERT INTO media (id, title, type, \"libraryId\") VALUES (1, 'show', 'series', 1);",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn state(pool: &PgPool, id: i32) -> (String, bool) {
    sqlx::query_as(
        "SELECT series_monitoring(id, \"monitorNewSeasons\"), monitored FROM media WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn season(pool: &PgPool, media: i32, n: i32, monitored: bool) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO item_groups (\"mediaId\", \"number\", monitored) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(media)
    .bind(n)
    .bind(monitored)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_series_follows_its_seasons(pool: PgPool) {
    setup(&pool).await;
    assert_eq!(
        state(&pool, 1).await,
        ("all".into(), true),
        "no season: the policy"
    );
    let s1 = season(&pool, 1, 1, true).await;
    let s2 = season(&pool, 1, 2, true).await;
    assert_eq!(state(&pool, 1).await, ("all".into(), true));
    sqlx::query("UPDATE item_groups SET monitored = false WHERE id = $1")
        .bind(s2)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(state(&pool, 1).await, ("partial".into(), true));
    sqlx::query("UPDATE item_groups SET monitored = false WHERE id = $1")
        .bind(s1)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(state(&pool, 1).await, ("none".into(), false));
    sqlx::query("DELETE FROM item_groups WHERE \"mediaId\" = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        state(&pool, 1).await,
        ("all".into(), true),
        "seasonless again: the policy"
    );
}

#[sqlx::test(migrations = false)]
async fn specials_alone_keep_the_series_monitored(pool: PgPool) {
    setup(&pool).await;
    sqlx::query("UPDATE media SET \"monitorNewSeasons\" = false WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(state(&pool, 1).await, ("none".into(), false));
    season(&pool, 1, 0, true).await;
    assert_eq!(state(&pool, 1).await, ("partial".into(), true));
    season(&pool, 1, 1, false).await;
    assert_eq!(state(&pool, 1).await, ("partial".into(), true));
}

#[sqlx::test(migrations = false)]
async fn a_direct_write_that_disagrees_raises(pool: PgPool) {
    setup(&pool).await;
    season(&pool, 1, 1, true).await;
    let e = sqlx::query("UPDATE media SET monitored = false WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("derived from its seasons"), "{e}");
    sqlx::query("UPDATE media SET monitored = true WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_new_season_takes_the_policy(pool: PgPool) {
    setup(&pool).await;
    sqlx::query("UPDATE media SET \"monitorNewSeasons\" = false WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let mut c = pool.acquire().await.unwrap();
    let (_, made) = fliks_server::media::items::ensure_group(&mut c, 1, 1)
        .await
        .unwrap();
    assert!(made);
    let m: bool = sqlx::query_scalar(
        "SELECT monitored FROM item_groups WHERE \"mediaId\" = 1 AND \"number\" = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!m);
    sqlx::query("UPDATE media SET \"monitorNewSeasons\" = true WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    fliks_server::media::items::ensure_group(&mut c, 1, 2)
        .await
        .unwrap();
    fliks_server::media::items::ensure_group(&mut c, 1, 0)
        .await
        .unwrap();
    let m: Vec<(i32, bool)> = sqlx::query_as(
        "SELECT \"number\", monitored FROM item_groups WHERE \"mediaId\" = 1 ORDER BY 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(m, [(0, false), (1, false), (2, true)]);
    assert_eq!(state(&pool, 1).await, ("partial".into(), true));
}

#[sqlx::test(migrations = false)]
async fn a_movie_turned_series_starts_from_its_flag(pool: PgPool) {
    setup(&pool).await;
    sqlx::query(
        "INSERT INTO media (id, title, type, monitored, \"libraryId\") VALUES (2, 'film', 'movie', false, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE media SET \"monitorNewSeasons\" = monitored WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE media SET type = 'series' WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(state(&pool, 2).await, ("none".into(), false));
}

#[sqlx::test(migrations = false)]
async fn two_season_toggles_on_one_series_do_not_deadlock(pool: PgPool) {
    setup(&pool).await;
    let ids = [
        season(&pool, 1, 1, true).await,
        season(&pool, 1, 2, true).await,
    ];
    let mut tasks = vec![];
    for round in 0..20 {
        for id in ids {
            let p = pool.clone();
            tasks.push(tokio::spawn(async move {
                sqlx::query("UPDATE item_groups SET monitored = $2 WHERE id = $1")
                    .bind(id)
                    .bind(round % 2 == 0)
                    .execute(&p)
                    .await
            }));
        }
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    let (kind, monitored) = state(&pool, 1).await;
    assert_eq!(monitored, kind != "none");
}
