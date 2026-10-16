//! Download, resize and cache artwork (`docs/spec/image-store.md`); the write side of `GET /api/images/*`.
use super::paths::{Kind, Size, Target, Variant};
use crate::{atomic_file::write_atomic, paths::data_dir};
use image::{
    ColorType, DynamicImage, ImageEncoder, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder,
    codecs::png::PngEncoder, imageops::FilterType,
};
use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    future::Future,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const NETWORK_SLOTS: usize = 3;
const JPEG_QUALITY: u8 = 90;
/// sharp's default input limit (16383 x 16383).
const MAX_PIXELS: u64 = 268_402_689;

/// What the import, refresh, request and person code needs from the image store.
pub trait ImageSink: Send + Sync {
    /// `/api/images/...?v=<hash>`, or `None` when nothing could be stored.
    fn download_and_store(
        &self,
        url: &str,
        t: &Target,
    ) -> impl Future<Output = Option<String>> + Send;
    fn store_from_disk(
        &self,
        abs: &Path,
        t: &Target,
    ) -> impl Future<Output = Option<String>> + Send;
    fn has_image(&self, t: &Target) -> bool;
}

pub struct ImageStore {
    /// `None` is the shared data directory, resolved on first use.
    root: Option<PathBuf>,
    /// `<image base>/`: the prefix of the TMDB URLs whose size segment is rewritten.
    tmdb_prefix: String,
    http: reqwest::Client,
    net: Semaphore,
    cpu: Semaphore,
    keys: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

#[derive(Deserialize)]
struct Sidecar {
    url: String,
    hash: String,
}

/// Widths of the `thumb` and `medium` files; `full` is the downloaded bytes.
fn widths(t: &Target) -> (Option<u32>, Option<u32>) {
    let variant = t.variant.unwrap_or(Variant::Poster);
    match (t.kind, variant) {
        (Kind::Media | Kind::Request, Variant::Poster) => (Some(185), Some(500)),
        (Kind::Media | Kind::Request, Variant::Fanart | Variant::FanartN(_)) => {
            (Some(300), Some(780))
        }
        (Kind::Media, Variant::Logo) => (Some(185), Some(500)),
        (Kind::Person, _) => (Some(45), None),
        (Kind::Episode, _) => (Some(300), Some(780)),
        (Kind::Season, _) => (Some(185), Some(500)),
        _ => (None, None),
    }
}

fn is_png(t: &Target) -> bool {
    t.kind == Kind::Livetv || (t.kind == Kind::Media && t.variant == Some(Variant::Logo))
}

/// The URL for logs: no userinfo, no query string (`image-store.md` rule 23).
fn redacted(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(mut u) => {
            let _ = (u.set_username(""), u.set_password(None));
            u.set_query(None);
            u.to_string()
        }
        Err(_) => "<invalid url>".into(),
    }
}

fn hash8(bytes: &[u8]) -> String {
    Sha1::digest(bytes)
        .iter()
        .take(4)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Header-level check: a supported format with readable dimensions.
fn probe(bytes: &[u8]) -> Option<(ImageFormat, u32, u32)> {
    let r = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let format = r.format()?;
    matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif
    )
    .then_some(())?;
    let (w, h) = r.into_dimensions().ok()?;
    Some((format, w, h))
}

/// Alpha flattened onto black, as libvips' `jpegsave` does.
fn flatten(img: &DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let mut out = image::RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u16::from(p[3]);
        *o = image::Rgb([0, 1, 2].map(|i| ((u16::from(p[i]) * a + 127) / 255) as u8));
    }
    out
}

