//! `/rest/*` (`docs/spec/opensubsonic.md`): authentication, browsing, annotation, playlists and the stream redirect.
use axum::{
    Router,
    body::Body,
    http::{Request, header::LOCATION},
};
use fliks_server::{
    config::Config,
    device_tokens::{self, Kind},
    state::AppState,
    subsonic,
};
use md5::{Digest, Md5};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    /// App password of alice (reads libraries 1 and 2), bob (library 1) and a disabled user.
    alice: String,
    bob: String,
    gone: String,
}

async fn password(st: &AppState, pool: &PgPool, user: i32) -> String {
    let (token, hash) = device_tokens::issue(Kind::Subsonic);
    let sealed = device_tokens::seal(&st.subsonic_key, user, &token);
    sqlx::query(
        r#"INSERT INTO device_tokens ("userId", name, kind, hash, secret) VALUES ($1, 'app', 'subsonic', $2, $3)"#,
    )
    .bind(user)
    .bind(hash)
    .bind(sealed)
    .execute(pool)
    .await
    .unwrap();
    token
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId", enabled) VALUES
          (1, 'alice', false, 1, true), (2, 'bob', false, 1, true), (3, 'gone', false, 1, false);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES
          (1, 'Music', '["album"]'), (2, 'Hidden', '["album"]'), (3, 'Books', '["book"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m/one'), (2, '/m/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 1), (2, 1), (1, 2), (1, 3);
        INSERT INTO persons (id, name, "sortName") VALUES (1, 'The Band', 'Band, The'), (2, 'Solo', NULL), (3, 'Guest', NULL);
        INSERT INTO media (id, title, type, year, genres, "libraryId", "folderName") VALUES
          (10, 'First Album', 'album', 2001, '["Rock","Pop"]', 1, 'a'),
          (11, 'Second Album', 'album', 2005, '["Rock"]', 1, 'b'),
          (12, 'Secret Album', 'album', 2010, '["Jazz"]', 2, 'c');
        INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (10, 1, 'artist', 0), (11, 1, 'artist', 0), (12, 2, 'artist', 0);
        INSERT INTO album_details ("mediaId", "primaryType", "secondaryTypes", "firstReleaseDate") VALUES (10, 'album', '{live}', '2001-05-02');
        INSERT INTO editions (id, "mediaId", family, publisher) VALUES (1, 10, 'audio', 'Label'), (2, 11, 'audio', NULL), (3, 12, 'audio', NULL);
        INSERT INTO items (id, "mediaId", "editionId", title) VALUES
          (100, 10, 1, 'Opening'), (101, 10, 1, 'Closing'), (102, 11, 2, 'Other'), (103, 12, 3, 'Hidden'), (104, 11, 2, 'Wanted');
        INSERT INTO track_details ("itemId", "mediaId", position, "discNumber", "trackNumber", "durationMs") VALUES
          (100, 10, 1, 1, 1, 180000), (101, 10, 2, 1, 2, 200000), (102, 11, 1, 1, 1, 100000),
          (103, 12, 1, 1, 1, 100000), (104, 11, 2, 1, 2, 100000);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'A/01 Opening.mp3', 4000000, 'mp3', '{"durationSeconds": 180, "audio": [{"bitRate": 320000, "sampleRate": 44100, "channels": 2}]}'),
          (2, 10, 1, 'A/02 Closing.flac', 9000000, 'flac', '{"durationSeconds": 200}'),
          (3, 11, 1, 'B/01.mp3', 1000000, 'mp3', '{}'),
          (4, 12, 2, 'C/01.mp3', 1000000, 'mp3', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (100, 1, 10, 0, 0), (101, 2, 10, 0, 0), (102, 3, 11, 0, 0), (103, 4, 12, 0, 0);
        INSERT INTO item_credits ("itemId", "personId", role, position, "joinPhrase") VALUES
          (100, 2, 'artist', 0, ' feat. '), (100, 3, 'artist', 1, NULL), (100, 1, 'composer', 0, NULL);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (alice, bob, gone) = (
        password(&st, &pool, 1).await,
        password(&st, &pool, 2).await,
        password(&st, &pool, 3).await,
    );
    Ctx {
        app: subsonic::router().with_state(st.clone()),
        st,
        pool,
        alice,
        bob,
        gone,
    }
}

fn md5_hex(s: &str) -> String {
    Md5::digest(s).iter().map(|b| format!("{b:02x}")).collect()
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

impl Ctx {
    async fn raw(&self, method: &str, uri: &str, body: Option<&str>) -> axum::response::Response {
        let mut req = Request::builder().method(method).uri(uri);
        if body.is_some() {
            req = req.header("content-type", "application/x-www-form-urlencoded");
        }
        self.app
            .clone()
            .oneshot(req.body(Body::from(body.unwrap_or("").to_owned())).unwrap())
            .await
            .unwrap()
    }

    /// The `subsonic-response` of a JSON call authenticated with `auth` (a query fragment).
    async fn call(&self, endpoint: &str, auth: &str, params: &str) -> Value {
        let uri = format!("/rest/{endpoint}?c=test&v=1.16.1&f=json&{auth}&{params}");
        let res = self.raw("GET", &uri, None).await;
        assert_eq!(res.status(), 200, "{endpoint}");
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let mut v: Value = serde_json::from_slice(&bytes).unwrap();
        v["subsonic-response"].take()
    }

    async fn alice(&self, endpoint: &str, params: &str) -> Value {
        self.call(endpoint, &format!("apiKey={}", self.alice), params)
            .await
    }

    async fn bob(&self, endpoint: &str, params: &str) -> Value {
        self.call(endpoint, &format!("apiKey={}", self.bob), params)
            .await
    }
}

fn code(v: &Value) -> i64 {
    assert_eq!(v["status"], "failed", "{v}");
    v["error"]["code"].as_i64().unwrap()
}

fn names(v: &Value, key: &str) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("{key}: {v}"))
        .iter()
        .map(|e| e[key].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test(migrations = false)]
async fn every_credential_form_authenticates_and_a_wrong_one_does_not(pool: PgPool) {
    let c = ctx(pool).await;
    let key = c.alice.clone();
    let salt = "s4lt";
    let ok = |v: Value| assert_eq!(v["status"], "ok", "{v}");
    ok(c.call("ping", &format!("apiKey={key}"), "").await);
    ok(c.call("ping", &format!("u=alice&p={key}"), "").await);
    ok(c.call("ping", &format!("u=ALICE&p=enc:{}", hex(&key)), "")
        .await);
    ok(c.call(
        "ping",
        &format!("u=alice&t={}&s={salt}", md5_hex(&format!("{key}{salt}"))),
        "",
    )
    .await);
    ok(c.call(
        "ping.view",
        &format!(
            "u=alice&t={}&s={salt}",
            md5_hex(&format!("{key}{salt}")).to_uppercase()
        ),
        "",
    )
    .await);
    let tokeninfo = c.call("tokenInfo", &format!("apiKey={key}"), "").await;
    assert_eq!(tokeninfo["tokenInfo"]["username"], "alice");
    assert_eq!(
        code(&c.call("tokenInfo", &format!("u=alice&p={key}"), "").await),
        44
    );

    assert_eq!(
        code(&c.call("ping", &format!("apiKey={key}&u=alice"), "").await),
        43
    );
    assert_eq!(code(&c.call("ping", "apiKey=nope", "").await), 44);
    assert_eq!(
        code(
            &c.call(
                "ping",
                &format!("apiKey={}", "fkd_".to_owned() + &"0".repeat(64)),
                ""
            )
            .await
        ),
        44
    );
    assert_eq!(code(&c.call("ping", "", "").await), 10);
    assert_eq!(code(&c.call("ping", "u=alice", "").await), 10);
    assert_eq!(
        code(&c.call("ping", &format!("u=bob&p={key}"), "").await),
        40,
        "another user's name"
    );
    assert_eq!(
        code(
            &c.call("ping", &format!("u=alice&t={}&s=x", md5_hex("nope")), "")
                .await
        ),
        40
    );
    assert_eq!(code(&c.call("ping", "u=alice&p=enc:zz", "").await), 40);
    assert_eq!(
        code(&c.call("ping", &format!("apiKey={}", c.gone), "").await),
        40,
        "disabled owner"
    );

    // Missing client parameters, and the unauthenticated extensions list.
    let res = c
        .raw("GET", &format!("/rest/ping?v=1&f=json&apiKey={key}"), None)
        .await;
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["subsonic-response"]["error"]["code"], 10);
    let ext = c.call("getOpenSubsonicExtensions", "", "").await;
    assert_eq!(
        names(&ext["openSubsonicExtensions"], "name"),
        ["apiKeyAuthentication", "formPost"]
    );

    // A renewed password replaces the old one; a revoked row stops working at once.
    sqlx::query("DELETE FROM device_tokens")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        code(&c.call("ping", &format!("apiKey={key}"), "").await),
        44
    );
    assert_eq!(
        code(
            &c.call(
                "ping",
                &format!("u=alice&t={}&s={salt}", md5_hex(&format!("{key}{salt}"))),
                ""
            )
            .await
        ),
        40
    );
}

