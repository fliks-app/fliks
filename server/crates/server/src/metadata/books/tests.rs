//! `attach` and `identify` against fake providers registered in the metadata registry.
use super::{
    ANCHOR,
    identify::{BookHints, BookMatch, identify},
    link::{attach, attach_with, stored},
};
use crate::{
    config::Config,
    metadata::{
        EditionRef, Metadata, MetadataProvider, PersonDetails, Search, Upstream, provider::Call,
    },
    state::AppState,
};
use fliks_domain::{
    external_id::ExternalProvider::{self, Asin, Audible, GoogleBooks, Isbn, OpenLibrary},
    media::{family::Family, kind::MediaKind},
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const ISBN: &str = "9780306406157";
const P: Priority = Priority::Interactive;

#[derive(Default)]
struct Fake {
    id: Option<ExternalProvider>,
    works: HashMap<String, Value>,
    editions: HashMap<(ExternalProvider, String), Value>,
    finds: HashMap<(ExternalProvider, String), String>,
    found: Vec<Value>,
    broken: bool,
    calls: Mutex<Vec<String>>,
}

impl Fake {
    fn new(id: ExternalProvider) -> Self {
        Self {
            id: Some(id),
            ..Self::default()
        }
    }

    fn edition(mut self, ns: ExternalProvider, v: &str, record: Value) -> Self {
        self.editions.insert((ns, v.into()), record);
        self
    }

    fn log(&self, what: &str) {
        self.calls.lock().unwrap().push(what.into());
    }
}

fn down<T: Send + 'static>() -> Call<'static, T> {
    Box::pin(async { Err(Upstream::new(Some(500), "down")) })
}

impl MetadataProvider for Fake {
    fn id(&self) -> ExternalProvider {
        self.id.unwrap()
    }
    fn supports(&self, kind: MediaKind) -> bool {
        kind == MediaKind::Book
    }
    fn has_persons(&self) -> bool {
        false
    }
    fn limits(&self) -> Limits {
        Limits::new(100.0, 100)
    }
    fn search<'a>(
        &'a self,
        _: &'a Search<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        self.log("search");
        let r = self.found.clone();
        Box::pin(async move { Ok(r) })
    }
    fn fetch_work<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        self.log("work");
        let r = self.works.get(id).cloned();
        Box::pin(async move { r.ok_or_else(|| Upstream::new(Some(404), "no work")) })
    }
    fn fetch_children<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn child_stubs<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn find_by<'a>(
        &'a self,
        s: ExternalProvider,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        self.log("find_by");
        let r = self
            .finds
            .get(&(s, id.to_owned()))
            .map(|w| (w.clone(), MediaKind::Book));
        Box::pin(async move { Ok(r) })
    }
    fn fetch_person<'a>(
        &'a self,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, PersonDetails> {
        down()
    }
    fn person_credits<'a>(
        &'a self,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, crate::metadata::Credits> {
        down()
    }
    fn fetch_edition<'a>(
        &'a self,
        e: &'a EditionRef<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<Value>> {
        self.log("edition");
        if self.broken {
            return down();
        }
        let r = self
            .editions
            .get(&(e.namespace, e.value.to_owned()))
            .cloned();
        Box::pin(async move { Ok(r) })
    }
}

fn state(db: &PgPool, fakes: Vec<Fake>) -> AppState {
    let mut st = AppState::new(db.clone(), Config::from_lookup(|_| None), SECRET);
    let m: &mut Metadata = Arc::get_mut(&mut st.metadata).unwrap();
    for f in fakes {
        m.register(Arc::new(f));
    }
    st
}

fn anchor() -> Fake {
    let mut f = Fake::new(OpenLibrary);
    f.works.insert(
        "OL1W".into(),
        json!({"title": "Alpha", "overview": "OL text", "year": 1999, "subjects": ["Novel"],
               "authors": [{"name": "Una Roe", "id": "OL7A"}],
               "series": [{"name": "Cycle", "position": "2", "id": null}]}),
    );
    f
}

fn text_edition_records() -> (Fake, Fake) {
    let ol = anchor().edition(
        Isbn,
        ISBN,
        json!({"externalId": "OL5M", "title": "Alpha", "publisher": "Pub", "pageCount": 320,
               "language": "fre", "releaseDate": "2001-05", "isbn13": [ISBN]}),
    );
    let gb = Fake::new(GoogleBooks).edition(
        Isbn,
        ISBN,
        json!({"externalId": "gb1", "overview": "Long text", "subtitle": "A subtitle"}),
    );
    (ol, gb)
}

