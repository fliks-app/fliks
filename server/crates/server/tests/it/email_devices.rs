//! `/api/email-devices` and the send (`docs/spec/email-devices.md`), against a fake SMTP server.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, email, settings, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const BOOK: &[u8] = b"PK\x03\x04 fake epub bytes";

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

struct Ctx {
    app: Router,
    pool: PgPool,
    admin: String,
    a: String,
    b: String,
    c: String,
    _dir: Dir,
}

/// Users: 1 admin, 2 `a` and 3 `b` read library 1 only. Files: 1 book, 2 its twin in a hidden edition,
/// 3 a book of library 2, 4 a PDF, 5 an audiobook, 6 a book one byte over 1 MiB.
async fn ctx(pool: PgPool, tag: &str) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let dir = Dir(std::env::temp_dir().join(format!("fliks-email-{}-{tag}", std::process::id())));
    let (one, two) = (dir.0.join("one"), dir.0.join("two"));
    std::fs::create_dir_all(&one).unwrap();
    std::fs::create_dir_all(&two).unwrap();
    for (d, n, b) in [
        (&one, "a.epub", BOOK.to_vec()),
        (&one, "b.epub", BOOK.to_vec()),
        (&two, "c.epub", BOOK.to_vec()),
        (&one, "d.pdf", b"%PDF".to_vec()),
        (&one, "e.m4b", b"audio".to_vec()),
        (&one, "f.epub", vec![0; 1024 * 1024 + 1]),
    ] {
        std::fs::write(d.join(n), b).unwrap();
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read","books.email"]', false), (2, 'Plain', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'a', false, 1), (3, 'b', false, 1), (4, 'c', false, 2);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '{one}'), (2, 2, '{two}');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3), (1, 4);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'book', 1, 'a'), (11, 'Beta', 'book', 1, 'b'), (12, 'Gamma', 'book', 2, 'c'),
          (13, 'Delta', 'book', 1, 'd'), (14, 'Echo', 'book', 1, 'e'), (15, 'Big', 'book', 1, 'f');
        INSERT INTO editions (id, "mediaId", family, format, "libraryId") VALUES
          (1, 10, 'text', 'epub', NULL), (2, 11, 'text', 'epub', 2), (3, 12, 'text', 'epub', NULL),
          (4, 13, 'text', 'pdf', NULL), (5, 14, 'audio', 'm4b', NULL), (6, 15, 'text', 'epub', NULL);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 12, 3), (4, 13, 4), (5, 14, 5), (6, 15, 6);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a.epub', 1, 'EPUB', '{{}}'), (2, 11, 1, 'b.epub', 1, 'EPUB', '{{}}'), (3, 12, 2, 'c.epub', 1, 'EPUB', '{{}}'),
          (4, 13, 1, 'd.pdf', 1, 'PDF', '{{}}'), (5, 14, 1, 'e.m4b', 1, 'M4B', '{{}}'), (6, 15, 1, 'f.epub', 1, 'EPUB', '{{}}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 11, 0, 0), (3, 3, 12, 0, 0), (4, 4, 13, 0, 0), (5, 5, 14, 0, 0), (6, 6, 15, 0, 0);
        "#,
        one = one.display(),
        two = two.display()
    )))
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        a: st.jwt.sign_access(2, "a").unwrap().token,
        b: st.jwt.sign_access(3, "b").unwrap().token,
        c: st.jwt.sign_access(4, "c").unwrap().token,
        app: email::router().merge(settings::router()).with_state(st),
        pool,
        _dir: dir,
    }
}

type Mails = Arc<Mutex<Vec<String>>>;

/// A one-shot-per-connection SMTP server with no TLS: `data_reply` answers every message.
async fn smtp(data_reply: &'static str) -> (u16, Mails) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mails: Mails = Arc::default();
    let seen = mails.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut r = BufReader::new(r);
                w.write_all(b"220 fake\r\n").await.ok();
                let mut line = String::new();
                loop {
                    line.clear();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let cmd = line.to_uppercase();
                    if cmd.starts_with("DATA") {
                        w.write_all(b"354 go\r\n").await.ok();
                        let mut mail = String::new();
                        loop {
                            line.clear();
                            if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                                return;
                            }
                            if line == ".\r\n" {
                                break;
                            }
                            mail.push_str(&line);
                        }
                        if data_reply.starts_with('2') {
                            seen.lock().unwrap().push(mail);
                        }
                        w.write_all(format!("{data_reply}\r\n").as_bytes())
                            .await
                            .ok();
                    } else if cmd.starts_with("QUIT") {
                        w.write_all(b"221 bye\r\n").await.ok();
                        return;
                    } else {
                        w.write_all(b"250 ok\r\n").await.ok();
                    }
                }
            });
        }
    });
    (port, mails)
}

