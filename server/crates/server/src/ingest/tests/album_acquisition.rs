//! An album handed over by a download: named by its tags, its sidecars and artwork carried along
//! (`docs/spec/music.md` rule 48).
use super::*;
use crate::ingest::{
    library::{self, File, Request},
    transfer::Method,
};

fn track(title: &str, number: u32, disc: u32, discs: u32) -> crate::engine::testkit::Answer {
    ok(
        json!({"ok": true, "info": {"video": [], "audio": [{"streamIndex": 0, "codec": "flac", "language": "und"}],
        "subtitles": [], "durationSeconds": 200.0,
        "tags": {"title": title, "album": "Salt Meadows", "artist": "Cora Vell", "albumArtist": "Cora Vell",
                 "track": number, "disc": disc, "discTotal": discs}}}),
    )
}

async fn album(c: &Ctx) -> i32 {
    let l = library(c, "Music", &c.dir.join("music"), r#"["album"]"#).await;
    let m = media(c, l, "Cora Vell/Salt Meadows (2019)", "album").await;
    sqlx::query("UPDATE media SET title = 'Salt Meadows', year = 2019 WHERE id = $1")
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
    m
}

async fn bring(c: &Ctx, m: i32, files: &[&Path], method: Method) -> library::Outcome {
    let guard = c.st.ingest.media.lock(m).await;
    library::ingest(
        &c.st,
        &guard,
        Request {
            media_id: m,
            files: files
                .iter()
                .map(|p| File {
                    path: p.to_path_buf(),
                    episode_id: None,
                })
                .collect(),
            transfer: method,
            fallback_quality: None,
            release_name: Some("Cora Vell - Salt Meadows [FLAC]".into()),
            force: false,
            uniquify_on_collision: false,
            replace_existing: true,
            language: None,
        },
    )
    .await
    .unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[sqlx::test(migrations = false)]
async fn two_discs_with_the_same_file_names_do_not_collide(pool: PgPool) {
    let c = ctx(pool).await;
    let m = album(&c).await;
    let inbox = c.dir.join("inbox/release");
    let (a, b) = (inbox.join("CD1/01.flac"), inbox.join("CD2/01.flac"));
    touch(&a, b"disc one");
    touch(&b, b"disc two");
    touch(&inbox.join("CD1/01.lrc"), b"[00:01.00]la");
    touch(&inbox.join("CD1/cover.jpg"), b"cover");
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![
            track("Low Tide", 1, 1, 2),
            track("High Tide", 1, 2, 2),
            track("Low Tide", 1, 1, 2),
            track("High Tide", 1, 2, 2),
        ],
    );
    let out = bring(&c, m, &[&a, &b], Method::Move).await;
    assert!(
        out.errors.is_empty() && out.already_present.is_empty(),
        "{:?}",
        out.errors
    );
    assert_eq!(out.imported.len(), 2);
    let dest = c.dir.join("music/Cora Vell/Salt Meadows (2019)");
    assert_eq!(
        names(&dest),
        [
            "01-01 - Low Tide.flac",
            "01-01 - Low Tide.lrc",
            "02-01 - High Tide.flac",
            "cover.jpg"
        ]
    );
    assert!(!a.exists() && !b.exists(), "a move empties the source");
}

#[sqlx::test(migrations = false)]
async fn a_single_track_is_imported_alone_and_a_file_without_a_number_keeps_its_name(pool: PgPool) {
    let c = ctx(pool).await;
    let m = album(&c).await;
    let inbox = c.dir.join("inbox/single");
    let (one, odd) = (inbox.join("whatever.flac"), inbox.join("hidden.flac"));
    touch(&one, b"x");
    touch(&odd, b"y");
    c.fake.script(
        "POST",
        "/v1/probe",
        vec![
            track("Low Tide", 5, 1, 1),
            ok(json!({"ok": true, "info": {"video": [], "audio": [{"streamIndex": 0, "codec": "flac", "language": "und"}],
                "subtitles": [], "durationSeconds": 10.0, "tags": {"album": "Salt Meadows"}}})),
            track("Low Tide", 5, 1, 1),
            ok(json!({"ok": true, "info": {"video": [], "audio": [{"streamIndex": 0, "codec": "flac", "language": "und"}],
                "subtitles": [], "durationSeconds": 10.0, "tags": {"album": "Salt Meadows"}}})),
        ],
    );
    let out = bring(&c, m, &[&one, &odd], Method::Copy).await;
    assert_eq!(out.imported.len(), 2, "{:?}", out.errors);
    let dest = c.dir.join("music/Cora Vell/Salt Meadows (2019)");
    assert_eq!(names(&dest), ["05 - Low Tide.flac", "hidden.flac"]);
    assert!(one.exists(), "a copy keeps the source");
}
