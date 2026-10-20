//! Ports of `engine.service.spec.ts`, `engine-client.spec.ts` and the follower cases of
//! `engine-events.service.spec.ts` against a fake engine, grouped by block as `engine-glue.md` lists them.
use super::{
    testkit::{
        self, Answer, Conn, FEATURES, Fake, RUNTIME, coded, hello_body, ok, retry_after, slow,
        status,
    },
    *,
};
use crate::sync::MutexExt;
use fliks_engine_core::api::{
    BgJobState, EngineEvent, FingerprintWindow, HeartbeatRequest, JobKind, JobRequest, JobResult,
    MediaRef, SessionAction,
};
use serde_json::{Value, json};
use std::time::Instant;

/// Short deadlines; the poll is an hour away unless a test wants it.
fn fast() -> Timing {
    Timing {
        hello_attempts: 3,
        hello_retry: Duration::from_millis(5),
        poll: Duration::from_secs(3600),
        events_idle: Duration::from_millis(150),
        events_min: Duration::from_millis(50),
        events_max: Duration::from_millis(400),
        second: Duration::from_millis(5),
        capabilities_deadline: Duration::from_secs(2),
        open_deadline: Duration::from_secs(2),
        conflict_backoff: Duration::from_millis(1),
    }
}

fn engine_with(url: &str, timing: Timing) -> Engine {
    Engine::with_timing(url, "tok", timing)
}

async fn boot(fake: &Fake) -> Engine {
    let e = engine_with(&fake.url, fast());
    e.start_with(None, 4849).await;
    e
}

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never happened: {what}");
}

async fn tick(e: &Engine) {
    let epoch = e.state().epoch;
    e.tick(epoch).await;
}

fn puts(fake: &Fake) -> Vec<Value> {
    fake.seen("PUT", "/v1/config")
        .into_iter()
        .map(|s| s.body)
        .collect()
}

fn caps(node: Option<&str>) -> Value {
    json!({"hwAccel": "vaapi", "encoders": [], "decoders": [], "tonemapAlgos": [], "platform": "linux",
        "pauseCapability": "none", "defaultGpu": node, "hostCaps": {},
        "gpus": node.map(|n| json!([{"renderNode": n, "name": "g"}])).unwrap_or(json!([]))})
}

mod hello_gating {
    use super::*;

    #[tokio::test]
    async fn is_disabled_without_both_env_vars() {
        for (url, token) in [("", "t"), ("http://127.0.0.1:1", "")] {
            let e = Engine::with_timing(url, token, fast());
            e.start_with(None, 4849).await;
            assert!(!e.enabled());
            assert_eq!(e.status(), Status::Off);
        }
    }

    #[tokio::test]
    async fn enables_on_a_compatible_engine() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        assert!(e.enabled());
        assert_eq!(f.seen("GET", "/v1/hello")[0].auth, "Bearer tok");
    }

    #[tokio::test]
    async fn refuses_a_protocol_below_the_minimum() {
        let f = Fake::start().await;
        f.hello(Some(json!({"engineVersion": "0.2.0", "protocolVersion": 0, "features": FEATURES, "instanceId": "x"})));
        let e = boot(&f).await;
        assert!(!e.enabled());
        assert_eq!(e.status(), Status::Down);
    }

    #[tokio::test]
    async fn refuses_an_engine_without_probe_or_capabilities() {
        for missing in ["probe", "capabilities"] {
            let f = Fake::start().await;
            let features: Vec<&str> = FEATURES.iter().copied().filter(|x| *x != missing).collect();
            f.hello(Some(hello_body(&features, "x")));
            assert!(!boot(&f).await.enabled(), "{missing}");
        }
    }

    #[tokio::test]
    async fn retries_while_the_engine_starts() {
        let f = Fake::start().await;
        f.script(
            "GET",
            "/v1/hello",
            vec![status(500), status(503), ok(hello_body(&FEATURES, "x"))],
        );
        let e = boot(&f).await;
        assert!(e.enabled());
        assert_eq!(f.seen("GET", "/v1/hello").len(), 3);
    }

    #[tokio::test]
    async fn stays_disabled_when_the_engine_never_answers() {
        let f = Fake::start().await;
        f.hello(None);
        let e = boot(&f).await;
        assert!(!e.enabled());
        assert_eq!(f.seen("GET", "/v1/hello").len(), 3);
    }

    #[tokio::test]
    async fn a_refusal_never_stops_the_poll() {
        let f = Fake::start().await;
        f.hello(Some(json!({"engineVersion": "0.2.0", "protocolVersion": 0, "features": FEATURES, "instanceId": "x"})));
        let e = engine_with(
            &f.url,
            Timing {
                poll: Duration::from_millis(20),
                ..fast()
            },
        );
        e.start_with(None, 4849).await;
        assert!(!e.enabled());
        f.hello(Some(hello_body(&FEATURES, "x")));
        eventually("adopted and pushed once the engine got compatible", || {
            puts(&f).len() == 1
        })
        .await;
        assert!(e.enabled());
    }

    #[tokio::test]
    async fn a_config_read_error_status_counts_as_revision_zero() {
        let f = Fake::start().await;
        f.script("GET", "/v1/config", vec![status(500)]);
        let e = boot(&f).await;
        assert!(e.enabled());
        assert_eq!(puts(&f)[0]["revision"], 1);
    }
}

mod background_connection {
    use super::*;