impl Ctx {
    async fn set(&self, key: &str, value: &str) {
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn configure(&self, port: u16) {
        self.set("smtp_host", "127.0.0.1").await;
        self.set("smtp_port", &port.to_string()).await;
        self.set("smtp_security", "none").await;
        self.set("smtp_from", "Fliks <books@example.com>").await;
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
            .app
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn device(&self, token: &str, name: &str) -> i64 {
        let (s, d) = self
            .call(
                "POST",
                "/api/email-devices",
                token,
                Some(json!({"name": name, "kind": "kindle", "address": "me@kindle.com"})),
            )
            .await;
        assert_eq!(s, 201, "{d}");
        d["id"].as_i64().unwrap()
    }

    async fn send(&self, token: &str, device: i64, file: i64) -> (u16, Value) {
        self.call(
            "POST",
            &format!("/api/email-devices/{device}/send"),
            token,
            Some(json!({"fileId": file})),
        )
        .await
    }

    async fn settled(&self, id: i64) -> (String, Option<String>) {
        for _ in 0..100 {
            let row: (String, Option<String>) =
                sqlx::query_as("SELECT status, error FROM book_sends WHERE id = $1")
                    .bind(id as i32)
                    .fetch_one(&self.pool)
                    .await
                    .unwrap();
            if row.0 == "sent" || row.0 == "failed" {
                return row;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("send {id} never settled");
    }
}

#[sqlx::test(migrations = false)]
async fn the_password_is_a_secret_and_a_bad_setting_is_refused(pool: PgPool) {
    let c = ctx(pool, "secret").await;
    for (k, v) in [
        ("smtp_port", "99999"),
        ("smtp_security", "ssl"),
        ("smtp_from", "x\r\nBcc: y@z.example"),
    ] {
        let (s, _) = c
            .call(
                "PUT",
                &format!("/api/settings/{k}"),
                &c.admin,
                Some(json!({"value": v})),
            )
            .await;
        assert_eq!(s, 400, "{k}");
    }
    let (s, b) = c
        .call(
            "PUT",
            "/api/settings/smtp_password",
            &c.admin,
            Some(json!({"value": "hunter2"})),
        )
        .await;
    assert_eq!((s, &b["value"]), (200, &Value::Null));
    let (_, all) = c.call("GET", "/api/settings", &c.admin, None).await;
    assert!(all.get("smtp_password").is_none());
    assert!(
        all["secretsSet"]
            .as_array()
            .unwrap()
            .contains(&json!("smtp_password"))
    );
    let (s, _) = c.call("GET", "/api/settings", &c.a, None).await;
    assert_eq!(s, 403);
}

#[sqlx::test(migrations = false)]
async fn devices_are_validated_owned_and_capped(pool: PgPool) {
    let c = ctx(pool, "devices").await;
    let id = c.device(&c.a, "Kindle").await;
    for address in [
        "Name <me@kindle.com>",
        "me@kindle.com\r\nBcc: x@y.example",
        "me@kindle.com, x@y.example",
        "nope",
    ] {
        let (s, _) = c
            .call(
                "POST",
                "/api/email-devices",
                &c.a,
                Some(json!({"name": "X", "kind": "kindle", "address": address})),
            )
            .await;
        assert_eq!(s, 400, "{address:?}");
    }
    for bad in [
        json!({"name": "Y", "kind": "tv", "address": "a@kindle.com"}),
        json!({"name": "Y", "kind": "kindle", "address": "a@kindle.com", "formats": ["exe"]}),
        json!({"name": "Y", "kind": "kindle", "address": "a@kindle.com", "formats": []}),
    ] {
        assert_eq!(
            c.call("POST", "/api/email-devices", &c.a, Some(bad))
                .await
                .0,
            400
        );
    }
    let (s, dup) = c
        .call(
            "POST",
            "/api/email-devices",
            &c.a,
            Some(json!({"name": "Kindle", "kind": "kindle", "address": "a@kindle.com"})),
        )
        .await;
    assert_eq!(
        (s, dup["message"].as_str()),
        (409, Some("email_devices.error_name_taken"))
    );
    let (_, list) = c.call("GET", "/api/email-devices", &c.a, None).await;
    assert_eq!(list["enabled"], false);
    assert_eq!(list["devices"][0]["formats"], json!(["epub", "pdf"]));
    let (_, other) = c.call("GET", "/api/email-devices", &c.b, None).await;
    assert_eq!(other["devices"], json!([]));
    let body = json!({"name": "Mine", "kind": "kindle", "address": "a@kindle.com"});
    assert_eq!(
        c.call(
            "PUT",
            &format!("/api/email-devices/{id}"),
            &c.b,
            Some(body.clone())
        )
        .await
        .0,
        404
    );
    assert_eq!(
        c.call("DELETE", &format!("/api/email-devices/{id}"), &c.b, None)
            .await
            .0,
        404
    );
    let (s, upd) = c
        .call("PUT", &format!("/api/email-devices/{id}"), &c.a, Some(body))
        .await;
    assert_eq!((s, upd["formats"].clone()), (200, json!(["epub", "pdf"])));
    for n in 0..9 {
        c.device(&c.a, &format!("D{n}")).await;
    }
    let (s, full) = c
        .call(
            "POST",
            "/api/email-devices",
            &c.a,
            Some(json!({"name": "Z", "kind": "kindle", "address": "a@kindle.com"})),
        )
        .await;
    assert_eq!(
        (s, full["message"].as_str()),
        (400, Some("email_devices.error_too_many"))
    );
    assert_eq!(
        c.call("DELETE", &format!("/api/email-devices/{id}"), &c.a, None)
            .await
            .0,
        204
    );
}

#[sqlx::test(migrations = false)]
async fn a_book_is_mailed_with_its_file_and_logged(pool: PgPool) {
    let c = ctx(pool, "send").await;
    let (port, mails) = smtp("250 queued").await;
    c.configure(port).await;
    let dev = c.device(&c.a, "Kindle").await;
    let (s, sent) = c.send(&c.a, dev, 1).await;
    assert_eq!((s, sent["status"].as_str()), (202, Some("queued")));
    assert_eq!(
        c.settled(sent["id"].as_i64().unwrap()).await,
        ("sent".into(), None)
    );
    let mail = mails.lock().unwrap().remove(0);
    let (head, _) = mail.split_once("\r\n\r\n").unwrap();
    assert!(
        head.contains("To: me@kindle.com") && head.contains("From: Fliks <books@example.com>"),
        "{head}"
    );
    assert!(!head.to_lowercase().contains("bcc:"));
    assert!(mail.contains(r#"filename="a.epub""#), "{mail}");
    assert!(
        mail.contains("UEsDBCBmYWtlIGVwdWIgYnl0ZXM="),
        "base64 of the file"
    );
    let (_, log) = c.call("GET", "/api/book-sends", &c.a, None).await;
    assert_eq!(
        (
            log[0]["deviceName"].as_str(),
            log[0]["fileName"].as_str(),
            log[0]["status"].as_str()
        ),
        (Some("Kindle"), Some("a.epub"), Some("sent"))
    );
    assert!(
        !log.to_string().contains("kindle.com"),
        "the address is not logged"
    );
    let (_, other) = c.call("GET", "/api/book-sends", &c.b, None).await;
    assert_eq!(other, json!([]));
}

#[sqlx::test(migrations = false)]
async fn only_readable_files_in_an_accepted_format_under_the_limit_go_out(pool: PgPool) {
    let c = ctx(pool, "refuse").await;
    let (port, mails) = smtp("250 queued").await;
    let dev = c.device(&c.a, "Kindle").await;
    let (s, b) = c.send(&c.a, dev, 1).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("send_to_device.error_not_configured"))
    );
    c.configure(port).await;
    c.set("smtp_max_attachment_mb", "1").await;
    for file in [2, 3, 999] {
        assert_eq!(c.send(&c.a, dev, file).await.0, 404, "file {file}");
    }
    let (s, b) = c.send(&c.a, dev, 5).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("send_to_device.error_format"))
    );
    let (s, b) = c.send(&c.a, dev, 6).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (413, Some("send_to_device.error_too_big"))
    );
    assert_eq!(c.send(&c.b, dev, 1).await.0, 404, "another user's device");
    let reader = c
        .call(
            "POST",
            "/api/email-devices",
            &c.a,
            Some(json!({"name": "Reader", "kind": "pocketbook", "address": "k@pbsync.com", "formats": ["epub"]})),
        )
        .await
        .1["id"]
        .as_i64()
        .unwrap();
    let (s, b) = c.send(&c.a, reader, 4).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("send_to_device.error_format"))
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM book_sends")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!((n, mails.lock().unwrap().len()), (0, 0));
}