async fn book(db: &PgPool) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO media (title, type) VALUES ('Untitled', 'book') RETURNING id"#,
    )
    .fetch_one(db)
    .await
    .unwrap()
}

async fn edition(db: &PgPool, media: i32, family: &str) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO editions ("mediaId", family) VALUES ($1, $2) RETURNING id"#)
        .bind(media)
        .bind(family)
        .fetch_one(db)
        .await
        .unwrap()
}

fn matched(edition: &[(ExternalProvider, &str)]) -> BookMatch {
    BookMatch {
        work: "OL1W".into(),
        edition: edition.iter().map(|(p, v)| (*p, (*v).to_owned())).collect(),
        confidence: 100,
    }
}

async fn strings(db: &PgPool, sql: &'static str, id: i32) -> Vec<String> {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_all(db)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_text_edition_is_linked_merged_and_written(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let (ol, gb) = text_edition_records();
    let st = state(&db, vec![ol, gb]);
    let media = book(&db).await;
    let ed = edition(&db, media, "text").await;
    attach(&st, media, Some(ed), &matched(&[(Isbn, ISBN)]), P)
        .await
        .unwrap();

    let row: (String, Option<String>, Option<i32>) =
        sqlx::query_as(r#"SELECT title, overview, year FROM media WHERE id = $1"#)
            .bind(media)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(row, ("Alpha".into(), Some("Long text".into()), Some(1999)));
    let sub: Option<String> =
        sqlx::query_scalar(r#"SELECT subtitle FROM book_details WHERE "mediaId" = $1"#)
            .bind(media)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(sub.as_deref(), Some("A subtitle"));
    assert_eq!(
        strings(&db, r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'openlibrary'"#, media).await,
        ["OL1W"]
    );
    assert_eq!(
        strings(&db, r#"SELECT provider || ':' || value FROM edition_external_ids WHERE "editionId" = $1 ORDER BY 1"#, ed).await,
        ["googlebooks:gb1".to_owned(), format!("isbn:{ISBN}"), "openlibrary:OL5M".to_owned()]
    );
    let facts: (Option<String>, Option<i32>, Option<String>, Option<String>) = sqlx::query_as(
        r#"SELECT publisher, "pageCount", language, title FROM editions WHERE id = $1"#,
    )
    .bind(ed)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        facts,
        (Some("Pub".into()), Some(320), Some("fr".into()), None)
    );
    assert_eq!(
        strings(
            &db,
            r#"SELECT date::text FROM media_release_dates WHERE "editionId" = $1"#,
            ed
        )
        .await,
        ["2001-05-01"]
    );
    assert_eq!(
        strings(&db, r#"SELECT p.name || '|' || p."sortName" FROM media_credits c JOIN persons p ON p.id = c."personId"
                        WHERE c."mediaId" = $1 AND c.role = 'author' AND c."editionId" IS NULL"#, media).await,
        ["Una Roe|Roe, Una"]
    );
    assert_eq!(
        strings(&db, r#"SELECT x.value FROM person_external_ids x JOIN media_credits c ON c."personId" = x."personId" WHERE c."mediaId" = $1"#, media).await,
        ["OL7A"]
    );
    assert_eq!(
        strings(&db, r#"SELECT c.name || '|' || e.position::text FROM collection_entries e JOIN collections c ON c.id = e."collectionId" WHERE e."mediaId" = $1"#, media).await,
        ["Cycle|2"]
    );
    assert_eq!(
        strings(&db, r#"SELECT field || ':' || provider FROM media_field_sources WHERE "mediaId" = $1 AND field IN ('title', 'overview', 'subtitle') ORDER BY 1"#, media).await,
        ["overview:googlebooks", "subtitle:googlebooks", "title:openlibrary"]
    );
    assert_eq!(
        strings(&db, r#"SELECT field || ':' || provider FROM edition_field_sources WHERE "editionId" = $1 AND field IN ('publisher', 'language') ORDER BY 1"#, ed).await,
        ["language:openlibrary", "publisher:openlibrary"]
    );
    assert_eq!(
        stored(&db, media, Some(ed))
            .await
            .unwrap()
            .map(|m| (m.work, m.edition.len())),
        Some(("OL1W".into(), 3))
    );
}

#[sqlx::test(migrations = false)]
async fn attaching_twice_changes_nothing_more(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let (ol, gb) = text_edition_records();
    let st = state(&db, vec![ol, gb]);
    let media = book(&db).await;
    let ed = edition(&db, media, "text").await;
    let m = matched(&[(Isbn, ISBN)]);
    attach(&st, media, Some(ed), &m, P).await.unwrap();
    attach(&st, media, Some(ed), &m, P).await.unwrap();
    for (sql, id, n) in [
        (
            r#"SELECT count(*)::text FROM media_credits WHERE "mediaId" = $1"#,
            media,
            "1",
        ),
        (
            r#"SELECT count(*)::text FROM collection_entries WHERE "mediaId" = $1"#,
            media,
            "1",
        ),
        (
            r#"SELECT count(*)::text FROM edition_external_ids WHERE "editionId" = $1"#,
            ed,
            "3",
        ),
        (r#"SELECT count(*)::text FROM collections"#, media, "1"),
    ] {
        assert_eq!(strings(&db, sql, id).await, [n], "{sql}");
    }
}

#[sqlx::test(migrations = false)]
async fn an_audio_edition_takes_its_series_and_the_file_narrator(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let audible = Fake::new(Audible).edition(
        Asin,
        "B000000002",
        json!({"externalId": "B000000002", "asin": "B000000002", "format": "audio", "durationSeconds": 3600,
               "language": "fr", "narrators": [{"name": "Voice B", "id": "B000000003"}],
               "series": [{"name": "Cycle A", "position": "2", "id": "B000000001"}]}),
    );
    let st = state(&db, vec![anchor(), audible]);
    let media = book(&db).await;
    let ed = edition(&db, media, "audio").await;
    let file = json!({"narrators": [{"name": "Voice A", "id": null}]});
    let file: &Map<String, Value> = file.as_object().unwrap();
    attach_with(
        &st,
        media,
        Some(ed),
        &matched(&[(Asin, "B000000002")]),
        Some(file),
        P,
    )
    .await
    .unwrap();
    assert_eq!(
        strings(&db, r#"SELECT p.name FROM media_credits c JOIN persons p ON p.id = c."personId" WHERE c."editionId" = $1 AND c.role = 'narrator'"#, ed).await,
        ["Voice A"]
    );
    assert_eq!(
        strings(&db, r#"SELECT c.name || '|' || x.value FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
                        JOIN collection_external_ids x ON x."collectionId" = c.id WHERE e."mediaId" = $1"#, media).await,
        ["Cycle A|B000000001"]
    );
    assert_eq!(
        strings(&db, r#"SELECT count(*)::text FROM collections"#, 0).await,
        ["1"]
    );
    let facts: (Option<String>, Option<i32>) =
        sqlx::query_as(r#"SELECT format, "durationSeconds" FROM editions WHERE id = $1"#)
            .bind(ed)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(facts, (Some("audio".into()), Some(3600)));
    assert_eq!(
        strings(&db, r#"SELECT provider FROM edition_field_sources WHERE "editionId" = $1 AND field = 'narrators'"#, ed).await,
        ["file"]
    );
}

#[sqlx::test(migrations = false)]
async fn an_asin_is_stored_on_an_edition_only(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let audible = Fake::new(Audible).edition(Asin, "B000000002", json!({"title": "Alpha (audio)"}));
    let st = state(&db, vec![anchor(), audible]);
    let media = book(&db).await;
    attach(&st, media, None, &matched(&[(Asin, "B000000002")]), P)
        .await
        .unwrap();
    assert_eq!(
        strings(
            &db,
            "SELECT count(*)::text FROM edition_external_ids WHERE $1 > 0",
            1
        )
        .await,
        ["0"]
    );
}

#[sqlx::test(migrations = false)]
async fn locked_fields_and_failing_providers_do_not_stop_the_attach(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let (ol, mut gb) = text_edition_records();
    gb.broken = true;
    let st = state(&db, vec![ol, gb]);
    let media = book(&db).await;
    let ed = edition(&db, media, "text").await;
    sqlx::query(r#"UPDATE media SET overview = 'mine' WHERE id = $1"#)
        .bind(media)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES ($1, 'overview', NULL, true)"#)
        .bind(media).execute(&db).await.unwrap();
    sqlx::query(r#"UPDATE editions SET publisher = 'Mine' WHERE id = $1"#)
        .bind(ed)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO edition_field_sources ("editionId", field, provider, locked) VALUES ($1, 'publisher', NULL, true)"#)
        .bind(ed).execute(&db).await.unwrap();
    attach(&st, media, Some(ed), &matched(&[(Isbn, ISBN)]), P)
        .await
        .unwrap();
    assert_eq!(
        strings(&db, "SELECT overview FROM media WHERE id = $1", media).await,
        ["mine"]
    );
    assert_eq!(
        strings(&db, "SELECT publisher FROM editions WHERE id = $1", ed).await,
        ["Mine"]
    );
    assert_eq!(
        strings(&db, "SELECT title FROM media WHERE id = $1", media).await,
        ["Alpha"]
    );
    assert_eq!(
        strings(&db, r#"SELECT locked::text FROM media_field_sources WHERE "mediaId" = $1 AND field = 'overview'"#, media).await,
        ["true"]
    );
}

#[sqlx::test(migrations = false)]
async fn a_work_held_by_another_media_is_left_unlinked(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let st = state(&db, vec![anchor()]);
    let (other, media) = (book(&db).await, book(&db).await);
    sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'book', 'openlibrary', 'OL1W')"#)
        .bind(other).execute(&db).await.unwrap();
    attach(&st, media, None, &matched(&[]), P).await.unwrap();
    assert!(
        strings(
            &db,
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1"#,
            media
        )
        .await
        .is_empty()
    );
    assert_eq!(
        strings(&db, "SELECT title FROM media WHERE id = $1", media).await,
        ["Alpha"]
    );
}

fn hints() -> BookHints {
    BookHints {
        family: Family::Text,
        isbns: vec![],
        asin: None,
        title: Some("Alpha".into()),
        authors: vec!["Una Roe".into()],
        narrators: vec![],
        language: None,
        series: None,
        year: None,
    }
}

fn search_hit(title: &str, author: &str, work: &str) -> Value {
    json!({"externalId": work, "title": title, "authors": [{"name": author, "id": null}], "year": 1999})
}

#[sqlx::test(migrations = false)]
async fn identify_by_isbn_then_by_a_search_above_the_threshold(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let mut ol = anchor();
    ol.finds.insert((Isbn, ISBN.into()), "OL1W".into());
    ol.found = vec![
        search_hit("Alpha Two", "Una Roe", "OL2W"),
        search_hit("Alpha", "Una Roe", "OL1W"),
    ];
    let st = state(&db, vec![ol]);

    let strong = BookHints {
        isbns: vec!["978-0-306-40615-7".into()],
        title: None,
        authors: vec![],
        ..hints()
    };
    let m = identify(&st, &strong, P).await.unwrap().unwrap();
    assert_eq!(
        (m.work.as_str(), m.confidence, m.edition),
        ("OL1W", 100, vec![(Isbn, ISBN.to_owned())])
    );

    let m = identify(&st, &hints(), P).await.unwrap().unwrap();
    assert_eq!(m.work, "OL1W");
    assert!(m.confidence >= 85 && m.edition.is_empty());

    let other = BookHints {
        authors: vec!["John Doe".into()],
        ..hints()
    };
    assert!(identify(&st, &other, P).await.unwrap().is_none());
    let bare = BookHints {
        authors: vec![],
        ..hints()
    };
    assert!(identify(&st, &bare, P).await.unwrap().is_none());
}

#[sqlx::test(migrations = false)]
async fn identify_reads_the_title_of_an_asin_and_needs_the_anchor(db: PgPool) {
    crate::db::migrate(&db).await.unwrap();
    let mut ol = anchor();
    ol.found = vec![search_hit("Alpha", "Una Roe", "OL1W")];
    let audible = Fake::new(Audible).edition(
        Asin,
        "B000000002",
        json!({"title": "Alpha", "authors": [{"name": "Una Roe", "id": null}]}),
    );
    let st = state(&db, vec![ol, audible]);
    let h = BookHints {
        family: Family::Audio,
        asin: Some("B000000002".into()),
        title: None,
        authors: vec![],
        ..hints()
    };
    let m = identify(&st, &h, P).await.unwrap().unwrap();
    assert_eq!(
        (m.work.as_str(), m.edition),
        ("OL1W", vec![(Asin, "B000000002".to_owned())])
    );

    let st = state(&db, vec![Fake::new(Audible)]);
    assert!(identify(&st, &hints(), P).await.unwrap().is_none());
    assert_eq!(ANCHOR, OpenLibrary);
}