    #[tokio::test]
    async fn keeps_retrying_after_the_boot_window_and_signals_once_the_engine_answers() {
        let f = Fake::start().await;
        f.hello(None);
        let e = engine_with(
            &f.url,
            Timing {
                poll: Duration::from_millis(20),
                ..fast()
            },
        );
        let adopted = e.adoptions();
        e.start_with(None, 4849).await;
        assert!(!e.enabled());
        assert_eq!(*adopted.borrow(), 0);
        f.hello(Some(hello_body(&FEATURES, "x")));
        eventually("adopted", || *adopted.borrow() == 1).await;
        assert!(e.enabled());
    }

    #[tokio::test]
    async fn reloads_on_an_instance_change_and_keeps_its_state_while_hello_fails() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        let adopted = e.adoptions();
        tick(&e).await;
        assert_eq!(*adopted.borrow(), 1, "same instance: nothing reloads");

        f.hello(None);
        tick(&e).await;
        assert!(e.enabled());
        assert_eq!(e.status(), Status::Down);
        assert_eq!(*adopted.borrow(), 1);

        f.hello(Some(hello_body(&FEATURES, "y")));
        f.script("GET", "/v1/config", vec![ok(json!({"revision": 0}))]);
        tick(&e).await;
        assert_eq!(e.status(), Status::Up);
        assert_eq!(*adopted.borrow(), 2);
        let sent = puts(&f);
        assert_eq!((sent.len(), sent[1]["revision"].as_u64()), (2, Some(1)));
    }
}

mod config_push {
    use super::*;

    #[tokio::test]
    async fn the_first_push_continues_the_engine_revision() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        let body = &puts(&f)[0];
        assert_eq!(body["revision"], 8);
        assert_eq!(body["hostUrl"], "http://127.0.0.1:4849");
        assert_eq!(body["hostToken"], e.host_token());
        assert_eq!(body["lifetime"]["jobGraceMs"], 60_000);
        assert_eq!(body["lifetime"]["maxSessionsPerOwner"], 10);
        assert_eq!(body["streaming"]["segmentDuration"], 3.0);
        assert_eq!(body["streaming"]["gpuRenderNode"], "auto");
        assert!(body.get("pathMappings").is_none());
        assert!(body["streaming"].get("jobMinFreeBytes").is_none());
    }

    #[tokio::test]
    async fn skips_an_unchanged_push() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        e.push_config().await.unwrap();
        e.push_config().await.unwrap();
        assert_eq!(puts(&f).len(), 1);
    }

    #[tokio::test]
    async fn does_not_count_a_rejected_push_and_the_poll_retries_it() {
        let f = Fake::start().await;
        f.script("PUT", "/v1/config", vec![status(500)]);
        let e = boot(&f).await;
        let err = e.push_config().await.unwrap_err();
        assert_eq!(err.to_string(), "PUT /v1/config -> 500");
        let revisions: Vec<_> = puts(&f)
            .iter()
            .map(|b| b["revision"].as_u64().unwrap())
            .collect();
        assert_eq!(
            revisions,
            [8, 8],
            "the boot push, then ours: the same revision again"
        );
        f.script("PUT", "/v1/config", vec![ok(json!({}))]);
        tick(&e).await;
        assert_eq!(puts(&f).len(), 3);
        tick(&e).await;
        assert_eq!(puts(&f).len(), 3, "pushed: the poll stops retrying");
    }

    #[tokio::test]
    async fn a_409_refetches_the_revision_and_retries() {
        let f = Fake::start().await;
        f.script("PUT", "/v1/config", vec![status(409), ok(json!({}))]);
        f.script(
            "GET",
            "/v1/config",
            vec![ok(json!({"revision": 7})), ok(json!({"revision": 12}))],
        );
        boot(&f).await;
        let revisions: Vec<_> = puts(&f)
            .iter()
            .map(|b| b["revision"].as_u64().unwrap())
            .collect();
        assert_eq!(revisions, [8, 13]);
    }

    #[tokio::test]
    async fn a_409_that_never_clears_gives_up_after_a_bounded_number_of_attempts() {
        let f = Fake::start().await;
        f.script("PUT", "/v1/config", vec![status(409)]);
        let e = boot(&f).await;
        assert_eq!(puts(&f).len(), 5);
        assert_eq!(e.push_config().await.unwrap_err().status(), Some(409));
    }

    #[tokio::test]
    async fn sends_path_mappings_when_set_and_omits_them_when_empty() {
        let f = Fake::start().await;
        let e = engine_with(&f.url, fast());
        e.state().path_mappings = vec![PathMapping {
            from: "/nas".into(),
            to: "/data".into(),
        }];
        e.start_with(None, 4849).await;
        let sent = puts(&f);
        assert_eq!(
            sent[0]["pathMappings"],
            json!([{"from": "/nas", "to": "/data"}])
        );
        let other = Fake::start().await;
        boot(&other).await;
        assert!(puts(&other)[0].get("pathMappings").is_none());
    }

    #[tokio::test]
    async fn streaming_setting_writes_repush_and_other_keys_do_not() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        e.settings_changed(&["theme".into()]).await;
        assert_eq!(puts(&f).len(), 1);
        e.settings_changed(&["streaming_gpu_render_node".into()])
            .await;
        assert_eq!(
            puts(&f).len(),
            1,
            "nothing changed in the assembled config: deduped"
        );
    }
}

mod capabilities {
    use super::*;