#[sqlx::test(migrations = false)]
async fn a_user_is_limited_per_hour_and_in_flight(pool: PgPool) {
    let c = ctx(pool, "limits").await;
    let (port, _) = smtp("250 queued").await;
    c.configure(port).await;
    let dev = c.device(&c.a, "Kindle").await;
    sqlx::query(
        r#"INSERT INTO book_sends ("userId", "deviceName", "fileName", bytes, status)
           SELECT 2, 'Kindle', 'x.epub', 1, 'queued' FROM generate_series(1, 3)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, b) = c.send(&c.a, dev, 1).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (429, Some("send_to_device.error_rate_limited"))
    );
    sqlx::query("UPDATE book_sends SET status = 'sent'")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        c.send(&c.b, c.device(&c.b, "Kindle").await, 1).await.0,
        202,
        "limits are per user"
    );
    sqlx::query(
        r#"INSERT INTO book_sends ("userId", "deviceName", "fileName", bytes, status)
           SELECT 2, 'Kindle', 'x.epub', 1, 'sent' FROM generate_series(1, 17)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(c.send(&c.a, dev, 1).await.0, 429);
}

#[sqlx::test(migrations = false)]
async fn an_smtp_refusal_is_a_coded_failure_and_a_restart_closes_open_sends(pool: PgPool) {
    let c = ctx(pool, "fail").await;
    let (port, _) = smtp("550 no such user").await;
    c.configure(port).await;
    let dev = c.device(&c.a, "Kindle").await;
    let (_, sent) = c.send(&c.a, dev, 1).await;
    let (status, error) = c.settled(sent["id"].as_i64().unwrap()).await;
    assert_eq!(
        (status.as_str(), error.as_deref()),
        ("failed", Some("rejected"))
    );
    sqlx::query(r#"UPDATE book_sends SET status = 'sending', error = NULL"#)
        .execute(&c.pool)
        .await
        .unwrap();
    email::sweep(&c.pool).await.unwrap();
    let row: (String, Option<String>) = sqlx::query_as("SELECT status, error FROM book_sends")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(row, ("failed".into(), Some("interrupted".into())));
}

#[sqlx::test(migrations = false)]
async fn the_admin_test_reports_the_outcome(pool: PgPool) {
    let c = ctx(pool, "test").await;
    let body = || Some(json!({"to": "me@example.com"}));
    assert_eq!(c.call("POST", "/api/email/test", &c.a, body()).await.0, 403);
    assert_eq!(
        c.call("POST", "/api/email/test", &c.admin, body()).await.0,
        400,
        "not configured"
    );
    let (port, mails) = smtp("250 queued").await;
    c.configure(port).await;
    assert_eq!(
        c.call(
            "POST",
            "/api/email/test",
            &c.admin,
            Some(json!({"to": "x\r\nBcc: y@z.example"}))
        )
        .await
        .0,
        400
    );
    let (s, b) = c.call("POST", "/api/email/test", &c.admin, body()).await;
    assert_eq!((s, b["ok"].clone()), (200, json!(true)));
    assert_eq!(mails.lock().unwrap().len(), 1);
    c.set("smtp_username", "u").await;
    let (s, b) = c.call("POST", "/api/email/test", &c.admin, body()).await;
    assert_eq!(
        (s, b["ok"].clone()),
        (200, json!(false)),
        "no credentials over a clear connection"
    );
}

#[sqlx::test(migrations = false)]
async fn a_device_needs_the_permission_and_the_kind_domain(pool: PgPool) {
    let c = ctx(pool, "perm").await;
    let body =
        |kind: &str, address: &str| Some(json!({"name": "D", "kind": kind, "address": address}));
    let (s, _) = c
        .call(
            "POST",
            "/api/email-devices",
            &c.c,
            body("kindle", "me@kindle.com"),
        )
        .await;
    assert_eq!(s, 403, "no books.email");
    let (_, list) = c.call("GET", "/api/email-devices", &c.c, None).await;
    assert_eq!(list["canSend"], false);
    for (kind, address) in [
        ("kindle", "me@example.com"),
        ("kindle", "me@evilkindle.com"),
        ("pocketbook", "me@kindle.com"),
    ] {
        let (s, _) = c
            .call("POST", "/api/email-devices", &c.a, body(kind, address))
            .await;
        assert_eq!(s, 400, "{kind} {address}");
    }
    for (kind, address) in [
        ("kindle", "me@Free.Kindle.com"),
        ("pocketbook", "me@pbsync.com"),
    ] {
        let (s, _) = c
            .call("POST", "/api/email-devices", &c.a, body(kind, address))
            .await;
        assert_eq!(s, 201, "{kind} {address}");
        let (_, d) = c.call("GET", "/api/email-devices", &c.a, None).await;
        c.call(
            "DELETE",
            &format!("/api/email-devices/{}", d["devices"][0]["id"]),
            &c.a,
            None,
        )
        .await;
    }
    let (s, b) = c
        .call(
            "POST",
            "/api/email-devices",
            &c.a,
            body("other", "me@example.com"),
        )
        .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (403, Some("email_devices.error_kind_forbidden"))
    );
    assert_eq!(
        c.call(
            "POST",
            "/api/email-devices",
            &c.admin,
            body("other", "me@example.com")
        )
        .await
        .0,
        201
    );
    let (port, _) = smtp("250 queued").await;
    c.configure(port).await;
    let dev = c.device(&c.a, "Kindle").await;
    sqlx::query("UPDATE roles SET permissions = '[\"media.read\"]' WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        c.send(&c.a, dev, 1).await.0,
        403,
        "a role that lost the permission cannot send"
    );
}

