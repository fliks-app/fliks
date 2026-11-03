//! In-process stand-ins for the provider plugins: records are already mapped, as a plugin answers them.
use axum::{Router, extract::State, http::Uri, response::IntoResponse};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use fliks_server::{
    images::ImageStore,
    metadata::{Call, Credits, MetadataProvider, PersonDetails, Search, Upstream},
    net::guard::{Net, SystemNet},
};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

type Answer = Result<Value, u16>;
type Fallback = Arc<dyn Fn(&str) -> Option<Answer> + Send + Sync>;

/// A provider answering from a table. Keys: `search/<kind>`, `work/<kind>/<id>`, `children/<id>`,
/// `stubs/<id>`, `list/<kind>/<name>`, `person/<id>`, `credits/<id>`. A missing key answers 404.
pub struct Scripted {
    id: Namespace,
    routes: Mutex<HashMap<String, Answer>>,
    fallback: Mutex<Option<Fallback>>,
    log: Mutex<Vec<String>>,
    pub on: AtomicBool,
}

impl Scripted {
    pub fn new(id: Namespace) -> Arc<Self> {
        Arc::new(Self {
            id,
            routes: Mutex::default(),
            fallback: Mutex::default(),
            log: Mutex::default(),
            on: AtomicBool::new(true),
        })
    }

    pub fn ok(&self, key: &str, body: Value) {
        self.routes.lock().unwrap().insert(key.into(), Ok(body));
    }

    pub fn fail(&self, key: &str, status: u16) {
        self.routes.lock().unwrap().insert(key.into(), Err(status));
    }

    /// Answers the keys the table does not hold; `None` is a 404.
    pub fn otherwise(&self, f: impl Fn(&str) -> Option<Answer> + Send + Sync + 'static) {
        *self.fallback.lock().unwrap() = Some(Arc::new(f));
    }

    /// Calls whose key (with its parameters) starts with `prefix`.
    pub fn seen(&self, prefix: &str) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|l| l.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn answer<T: Send + 'static>(
        &self,
        key: String,
        logged: String,
        map: impl FnOnce(Value) -> T,
    ) -> Call<'static, T> {
        self.log.lock().unwrap().push(logged);
        let found = self.routes.lock().unwrap().get(&key).cloned();
        let fallback = self.fallback.lock().unwrap().clone();
        let r = found
            .or_else(|| fallback.and_then(|f| f(&key)))
            .unwrap_or(Err(404));
        let r = r
            .map(map)
            .map_err(|s| Upstream::new(Some(s), format!("HTTP {s}")));
        Box::pin(async move { r })
    }
}

fn items(v: Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn text(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_owned)
}

impl MetadataProvider for Scripted {
    fn id(&self) -> Namespace {
        self.id
    }
    fn supports(&self, kind: MediaKind) -> bool {
        kind != MediaKind::Book
    }
    fn has_persons(&self) -> bool {
        true
    }
    fn limits(&self) -> Limits {
        Limits::new(1000.0, 1000)
    }
    fn available(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }
    fn has_lists(&self, kind: MediaKind) -> bool {
        kind != MediaKind::Book
    }
    fn search<'a>(
        &'a self,
        q: &'a Search<'a>,
        lang: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let year = q.year.map_or(String::new(), |y| format!("&year={y}"));
        let logged = format!(
            "search/{}?query={}{year}&language={}",
            q.kind.as_str(),
            q.query,
            lang.tmdb_locale
        );
        self.answer(format!("search/{}", q.kind.as_str()), logged, items)
    }
    fn fetch_work<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        let key = format!("work/{}/{id}", kind.as_str());
        self.answer(key.clone(), key, |v| v)
    }
    fn fetch_children<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let key = format!("children/{id}");
        self.answer(key.clone(), key, items)
    }
    fn child_stubs<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let key = format!("stubs/{id}");
        self.answer(key.clone(), key, items)
    }
    fn find_by<'a>(
        &'a self,
        _: Namespace,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        Box::pin(async { Ok(None) })
    }
    fn fetch_person<'a>(
        &'a self,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, PersonDetails> {
        let key = format!("person/{id}");
        self.answer(key.clone(), key, |v| PersonDetails {
            name: text(&v, "name"),
            biography: text(&v, "biography"),
            birthday: text(&v, "birthday"),
            deathday: text(&v, "deathday"),
            place_of_birth: text(&v, "placeOfBirth"),
            avatar_url: text(&v, "avatarUrl"),
            known_for_department: text(&v, "knownForDepartment"),
        })
    }
    fn person_credits<'a>(
        &'a self,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Credits> {
        let key = format!("credits/{id}");
        self.answer(key.clone(), key, |v| Credits {
            cast: items(v["cast"].clone()),
            crew: items(v["crew"].clone()),
        })
    }
    fn list<'a>(
        &'a self,
        kind: MediaKind,
        name: &'a str,
        params: &'a [(String, String)],
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        let key = format!("list/{}/{name}", kind.as_str());
        let q: Vec<_> = params.iter().map(|(k, v)| format!("{k}={v}")).collect();
        self.answer(key.clone(), format!("{key}?{}", q.join("&")), |v| v)
    }
}