    #[tokio::test]
    async fn waits_out_503_and_retry_after() {
        let f = Fake::start().await;
        f.script(
            "GET",
            "/v1/capabilities",
            vec![retry_after(503, "1"), ok(caps(None))],
        );
        let e = boot(&f).await;
        assert_eq!(
            e.capabilities().await.unwrap().capabilities.hw_accel,
            "vaapi"
        );
        assert_eq!(f.seen("GET", "/v1/capabilities").len(), 2);
    }

    #[tokio::test]
    async fn fails_on_an_unexpected_status() {
        let f = Fake::start().await;
        f.script("GET", "/v1/capabilities", vec![status(500)]);
        let e = boot(&f).await;
        let err = e.capabilities().await.unwrap_err();
        assert!(err.to_string().contains("500"), "{err}");
    }

    #[tokio::test]
    async fn polls_until_the_rerun_for_the_pinned_node_lands() {
        let f = Fake::start().await;
        let d128 = || ok(caps(Some("/dev/dri/renderD128")));
        f.script(
            "GET",
            "/v1/capabilities",
            vec![d128(), d128(), ok(caps(Some("/dev/dri/renderD129")))],
        );
        let e = boot(&f).await;
        let out = e.capabilities_for("/dev/dri/renderD129").await.unwrap();
        assert_eq!(
            out.capabilities.default_gpu.as_deref(),
            Some("/dev/dri/renderD129")
        );
        assert_eq!(f.seen("GET", "/v1/capabilities").len(), 3);
    }

    #[tokio::test]
    async fn treats_auto_as_the_default_node_and_a_gpu_less_host_as_settled() {
        let f = Fake::start().await;
        f.script("GET", "/v1/capabilities", vec![ok(caps(None))]);
        let e = boot(&f).await;
        e.capabilities_for("/dev/dri/renderD129").await.unwrap();
        assert_eq!(f.seen("GET", "/v1/capabilities").len(), 1);
        f.script(
            "GET",
            "/v1/capabilities",
            vec![ok(caps(Some("/dev/dri/renderD128")))],
        );
        e.capabilities_for(" auto ").await.unwrap();
        assert_eq!(f.seen("GET", "/v1/capabilities").len(), 2);
    }
}

mod probe {
    use super::*;

    #[tokio::test]
    async fn posts_the_absolute_path_and_options() {
        let f = Fake::start().await;
        f.script("POST", "/v1/probe", vec![ok(json!({"ok": true}))]);
        let e = boot(&f).await;
        assert!(e.probe("/m/a.mkv", true, false, false).await.unwrap().ok);
        assert_eq!(
            f.seen("POST", "/v1/probe")[0].body,
            json!({"media": {"mediaFileId": 0, "path": "/m/a.mkv"}, "crop": true, "mkvTags": false, "moviehash": false})
        );
    }

    #[tokio::test]
    async fn throws_on_a_non_200() {
        let f = Fake::start().await;
        f.script("POST", "/v1/probe", vec![status(400)]);
        let e = boot(&f).await;
        let err = e.probe("rel.mkv", false, false, false).await.unwrap_err();
        assert_eq!(err.to_string(), "POST /v1/probe -> 400");
    }
}

mod host_callback {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn accepts_only_its_own_bearer() {
        let (a, b) = (Engine::new("", ""), Engine::new("", ""));
        let with = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("authorization", v.parse().unwrap());
            h
        };
        let ok = |e: &Engine, h: &HeaderMap| crate::engine::resolve::bearer_is(h, e.host_token());
        assert_eq!(a.host_token().len(), 64);
        assert!(ok(&a, &with(&format!("Bearer {}", a.host_token()))));
        assert!(!ok(&a, &with(&format!("Bearer {}x", a.host_token()))));
        assert!(!ok(&a, &HeaderMap::new()));
        assert!(!ok(&b, &with(&format!("Bearer {}", a.host_token()))));
        for wrong in ["", "Bearer", "Bearer wrong", a.host_token(), "Basic abc"] {
            assert!(!ok(&a, &with(wrong)), "{wrong:?}");
        }
    }
}

mod revoke {
    use super::*;

    #[tokio::test]
    async fn posts_the_owner_when_the_engine_announces_revoke() {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&["probe", "capabilities", "revoke"], "x")));
        f.script("POST", "/v1/revoke", vec![ok(json!({"sessions": 0}))]);
        let e = boot(&f).await;
        e.revoke_owner(5).await;
        assert_eq!(
            f.seen("POST", "/v1/revoke")[0].body,
            json!({"ownerId": "5"})
        );
    }

    #[tokio::test]
    async fn is_a_no_op_without_the_feature_or_without_an_engine() {
        let f = Fake::start().await;
        Engine::new("", "").revoke_owner(5).await;
        boot(&f).await.revoke_owner(5).await;
        assert!(f.seen("POST", "/v1/revoke").is_empty());
    }

    #[tokio::test]
    async fn swallows_a_failing_engine() {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&["probe", "capabilities", "revoke"], "x")));
        f.script("POST", "/v1/revoke", vec![status(500)]);
        boot(&f).await.revoke_owner(5).await;
        assert_eq!(f.seen("POST", "/v1/revoke").len(), 1);
    }
}

mod runtime {
    use super::*;

    async fn with(features: &[&str]) -> (Fake, Engine) {
        let f = Fake::start().await;
        f.hello(Some(hello_body(features, "x")));
        let e = boot(&f).await;
        (f, e)
    }

