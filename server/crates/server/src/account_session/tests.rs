use super::*;
use crate::config::Config;
use sqlx::PgPool;

async fn state(pool: &PgPool) -> AppState {
    crate::db::migrate(pool).await.unwrap();
    let cfg = Config::from_lookup(|_| None);
    AppState::new(pool.clone(), cfg, "0123456789abcdef0123456789abcdef")
}

async fn user(pool: &PgPool, name: &str, sync: bool, kinds: Option<&[&str]>) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO users (username, "sessionSync", "sessionKinds") VALUES ($1, $2, $3::text[]) RETURNING id"#,
    )
    .bind(name)
    .bind(sync)
    .bind(kinds)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn item(pool: &PgPool) -> i32 {
    sqlx::query_scalar(
        r#"WITH m AS (INSERT INTO media (title, type) VALUES ('placeholder', 'movie') RETURNING id),
                e AS (INSERT INTO editions ("mediaId", family) SELECT id, 'video' FROM m RETURNING id, "mediaId")
           INSERT INTO items ("mediaId", "editionId") SELECT "mediaId", id FROM e RETURNING id"#,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

fn beat(account: i32, sid: &str, target: &str, item: i32) -> BeatIn {
    BeatIn {
        account,
        hub_user: account,
        sid: sid.into(),
        connection: None,
        owner: Owner {
            target_id: Some(target.into()),
            device_name: Some(format!("device {target}")),
            form_factor: None,
        },
        kind: MediaKind::Movie,
        item,
        file: None,
        state: State::Playing,
        position: 10.0,
        duration: Some(100.0),
        queue: None,
    }
}

/// A presence entry that beat just now, so a read finds the owner alive.
fn alive(st: &AppState, sid: &str) {
    use crate::{events::event::PlayState, presence::LiveSession};
    use fliks_engine_core::api::SessionKind;
    st.presence.create(LiveSession {
        session_id: sid.into(),
        user_id: None,
        username: None,
        media_file_id: 1,
        media_title: None,
        media_type: Some("movie".into()),
        poster_url: None,
        fanart_url: None,
        profile_hash: None,
        quality: None,
        qualities: None,
        attributed_user_id: None,
        autoplay_blocked: false,
        has_next: false,
        kind: SessionKind::Directplay,
        device_label: None,
        system_name: None,
        app_version: None,
        sse_connection_id: None,
        started_at: now_ms(),
        last_beat: now_ms(),
        position: 0.0,
        state: PlayState::Playing,
        episode_label: None,
        item_id: None,
        supports_volume: None,
        subtitle_id: None,
        audio_track_index: None,
        subtitle_track_index: None,
        volume: None,
        muted: None,
        audio_plan: None,
        source_fps: None,
        bitrate_by_quality: None,
        hdr_ladder: false,
        transcode_reasons: vec![],
        client_tonemap: false,
    });
}

async fn row(st: &AppState, user: i32) -> Option<Row> {
    st.account_sessions.get(st, user).await
}

#[sqlx::test(migrations = false)]
async fn concurrent_claims_leave_one_owner_and_one_superseded(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let sessions = &st.account_sessions;
    let (a, b) = tokio::join!(
        sessions.beat(&st, beat(u, "s1", "tA", i)),
        sessions.beat(&st, beat(u, "s2", "tB", i)),
    );
    assert_eq!((a, b), (Verdict::Current, Verdict::Current));
    let owner = row(&st, u).await.unwrap();
    assert_eq!(owner.epoch, 2, "the second claim is a change of owner");
    let (winner, loser, target) = match owner.session_id.as_str() {
        "s1" => ("s1", "s2", "tA"),
        _ => ("s2", "s1", "tB"),
    };
    assert_eq!(owner.owner.target_id.as_deref(), Some(target));
    let late = |sid: &str, t: &str| beat(u, sid, t, i);
    let lost_target = if loser == "s1" { "tA" } else { "tB" };
    assert_eq!(
        sessions.beat(&st, late(loser, lost_target)).await,
        Verdict::Superseded
    );
    assert_eq!(
        sessions.beat(&st, late(winner, target)).await,
        Verdict::Current
    );
}

#[sqlx::test(migrations = false)]
async fn a_replaced_session_of_the_same_device_keeps_the_epoch_and_is_not_superseded(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    s.beat(&st, beat(u, "s2", "tA", i)).await;
    let r = row(&st, u).await.unwrap();
    assert_eq!((r.epoch, r.session_id.as_str()), (1, "s2"));
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Ignored);
}

#[sqlx::test(migrations = false)]
async fn the_option_off_or_another_kind_or_no_target_leaves_no_row(pool: PgPool) {
    let st = state(&pool).await;
    let i = item(&pool).await;
    let off = user(&pool, "off", false, None).await;
    let music = user(&pool, "music", true, Some(&["album"])).await;
    let any = user(&pool, "any", true, None).await;
    let s = &st.account_sessions;
    assert_eq!(s.beat(&st, beat(off, "a", "t", i)).await, Verdict::Ignored);
    assert_eq!(
        s.beat(&st, beat(music, "b", "t", i)).await,
        Verdict::Ignored
    );
    let mut no_target = beat(any, "c", "t", i);
    no_target.owner.target_id = None;
    assert_eq!(s.beat(&st, no_target).await, Verdict::Ignored);
    for u in [off, music, any] {
        assert!(row(&st, u).await.is_none());
    }
    let mut album = beat(music, "d", "t", i);
    album.kind = MediaKind::Album;
    assert_eq!(s.beat(&st, album).await, Verdict::Current);
}

#[sqlx::test(migrations = false)]
async fn a_shared_device_parks_the_row_of_the_account_it_was_playing_for(pool: PgPool) {
    let st = state(&pool).await;
    let i = item(&pool).await;
    let (a, b) = (
        user(&pool, "a", true, None).await,
        user(&pool, "b", true, None).await,
    );
    let s = &st.account_sessions;
    alive(&st, "s2");
    s.beat(&st, beat(a, "s1", "tv", i)).await;
    s.beat(&st, beat(b, "s2", "tv", i)).await;
    assert_eq!(row(&st, a).await.unwrap().state, State::Parked);
    assert_eq!(row(&st, b).await.unwrap().state, State::Playing);
}

#[sqlx::test(migrations = false)]
async fn the_sweep_parks_a_silent_owner_and_drops_a_parked_row_after_a_day(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    s.sweep(&st).await;
    let parked = row(&st, u).await.unwrap();
    assert_eq!((parked.state, parked.position), (State::Parked, 10.0));
    s.0.lock().await.rows.get_mut(&u).unwrap().row.updated_at =
        Utc::now() - chrono::Duration::hours(25);
    s.sweep(&st).await;
    assert!(row(&st, u).await.is_none());
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM account_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, 0);
}