pub fn jpeg() -> Vec<u8> {
    let img = image::RgbImage::from_fn(60, 90, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 3])
    });
    let mut out = vec![];
    image::DynamicImage::ImageRgb8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    out
}

/// A loopback server standing for `image.tmdb.org`: the files it holds, else a default JPEG when `any`.
#[derive(Default)]
pub struct Images {
    files: Mutex<HashMap<String, Vec<u8>>>,
    log: Mutex<Vec<String>>,
    any: AtomicBool,
    port: Mutex<u16>,
}

impl Images {
    pub async fn start(any: bool) -> Arc<Self> {
        let me = Arc::new(Self::default());
        me.any.store(any, Ordering::SeqCst);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        *me.port.lock().unwrap() = l.local_addr().unwrap().port();
        let app = Router::new().fallback(serve).with_state(me.clone());
        tokio::spawn(async { axum::serve(l, app).await.unwrap() });
        me
    }

    pub fn put(&self, path: &str, bytes: Vec<u8>) {
        self.files.lock().unwrap().insert(path.into(), bytes);
    }

    pub fn seen(&self, prefix: &str) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|l| l.starts_with(prefix))
            .cloned()
            .collect()
    }

    /// A store on `data` whose `image.tmdb.org` is this server.
    pub fn store(self: &Arc<Self>, data: PathBuf) -> ImageStore {
        let net = Arc::new(Dns {
            port: *self.port.lock().unwrap(),
            tls: SystemNet::new(),
        });
        let s = ImageStore::with_root(data).with_net(net);
        s.allow_hosts("fliks.tmdb", vec!["image.tmdb.org".into()]);
        s
    }
}

async fn serve(State(i): State<Arc<Images>>, uri: Uri) -> impl IntoResponse {
    i.log.lock().unwrap().push(uri.path().to_owned());
    let held = i.files.lock().unwrap().get(uri.path()).cloned();
    match held.or_else(|| i.any.load(Ordering::SeqCst).then(jpeg)) {
        Some(b) => ([("content-type", "image/jpeg")], b).into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

/// Every name is a public address; every dial goes to the local server.
struct Dns {
    port: u16,
    tls: SystemNet,
}

impl Net for Dns {
    fn lookup(&self, _: &str, port: u16) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
        Box::pin(async move { Ok(vec![SocketAddr::from(([93, 184, 216, 34], port))]) })
    }
    fn connect(&self, _: SocketAddr) -> BoxFuture<'static, std::io::Result<tokio::net::TcpStream>> {
        let port = self.port;
        Box::pin(async move { tokio::net::TcpStream::connect(("127.0.0.1", port)).await })
    }
    fn tls(&self) -> Arc<tokio_rustls::rustls::ClientConfig> {
        self.tls.tls()
    }
    fn route(&self, _: SocketAddr) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.port))
    }
}
