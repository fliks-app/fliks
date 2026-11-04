//! A loopback HTTP server for the client unit tests.
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// What the server answers: status, `Retry-After`, JSON body.
pub type Reply = (u16, Option<String>, String);

/// Answers each request with `handler(path without query, request number from 0)`; returns the base
/// URL and the request counter.
pub async fn serve(
    handler: impl Fn(&str, u32) -> Reply + Send + 'static,
) -> (String, Arc<AtomicU32>) {
    let hits = Arc::new(AtomicU32::new(0));
    let seen = hits.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let n = seen.fetch_add(1, Ordering::Relaxed);
            let mut buf = [0u8; 4096];
            let read = sock.read(&mut buf).await.unwrap_or(0);
            let line = String::from_utf8_lossy(&buf[..read]);
            let target = line.split_whitespace().nth(1).unwrap_or("/");
            let path = target.split('?').next().unwrap_or("/");
            let (status, after, body) = handler(path, n);
            let retry = after.map_or(String::new(), |a| format!("Retry-After: {a}\r\n"));
            let reply = format!(
                "HTTP/1.1 {status} X\r\n{retry}Content-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        }
    });
    (url, hits)
}

/// A scene provider answering from a table, for the tests of the scene numbering.
pub mod scene {
    use crate::metadata::{Call, Credits, MetadataProvider, PersonDetails, Search, Upstream};
    use fliks_domain::{
        external_id::Namespace,
        media::kind::MediaKind,
        metadata::{
            language::Resolved,
            limiter::{Limits, Priority},
        },
        release::scene::Entry,
    };
    use serde_json::Value;
    use std::{
        collections::HashMap,
        sync::{
            Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    #[derive(Default)]
    pub struct SceneStub {
        /// What `scene_mapped_ids` lists.
        pub ids: Mutex<Vec<String>>,
        /// The mapping per TVDB id; an id without one answers none.
        pub maps: Mutex<HashMap<String, Vec<Entry>>>,
        /// Every call fails 503.
        pub down: AtomicBool,
        /// `scene_mapping` calls so far.
        pub mapping_calls: AtomicUsize,
    }

    fn off<T: Send + 'static>() -> Call<'static, T> {
        Box::pin(async { Err(Upstream::new(Some(404), "scene stub")) })
    }

    impl MetadataProvider for SceneStub {
        fn id(&self) -> Namespace {
            Namespace::TVDB
        }
        fn supports(&self, _: MediaKind) -> bool {
            false
        }
        fn has_persons(&self) -> bool {
            false
        }
        fn limits(&self) -> Limits {
            Limits::new(1.0, 1)
        }
        fn has_scene(&self) -> bool {
            true
        }
        fn scene_mapped_ids<'a>(&'a self, _: Priority) -> Call<'a, Vec<String>> {
            let r = if self.down.load(Ordering::SeqCst) {
                Err(Upstream::new(Some(503), "scene stub down"))
            } else {
                Ok(self.ids.lock().unwrap().clone())
            };
            Box::pin(async move { r })
        }
        fn scene_mapping<'a>(&'a self, id: &'a str, _: Priority) -> Call<'a, Option<Vec<Entry>>> {
            self.mapping_calls.fetch_add(1, Ordering::SeqCst);
            let r = if self.down.load(Ordering::SeqCst) {
                Err(Upstream::new(Some(503), "scene stub down"))
            } else {
                Ok(self.maps.lock().unwrap().get(id).cloned())
            };
            Box::pin(async move { r })
        }
        fn search<'a>(
            &'a self,
            _: &'a Search<'a>,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            off()
        }
        fn fetch_work<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Value> {
            off()
        }
        fn fetch_children<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            off()
        }
        fn child_stubs<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            off()
        }
        fn find_by<'a>(
            &'a self,
            _: Namespace,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Option<(String, MediaKind)>> {
            off()
        }
        fn fetch_person<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, PersonDetails> {
            off()
        }
        fn person_credits<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Credits> {
            off()
        }
    }
}