#[sqlx::test(migrations = false)]
async fn a_restart_parks_every_stored_row(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    st.account_sessions.beat(&st, beat(u, "s1", "tA", i)).await;
    let fresh = AccountSessions::default();
    fresh.load(&st).await.unwrap();
    let r = fresh.get(&st, u).await.unwrap();
    assert_eq!((r.state, r.epoch), (State::Parked, 1));
}

#[sqlx::test(migrations = false)]
async fn completion_removes_the_row_and_the_sid_never_claims_again(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    s.complete(&st, u, "s1").await;
    assert!(row(&st, u).await.is_none());
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Ignored);
    assert!(row(&st, u).await.is_none());
}

#[sqlx::test(migrations = false)]
async fn only_a_parked_row_can_be_dismissed(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    assert!(s.dismiss(&st, u).await.is_ok(), "no row is a no-op");
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    assert!(s.dismiss(&st, u).await.is_err());
    s.ended(&st, "s1").await;
    assert!(s.dismiss(&st, u).await.is_ok());
    assert!(row(&st, u).await.is_none());
}

#[sqlx::test(migrations = false)]
async fn a_parked_owner_that_beats_again_resumes_and_a_new_beat_keeps_the_queue(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    let mut first = beat(u, "s1", "tA", i);
    first.queue = Some(QueueState {
        item_ids: vec![1, 2, 3],
        index: 1,
        shuffle: true,
        repeat: Repeat::All,
    });
    s.beat(&st, first).await;
    s.sweep(&st).await;
    assert_eq!(row(&st, u).await.unwrap().state, State::Parked);
    alive(&st, "s1");
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Current);
    let r = row(&st, u).await.unwrap();
    assert_eq!(r.state, State::Playing);
    assert_eq!(
        r.queue.unwrap().item_ids,
        [1, 2, 3],
        "an absent queue is kept"
    );
}

#[sqlx::test(migrations = false)]
async fn a_revived_session_of_a_device_that_lost_the_screen_stays_superseded(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    s.ended(&st, "s1").await;
    assert_eq!(s.beat(&st, beat(u, "s2", "tB", i)).await, Verdict::Current);
    assert_eq!(
        s.beat(&st, beat(u, "s1", "tA", i)).await,
        Verdict::Superseded
    );
    assert!(s.is_superseded(u, "s1").await);
    assert_eq!(row(&st, u).await.unwrap().session_id, "s2");
    s.0.lock().await.claimed.get_mut("s1").unwrap().ended_at = Some(0);
    s.sweep(&st).await;
    assert!(
        !s.is_superseded(u, "s1").await,
        "forgotten past the revive window"
    );
}

#[sqlx::test(migrations = false)]
async fn an_out_of_scope_sid_reads_the_preference_once_until_it_ends(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", false, None).await, item(&pool).await);
    let s = &st.account_sessions;
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Ignored);
    sqlx::query(r#"UPDATE users SET "sessionSync" = true WHERE id = $1"#)
        .bind(u)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Ignored);
    s.ended(&st, "s1").await;
    assert_eq!(s.beat(&st, beat(u, "s1", "tA", i)).await, Verdict::Current);
}