    #[tokio::test]
    async fn runs_playback_only_with_sessions_serve_and_events() {
        let base = ["probe", "capabilities"];
        for (extra, runtime) in [
            (vec!["sessions", "serve", "events"], true),
            (vec![], false),
            (vec!["sessions", "serve"], false),
            (vec!["sessions", "events"], false),
        ] {
            let features: Vec<&str> = base.iter().copied().chain(extra).collect();
            let (_f, e) = with(&features).await;
            assert!(e.enabled());
            assert_eq!(e.runtime(), runtime, "{features:?}");
        }
    }

    #[tokio::test]
    async fn is_not_a_runtime_before_it_is_adopted_nor_once_it_is_refused() {
        assert!(!Engine::new("", "").runtime());
        let (_f, e) = with(&["sessions", "serve", "events"]).await;
        assert!(!e.enabled() && !e.runtime());
    }

    #[tokio::test]
    async fn exposes_the_announced_features_of_the_adopted_engine_only() {
        assert!(Engine::new("", "").engine_features().is_empty());
        let (_f, e) = with(&RUNTIME).await;
        assert_eq!(e.engine_features(), RUNTIME);
        assert_eq!(
            e.features().await,
            [
                "deviceProfileExtensions",
                "hlsSubtitleRequest",
                "muxedAudioRendition"
            ]
        );
        let (_f, e) = with(&["probe", "capabilities", "serve"]).await;
        assert_eq!(
            e.features().await,
            ["hlsSubtitleRequest", "muxedAudioRendition"]
        );
        assert!(Engine::new("", "").features().await.is_empty());
    }

    #[tokio::test]
    async fn reports_off_up_and_down() {
        assert_eq!(Engine::new("", "").status(), Status::Off);
        let f = Fake::start().await;
        f.hello(Some(hello_body(&RUNTIME, "x")));
        let e = boot(&f).await;
        assert_eq!(e.status(), Status::Up);
        f.hello(None);
        tick(&e).await;
        assert_eq!(e.status(), Status::Down);
        f.hello(Some(hello_body(&RUNTIME, "x")));
        tick(&e).await;
        assert_eq!(e.status(), Status::Up);
    }
}

mod session_calls {
    use super::*;