#[sqlx::test(migrations = false)]
async fn a_secret_sealed_by_another_key_still_verifies_by_hash_only(pool: PgPool) {
    let c = ctx(pool).await;
    let other = AppState::new(
        c.pool.clone(),
        Config::from_lookup(|_| None),
        "another secret entirely, 32 bytes!",
    );
    let (token, hash) = device_tokens::issue(Kind::Subsonic);
    sqlx::query("DELETE FROM device_tokens")
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO device_tokens ("userId", name, kind, hash, secret) VALUES (1, 'a', 'subsonic', $1, $2)"#)
        .bind(hash)
        .bind(device_tokens::seal(&other.subsonic_key, 1, &token))
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        c.call("ping", &format!("u=alice&p={token}"), "").await["status"],
        "ok"
    );
    let t = md5_hex(&format!("{token}x"));
    assert_eq!(
        code(&c.call("ping", &format!("u=alice&t={t}&s=x"), "").await),
        40
    );
}

#[sqlx::test(migrations = false)]
async fn failures_are_throttled_and_a_success_gives_its_attempt_back(pool: PgPool) {
    let c = ctx(pool).await;
    for _ in 0..200 {
        assert_eq!(c.alice("ping", "").await["status"], "ok");
    }
    let mut last = 0;
    for _ in 0..70 {
        last = code(&c.call("ping", "apiKey=nope", "").await);
    }
    assert_eq!(last, 40, "throttled");
    let v = c.alice("ping", "").await;
    assert_eq!(
        v["error"]["message"],
        "Too many failed attempts, try again later"
    );
}