#[test]
fn a_beat_queue_is_taken_only_when_well_formed() {
    let q = |v: serde_json::Value| QueueState::from_beat(&v);
    let ok = q(serde_json::json!({"itemIds": [4, 5], "index": 1, "repeat": "one"})).unwrap();
    assert_eq!((ok.index, ok.shuffle, ok.repeat), (1, false, Repeat::One));
    assert!(q(serde_json::json!({"itemIds": [4], "index": 1})).is_none());
    assert!(q(serde_json::json!({"itemIds": [4], "index": -1})).is_none());
    assert!(q(serde_json::json!({"itemIds": [4], "index": 0, "repeat": "x"})).is_none());
    assert!(q(serde_json::json!({"itemIds": vec![1; 501], "index": 0})).is_none());
    assert!(q(serde_json::json!("queue")).is_none());
}

fn reading(account: i32, item: i32, progression: f64) -> ReadingIn {
    ReadingIn {
        account,
        owner: Owner {
            target_id: Some("tA".into()),
            device_name: Some("device tA".into()),
            form_factor: None,
        },
        kind: MediaKind::Movie,
        item,
        file: 1,
        progression,
    }
}

#[sqlx::test]
async fn a_reader_save_parks_a_row_without_bumping_the_epoch_and_never_replaces_a_live_one(
    pool: PgPool,
) {
    let st = state(&pool).await;
    let s = &st.account_sessions;
    let u = user(&pool, "u", true, None).await;
    let i = item(&pool).await;
    s.reading(&st, reading(u, i, 0.2)).await;
    s.reading(&st, reading(u, i, 0.4)).await;
    let r = row(&st, u).await.unwrap();
    assert_eq!((r.state, r.epoch, r.position), (State::Parked, 1, 0.4));
    s.complete_reading(&st, u, i).await;
    assert!(row(&st, u).await.is_none());
    alive(&st, "s1");
    s.beat(&st, beat(u, "s1", "tB", i)).await;
    s.reading(&st, reading(u, i, 0.9)).await;
    let r = row(&st, u).await.unwrap();
    assert_eq!((r.session_id.as_str(), r.state), ("s1", State::Playing));
}

#[sqlx::test]
async fn a_reader_save_out_of_scope_leaves_no_row(pool: PgPool) {
    let st = state(&pool).await;
    let off = user(&pool, "off", false, None).await;
    let other = user(&pool, "other", true, Some(&["book"])).await;
    let i = item(&pool).await;
    st.account_sessions.reading(&st, reading(off, i, 0.5)).await;
    st.account_sessions
        .reading(&st, reading(other, i, 0.5))
        .await;
    assert!(row(&st, off).await.is_none() && row(&st, other).await.is_none());
}

fn queued(ids: Vec<i64>) -> Option<QueueState> {
    Some(QueueState {
        item_ids: ids,
        index: 0,
        shuffle: false,
        repeat: Repeat::Off,
    })
}

#[sqlx::test(migrations = false)]
async fn a_same_owner_claim_keeps_the_queue_only_when_it_holds_the_item(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    let mut first = beat(u, "s1", "tA", i);
    first.queue = queued(vec![i64::from(i), 99]);
    s.beat(&st, first).await;
    s.beat(&st, beat(u, "s2", "tA", i)).await;
    assert_eq!(row(&st, u).await.unwrap().queue.unwrap().item_ids.len(), 2);
    let other = item(&pool).await;
    s.beat(&st, beat(u, "s3", "tA", other)).await;
    assert!(row(&st, u).await.unwrap().queue.is_none());
}

#[sqlx::test(migrations = false)]
async fn a_beat_without_a_target_keeps_the_stored_one(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    let mut b = beat(u, "s1", "tA", i);
    b.owner.target_id = None;
    s.beat(&st, b).await;
    let r = row(&st, u).await.unwrap();
    assert_eq!(r.owner.target_id.as_deref(), Some("tA"));
}

#[sqlx::test(migrations = false)]
async fn boot_rebuilds_the_claims_from_the_rows(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    st.account_sessions.beat(&st, beat(u, "s1", "tA", i)).await;
    st.account_sessions.beat(&st, beat(u, "s2", "tB", i)).await;
    let fresh = AccountSessions::default();
    fresh.load(&st).await.unwrap();
    assert_eq!(
        fresh.beat(&st, beat(u, "s2", "tB", i)).await,
        Verdict::Current
    );
    assert!(!fresh.is_superseded(u, "s2").await);
    assert_eq!(
        fresh.beat(&st, beat(u, "s1", "tA", i)).await,
        Verdict::Superseded
    );
}

#[sqlx::test(migrations = false)]
async fn the_sweep_stamps_a_claim_without_presence(pool: PgPool) {
    let st = state(&pool).await;
    let (u, i) = (user(&pool, "a", true, None).await, item(&pool).await);
    let s = &st.account_sessions;
    s.beat(&st, beat(u, "s1", "tA", i)).await;
    s.sweep(&st).await;
    assert!(s.0.lock().await.claimed["s1"].ended_at.is_some());
}
