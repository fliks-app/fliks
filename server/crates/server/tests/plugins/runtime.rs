//! Lanes, supervision, scheduled calls, the component cache and the compile child.
use super::harness::*;
use fliks_server::plugins::runtime::{HttpRequest, Principal, State};
use fliks_server::plugins::{compile, packages};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const ID: &str = "fliks.fixture";

fn req(path: &str, query: &[(&str, &str)]) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        path: path.into(),
        query: query
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        body: b"{}".to_vec(),
        principal: Principal::Delegated(1),
    }
}

fn body(r: &fliks_server::plugins::runtime::HttpResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap_or(Value::Null)
}

async fn setup(
    tag: &str,
    tune: impl Fn(&mut fliks_server::plugins::runtime::HostConfig) + Send + Sync + 'static,
) -> Option<(Scratch, H)> {
    let (m, w) = fixture()?;
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, tune).await;
    allow_unsigned(&h).await;
    let r = h.install(&pack(&m, "0.1.0", &w, None)).await;
    assert_eq!(r["status"], "active", "{r}");
    Some((s, h))
}

async fn done(s: Scratch, h: H) {
    h.finish().await;
    s.finish().await;
}

fn logs(text: &str) -> usize {
    fliks_server::system::logs::query("", text, None).len()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_routes_and_lifecycle() {
    let Some((s, h)) = setup("proxy", |_| {}).await else {
        return;
    };
    let (st, b) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/hello",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, b["hello"].as_str()), (200, Some("world")));
    let (st, headers, _) = h
        .raw(
            "GET",
            "/api/plugins/fliks.fixture/HELLO/",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 200);
    assert_eq!(headers["cache-control"], "no-store");
    let (st, headers, _) = h
        .raw(
            "GET",
            "/api/plugins/fliks.fixture/headers",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 200);
    assert!(
        headers.get("set-cookie").is_none()
            && headers.get("x-custom").is_none()
            && headers.get("location").is_none()
    );
    assert_eq!(headers["etag"], "\"v1\"");
    assert_eq!(headers["cache-control"], "max-age=60");
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/status/700",
            Some(&h.admin),
            None
        )
        .await
        .0,
        502
    );
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/status/418",
            Some(&h.admin),
            None
        )
        .await
        .0,
        418
    );
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/nope",
            Some(&h.admin),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/admin",
            Some(&h.user),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/media/1",
            Some(&h.admin),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        h.call("GET", "/api/plugins/fliks.fixture/hello", None, None)
            .await
            .0,
        401
    );
    let (_, b) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/path/a%2Fb",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(b["path"], "/path/a%2Fb");
    let (_, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/echo?x=1&x=2",
            Some(&h.admin),
            Some(json!({"a": 1})),
        )
        .await;
    assert_eq!(
        b,
        json!({"method": "POST", "body": {"a": 1}, "query": [["x", "1"], ["x", "2"]]})
    );
    let (st, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/disable",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, b["enabled"].as_bool()), (201, Some(false)));
    let (st, b) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/hello",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, b["code"].as_str()), (503, Some("PLUGIN_UNAVAILABLE")));
    let (st, b) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/enable",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (st, b["processState"].as_str()),
        (201, Some("ready")),
        "{b}"
    );
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/hello",
            Some(&h.admin),
            None
        )
        .await
        .0,
        200
    );
    let (_, list) = h.call("GET", "/api/plugins", Some(&h.admin), None).await;
    assert_eq!(list[0]["status"], "active");
    assert_eq!(list[0]["signature"], "unsigned");
    let (_, ui) = h.call("GET", "/api/plugins/ui", Some(&h.user), None).await;
    let pages: Vec<&str> = ui[0]["configPages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        pages,
        ["general"],
        "the table page needs the plugin permission"
    );
    assert_eq!(ui[0]["contributions"].as_array().unwrap().len(), 1);
    let oid = s.oid().await;
    let role = format!("fp_{oid}_fliks_fixture");
    assert_eq!(
        h.call("DELETE", "/api/plugins/fliks.fixture", Some(&h.admin), None)
            .await
            .0,
        204
    );
    let left: (bool, bool) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1), EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'plugin_fliks_fixture')",
    )
    .bind(&role)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(left, (false, false), "uninstall drops role and schema");
    assert_eq!(
        h.call("DELETE", "/api/plugins/fliks.fixture", Some(&h.admin), None)
            .await
            .0,
        204
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduled_calls() {
    let Some((s, h)) = setup("sched", |c| {
        c.deadlines.scheduled = Duration::from_secs(2);
        c.lease_extra = Duration::from_millis(500);
    })
    .await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let call = async |key: &str, delay: &str, payload: &str| {
        let mut r = req("/test/schedule", &[("key", key), ("delay", delay)]);
        r.body = payload.as_bytes().to_vec();
        body(&rt.http(r, false).await.unwrap())
    };
    assert_eq!(call("again:a", "0", "\"first\"").await["ok"], Value::Null);
    until(
        "the re-scheduled call",
        Duration::from_secs(10),
        async || logs("scheduled again:a attempt 1 payload \"second\"") == 1,
    )
    .await;
    assert_eq!(logs("scheduled again:a attempt 1 payload \"first\""), 1);
    call("dedupe", "60000", "\"one\"").await;
    call("dedupe", "60000", "\"two\"").await;
    let rows: Vec<(String, i32)> = sqlx::query_as(
        r#"SELECT payload, attempt FROM plugin_scheduled_calls WHERE key = 'dedupe'"#,
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(rows, vec![("\"two\"".to_owned(), 0)]);
    assert_eq!(
        body(
            &rt.http(req("/test/cancel", &[("key", "dedupe")]), false)
                .await
                .unwrap()
        )["ok"],
        true
    );
    assert_eq!(
        body(
            &rt.http(req("/test/cancel", &[("key", "dedupe")]), false)
                .await
                .unwrap()
        )["ok"],
        false
    );
    let long = "k".repeat(129);
    assert_eq!(call(&long, "0", "1").await["error"], "ERR_VALIDATION");
    assert_eq!(
        call("big", "0", &format!("\"{}\"", "x".repeat(70 << 10))).await["error"],
        "ERR_VALIDATION"
    );
    assert_eq!(
        call("far", &(31u64 * 24 * 3600 * 1000).to_string(), "1").await["error"],
        "ERR_VALIDATION"
    );
    call("fail:x", "0", "1").await;
    until("a lease redelivery", Duration::from_secs(15), async || {
        logs("scheduled fail:x attempt 2") >= 1
    })
    .await;
    call("persist", "1500", "\"p\"").await;
    let (st, _) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/restart",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 204);
    until(
        "a call that survived the restart",
        Duration::from_secs(10),
        async || logs("scheduled persist attempt 1") == 1,
    )
    .await;
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_lane_claims_only_with_a_free_instance() {
    let Some((s, h)) = setup("tasklane", |_| {}).await else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    for k in ["spin:1", "spin:2"] {
        let mut r = req("/test/schedule", &[("key", k), ("delay", "0")]);
        r.body = b"3".to_vec();
        rt.http(r, false).await.unwrap();
    }
    until(
        "both task instances busy",
        Duration::from_secs(5),
        async || rt.task.free() == 0,
    )
    .await;
    let mut r = req("/test/schedule", &[("key", "waiting"), ("delay", "0")]);
    r.body = b"1".to_vec();
    rt.http(r, false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let attempt: i32 =
        sqlx::query_scalar("SELECT attempt FROM plugin_scheduled_calls WHERE key = 'waiting'")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        attempt, 0,
        "a due call with no free task instance stays unclaimed"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_lane_queue_bounds_and_deadline_start() {
    let Some((s, h)) = setup("httplane", |c| {
        c.deadlines.http = Duration::from_secs(3);
        c.deadlines.queue_wait = Duration::from_secs(6);
    })
    .await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let spin = |secs: &'static str| {
        let rt = rt.clone();
        tokio::spawn(async move { rt.http(req("/test/db/sleep", &[("s", secs)]), false).await })
    };
    let busy: Vec<_> = (0..4).map(|_| spin("2")).collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    let queued = spin("2").await.unwrap();
    assert!(
        queued.is_ok(),
        "a call queued ~2 s keeps its whole 3 s deadline: {queued:?}"
    );
    assert!(t.elapsed() > Duration::from_millis(3000));
    for b in busy {
        assert!(b.await.unwrap().is_ok());
    }
    let busy: Vec<_> = (0..4).map(|_| spin("2")).collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queue: Vec<_> = (0..32).map(|_| spin("0.01")).collect();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let t = Instant::now();
    let full = rt.http(req("/test/spin", &[("s", "0.01")]), false).await;
    assert!(
        matches!(full, Err(fliks_server::plugins::runtime::CallError::Unavailable(ref m)) if m == "queue full"),
        "{full:?}"
    );
    assert!(t.elapsed() < Duration::from_millis(100));
    for q in queue.into_iter().chain(busy) {
        let _ = q.await;
    }
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_wait_past_its_bound_is_503() {
    let Some((s, h)) = setup("qwait", |c| c.deadlines.queue_wait = Duration::from_secs(1)).await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let busy: Vec<_> = (0..4)
        .map(|_| {
            let rt = rt.clone();
            tokio::spawn(async move { rt.http(req("/test/db/sleep", &[("s", "3")]), false).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    let r = rt.http(req("/hello", &[]), false).await;
    eprintln!("hello after {:?}: {r:?}", t.elapsed());
    assert!(
        matches!(r, Err(fliks_server::plugins::runtime::CallError::Unavailable(ref m)) if m == "queue wait"),
        "{r:?}"
    );
    assert!(t.elapsed() >= Duration::from_millis(900) && t.elapsed() < Duration::from_secs(2));
    let (st, b) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/hello",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (st, b["message"].as_str()),
        (503, Some("errors.plugin_unavailable"))
    );
    for b in busy {
        eprintln!(
            "busy: {:?}",
            b.await
                .unwrap()
                .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        );
    }
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeouts_epoch_traps_and_breaker() {
    let Some((s, h)) = setup("breaker", |c| {
        c.deadlines.http = Duration::from_secs(1);
        c.ladder = vec![Duration::from_millis(20)];
    })
    .await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let t = Instant::now();
    let (st, b) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/test/loop",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (st, b["code"].as_str()),
        (504, Some("PLUGIN_TIMEOUT")),
        "epoch interrupt at the deadline is a 504"
    );
    assert!(t.elapsed() < Duration::from_millis(1400));
    assert_eq!(
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "C105: the timeout counts toward the breaker"
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (st, _) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/test/trap",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 503);
    assert_eq!(
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "the trap is a crash"
    );
    assert_eq!(
        rt.state(),
        State::Ready,
        "an http crash leaves the plugin ready"
    );
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = rt.http(req("/test/trap", &[]), false).await;
    }
    until("the breaker", Duration::from_secs(5), async || {
        rt.state() == State::Failed
    })
    .await;
    let (_, list) = h.call("GET", "/api/plugins", Some(&h.admin), None).await;
    assert_eq!(list[0]["processState"], "failed");
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.fixture/restart",
            Some(&h.admin),
            None
        )
        .await
        .0,
        204
    );
    assert_eq!(
        h.st.plugins.state_of(ID),
        Some(State::Ready),
        "a restart clears the breaker"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ladder_delay_gates_only_new_instances() {
    let Some((s, h)) = setup("ladder", |c| c.ladder = vec![Duration::from_secs(30)]).await else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let two: Vec<_> = (0..2)
        .map(|_| {
            let rt = rt.clone();
            tokio::spawn(async move { rt.http(req("/test/spin", &[("s", "0.3")]), false).await })
        })
        .collect();
    for t in two {
        t.await.unwrap().unwrap();
    }
    assert_eq!(rt.http.live.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(rt.http(req("/test/trap", &[]), false).await.is_err());
    assert!(
        rt.http(req("/hello", &[]), false).await.is_ok(),
        "the idle instance keeps serving through the delay"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn health_misses_and_timeouts() {
    let Some((s, h)) = setup("health", |c| {
        c.health_every = Duration::from_millis(200);
        c.deadlines.short = Duration::from_millis(500);
        c.ladder = vec![Duration::from_millis(50)];
    })
    .await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    h.set("plugin.fliks.fixture.health", "false").await;
    until(
        "degraded after 2 misses",
        Duration::from_secs(5),
        async || rt.state() == State::Degraded,
    )
    .await;
    assert_eq!(rt.restarts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        h.call(
            "GET",
            "/api/plugins/fliks.fixture/hello",
            Some(&h.admin),
            None
        )
        .await
        .0,
        503
    );
    until(
        "a crash after 4 misses",
        Duration::from_secs(5),
        async || rt.restarts.load(std::sync::atomic::Ordering::SeqCst) == 1,
    )
    .await;
    h.set("plugin.fliks.fixture.health", "ok").await;
    until("ready again", Duration::from_secs(5), async || {
        rt.state() == State::Ready
    })
    .await;
    let before = rt.restarts.load(std::sync::atomic::Ordering::SeqCst);
    h.set("plugin.fliks.fixture.health", "slow").await;
    until(
        "C118: a timed-out health is a crash at once",
        Duration::from_secs(5),
        async || rt.restarts.load(std::sync::atomic::Ordering::SeqCst) == before + 1,
    )
    .await;
    h.set("plugin.fliks.fixture.health", "ok").await;
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_abandons_in_flight_calls_and_their_queries() {
    let Some((s, h)) = setup("stop", |_| {}).await else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let call = {
        let rt = rt.clone();
        tokio::spawn(async move { rt.http(req("/test/db/sleep", &[("s", "30")]), false).await })
    };
    let role = format!("fp_{}_fliks_fixture", s.oid().await);
    let active = async || -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE usename = $1 AND query LIKE '%pg_sleep%' AND state = 'active'")
            .bind(&role)
            .fetch_one(&s.pool)
            .await
            .unwrap()
    };
    until("the query running", Duration::from_secs(5), async || {
        active().await == 1
    })
    .await;
    let t = Instant::now();
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.fixture/disable",
            Some(&h.admin),
            None
        )
        .await
        .0,
        201
    );
    let r = call.await.unwrap();
    assert!(
        matches!(r, Err(fliks_server::plugins::runtime::CallError::Unavailable(ref m)) if m == "stopped"),
        "{r:?}"
    );
    assert!(t.elapsed() < Duration::from_secs(5));
    until("the query cancelled", Duration::from_secs(5), async || {
        active().await == 0
    })
    .await;
    assert_eq!(
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a stop is not a crash"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manifest_mismatch_fails_without_retry() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("mismatch").await else {
        return;
    };
    let h = harness(&s, "mismatch", |_| {}).await;
    allow_unsigned(&h).await;
    let r = h.install(&pack(&m, "9.9.9", &w, None)).await;
    assert_eq!(
        (r["status"].as_str(), r["reason"].as_str()),
        (Some("failed"), Some("manifest-mismatch")),
        "{r}"
    );
    assert_eq!(r["detail"], "version");
    let pkg = packages::find(&s.pool, ID).await.unwrap().unwrap();
    assert_eq!(
        pkg.status_reason.as_deref(),
        Some("manifest-mismatch: version")
    );
    assert!(h.st.plugins.rt(ID).is_none());
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deadline_remaining_and_idle_reaping() {
    let Some((s, h)) = setup("deadline", |c| {
        c.deadlines.http = Duration::from_secs(20);
        c.idle_after = Duration::from_millis(300);
        c.health_every = Duration::from_millis(100);
    })
    .await
    else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let left = body(&rt.http(req("/test/deadline", &[]), false).await.unwrap())["remaining"]
        .as_u64()
        .unwrap();
    assert!(left > 15_000 && left <= 20_000, "{left}");
    assert_eq!(rt.http.live.load(std::sync::atomic::Ordering::SeqCst), 1);
    until(
        "the idle http instance reaped",
        Duration::from_secs(5),
        async || rt.http.live.load(std::sync::atomic::Ordering::SeqCst) == 0,
    )
    .await;
    assert_eq!(
        rt.core.live.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "core lives as long as the registration"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn jobs_no_overlap_and_commands() {
    let Some((s, h)) = setup("jobs", |_| {}).await else {
        return;
    };
    h.set("plugin.fliks.fixture.job_secs", "2").await;
    let (st, b) = h
        .call(
            "POST",
            "/api/commands",
            Some(&h.admin),
            Some(json!({"name": "FixtureJob"})),
        )
        .await;
    assert_eq!((st, b.clone()), (201, json!({"ok": true})));
    let (st, b) = h
        .call(
            "POST",
            "/api/commands",
            Some(&h.admin),
            Some(json!({"name": "FixtureJob"})),
        )
        .await;
    assert_eq!(
        (st, b["message"].as_str()),
        (409, Some("Job \"FixtureJob\" is already running"))
    );
    assert!(
        h.st.jobs.claim(fliks_server::jobs::RESTORE).is_none(),
        "C111: a restore is refused while a plugin job runs"
    );
    let (st, b) = h
        .call(
            "POST",
            "/api/commands",
            Some(&h.admin),
            Some(json!({"name": "FixtureHidden"})),
        )
        .await;
    assert_eq!(
        (st, b["message"].as_str()),
        (400, Some("Job \"FixtureHidden\" is not triggerable"))
    );
    let (_, list) = h
        .call("GET", "/api/commands/schedulers", Some(&h.admin), None)
        .await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|j| j["pluginId"].as_str().map(|_| j["name"].as_str().unwrap()))
        .collect();
    assert_eq!(names, ["FixtureHidden", "FixtureJob"]);
    until("the job done", Duration::from_secs(10), async || {
        logs("job \"FixtureJob\" for plugin \"fliks.fixture\" completed") == 1
    })
    .await;
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn component_cache_and_compile_child() {
    let Some((s, h)) = setup("cache", |_| {}).await else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    assert!(
        !rt.timings.lock().unwrap().cache_hit,
        "the first install compiles"
    );
    h.call(
        "POST",
        "/api/plugins/fliks.fixture/restart",
        Some(&h.admin),
        None,
    )
    .await;
    assert!(
        h.st.plugins
            .rt(ID)
            .unwrap()
            .timings
            .lock()
            .unwrap()
            .cache_hit,
        "a restart deserialises"
    );
    let files: Vec<_> = std::fs::read_dir(h.dir.join("cwasm"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();
    assert_eq!(files.len(), 1);
    std::fs::write(&files[0], b"tampered").unwrap();
    h.call(
        "POST",
        "/api/plugins/fliks.fixture/restart",
        Some(&h.admin),
        None,
    )
    .await;
    let rt = h.st.plugins.rt(ID).unwrap();
    assert!(
        !rt.timings.lock().unwrap().cache_hit,
        "a .cwasm whose sha256 differs from the row is recompiled"
    );
    assert_eq!(rt.state(), State::Ready);
    sqlx::query(r#"UPDATE plugin_packages SET "cwasmEngine" = 'other'"#)
        .execute(&s.pool)
        .await
        .unwrap();
    h.call(
        "POST",
        "/api/plugins/fliks.fixture/restart",
        Some(&h.admin),
        None,
    )
    .await;
    assert!(
        !h.st
            .plugins
            .rt(ID)
            .unwrap()
            .timings
            .lock()
            .unwrap()
            .cache_hit,
        "an engine fingerprint change recompiles"
    );
    let fp = compile::fingerprint(
        &wasmtime::Engine::new(&fliks_server::plugins::runtime::engine_config()).unwrap(),
    );
    assert_eq!(fp.len(), 64);
    let err = compile::compile_in_child(
        std::path::Path::new("/bin/false"),
        Duration::from_secs(5),
        b"\0asm",
    )
    .await;
    assert!(
        matches!(err, Err(compile::LoadError::Invalid(_))),
        "a failing child is invalid-component"
    );
    let real = std::path::PathBuf::from(env!("CARGO_BIN_EXE_fliks-server"));
    let bad = compile::compile_in_child(&real, Duration::from_secs(30), b"not wasm").await;
    assert!(
        matches!(bad, Err(compile::LoadError::Invalid(ref m)) if !m.contains('/')),
        "{bad:?}"
    );
    let dir = h.dir.join("fake");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("compiler.sh");
    let marks = dir.join("marks");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho start >> {m}\nsleep 0.5\necho end >> {m}\ncat > /dev/null\n",
            m = marks.display()
        ),
    )
    .unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(
        &mut std::fs::metadata(&script).unwrap().permissions(),
        0o755,
    );
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let (a, b) = tokio::join!(
        compile::compile_in_child(&script, Duration::from_secs(5), b"x"),
        compile::compile_in_child(&script, Duration::from_secs(5), b"y")
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(
        std::fs::read_to_string(&marks).unwrap(),
        "start\nend\nstart\nend\n",
        "one compile at a time"
    );
    done(s, h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn event_ring_overflow_counts_drops() {
    let Some((s, h)) = setup("ring", |_| {}).await else {
        return;
    };
    h.set("plugin.fliks.fixture.start", "slow").await;
    let p = h.st.plugins.clone();
    let restart = tokio::spawn(async move { p.restart(ID).await.is_ok() });
    until("the slow start", Duration::from_secs(10), async || {
        h.st.plugins
            .rt(ID)
            .is_some_and(|r| r.state() == State::Handshaking)
    })
    .await;
    let rt = h.st.plugins.rt(ID).unwrap();
    for i in 0..70 {
        rt.push_event("media.removed", &format!("{{\"n\":{i}}}"));
    }
    assert_eq!(rt.event_drops.load(std::sync::atomic::Ordering::SeqCst), 6);
    let (_, m) = h
        .call("GET", "/api/plugins/metrics", Some(&h.admin), None)
        .await;
    assert_eq!(m[0]["metrics"]["eventDropCount"], 6);
    assert!(restart.await.unwrap());
    h.set("plugin.fliks.fixture.start", "ok").await;
    until(
        "the ring drained once ready",
        Duration::from_secs(20),
        async || logs("event media.removed") >= 64,
    )
    .await;
    done(s, h).await;
}

/// A TCP relay to Postgres that drops every connection while it is down.
struct Relay {
    up: std::sync::Arc<std::sync::atomic::AtomicBool>,
    conns: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    accept: tokio::task::JoinHandle<()>,
}

impl Relay {
    async fn start(port: u16, to: (String, u16)) -> Relay {
        use std::sync::atomic::Ordering;
        let l = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let up = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let conns = std::sync::Arc::<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>::default();
        let (u, c) = (up.clone(), conns.clone());
        let accept = tokio::spawn(async move {
            while let Ok((mut a, _)) = l.accept().await {
                if !u.load(Ordering::SeqCst) {
                    continue;
                }
                let to = to.clone();
                c.lock().unwrap().push(tokio::spawn(async move {
                    if let Ok(mut b) = tokio::net::TcpStream::connect(to).await {
                        let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
                    }
                }));
            }
        });
        Relay { up, conns, accept }
    }

    fn set(&self, up: bool) {
        self.up.store(up, std::sync::atomic::Ordering::SeqCst);
        if !up {
            self.conns.lock().unwrap().drain(..).for_each(|h| h.abort());
        }
    }
}

/// C109 after boot: provisioning that cannot reach Postgres is `degraded`, then registers once it answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provisioning_waits_for_the_database() {
    use fliks_server::plugins::{Plugins, runtime::HostConfig};
    use std::sync::Arc;
    let Some((s, h)) = setup("dbwait", |_| {}).await else {
        return;
    };
    h.st.plugins.unregister(ID).await;
    let o = s.pool.connect_options();
    let relay = Relay::start(4930, (o.get_host().to_owned(), o.get_port())).await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy_with((*o).clone().host("127.0.0.1").port(4930));
    let tune: Arc<dyn Fn(&mut HostConfig) + Send + Sync> = Arc::new(|c: &mut HostConfig| {
        c.ladder = vec![Duration::from_millis(100)];
        c.db_retry = Duration::from_millis(200);
    });
    let mut st = h.st.clone();
    st.plugins = Arc::new(Plugins::new(pool, options(&s, &h.dir.join("dbwait"), tune)));
    st.plugins.attach(&st);
    let p = st.plugins.clone();
    let pkg = packages::find(&s.pool, ID).await.unwrap().unwrap();

    relay.set(false);
    let f = p.register_and_settle(&pkg).await.unwrap_err();
    assert_eq!(f.reason, "db-unavailable", "{f:?}");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(p.state_of(ID), Some(State::Degraded));
    let summary = serde_json::to_value(p.summary(&pkg)).unwrap();
    assert!(
        summary["statusReason"]
            .as_str()
            .unwrap()
            .starts_with("db-unavailable: "),
        "{summary}"
    );
    assert_eq!(summary["processState"], "degraded");

    relay.set(true);
    until(
        "ready after the database returns",
        Duration::from_secs(30),
        async || p.state_of(ID) == Some(State::Ready),
    )
    .await;
    assert_eq!(p.db_wait_reason(ID), None);
    assert_eq!(
        packages::find(&s.pool, ID)
            .await
            .unwrap()
            .unwrap()
            .status_reason,
        None
    );
    p.unregister(ID).await;
    relay.accept.abort();
    relay.set(false);
    done(s, h).await;
}

/// C109: the plugin's database down while running makes `start` and `health` `degraded`, never a crash.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn database_outage_degrades_without_crashing() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("dbout").await else {
        return;
    };
    let o = s.pool.connect_options();
    let relay = Relay::start(4931, (o.get_host().to_owned(), o.get_port())).await;
    let h = harness(&s, "dbout", |c| {
        c.pg.host = "127.0.0.1".into();
        c.pg.port = 4931;
        c.deadlines.db_query = Duration::from_secs(2);
        c.health_every = Duration::from_millis(200);
        c.ladder = vec![Duration::from_millis(100)];
        c.db_retry = Duration::from_millis(200);
    })
    .await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    h.set("plugin.fliks.fixture.health", "db").await;
    h.set("plugin.fliks.fixture.start", "db").await;
    let rt = h.st.plugins.rt(ID).unwrap();

    relay.set(false);
    until("degraded by health", Duration::from_secs(10), async || {
        rt.state() == State::Degraded
    })
    .await;
    relay.set(true);
    until("ready again", Duration::from_secs(10), async || {
        rt.state() == State::Ready
    })
    .await;
    assert_eq!(
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "health on a down database is no crash"
    );

    relay.set(false);
    let p = h.st.plugins.clone();
    let restart = tokio::spawn(async move { p.restart(ID).await.is_ok() });
    until("degraded at start", Duration::from_secs(15), async || {
        h.st.plugins
            .rt(ID)
            .is_some_and(|r| r.state() == State::Degraded)
    })
    .await;
    let rt = h.st.plugins.rt(ID).unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        (
            rt.state(),
            rt.restarts.load(std::sync::atomic::Ordering::SeqCst)
        ),
        (State::Degraded, 0)
    );
    relay.set(true);
    until(
        "start re-run once the database answers",
        Duration::from_secs(15),
        async || rt.state() == State::Ready,
    )
    .await;
    let _ = restart.await;
    relay.accept.abort();
    done(s, h).await;
}

/// A proxied call dropped mid-flight takes its instance out of the live count.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dropped_call_frees_its_instance() {
    let Some((s, h)) = setup("dropcall", |_| {}).await else {
        return;
    };
    let rt = h.st.plugins.rt(ID).unwrap();
    let before = rt.live_instances();
    let r2 = rt.clone();
    let call = tokio::spawn(async move {
        r2.http(req("/test/spin", &[("s", "5")]), false)
            .await
            .map(drop)
    });
    until("the spin running", Duration::from_secs(5), async || {
        rt.live_instances() > before
    })
    .await;
    call.abort();
    let _ = call.await;
    until(
        "the instance uncounted",
        Duration::from_secs(5),
        async || rt.live_instances() == before,
    )
    .await;
    done(s, h).await;
}

/// C112: while a restore holds its claim, registration and the admin routes refuse.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_refuses_registration_and_admin_routes() {
    let Some((s, h)) = setup("restoring", |_| {}).await else {
        return;
    };
    let claim = h.st.jobs.claim(fliks_server::jobs::RESTORE).unwrap();
    for (method, path) in [
        ("POST", "/api/plugins/fliks.fixture/restart"),
        ("POST", "/api/plugins/fliks.fixture/enable"),
    ] {
        let (st, b) = h.call(method, path, Some(&h.admin), None).await;
        assert_eq!(
            (st, b["code"].as_str()),
            (409, Some("PLUGIN_BUSY")),
            "{path} {b}"
        );
    }
    let pkg = packages::find(&s.pool, ID).await.unwrap().unwrap();
    let f = h.st.plugins.register_and_settle(&pkg).await.unwrap_err();
    assert_eq!(f.reason, "db-unavailable");
    h.st.plugins.stop_all().await;
    assert_eq!(
        h.st.plugins.db_wait_reason(ID),
        None,
        "stop_all clears the waits"
    );
    drop(claim);
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.fixture/restart",
            Some(&h.admin),
            None
        )
        .await
        .0,
        204
    );
    done(s, h).await;
}