/// Fixed width, aspect kept, never enlarged; PNG for logos, JPEG q90 otherwise.
fn resized(bytes: &[u8], width: u32, png: bool) -> Option<Vec<u8>> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (w, h) = (img.width(), img.height());
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return None;
    }
    let img = if w > width {
        let nh = ((u64::from(h) * u64::from(width) + u64::from(w) / 2) / u64::from(w)).max(1);
        img.resize_exact(width, nh as u32, FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = vec![];
    if png {
        let rgba = img.to_rgba8();
        PngEncoder::new(&mut out)
            .write_image(&rgba, rgba.width(), rgba.height(), ColorType::Rgba8.into())
            .ok()?;
    } else {
        let rgb = flatten(&img);
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .write_image(&rgb, rgb.width(), rgb.height(), ColorType::Rgb8.into())
            .ok()?;
    }
    Some(out)
}

impl ImageStore {
    pub fn new(tmdb_image_base: &str) -> Self {
        Self::build(None, tmdb_image_base)
    }

    pub fn with_root(root: PathBuf, tmdb_image_base: &str) -> Self {
        Self::build(Some(root), tmdb_image_base)
    }

    fn root(&self) -> &Path {
        self.root.as_deref().unwrap_or_else(|| data_dir())
    }

    fn build(root: Option<PathBuf>, tmdb_image_base: &str) -> Self {
        Self {
            root,
            tmdb_prefix: format!("{}/", tmdb_image_base.trim_end_matches('/')),
            http: reqwest::Client::builder()
                .timeout(DOWNLOAD_TIMEOUT)
                .redirect(reqwest::redirect::Policy::limited(21))
                .build()
                .expect("reqwest client"),
            net: Semaphore::new(NETWORK_SLOTS),
            cpu: Semaphore::new(1),
            keys: Mutex::default(),
        }
    }

    /// TMDB URLs of the `<size>/<file>` shape are fetched at `original` (rule 5).
    fn fetch_url(&self, url: &str) -> String {
        if let Some((_, file)) = url
            .strip_prefix(&self.tmdb_prefix)
            .and_then(|rest| rest.split_once('/'))
            .filter(|(size, file)| !size.is_empty() && !file.is_empty())
        {
            return format!("{}original/{file}", self.tmdb_prefix);
        }
        url.to_owned()
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        let parsed = reqwest::Url::parse(url).map_err(|_| "invalid url".to_owned())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("unsupported scheme".into());
        }
        let mut resp = self
            .http
            .get(parsed)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let mut body = vec![];
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if body.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
                return Err("response too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    /// Sidecar says this source was stored, and every file it implies is still there (rule 10).
    async fn cached(&self, t: &Target, key: &str) -> Option<String> {
        let raw = tokio::fs::read(t.sidecar(self.root())).await.ok()?;
        let meta: Sidecar = serde_json::from_slice(&raw).ok()?;
        if meta.url != key
            || !tokio::fs::try_exists(t.file(self.root(), Size::Full))
                .await
                .ok()?
        {
            return None;
        }
        let (thumb, medium) = widths(t);
        for (px, size) in [(thumb, Size::Thumb), (medium, Size::Medium)] {
            if px.is_some()
                && !tokio::fs::try_exists(t.file(self.root(), size))
                    .await
                    .ok()?
            {
                return None;
            }
        }
        Some(format!("{}?v={}", t.api_path(), meta.hash))
    }

    /// One store at a time per target: a second call waits, then finds the files or reruns.
    async fn serialized<T>(&self, t: &Target, run: impl Future<Output = T>) -> T {
        let key = format!("{}/{:?}", t.api_path(), t.variant);
        let lock = self
            .keys
            .lock()
            .expect("keys")
            .entry(key.clone())
            .or_default()
            .clone();
        let out = {
            let _held = lock.lock().await;
            run.await
        };
        let mut keys = self.keys.lock().expect("keys");
        if Arc::strong_count(&lock) == 2 {
            keys.remove(&key);
        }
        out
    }

    async fn store(&self, t: &Target, key: &str, bytes: Vec<u8>) -> Option<String> {
        let full = t.file(self.root(), Size::Full);
        tokio::fs::create_dir_all(full.parent()?).await.ok()?;
        let (thumb, medium) = widths(t);
        let targets: Vec<(u32, PathBuf)> = [(thumb, Size::Thumb), (medium, Size::Medium)]
            .into_iter()
            .filter_map(|(px, size)| Some((px?, t.file(self.root(), size))))
            .collect();
        // A failed resize then leaves the variant absent, not the previous image's.
        for (_, p) in &targets {
            let _ = tokio::fs::remove_file(p).await;
        }
        write_atomic(&full, &bytes).await.ok()?;
        let png = is_png(t);
        let bytes = Arc::new(bytes);
        let _cpu = self.cpu.acquire().await.ok()?;
        for (px, dest) in targets {
            let b = bytes.clone();
            let out = tokio::task::spawn_blocking(move || resized(&b, px, png))
                .await
                .ok()
                .flatten();
            match out {
                Some(out) => {
                    if let Err(e) = write_atomic(&dest, &out).await {
                        tracing::warn!("image variant not written: {e}");
                    }
                }
                None => tracing::warn!("image variant {px}px not made for {}", t.api_path()),
            }
        }
        let hash = hash8(&bytes);
        let sidecar = format!(
            r#"{{"url":{},"hash":"{hash}"}}"#,
            serde_json::to_string(key).ok()?
        );
        write_atomic(&t.sidecar(self.root()), sidecar.as_bytes())
            .await
            .ok()?;
        Some(format!("{}?v={hash}", t.api_path()))
    }

    async fn run(
        &self,
        t: &Target,
        key: &str,
        source: impl Future<Output = Result<Vec<u8>, String>>,
        shown: &str,
    ) -> Option<String> {
        if let Some(hit) = self.cached(t, key).await {
            return Some(hit);
        }
        let _slot = self.net.acquire().await.ok()?;
        let bytes = match source.await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("image {shown}: {e}");
                return None;
            }
        };
        if probe(&bytes).is_none() {
            tracing::warn!("image {shown}: not a decodable image");
            return None;
        }
        let stored = self.store(t, key, bytes).await;
        if stored.is_none() {
            tracing::warn!("image {shown}: could not be stored");
        }
        stored
    }
}