    async fn connected() -> (Fake, Engine) {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&RUNTIME, "x")));
        let e = boot(&f).await;
        (f, e)
    }

    #[tokio::test]
    async fn opens_a_session_and_waits_out_the_503_of_the_first_detection_run() {
        let (f, e) = connected().await;
        f.script(
            "POST",
            "/v1/sessions",
            vec![retry_after(503, "2"), ok(json!({"sessionId": "a"}))],
        );
        let client = e.need().unwrap();
        let got: Value = e
            .open_retrying(
                &client,
                "POST /v1/sessions",
                "/v1/sessions",
                &json!({"x": 1}),
                false,
            )
            .await
            .unwrap();
        assert_eq!(got, json!({"sessionId": "a"}));
        assert_eq!(f.seen("POST", "/v1/sessions").len(), 2);
        assert_eq!(f.seen("POST", "/v1/sessions")[0].body, json!({"x": 1}));
    }

    #[tokio::test]
    async fn opens_a_live_session_waiting_out_the_detection_503_but_not_a_coded_one() {
        let f = Fake::start().await;
        let mut features = RUNTIME.to_vec();
        features.push("live");
        f.hello(Some(hello_body(&features, "x")));
        let e = boot(&f).await;
        let client = e.need().unwrap();
        let open = |coded_final| {
            let (e, client) = (e.clone(), client.clone());
            async move {
                e.open_retrying::<_, Value>(
                    &client,
                    "POST /v1/live",
                    "/v1/live",
                    &json!({}),
                    coded_final,
                )
                .await
            }
        };
        f.script(
            "POST",
            "/v1/live",
            vec![retry_after(503, "1"), ok(json!({"sessionId": "v"}))],
        );
        assert_eq!(open(true).await.unwrap(), json!({"sessionId": "v"}));
        for (code, st) in [("live_unavailable", 503), ("live_at_capacity", 409)] {
            f.script("POST", "/v1/live", vec![coded(st, code)]);
            let err = open(true).await.unwrap_err();
            let EngineError::Http {
                status: got,
                code: got_code,
                ..
            } = &err
            else {
                panic!("{err:?}")
            };
            assert_eq!((*got, got_code.as_deref()), (st, Some(code)));
        }
    }

    #[tokio::test]
    async fn refuses_a_live_open_on_an_engine_without_the_live_runtime() {
        let (_f, e) = connected().await;
        let body = serde_json::from_value(
            json!({"channelId": "c", "upstreams": [], "capacityToken": "t"}),
        )
        .unwrap();
        let err = e.open_live(&body).await.unwrap_err();
        assert_eq!(err.to_string(), "The engine has no live TV runtime");
    }

    #[tokio::test]
    async fn the_503_wait_ends_at_its_deadline_and_other_refusals_throw_their_status() {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&RUNTIME, "x")));
        let e = engine_with(
            &f.url,
            Timing {
                open_deadline: Duration::from_millis(30),
                ..fast()
            },
        );
        e.start_with(None, 4849).await;
        let client = e.need().unwrap();
        let body = json!({});
        let open = || {
            e.open_retrying::<_, Value>(&client, "POST /v1/sessions", "/v1/sessions", &body, false)
        };
        f.script("POST", "/v1/sessions", vec![retry_after(503, "1")]);
        assert_eq!(open().await.unwrap_err().status(), Some(503));
        f.script("POST", "/v1/sessions", vec![status(400)]);
        assert_eq!(open().await.unwrap_err().status(), Some(400));
    }

    #[tokio::test]
    async fn heartbeats_with_the_sid_as_a_path_parameter_and_surfaces_another_owner_as_403() {
        let (f, e) = connected().await;
        f.script(
            "POST",
            "/v1/sessions/a%2Fb/heartbeat",
            vec![ok(json!({"sessionLost": false}))],
        );
        f.script("POST", "/v1/sessions/a/heartbeat", vec![status(403)]);
        let beat = HeartbeatRequest {
            owner_id: Some("7".into()),
            position_s: Some(3.0),
            ..HeartbeatRequest::default()
        };
        assert!(!e.heartbeat("a/b", &beat).await.unwrap().session_lost);
        assert_eq!(
            f.seen("POST", "/v1/sessions/a%2Fb/heartbeat")[0].body,
            json!({"ownerId": "7", "positionS": 3.0})
        );
        assert_eq!(
            e.heartbeat("a", &HeartbeatRequest::default())
                .await
                .unwrap_err()
                .status(),
            Some(403)
        );
    }

    #[tokio::test]
    async fn deletes_a_session_with_its_reason_idempotently() {
        let (f, e) = connected().await;
        f.script("DELETE", "/v1/sessions/a", vec![status(204)]);
        e.delete_session("a", Some("stopped")).await.unwrap();
        assert_eq!(
            f.seen("DELETE", "/v1/sessions/a")[0].query,
            "reason=stopped"
        );
        f.script("DELETE", "/v1/sessions/a", vec![status(500)]);
        assert_eq!(
            e.delete_session("a", None).await.unwrap_err().to_string(),
            "DELETE session -> 500"
        );
    }

    #[tokio::test]
    async fn lists_with_filters_and_answers_none_for_an_unknown_session() {
        let (f, e) = connected().await;
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        let filter = SessionFilter {
            owner_id: Some("7".into()),
            media_file_id: Some(3),
        };
        assert!(e.list_sessions(&filter).await.unwrap().is_empty());
        assert_eq!(
            f.seen("GET", "/v1/sessions")[0].query,
            "ownerId=7&mediaFileId=3"
        );
        f.script("GET", "/v1/sessions/zz", vec![status(404)]);
        assert!(e.get_session("zz").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn answers_the_status_of_a_command() {
        let (f, e) = connected().await;
        f.script("POST", "/v1/sessions/a/command", vec![status(409)]);
        assert_eq!(
            e.session_command("a", SessionAction::PauseJob)
                .await
                .unwrap(),
            409
        );
        assert_eq!(
            f.seen("POST", "/v1/sessions/a/command")[0].body,
            json!({"action": "pauseJob"})
        );
    }

    #[tokio::test]
    async fn purges_the_cache_with_its_filters() {
        let (f, e) = connected().await;
        f.script("DELETE", "/v1/cache", vec![ok(json!({"removed": 3}))]);
        assert_eq!(e.purge_cache(Some(4), Some("7")).await.unwrap(), 3);
        assert_eq!(
            f.seen("DELETE", "/v1/cache")[0].query,
            "mediaFileId=4&ownerId=7"
        );
    }

    #[tokio::test]
    async fn invalidate_is_best_effort() {
        let (f, e) = connected().await;
        f.script("POST", "/v1/invalidate", vec![status(500)]);
        e.invalidate(9).await;
        Engine::new("", "").invalidate(9).await;
        assert_eq!(
            f.seen("POST", "/v1/invalidate")[0].body,
            json!({"mediaFileId": 9})
        );
    }

    #[tokio::test]
    async fn refuses_to_call_a_disabled_engine() {
        let err = Engine::new("", "")
            .heartbeat("a", &HeartbeatRequest::default())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "The streaming engine is not running");
        assert!(matches!(err, EngineError::NotRunning));
    }

    #[tokio::test]
    async fn control_calls_carry_the_bearer_and_json_only_with_a_body() {
        let (f, e) = connected().await;
        f.script(
            "GET",
            "/v1/cache",
            vec![ok(json!({"usedBytes": 0.0, "entries": []}))],
        );
        f.script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j"}))]);
        e.cache().await.unwrap();
        e.submit_job(&fingerprint_request()).await.unwrap();
        let get = &f.seen("GET", "/v1/cache")[0];
        assert_eq!(
            (get.auth.as_str(), get.content_type.as_deref()),
            ("Bearer tok", None)
        );
        assert_eq!(
            f.seen("POST", "/v1/jobs")[0].content_type.as_deref(),
            Some("application/json")
        );
    }
}

mod remote_config {
    use super::*;

    #[tokio::test]
    async fn connects_with_the_saved_url_and_token_over_the_env() {
        let f = Fake::start().await;
        let e = Engine::with_timing("http://127.0.0.1:1", "env-tok", fast());
        {
            let mut s = e.state();
            (s.stored_url, s.stored_token) = (format!(" {} ", f.url), " saved-tok ".into());
        }
        e.start_with(None, 4849).await;
        assert!(e.enabled());
        assert_eq!(f.seen("GET", "/v1/hello")[0].auth, "Bearer saved-tok");
    }

