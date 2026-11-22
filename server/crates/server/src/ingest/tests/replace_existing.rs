//! A retried download import (`replaceExisting`): a file counts as present only when a row of the media tracks it.
use super::*;
use crate::ingest::{
    library::{self, File, Request},
    transfer::Method,
};

async fn bring(c: &Ctx, m: i32, src: &Path) -> library::Outcome {
    let guard = c.st.ingest.media.lock(m).await;
    library::ingest(
        &c.st,
        &guard,
        Request {
            media_id: m,
            files: vec![File {
                path: src.to_path_buf(),
                episode_id: None,
            }],
            transfer: Method::Copy,
            fallback_quality: None,
            release_name: Some("Movie.2020.1080p.WEB-DL-GRP".into()),
            force: false,
            uniquify_on_collision: false,
            replace_existing: true,
            language: None,
        },
    )
    .await
    .unwrap()
}

async fn movie(c: &Ctx) -> i32 {
    let l = library(c, "Movies", &c.dir.join("movies"), r#"["movie"]"#).await;
    media(c, l, "Movie (2020)", "movie").await
}

#[sqlx::test(migrations = false)]
async fn a_retry_finds_the_row_of_the_first_import(pool: PgPool) {
    let c = ctx(pool).await;
    let m = movie(&c).await;
    let src = c.dir.join("dl/movie.mkv");
    touch(&src, b"movie");
    let first = bring(&c, m, &src).await;
    assert_eq!(first.imported.len(), 1, "{:?}", first.errors);
    let again = bring(&c, m, &src).await;
    assert_eq!((again.imported.len(), again.already_present.len()), (0, 1));
}

#[sqlx::test(migrations = false)]
async fn a_same_size_file_with_no_row_is_replaced_not_counted_present(pool: PgPool) {
    let c = ctx(pool).await;
    let m = movie(&c).await;
    let src = c.dir.join("dl/movie.mkv");
    touch(&src, b"movie");
    let first = bring(&c, m, &src).await;
    sqlx::query(r#"DELETE FROM media_files WHERE "mediaId" = $1"#)
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
    let again = bring(&c, m, &src).await;
    assert_eq!((again.imported.len(), again.already_present.len()), (1, 0));
    assert_eq!(
        again.imported[0].relative_path,
        first.imported[0].relative_path
    );
    let rows: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM media_files WHERE "mediaId" = $1"#)
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrations = false)]
async fn a_release_fault_is_a_refusal_not_a_core_error(pool: PgPool) {
    let c = ctx(pool).await;
    let m = movie(&c).await;
    let out = bring(&c, m, &c.dir.join("dl/missing.mkv")).await;
    assert_eq!((out.refused.len(), out.errors.len()), (1, 0));
}