#[sqlx::test(migrations = false)]
async fn concurrent_requests_cannot_pass_a_cap(pool: PgPool) {
    let c = ctx(pool, "race").await;
    for n in 0..7 {
        c.device(&c.a, &format!("D{n}")).await;
    }
    let creates = (0..6).map(|n| {
        c.call(
            "POST",
            "/api/email-devices",
            &c.a,
            Some(json!({"name": format!("N{n}"), "kind": "kindle", "address": "me@kindle.com"})),
        )
    });
    let made = futures_util::future::join_all(creates)
        .await
        .iter()
        .filter(|r| r.0 == 201)
        .count();
    assert_eq!(made, 3, "10 devices at most");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM email_devices WHERE \"userId\" = 2")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 10);
    let (port, _) = smtp("250 queued").await;
    c.configure(port).await;
    let dev = c.device(&c.b, "Kindle").await;
    sqlx::query(
        r#"INSERT INTO book_sends ("userId", "deviceName", "fileName", bytes, status)
           SELECT 3, 'Kindle', 'x.epub', 1, 'sent' FROM generate_series(1, 18)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let sends = (0..5).map(|_| c.send(&c.b, dev, 1));
    let statuses: Vec<u16> = futures_util::future::join_all(sends)
        .await
        .iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(
        statuses.iter().filter(|s| **s == 202).count(),
        2,
        "20 an hour at most: {statuses:?}"
    );
    assert_eq!(statuses.iter().filter(|s| **s == 429).count(), 3);
}

#[sqlx::test(migrations = false)]
async fn a_stuck_send_stops_counting_as_unfinished_after_15_minutes(pool: PgPool) {
    let c = ctx(pool, "stuck").await;
    let (port, _) = smtp("250 queued").await;
    c.configure(port).await;
    let dev = c.device(&c.a, "Kindle").await;
    sqlx::query(
        r#"INSERT INTO book_sends ("userId", "deviceName", "fileName", bytes, status, "updatedAt")
           SELECT 2, 'Kindle', 'x.epub', 1, 'sending', now() - interval '1 hour' FROM generate_series(1, 3)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(c.send(&c.a, dev, 1).await.0, 202);
}