    #[tokio::test]
    async fn test_connection_reports_unreachable_when_hello_fails() {
        let e = Engine::new("", "");
        let out = e.test_connection("http://127.0.0.1:1", "t", None).await;
        assert_eq!(
            out,
            ConnectionTest {
                error: Some("The streaming engine at http://127.0.0.1:1 did not answer".into()),
                ..Default::default()
            }
        );
        let blank = e.test_connection(" ", " ", None).await;
        assert_eq!(
            blank.error.as_deref(),
            Some("Engine URL and token are required")
        );
    }

    #[tokio::test]
    async fn test_connection_returns_probe_data_after_a_successful_hello() {
        let f = Fake::start().await;
        f.script("POST", "/v1/probe", vec![ok(json!({"ok": true}))]);
        let e = Engine::new("", "");
        let out = e.test_connection(&f.url, "t", Some(" /media/a.mkv ")).await;
        assert_eq!(
            (
                out.ok,
                out.engine_version.as_deref(),
                out.protocol_version,
                out.probe_ok
            ),
            (true, Some("0.2.0"), Some(1), Some(true))
        );
        assert_eq!(
            f.seen("POST", "/v1/probe")[0].body["media"]["path"],
            "/media/a.mkv"
        );
        for (answer, error) in [
            (status(500), "probe -> 500"),
            (
                ok(json!({"ok": false, "error": "no streams"})),
                "no streams",
            ),
            (ok(json!({"ok": false})), "Probe failed"),
        ] {
            f.script("POST", "/v1/probe", vec![answer]);
            let out = e.test_connection(&f.url, "t", Some("/a")).await;
            assert_eq!(
                (out.probe_ok, out.probe_error.as_deref()),
                (Some(false), Some(error))
            );
        }
        assert_eq!(
            e.test_connection(&f.url, "t", Some("  ")).await.probe_ok,
            None
        );
    }

    #[tokio::test]
    async fn does_not_adopt_a_handshake_that_started_before_reconfigure() {
        let (old, new) = (Fake::start().await, Fake::start().await);
        old.script(
            "GET",
            "/v1/hello",
            vec![slow(150, ok(hello_body(&FEATURES, "old")))],
        );
        new.hello(Some(hello_body(&FEATURES, "new")));
        let e = engine_with(&old.url, fast());
        let boot = tokio::spawn({
            let e = e.clone();
            async move { e.start_with(None, 4849).await }
        });
        eventually("the first hello", || {
            !old.seen("GET", "/v1/hello").is_empty()
        })
        .await;
        {
            let mut s = e.state();
            (s.stored_url, s.stored_token) = (new.url.clone(), "tok".into());
        }
        e.reconfigure().await;
        assert_eq!(e.hello().await.unwrap().instance_id, "new");
        boot.await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(e.hello().await.unwrap().instance_id, "new");
        assert!(
            old.seen("GET", "/v1/config").is_empty(),
            "the stale handshake went no further"
        );
    }

    #[tokio::test]
    async fn tests_the_process_engine_when_the_form_is_empty() {
        let f = Fake::start().await;
        let e = engine_with(&f.url, fast());
        assert!(e.test_connection("", "", None).await.ok);
        assert_eq!(f.seen("GET", "/v1/hello")[0].auth, "Bearer tok");
    }

    #[test]
    fn a_trailing_slash_is_the_same_engine_and_a_different_host_is_flagged() {
        let e = Engine::new("http://gateway", "t");
        e.state().stored_url = "http://gateway/".into();
        assert!(!e.gateway_mismatch());
        e.state().stored_url = "http://other".into();
        assert!(e.gateway_mismatch());
        e.state().stored_url = String::new();
        assert!(!e.gateway_mismatch());
        assert!(!Engine::new("", "t").gateway_mismatch());
    }
}

fn fingerprint_request() -> JobRequest {
    JobRequest {
        kind: JobKind::Fingerprint {
            window: FingerprintWindow::Head,
            max_lookup_minutes: None,
        },
        media: MediaRef {
            media_file_id: 3,
            path: "/m/a.mkv".into(),
        },
        priority: None,
        force: false,
    }
}

fn job_snapshot(state: &str, extra: Value) -> Answer {
    let mut body = json!({"jobId": "j1", "kind": "Fingerprint", "mediaFileId": 3, "priority": "normal",
        "state": state, "pct": 0.0, "createdMs": 1.0});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    ok(body)
}

fn fingerprint_result() -> Value {
    json!({"type": "Fingerprint", "fingerprint": {"hashes": [1], "durationSeconds": 5.0, "baseOffsetSec": 0.0}})
}