#[sqlx::test(migrations = false)]
async fn the_default_answer_is_xml_and_a_post_form_works(pool: PgPool) {
    let c = ctx(pool).await;
    let res = c
        .raw(
            "GET",
            &format!("/rest/getGenres?c=t&v=1&apiKey={}", c.alice),
            None,
        )
        .await;
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/xml")
    );
    let xml = String::from_utf8(
        axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(
        xml.starts_with("<?xml") && xml.contains(r#"xmlns="http://subsonic.org/restapi""#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"status="ok""#) && xml.contains(r#"openSubsonic="true""#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<genre albumCount="2" songCount="3">Rock</genre>"#),
        "{xml}"
    );
    let body = format!("c=t&v=1&f=json&apiKey={}&id=al-10", c.alice);
    let res = c.raw("POST", "/rest/getAlbum", Some(&body)).await;
    let v: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(v["subsonic-response"]["album"]["name"], "First Album");
    let res = c
        .raw(
            "GET",
            &format!("/rest/ping?c=t&v=1&f=jsonp&callback=cb&apiKey={}", c.alice),
            None,
        )
        .await;
    let text = String::from_utf8(
        axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.starts_with("cb({") && text.ends_with("})"), "{text}");
}

#[sqlx::test(migrations = false)]
async fn browsing_lists_what_the_caller_reads_with_the_wire_fields(pool: PgPool) {
    let c = ctx(pool).await;
    let artists = c.alice("getArtists", "").await;
    let index = &artists["artists"]["index"];
    assert_eq!(index[0]["name"], "B");
    assert_eq!(index[1]["name"], "S");
    assert_eq!(index[0]["artist"][0]["albumCount"], 2);
    assert_eq!(
        names(&c.bob("getArtists", "").await["artists"]["index"], "name"),
        ["B"]
    );
    assert_eq!(
        c.alice("getIndexes", "musicFolderId=1").await["indexes"]["index"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let artist = c.alice("getArtist", "id=ar-1").await["artist"].clone();
    assert_eq!(
        names(&artist["album"], "name"),
        ["First Album", "Second Album"]
    );
    assert_eq!(code(&c.alice("getArtist", "id=al-1").await), 70);
    assert_eq!(
        c.alice("getArtist", "id=ar-3").await["artist"]["albumCount"],
        0,
        "a track artist"
    );

    let album = c.alice("getAlbum", "id=al-10").await["album"].clone();
    assert_eq!(album["songCount"], 2);
    assert_eq!(album["duration"], 380);
    assert_eq!(album["artist"], "The Band");
    assert_eq!(album["releaseTypes"], json!(["Album", "Live"]));
    assert_eq!(
        album["originalReleaseDate"],
        json!({"year": 2001, "month": 5, "day": 2})
    );
    assert_eq!(album["recordLabels"], json!([{"name": "Label"}]));
    assert_eq!(album["genres"], json!([{"name": "Rock"}, {"name": "Pop"}]));
    assert_eq!(names(&album["song"], "title"), ["Opening", "Closing"]);
    let song = &album["song"][0];
    assert_eq!(song["id"], "tr-100");
    assert_eq!(song["track"], 1);
    assert_eq!(song["artist"], "Solo");
    assert_eq!(song["displayArtist"], "Solo feat. Guest");
    assert_eq!(song["artists"].as_array().unwrap().len(), 2);
    assert_eq!(song["displayAlbumArtist"], "The Band");
    assert_eq!(song["contributors"][0]["role"], "composer");
    assert_eq!(song["displayComposer"], "The Band");
    assert_eq!(
        (song["suffix"].as_str(), song["contentType"].as_str()),
        (Some("mp3"), Some("audio/mpeg"))
    );
    assert_eq!(
        (
            song["size"].as_i64(),
            song["duration"].as_i64(),
            song["bitRate"].as_i64()
        ),
        (Some(4000000), Some(180), Some(320))
    );
    assert_eq!(song["path"], "The Band/First Album/01 Opening.mp3");
    assert_eq!(
        album["song"][1]["artist"], "The Band",
        "no track credit falls back to the album artist"
    );
    assert_eq!(album["song"][1]["bitRate"], 360, "size over duration");
    assert_eq!(
        c.alice("getSong", "id=tr-101").await["song"]["title"],
        "Closing"
    );

    // The track with no file is not listed, a library the caller cannot read is not found.
    assert_eq!(
        c.alice("getAlbum", "id=al-11").await["album"]["songCount"],
        1
    );
    assert_eq!(code(&c.alice("getSong", "id=tr-104").await), 70);
    assert_eq!(c.alice("getAlbum", "id=al-12").await["status"], "ok");
    assert_eq!(code(&c.bob("getAlbum", "id=al-12").await), 70);
    assert_eq!(code(&c.bob("getSong", "id=tr-103").await), 70);
    assert_eq!(code(&c.alice("getAlbum", "id=al-999").await), 70);
    assert_eq!(code(&c.alice("getAlbum", "id=garbage").await), 70);
    assert_eq!(code(&c.alice("getAlbum", "").await), 10);

    let dir = c.alice("getMusicDirectory", "id=ar-1").await["directory"].clone();
    assert_eq!(dir["child"][0]["isDir"], true);
    assert_eq!(dir["child"][0]["parent"], "ar-1");
    assert_eq!(
        c.alice("getMusicDirectory", "id=al-10").await["directory"]["child"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let folders = c.alice("getMusicFolders", "").await["musicFolders"]["musicFolder"].clone();
    assert_eq!(names(&folders, "name"), ["Music", "Hidden"]);
    assert_eq!(
        names(
            &c.bob("getMusicFolders", "").await["musicFolders"]["musicFolder"],
            "name"
        ),
        ["Music"]
    );

    let genres = c.alice("getGenres", "").await["genres"]["genre"].clone();
    assert_eq!(names(&genres, "value"), ["Jazz", "Pop", "Rock"]);
    let rock = genres
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["value"] == "Rock")
        .unwrap();
    assert_eq!(
        (rock["albumCount"].as_i64(), rock["songCount"].as_i64()),
        (Some(2), Some(3))
    );
}

#[sqlx::test(migrations = false)]
async fn lists_and_search_follow_the_filters_and_the_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let list = |v: Value| names(&v["albumList2"]["album"], "name");
    assert_eq!(
        list(c.alice("getAlbumList2", "type=alphabeticalByName").await),
        ["First Album", "Second Album", "Secret Album"]
    );
    assert_eq!(
        list(c.bob("getAlbumList2", "type=alphabeticalByName").await),
        ["First Album", "Second Album"]
    );
    assert_eq!(
        list(
            c.alice("getAlbumList2", "type=byYear&fromYear=2000&toYear=2006")
                .await
        ),
        ["First Album", "Second Album"]
    );
    assert_eq!(
        list(
            c.alice("getAlbumList2", "type=byYear&fromYear=2006&toYear=2000")
                .await
        ),
        ["Second Album", "First Album"]
    );
    assert_eq!(
        list(c.alice("getAlbumList2", "type=byGenre&genre=pop").await),
        ["First Album"]
    );
    assert_eq!(
        list(
            c.alice("getAlbumList2", "type=newest&size=1&musicFolderId=1")
                .await
        )
        .len(),
        1
    );
    assert_eq!(
        list(
            c.alice("getAlbumList2", "type=newest&musicFolderId=9")
                .await
        )
        .len(),
        0
    );
    assert_eq!(
        list(c.alice("getAlbumList2", "type=random&size=2").await).len(),
        2
    );
    assert_eq!(
        list(c.alice("getAlbumList2", "type=frequent").await).len(),
        0
    );
    assert_eq!(code(&c.alice("getAlbumList2", "type=byYear").await), 10);
    assert_eq!(code(&c.alice("getAlbumList2", "type=nope").await), 0);
    assert_eq!(code(&c.alice("getAlbumList2", "").await), 10);

    assert_eq!(
        c.alice("getRandomSongs", "size=10").await["randomSongs"]["song"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        c.bob("getRandomSongs", "size=10").await["randomSongs"]["song"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        c.alice("getRandomSongs", "genre=Jazz").await["randomSongs"]["song"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        names(
            &c.alice("getSongsByGenre", "genre=Pop").await["songsByGenre"]["song"],
            "title"
        ),
        ["Closing", "Opening"]
    );
    assert_eq!(code(&c.alice("getSongsByGenre", "").await), 10);

    let s = c.alice("search3", "query=%22first%22").await["searchResult3"].clone();
    assert_eq!(names(&s["album"], "name"), ["First Album"]);
    assert_eq!(
        names(&s["song"], "title"),
        ["Closing", "Opening"],
        "a song matches its album's title"
    );
    assert!(s["artist"].as_array().unwrap().is_empty());
    let s = c.alice("search3", "query=band%20second").await["searchResult3"].clone();
    assert_eq!(names(&s["album"], "name"), ["Second Album"]);
    let s = c.alice("search3", "query=the").await["searchResult3"].clone();
    assert_eq!(names(&s["artist"], "name"), ["The Band"]);
    let s = c.alice("search3", "query=100%25").await["searchResult3"].clone();
    assert!(
        s["song"].as_array().is_none_or(Vec::is_empty),
        "a percent sign is not a wildcard"
    );
    let all = c
        .alice(
            "search3",
            "query=&songCount=2&songOffset=1&albumCount=1&artistCount=1",
        )
        .await["searchResult3"]
        .clone();
    assert_eq!(
        (
            all["song"].as_array().unwrap().len(),
            all["album"].as_array().unwrap().len(),
            all["artist"].as_array().unwrap().len()
        ),
        (2, 1, 1)
    );
    let hidden = c.bob("search3", "query=secret").await["searchResult3"].clone();
    assert!(hidden["album"].as_array().is_none_or(Vec::is_empty));
}

#[sqlx::test(migrations = false)]
async fn stars_ratings_and_scrobbles_land_on_likes_ratings_and_history(pool: PgPool) {
    let c = ctx(pool).await;
    assert_eq!(
        c.alice("star", "id=tr-100&id=tr-101&albumId=al-11").await["status"],
        "ok"
    );
    assert_eq!(c.alice("star", "id=tr-100").await["status"], "ok", "twice");
    let starred = c.alice("getStarred2", "").await["starred2"].clone();
    assert_eq!(names(&starred["album"], "name"), ["Second Album"]);
    assert_eq!(starred["song"].as_array().unwrap().len(), 2);
    assert!(c.alice("getSong", "id=tr-100").await["song"]["starred"].is_string());
    assert!(
        c.bob("getSong", "id=tr-100").await["song"]["starred"].is_null(),
        "per user"
    );
    let likes: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM likes"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(likes, 3);
    assert_eq!(
        c.alice("unstar", "id=tr-100&albumId=al-11").await["status"],
        "ok"
    );
    assert_eq!(
        c.alice("unstar", "id=tr-100").await["status"],
        "ok",
        "not starred"
    );
    assert_eq!(
        c.alice("getStarred2", "").await["starred2"]["song"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(code(&c.alice("star", "artistId=ar-1").await), 0);
    assert_eq!(code(&c.bob("star", "id=tr-101&id=tr-103").await), 70);
    let bobs: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM likes WHERE "userId" = 2"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(bobs, 0, "nothing written when one id is refused");

    assert_eq!(
        c.alice("setRating", "id=tr-100&rating=4").await["status"],
        "ok"
    );
    assert_eq!(
        c.alice("setRating", "id=tr-100&rating=5").await["status"],
        "ok"
    );
    assert_eq!(
        c.alice("getSong", "id=tr-100").await["song"]["userRating"],
        5
    );
    assert_eq!(
        c.alice("getAlbum", "id=al-10").await["album"]["userRating"],
        5
    );
    assert_eq!(
        names(
            &c.alice("getAlbumList2", "type=highest").await["albumList2"]["album"],
            "name"
        ),
        ["First Album"]
    );
    assert_eq!(
        c.alice("setRating", "id=tr-100&rating=0").await["status"],
        "ok"
    );
    assert!(c.alice("getSong", "id=tr-100").await["song"]["userRating"].is_null());
    assert_eq!(code(&c.alice("setRating", "id=tr-100&rating=6").await), 0);
    assert_eq!(code(&c.alice("setRating", "id=al-10&rating=3").await), 0);
    assert_eq!(code(&c.bob("setRating", "id=tr-103&rating=3").await), 70);

    let at = "1700000000000";
    for _ in 0..2 {
        assert_eq!(
            c.alice(
                "scrobble",
                &format!("id=tr-100&id=tr-101&time={at}&time={at}")
            )
            .await["status"],
            "ok"
        );
    }
    let rows: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM playback_history WHERE "userId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(rows, 2, "a replay adds nothing");
    assert_eq!(
        c.alice("scrobble", "id=tr-100&submission=false").await["status"],
        "ok"
    );
    let rows: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM playback_history"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(rows, 2, "now playing is not stored");
    assert_eq!(
        c.alice("getSong", "id=tr-100").await["song"]["playCount"],
        1
    );
    assert_eq!(
        c.alice("getAlbum", "id=al-10").await["album"]["playCount"],
        2
    );
    assert_eq!(
        names(
            &c.alice("getAlbumList2", "type=recent").await["albumList2"]["album"],
            "name"
        ),
        ["First Album"]
    );
    assert_eq!(code(&c.bob("scrobble", "id=tr-103").await), 70);
    assert_eq!(code(&c.alice("scrobble", "id=al-10").await), 70);
    assert_eq!(code(&c.alice("scrobble", "").await), 10);
}

#[sqlx::test(migrations = false)]
async fn playlists_follow_the_roles_of_the_playlist_spec(pool: PgPool) {
    let c = ctx(pool).await;
    let made = c
        .alice(
            "createPlaylist",
            "name=%20Mix%20&songId=tr-100&songId=tr-102",
        )
        .await["playlist"]
        .clone();
    assert_eq!(made["name"], "Mix");
    assert_eq!(made["owner"], "alice");
    assert_eq!(made["songCount"], 2);
    assert_eq!(made["duration"], 280);
    let id = made["id"].as_str().unwrap().to_owned();
    assert_eq!(names(&made["entry"], "title"), ["Opening", "Other"]);

    assert_eq!(
        c.alice(
            "updatePlaylist",
            &format!(
                "playlistId={id}&songIdToAdd=tr-101&songIdToAdd=tr-100&name=Renamed&public=true"
            )
        )
        .await["status"],
        "ok"
    );
    let got = c.alice("getPlaylist", &format!("id={id}")).await["playlist"].clone();
    assert_eq!(
        (
            got["name"].as_str(),
            got["public"].as_bool(),
            got["songCount"].as_i64()
        ),
        (Some("Renamed"), Some(true), Some(3))
    );
    assert_eq!(
        names(&got["entry"], "title"),
        ["Opening", "Other", "Closing"],
        "a duplicate is skipped"
    );
    assert_eq!(
        c.alice(
            "updatePlaylist",
            &format!("playlistId={id}&songIndexToRemove=1")
        )
        .await["status"],
        "ok"
    );
    assert_eq!(
        names(
            &c.alice("getPlaylist", &format!("id={id}")).await["playlist"]["entry"],
            "title"
        ),
        ["Opening", "Closing"]
    );
    assert_eq!(
        code(
            &c.alice(
                "updatePlaylist",
                &format!("playlistId={id}&songIndexToRemove=9")
            )
            .await
        ),
        70
    );

    // Public gives bob a read, never a listing nor a write; his unreadable track is refused.
    assert_eq!(
        c.bob("getPlaylist", &format!("id={id}")).await["playlist"]["songCount"],
        2
    );
    assert!(
        c.bob("getPlaylists", "").await["playlists"]["playlist"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    assert_eq!(
        code(
            &c.bob(
                "updatePlaylist",
                &format!("playlistId={id}&songIdToAdd=tr-102")
            )
            .await
        ),
        70
    );
    assert_eq!(
        code(&c.bob("deletePlaylist", &format!("id={id}")).await),
        70
    );
    sqlx::query(
        r#"INSERT INTO playlist_shares ("playlistId", "userId", role) VALUES (1, 2, 'editor')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        code(&c.bob("deletePlaylist", &format!("id={id}")).await),
        50,
        "a member below owner"
    );
    assert_eq!(
        code(
            &c.bob("updatePlaylist", &format!("playlistId={id}&name=No"))
                .await
        ),
        50,
        "an editor cannot rename"
    );
    assert_eq!(
        c.bob("getPlaylists", "").await["playlists"]["playlist"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "a share lists it"
    );
    sqlx::query("DELETE FROM playlist_shares")
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE playlists SET visibility = 'private'")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(code(&c.bob("getPlaylist", &format!("id={id}")).await), 70);
    assert_eq!(
        code(
            &c.alice("createPlaylist", "name=x&songId=tr-103&songId=tr-999")
                .await
        ),
        70
    );
    assert_eq!(
        code(&c.bob("createPlaylist", "name=x&songId=tr-103").await),
        70
    );
    assert_eq!(code(&c.alice("createPlaylist", "").await), 10);

    let replaced = c
        .alice("createPlaylist", &format!("playlistId={id}&songId=tr-102"))
        .await["playlist"]
        .clone();
    assert_eq!(names(&replaced["entry"], "title"), ["Other"]);
    assert_eq!(replaced["name"], "Renamed");
    assert_eq!(
        c.alice("getPlaylists", "").await["playlists"]["playlist"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        c.alice("deletePlaylist", &format!("id={id}")).await["status"],
        "ok"
    );
    assert_eq!(code(&c.alice("getPlaylist", &format!("id={id}")).await), 70);
}

#[sqlx::test(migrations = false)]
async fn stream_and_download_redirect_to_the_data_plane_with_a_credential(pool: PgPool) {
    let c = ctx(pool).await;
    for (endpoint, download) in [("stream", false), ("download", true)] {
        let uri = format!(
            "/rest/{endpoint}?c=t&v=1&apiKey={}&id=tr-101&maxBitRate=128&format=mp3&timeOffset=30",
            c.alice
        );
        let res = c.raw("GET", &uri, None).await;
        assert_eq!(res.status(), 302);
        let location = res.headers()[LOCATION].to_str().unwrap().to_owned();
        let (path, query) = location.split_once('?').unwrap();
        assert_eq!(path, "/api/stream/2");
        assert_eq!(query.contains("download=1"), download);
        let token = query
            .strip_prefix("token=")
            .unwrap()
            .split('&')
            .next()
            .unwrap();
        let claims = c.st.jwt.verify(token).unwrap();
        assert_eq!((claims.sub, claims.mf, claims.sid), (1, Some(2), None));
        assert!(claims.dt.is_some());
        assert!(claims.exp - chrono::Utc::now().timestamp() <= 3600);
    }
    let res = c
        .raw(
            "GET",
            &format!("/rest/stream?c=t&v=1&f=json&apiKey={}&id=tr-103", c.bob),
            None,
        )
        .await;
    assert_eq!(
        res.status(),
        200,
        "a refusal is a Subsonic error, not a redirect"
    );
    let v: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(v["subsonic-response"]["error"]["code"], 70);
    let res = c
        .raw(
            "GET",
            "/rest/stream?c=t&v=1&f=json&apiKey=nope&id=tr-100",
            None,
        )
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(c.alice("stream", "id=al-10").await["error"]["code"], 70);
}

#[sqlx::test(migrations = false)]
async fn cover_art_answers_404_without_an_image_and_70_outside_the_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let key = c.alice.clone();
    for id in ["al-10", "tr-100", "ar-1"] {
        let res = c
            .raw(
                "GET",
                &format!("/rest/getCoverArt?c=t&v=1&apiKey={key}&id={id}&size=100"),
                None,
            )
            .await;
        assert_eq!(res.status(), 404, "{id}");
    }
    assert_eq!(code(&c.bob("getCoverArt", "id=al-12").await), 70);
    assert_eq!(code(&c.alice("getCoverArt", "id=pl-1").await), 70);
}

#[sqlx::test(migrations = false)]
async fn info_endpoints_give_notes_and_image_urls(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(r#"UPDATE media SET overview = 'Notes', "posterUrl" = '/api/images/media/10/poster' WHERE id = 10"#)
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE persons SET biography = 'Bio', "avatarUrl" = '/api/images/person/1' WHERE id = 1"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let a = c.alice("getAlbumInfo2", "id=al-10").await["albumInfo"].clone();
    assert_eq!(a["notes"], "Notes");
    assert!(
        a["mediumImageUrl"]
            .as_str()
            .unwrap()
            .ends_with("/api/images/media/10/poster?size=medium")
    );
    let p = c.alice("getArtistInfo2", "id=ar-1").await["artistInfo2"].clone();
    assert_eq!(p["biography"], "Bio");
    assert!(
        p["smallImageUrl"]
            .as_str()
            .unwrap()
            .ends_with("/api/images/person/1?size=thumb")
    );
    assert_eq!(
        c.alice("getAlbum", "id=al-10").await["album"]["coverArt"],
        "al-10"
    );
    assert_eq!(
        c.alice("getArtists", "").await["artists"]["index"][0]["artist"][0]["coverArt"],
        "ar-1"
    );
    let none = c.alice("getArtistInfo2", "id=ar-2").await["artistInfo2"].clone();
    assert!(none["smallImageUrl"].is_null());
    assert_eq!(code(&c.bob("getAlbumInfo2", "id=al-12").await), 70);
    assert_eq!(
        c.alice("getUser", "username=alice").await["user"]["streamRole"],
        true
    );
    assert_eq!(code(&c.alice("getUser", "username=bob").await), 50);
    assert_eq!(c.alice("getLicense", "").await["license"]["valid"], true);
    assert_eq!(code(&c.alice("getNothing", "").await), 0);
}
