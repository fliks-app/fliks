//! A rescan of a book folder (`ingest::books::refresh`) survives a part that cannot be probed.
use fliks_server::{
    config::Config,
    ingest::{
        books::{KnownFile, refresh},
        rescan::PROBE_VERSION,
    },
    state::AppState,
};
use sqlx::PgPool;

#[sqlx::test]
async fn one_unprobeable_audio_part_does_not_stop_the_refresh(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let dir = std::env::temp_dir().join(format!("fliks-refresh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.mp3"), b"damaged").unwrap();
    std::fs::write(dir.join("b.epub"), b"changed on disk").unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO libraries (id, name) VALUES (1, 'L');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/b');
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (1, 'Book', 'book', 1, 'b');
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 1, 1, 'a.mp3', 7, 'MP3', '{}'), (2, 1, 1, 'b.epub', 1, 'EPUB', '{}');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    // No engine is configured, so every probe fails; the epub never needs one.
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    // The audio row is stale only by its probe version, as after a `PROBE_VERSION` bump.
    let known = |id, rel: &str, size| KnownFile {
        id,
        rel: rel.into(),
        size,
        mtime_ms: None,
        probe_version: Some(PROBE_VERSION - 1),
    };
    let (a, b) = (known(1, "a.mp3", 7), known(2, "b.epub", 1));
    let updated = refresh(&st, &dir, &[&a, &b]).await.unwrap();
    assert_eq!(updated, 1);
    let size: i64 = sqlx::query_scalar(r#"SELECT size FROM media_files WHERE id = 2"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(size, 15);
    std::fs::remove_dir_all(&dir).unwrap();
}