mod jobs {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn connected(snapshot: Answer) -> (Fake, Engine) {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&FEATURES, "x")));
        f.script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
        f.script("GET", "/v1/jobs/j1", vec![snapshot]);
        let e = boot(&f).await;
        (f, e)
    }

    fn waiting(e: &Engine) -> bool {
        e.inner.jobs.pending().iter().any(|id| id == "j1")
    }

    #[tokio::test]
    async fn resolves_with_the_result_on_bgjobdone_and_reports_progress() {
        let (f, e) = connected(job_snapshot("running", json!({}))).await;
        let progress: Arc<Mutex<Vec<f64>>> = Arc::default();
        let sink = progress.clone();
        let run = tokio::spawn({
            let e = e.clone();
            async move {
                e.run_job(
                    &fingerprint_request(),
                    Some(Arc::new(move |p| sink.lock_clean().push(p))),
                )
                .await
            }
        });
        eventually("registered", || waiting(&e)).await;
        e.job_progress("j1", 50.0);
        let result: JobResult = serde_json::from_value(fingerprint_result()).unwrap();
        e.job_ended("j1", BgJobState::Done, Some(result.clone()), None);
        assert_eq!(run.await.unwrap().unwrap(), result);
        assert_eq!(*progress.lock_clean(), [50.0]);
        assert_eq!(
            f.seen("POST", "/v1/jobs")[0].body["kind"]["type"],
            "Fingerprint"
        );
    }

    #[tokio::test]
    async fn rejects_a_failed_job_with_its_error() {
        let (_f, e) = connected(job_snapshot("running", json!({}))).await;
        let run = tokio::spawn({
            let e = e.clone();
            async move { e.run_job(&fingerprint_request(), None).await }
        });
        eventually("registered", || waiting(&e)).await;
        e.job_ended(
            "j1",
            BgJobState::Failed,
            None,
            Some("fpcalc exited 1".into()),
        );
        assert_eq!(
            run.await.unwrap().unwrap_err().to_string(),
            "engine job failed: fpcalc exited 1"
        );
    }

    #[tokio::test]
    async fn settles_a_job_that_ended_before_it_was_registered() {
        let done = job_snapshot("done", json!({"result": fingerprint_result()}));
        let (_f, e) = connected(done).await;
        let got = e.run_job(&fingerprint_request(), None).await.unwrap();
        assert!(matches!(got, JobResult::Fingerprint { .. }));
    }

    #[tokio::test]
    async fn rechecks_pending_jobs_on_resync_and_rejects_one_the_engine_lost() {
        let (f, e) = connected(job_snapshot("running", json!({}))).await;
        let run = tokio::spawn({
            let e = e.clone();
            async move { e.run_job(&fingerprint_request(), None).await }
        });
        eventually("registered", || waiting(&e)).await;
        f.script("GET", "/v1/jobs/j1", vec![status(404)]);
        e.resync_jobs().await;
        assert_eq!(
            run.await.unwrap().unwrap_err().to_string(),
            "engine lost job j1"
        );
    }

    #[tokio::test]
    async fn a_cancelled_job_and_a_done_one_without_a_result_are_job_errors() {
        let (_f, e) = connected(job_snapshot("cancelled", json!({}))).await;
        let err = e.run_job(&fingerprint_request(), None).await.unwrap_err();
        assert_eq!(err.to_string(), "engine job cancelled: Fingerprint");
        let (_f, e) = connected(job_snapshot("done", json!({}))).await;
        let err = e.run_job(&fingerprint_request(), None).await.unwrap_err();
        assert_eq!(err.to_string(), "engine job done: Fingerprint");
    }

    #[tokio::test]
    async fn a_missing_engine_leaves_waiters_for_the_next_resync() {
        let (_f, e) = connected(job_snapshot("running", json!({}))).await;
        let run = tokio::spawn({
            let e = e.clone();
            async move { e.run_job(&fingerprint_request(), None).await }
        });
        eventually("registered", || waiting(&e)).await;
        e.state().client = None;
        e.resync_jobs().await;
        assert!(waiting(&e));
        run.abort();
    }
}

mod events {
    use super::*;

    fn frame(v: Value) -> String {
        format!("event: x\ndata: {v}\n\n")
    }

    fn ended(sid: &str) -> Value {
        json!({"type": "SessionEnded", "sessionId": sid, "reason": "stopped"})
    }

    async fn runtime_engine(f: &Fake, timing: Timing) -> Engine {
        f.hello(Some(hello_body(&RUNTIME, "x")));
        let e = engine_with(&f.url, timing);
        e.start_with(None, 4849).await;
        e
    }

    async fn next(rx: &mut broadcast::Receiver<Feed>) -> Feed {
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("a feed item in time")
            .expect("an open feed")
    }