impl ImageSink for ImageStore {
    async fn download_and_store(&self, url: &str, t: &Target) -> Option<String> {
        let shown = redacted(url);
        self.serialized(
            t,
            self.run(t, url, self.download(&self.fetch_url(url)), &shown),
        )
        .await
    }

    async fn store_from_disk(&self, abs: &Path, t: &Target) -> Option<String> {
        let shown = abs.display().to_string();
        let mtime = match tokio::fs::metadata(abs).await.and_then(|m| m.modified()) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("image {shown}: {e}");
                return None;
            }
        };
        let ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs_f64()
            * 1000.0;
        let key = format!("file://{}@{ms}", abs.display());
        let read = async { tokio::fs::read(abs).await.map_err(|e| e.to_string()) };
        self.serialized(t, self.run(t, &key, read, &shown)).await
    }

    fn has_image(&self, t: &Target) -> bool {
        t.file(self.root(), Size::Full).is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::MediaKind;
    use axum::{
        Router,
        extract::{Path as AxPath, State},
        http::{StatusCode, header},
        response::{IntoResponse, Redirect},
        routing::get,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct Mock {
        files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        hits: Arc<AtomicUsize>,
        seen: Arc<Mutex<Vec<String>>>,
    }

    async fn serve_file(State(m): State<Mock>, uri: axum::http::Uri) -> impl IntoResponse {
        m.hits.fetch_add(1, Ordering::SeqCst);
        m.seen.lock().unwrap().push(uri.path().to_owned());
        let name = uri.path().rsplit('/').next().unwrap_or_default().to_owned();
        match m.files.lock().unwrap().get(&name) {
            Some(b) => ([(header::CONTENT_TYPE, "image/jpeg")], b.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn hop(AxPath(n): AxPath<u32>) -> Redirect {
        Redirect::temporary(&if n == 0 {
            "/f/poster.jpg".into()
        } else {
            format!("/hop/{}", n - 1)
        })
    }

    async fn big() -> Vec<u8> {
        vec![0; MAX_DOWNLOAD_BYTES + 1]
    }

    async fn mock() -> (Mock, String) {
        let m = Mock::default();
        let app = Router::new()
            .route("/hop/{n}", get(hop))
            .route("/big.jpg", get(big))
            .fallback(get(serve_file))
            .with_state(m.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async { axum::serve(l, app).await.unwrap() });
        (m, base)
    }

    fn temp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("fliks-img-{}", crate::config::random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn gradient(w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        })
    }

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![];
        JpegEncoder::new_with_quality(&mut out, 80)
            .encode_image(&gradient(w, h))
            .unwrap();
        out
    }

    fn png_rgba(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, _| {
            image::Rgba([255, 0, 0, if x < w / 2 { 0 } else { 255 }])
        });
        let mut out = vec![];
        PngEncoder::new(&mut out)
            .write_image(&img, w, h, ColorType::Rgba8.into())
            .unwrap();
        out
    }

    fn size_of(p: &Path) -> (u32, u32, Option<ImageFormat>) {
        let r = ImageReader::open(p).unwrap().with_guessed_format().unwrap();
        let f = r.format();
        let (w, h) = r.into_dimensions().unwrap();
        (w, h, f)
    }

    struct Fx {
        store: ImageStore,
        root: PathBuf,
        mock: Mock,
        base: String,
    }

    async fn fx() -> Fx {
        let (mock, base) = mock().await;
        let root = temp_root();
        let store = ImageStore::with_root(root.clone(), &format!("{base}/t/p"));
        Fx {
            store,
            root,
            mock,
            base,
        }
    }

    impl Fx {
        fn serve(&self, name: &str, bytes: Vec<u8>) -> String {
            self.mock.files.lock().unwrap().insert(name.into(), bytes);
            format!("{}/f/{name}", self.base)
        }

        fn hits(&self) -> usize {
            self.mock.hits.load(Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn downloads_and_resizes_on_a_cold_call() {
        let f = fx().await;
        let src = jpeg(1200, 1800);
        let url = f.serve("poster.jpg", src.clone());
        let t = Target::media(1, Variant::Poster);
        let got = f.store.download_and_store(&url, &t).await.unwrap();
        assert_eq!(got, format!("/api/images/media/1/poster?v={}", hash8(&src)));
        let dir = f.root.join("media/1");
        assert_eq!(std::fs::read(dir.join("poster.jpg")).unwrap(), src);
        assert_eq!(
            size_of(&dir.join("poster-thumb.jpg")),
            (185, 278, Some(ImageFormat::Jpeg))
        );
        assert_eq!(size_of(&dir.join("poster-medium.jpg")).0, 500);
        let side = std::fs::read_to_string(dir.join("poster.src.json")).unwrap();
        assert_eq!(
            side,
            format!(r#"{{"url":"{url}","hash":"{}"}}"#, hash8(&src))
        );
    }

    #[tokio::test]
    async fn skips_the_download_and_resize_on_a_repeat_call_with_the_same_url() {
        let f = fx().await;
        let url = f.serve("poster.jpg", jpeg(600, 900));
        let t = Target::media(1, Variant::Poster);
        let a = f.store.download_and_store(&url, &t).await;
        let b = f.store.download_and_store(&url, &t).await;
        assert_eq!((a.clone(), f.hits()), (b, 1));
        assert!(a.is_some());
    }

    #[tokio::test]
    async fn re_downloads_when_the_url_changes() {
        let f = fx().await;
        let a = f.serve("poster.jpg", jpeg(600, 900));
        let b = f.serve("other.jpg", jpeg(700, 900));
        let t = Target::media(1, Variant::Poster);
        let first = f.store.download_and_store(&a, &t).await;
        let second = f.store.download_and_store(&b, &t).await;
        assert_ne!(first, second);
        assert_eq!(f.hits(), 2);
    }

    #[tokio::test]
    async fn re_downloads_when_a_sized_variant_is_missing_on_disk() {
        let f = fx().await;
        let url = f.serve("poster.jpg", jpeg(600, 900));
        let t = Target::media(1, Variant::Poster);
        f.store.download_and_store(&url, &t).await.unwrap();
        std::fs::remove_file(f.root.join("media/1/poster-medium.jpg")).unwrap();
        f.store.download_and_store(&url, &t).await.unwrap();
        assert_eq!(f.hits(), 2);
        assert!(f.root.join("media/1/poster-medium.jpg").exists());
    }

    #[tokio::test]
    async fn returns_null_when_the_downloaded_bytes_are_not_a_decodable_image() {
        let f = fx().await;
        let url = f.serve("poster.jpg", b"<html>nope</html>".to_vec());
        let t = Target::media(1, Variant::Poster);
        assert_eq!(f.store.download_and_store(&url, &t).await, None);
        assert!(!f.root.join("media/1").exists());
        assert_eq!(
            f.store
                .download_and_store(&format!("{}/f/missing.jpg", f.base), &t)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn serializes_two_concurrent_calls_for_the_same_target() {
        let f = fx().await;
        let (a_bytes, b_bytes) = (jpeg(600, 900), jpeg(640, 960));
        let a = f.serve("a.jpg", a_bytes);
        let b = f.serve("b.jpg", b_bytes);
        let t = Target::media(1, Variant::Poster);
        let (ra, rb) = tokio::join!(
            f.store.download_and_store(&a, &t),
            f.store.download_and_store(&b, &t)
        );
        assert!(ra.is_some() && rb.is_some());
        let full = std::fs::read(f.root.join("media/1/poster.jpg")).unwrap();
        let side: Sidecar =
            serde_json::from_slice(&std::fs::read(f.root.join("media/1/poster.src.json")).unwrap())
                .unwrap();
        assert_eq!(side.hash, hash8(&full));
        assert!(side.url == a || side.url == b);
    }

    #[tokio::test]
    async fn an_in_flight_store_with_another_url_waits_then_stores_its_own() {
        let f = fx().await;
        let a = f.serve("a.jpg", jpeg(600, 900));
        let b_bytes = jpeg(640, 960);
        let b = f.serve("b.jpg", b_bytes.clone());
        let t = Target::media(1, Variant::Poster);
        let (_, rb) = tokio::join!(
            f.store.download_and_store(&a, &t),
            f.store.download_and_store(&b, &t)
        );
        assert_eq!(
            rb,
            Some(format!("/api/images/media/1/poster?v={}", hash8(&b_bytes)))
        );
    }

    #[tokio::test]
    async fn store_from_disk_writes_the_full_image_its_variants_and_the_sidecar() {
        let f = fx().await;
        let src = f.root.join("sibling.jpg");
        std::fs::write(&src, jpeg(900, 1350)).unwrap();
        let t = Target::season(4);
        let got = f.store.store_from_disk(&src, &t).await.unwrap();
        assert!(got.starts_with("/api/images/season/4?v="));
        assert_eq!(size_of(&f.root.join("seasons/4-thumb.jpg")).0, 185);
        assert!(
            f.root.join("seasons/4-medium.jpg").exists()
                && f.root.join("seasons/4.src.json").exists()
        );
        let side: Sidecar =
            serde_json::from_slice(&std::fs::read(f.root.join("seasons/4.src.json")).unwrap())
                .unwrap();
        assert!(side.url.starts_with(&format!("file://{}@", src.display())));
        // the source is never written to
        assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn store_from_disk_is_a_cache_hit_on_a_second_call_with_an_unchanged_file() {
        let f = fx().await;
        let src = f.root.join("sibling.jpg");
        std::fs::write(&src, jpeg(900, 1350)).unwrap();
        let t = Target::season(4);
        let a = f.store.store_from_disk(&src, &t).await.unwrap();
        std::fs::remove_file(f.root.join("seasons/4.jpg")).unwrap();
        // the full file is gone, so this would be a miss: re-store, then hit
        let b = f.store.store_from_disk(&src, &t).await.unwrap();
        let before = std::fs::metadata(f.root.join("seasons/4.jpg"))
            .unwrap()
            .modified()
            .unwrap();
        let c = f.store.store_from_disk(&src, &t).await.unwrap();
        assert_eq!((a, b.clone()), (b, c));
        assert_eq!(
            std::fs::metadata(f.root.join("seasons/4.jpg"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn store_from_disk_returns_null_for_a_path_that_cannot_be_read_or_decoded() {
        let f = fx().await;
        let t = Target::season(4);
        assert_eq!(
            f.store.store_from_disk(&f.root.join("nope.jpg"), &t).await,
            None
        );
        let junk = f.root.join("junk.jpg");
        std::fs::write(&junk, b"not an image").unwrap();
        assert_eq!(f.store.store_from_disk(&junk, &t).await, None);
    }

    #[tokio::test]
    async fn the_size_table_follows_the_key() {
        let f = fx().await;
        let url = f.serve("x.jpg", jpeg(900, 900));
        let cases: [(Target, &str, Option<u32>, Option<u32>); 8] = [
            (
                Target::media(1, Variant::Fanart),
                "media/1/fanart",
                Some(300),
                Some(780),
            ),
            (
                Target::media(1, Variant::FanartN(3)),
                "media/1/fanart-3",
                Some(300),
                Some(780),
            ),
            (
                Target::request(MediaKind::Movie, 603, Variant::Poster),
                "requests/movie-603/poster",
                Some(185),
                Some(500),
            ),
            (Target::person(5), "persons/5", Some(45), None),
            (Target::episode(6), "episodes/6", Some(300), Some(780)),
            (Target::season(7), "seasons/7", Some(185), Some(500)),
            (
                Target::request(MediaKind::Series, 9, Variant::Logo),
                "requests/series-9/logo",
                None,
                None,
            ),
            (Target::livetv(8), "livetv/8", None, None),
        ];
        for (t, stem, thumb, medium) in cases {
            f.store.download_and_store(&url, &t).await.unwrap();
            let ext = if t.kind == Kind::Livetv { "png" } else { "jpg" };
            let width = |s: &str| {
                let p = f.root.join(format!("{stem}{s}.{ext}"));
                p.exists().then(|| size_of(&p).0)
            };
            assert_eq!(
                (width("-thumb"), width("-medium")),
                (thumb, medium),
                "{stem}"
            );
        }
    }

    #[tokio::test]
    async fn logos_are_png_and_everything_else_jpeg_without_enlargement() {
        let f = fx().await;
        let url = f.serve("logo.png", png_rgba(120, 60));
        let t = Target::media(2, Variant::Logo);
        f.store.download_and_store(&url, &t).await.unwrap();
        let dir = f.root.join("media/2");
        assert_eq!(
            size_of(&dir.join("logo.png")),
            (120, 60, Some(ImageFormat::Png))
        );
        // narrower than both targets: re-encoded at its own size
        assert_eq!(
            size_of(&dir.join("logo-thumb.png")),
            (120, 60, Some(ImageFormat::Png))
        );
        let img = ImageReader::open(dir.join("logo-medium.png"))
            .unwrap()
            .decode()
            .unwrap()
            .to_rgba8();
        assert_eq!(img.get_pixel(100, 0)[3], 255);
        let poster = f.serve("p.png", png_rgba(400, 200));
        f.store
            .download_and_store(&poster, &Target::media(2, Variant::Poster))
            .await
            .unwrap();
        // a PNG source is stored unchanged under the .jpg name, its variants are JPEG with alpha on black
        assert_eq!(size_of(&dir.join("poster.jpg")).2, Some(ImageFormat::Png));
        assert_eq!(
            size_of(&dir.join("poster-thumb.jpg")),
            (185, 93, Some(ImageFormat::Jpeg))
        );
        let flat = ImageReader::open(dir.join("poster-thumb.jpg"))
            .unwrap()
            .decode()
            .unwrap()
            .to_rgb8();
        assert!(flat.get_pixel(5, 5)[0] < 20, "transparent area is black");
    }

    #[tokio::test]
    async fn webp_and_gif_sources_are_accepted_and_svg_is_not() {
        let f = fx().await;
        let mut webp = vec![];
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .write_image(&gradient(300, 300), 300, 300, ColorType::Rgb8.into())
            .unwrap();
        let mut gif = vec![];
        image::codecs::gif::GifEncoder::new(&mut gif)
            .encode(&gradient(40, 40), 40, 40, ColorType::Rgb8.into())
            .unwrap();
        for (id, name, bytes) in [(1, "w.webp", webp), (2, "g.gif", gif)] {
            let url = f.serve(name, bytes);
            assert!(
                f.store
                    .download_and_store(&url, &Target::person(id))
                    .await
                    .is_some(),
                "{name}"
            );
        }
        let svg = f.serve(
            "s.svg",
            br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.to_vec(),
        );
        assert_eq!(
            f.store.download_and_store(&svg, &Target::person(3)).await,
            None
        );
    }

    #[tokio::test]
    async fn tmdb_urls_are_fetched_at_original_and_other_hosts_untouched() {
        let f = fx().await;
        f.serve("abc.jpg", jpeg(600, 900));
        let t = Target::media(1, Variant::Poster);
        let url = format!("{}/t/p/w500/abc.jpg", f.base);
        let got = f.store.download_and_store(&url, &t).await.unwrap();
        assert!(got.contains("?v="));
        assert_eq!(
            f.mock.seen.lock().unwrap().as_slice(),
            ["/t/p/original/abc.jpg"]
        );
        let other = format!("{}/other/w500/abc.jpg", f.base);
        f.store
            .download_and_store(&other, &Target::media(3, Variant::Poster))
            .await
            .unwrap();
        assert_eq!(
            f.mock.seen.lock().unwrap().last().unwrap(),
            "/other/w500/abc.jpg"
        );
        // the cache key is the URL as passed in
        let side: Sidecar =
            serde_json::from_slice(&std::fs::read(f.root.join("media/1/poster.src.json")).unwrap())
                .unwrap();
        assert_eq!(side.url, url);
        assert_eq!(
            f.store.fetch_url(&format!("{}/t/p/w500", f.base)),
            format!("{}/t/p/w500", f.base)
        );
    }

    #[tokio::test]
    async fn the_download_is_capped_and_redirects_are_limited() {
        let f = fx().await;
        let t = Target::media(1, Variant::Poster);
        assert_eq!(
            f.store
                .download_and_store(&format!("{}/big.jpg", f.base), &t)
                .await,
            None
        );
        f.serve("poster.jpg", jpeg(300, 450));
        assert!(
            f.store
                .download_and_store(&format!("{}/hop/5", f.base), &t)
                .await
                .is_some()
        );
        assert!(
            f.store
                .download_and_store(
                    &format!("{}/hop/20", f.base),
                    &Target::media(2, Variant::Poster)
                )
                .await
                .is_some()
        );
        assert_eq!(
            f.store
                .download_and_store(
                    &format!("{}/hop/21", f.base),
                    &Target::media(3, Variant::Poster)
                )
                .await,
            None
        );
        assert!(
            f.store
                .download_and_store("ftp://example.invalid/x.jpg", &t)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_failed_resize_leaves_no_stale_variant() {
        let f = fx().await;
        let t = Target::media(1, Variant::Poster);
        let url = f.serve("poster.jpg", jpeg(600, 900));
        f.store.download_and_store(&url, &t).await.unwrap();
        // 20000x20000 header: probes fine, every resize hits the pixel limit
        let mut huge = jpeg(8, 8);
        let sof = huge.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        huge[sof + 5..sof + 9].copy_from_slice(&[0x4E, 0x20, 0x4E, 0x20]);
        let url2 = f.serve("huge.jpg", huge);
        assert!(f.store.download_and_store(&url2, &t).await.is_some());
        let dir = f.root.join("media/1");
        assert!(dir.join("poster.jpg").exists());
        assert!(!dir.join("poster-thumb.jpg").exists() && !dir.join("poster-medium.jpg").exists());
    }

    #[tokio::test]
    async fn has_image_checks_the_full_file() {
        let f = fx().await;
        let t = Target::request(MediaKind::Movie, 603, Variant::Poster);
        assert!(!f.store.has_image(&t));
        let url = f.serve("poster.jpg", jpeg(300, 450));
        f.store.download_and_store(&url, &t).await.unwrap();
        assert!(f.store.has_image(&t));
    }

    #[test]
    fn log_urls_carry_no_userinfo_or_query() {
        assert_eq!(
            redacted("https://u:p@host/x/y.png?token=s3cret"),
            "https://host/x/y.png"
        );
        assert_eq!(redacted("not a url"), "<invalid url>");
    }
}