    #[tokio::test]
    async fn lists_after_subscribing_then_applies_the_events() {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&RUNTIME, "x")));
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.connections(vec![Conn::Hold(vec![
            frame(ended("s1")),
            frame(json!({"type": "FutureThing"})),
            ": ka\n\n".into(),
            frame(ended("s2")),
        ])]);
        let e = engine_with(&f.url, fast());
        let mut rx = e.subscribe();
        e.start_with(None, 4849).await;
        assert!(matches!(next(&mut rx).await, Feed::Resync(s, _) if s.is_empty()));
        let mut sids = vec![];
        for _ in 0..2 {
            match next(&mut rx).await {
                Feed::Event(ev) => match &*ev {
                    EngineEvent::SessionEnded { session_id, .. } => sids.push(session_id.clone()),
                    other => panic!("{other:?}"),
                },
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(sids, ["s1", "s2"], "the unknown type was skipped");
        let order = f.order();
        let at = |what: &str| order.iter().position(|r| r == what).unwrap();
        assert!(
            at("GET /v1/events") < at("GET /v1/sessions"),
            "subscribe first, list after"
        );
    }

    #[tokio::test]
    async fn settles_job_waiters_from_the_stream() {
        let f = Fake::start().await;
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
        f.script(
            "GET",
            "/v1/jobs/j1",
            vec![job_snapshot("running", json!({}))],
        );
        f.connections(vec![Conn::Hold(vec![])]);
        let e = runtime_engine(&f, fast()).await;
        let run = tokio::spawn({
            let e = e.clone();
            async move { e.run_job(&fingerprint_request(), None).await }
        });
        eventually("registered", || {
            e.inner.jobs.pending().iter().any(|id| id == "j1")
        })
        .await;
        let done = json!({"type": "BgJobDone", "jobId": "j1", "state": "done", "result": fingerprint_result()});
        f.push_frames(&frame(done));
        assert!(matches!(
            run.await.unwrap().unwrap(),
            JobResult::Fingerprint { .. }
        ));
    }

    #[tokio::test]
    async fn backs_off_while_down_and_starts_over_after_a_good_connection() {
        let f = Fake::start().await;
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.connections(vec![
            Conn::Refuse(503),
            Conn::Refuse(503),
            Conn::End(vec![]),
            Conn::Hold(vec![]),
        ]);
        runtime_engine(&f, fast()).await;
        eventually("four connections", || f.connected_at().len() >= 4).await;
        let at = f.connected_at();
        let gap = |i: usize| at[i + 1] - at[i];
        assert!(gap(0) >= Duration::from_millis(50), "{:?}", gap(0));
        assert!(gap(1) >= Duration::from_millis(100), "{:?}", gap(1));
        // A third failure would have waited 200 ms; a good connection starts over at the minimum.
        assert!(
            gap(2) >= Duration::from_millis(50) && gap(2) < Duration::from_millis(150),
            "{:?}",
            gap(2)
        );
    }

    #[tokio::test]
    async fn the_backoff_resets_only_after_a_successful_resync() {
        let f = Fake::start().await;
        f.script("GET", "/v1/sessions", vec![status(500)]);
        f.connections((0..4).map(|_| Conn::End(vec![])).collect());
        runtime_engine(&f, fast()).await;
        eventually("four connections", || f.connected_at().len() >= 4).await;
        let at = f.connected_at();
        let gaps: Vec<_> = (0..3).map(|i| at[i + 1] - at[i]).collect();
        assert!(gaps[0] >= Duration::from_millis(50), "{gaps:?}");
        assert!(gaps[1] >= Duration::from_millis(100), "{gaps:?}");
        assert!(gaps[2] >= Duration::from_millis(200), "{gaps:?}");
    }

    #[tokio::test]
    async fn the_idle_watchdog_drops_a_silent_connection_but_keep_alives_count() {
        let f = Fake::start().await;
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.connections(vec![Conn::Hold(vec![]), Conn::Hold(vec![])]);
        let started = Instant::now();
        runtime_engine(&f, fast()).await;
        eventually("a second connection after the silence", || {
            f.connected_at().len() >= 2
        })
        .await;
        assert!(f.connected_at()[1] - started >= Duration::from_millis(150));
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            f.push_frames(": ping\n\n");
        }
        assert_eq!(f.connected_at().len(), 2, "keep-alives re-arm the watchdog");
    }

    #[tokio::test]
    async fn does_not_stream_from_an_engine_that_does_not_run_playback() {
        let f = Fake::start().await;
        let e = boot(&f).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(e.enabled() && !e.runtime());
        assert!(f.seen("GET", "/v1/events").is_empty());
    }

    #[tokio::test]
    async fn restarts_on_every_adoption() {
        let f = Fake::start().await;
        f.hello(Some(hello_body(&RUNTIME, "x")));
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.connections(vec![Conn::Hold(vec![]), Conn::Hold(vec![])]);
        // No idle watchdog reconnect: only the adoption may open the second connection.
        let timing = Timing {
            events_idle: Duration::from_secs(60),
            ..fast()
        };
        let e = engine_with(&f.url, timing);
        let mut rx = e.subscribe();
        e.start_with(None, 4849).await;
        assert!(matches!(next(&mut rx).await, Feed::Resync(..)));
        f.hello(Some(hello_body(&RUNTIME, "y")));
        tick(&e).await;
        assert!(matches!(next(&mut rx).await, Feed::Resync(..)));
        assert_eq!(f.connected_at().len(), 2);
        assert_eq!(f.seen("GET", "/v1/sessions").len(), 2);
    }

    #[tokio::test]
    async fn stops_following_when_the_engine_is_dropped_by_a_reconfigure() {
        let f = Fake::start().await;
        f.script("GET", "/v1/sessions", vec![ok(json!([]))]);
        f.connections(vec![Conn::Hold(vec![])]);
        let e = runtime_engine(&f, fast()).await;
        eventually("connected", || f.connected_at().len() == 1).await;
        f.hello(Some(hello_body(&FEATURES, "z")));
        e.reconfigure().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!e.runtime());
        assert_eq!(f.connected_at().len(), 1);
    }
}

#[test]
fn the_fake_and_the_real_timings_agree_on_the_contract_numbers() {
    let t = Timing::default();
    assert_eq!(
        (t.hello_attempts, t.hello_retry, t.poll),
        (20, Duration::from_millis(500), Duration::from_secs(10))
    );
    assert_eq!(
        (t.events_idle, t.events_min, t.events_max),
        (
            Duration::from_secs(45),
            Duration::from_millis(500),
            Duration::from_secs(15)
        )
    );
    assert_eq!(
        (t.capabilities_deadline, t.open_deadline),
        (Duration::from_secs(300), Duration::from_secs(15))
    );
    let _ = testkit::status(200);
}
