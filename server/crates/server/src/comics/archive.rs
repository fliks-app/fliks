//! Comic archives read in memory, never extracted (`docs/spec/comics.md`, archive rules). The format
//! is sniffed from the magic bytes, so a `.cbr` that is a zip reads as one. Zip goes through `zip`,
//! 7z and RAR through libarchive (`ar.rs`), read-only: no call that touches the filesystem is made.
use std::{
    cell::Cell,
    cmp::Ordering,
    fs::File,
    io::{self, BufReader, Cursor, Read},
    path::Path,
};
use zip::ZipArchive;

/// Entries an archive may list.
pub const MAX_ENTRIES: usize = 20_000;
/// Pages an archive may serve.
pub const MAX_PAGES: usize = 5_000;
/// Uncompressed bytes of one entry.
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Uncompressed bytes one operation may produce, solid blocks included.
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Uncompressed over compressed bytes, with a 1 MiB floor.
pub const MAX_RATIO: u64 = 100;
const RATIO_FLOOR: u64 = 1024 * 1024;
/// How much of a page is read for its dimensions.
const HEADER_BYTES: u64 = 256 * 1024;
/// Bytes the dimension probe of a zip may read in all; pages past it list as `0 x 0`.
const DIMS_BUDGET: u64 = 64 * 1024 * 1024;
/// Decoded pages of one solid archive the page cache may hold.
pub const SOLID_CACHE_BYTES: u64 = 256 * 1024 * 1024;
/// Uncompressed bytes of a `ComicInfo.xml`.
pub const MAX_INFO_BYTES: u64 = 1024 * 1024;
/// Bytes a solid archive may decode while looking for its `ComicInfo.xml`.
const INFO_SCAN_BYTES: u64 = 256 * 1024 * 1024;
const PAGE_EXTS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// An encrypted archive or a PDF: no page can be read.
    Unsupported(&'static str),
    Corrupt,
    TooLarge,
    NoPages,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Zip,
    /// 7z and RAR, read by libarchive.
    Lib,
}

fn sniff(path: &Path) -> Result<Kind, Error> {
    let mut head = [0u8; 8];
    let n = File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|_| Error::Missing)?;
    let head = &head[..n];
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        Ok(Kind::Zip)
    } else if head.starts_with(b"7z\xBC\xAF\x27\x1C") || head.starts_with(b"Rar!\x1A\x07") {
        Ok(Kind::Lib)
    } else if head.starts_with(b"%PDF") {
        Err(Error::Unsupported("pdf"))
    } else {
        Err(Error::Corrupt)
    }
}

/// A page name: relative, no `..`, no hidden or `__MACOSX` segment, a decodable image extension.
/// Backslashes count as separators; the name is only ever a key, nothing is opened by it.
fn page_name(raw: &str) -> Option<String> {
    let name = raw.replace('\\', "/");
    if name.contains('\0') || name.starts_with('/') || name.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    let segs: Vec<&str> = name.split('/').collect();
    let bad = segs.iter().enumerate().any(|(i, s)| {
        (s.is_empty() && i + 1 != segs.len())
            || *s == "."
            || *s == ".."
            || s.starts_with('.')
            || *s == "__MACOSX"
    });
    let file = segs.last()?;
    let ext = file.rsplit_once('.')?.1.to_ascii_lowercase();
    (!bad && !file.is_empty() && PAGE_EXTS.contains(&ext.as_str())).then_some(name)
}

/// The archive-root `ComicInfo.xml`, any case; the name is only a key.
fn info_name(raw: &str) -> Option<String> {
    let name = raw.replace('\\', "/");
    name.eq_ignore_ascii_case("ComicInfo.xml").then_some(name)
}

/// Digit runs compare as numbers (`2` before `10`), case ignored.
fn natural(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    while let (Some(&x), Some(&y)) = (a.first(), b.first()) {
        if x.is_ascii_digit() && y.is_ascii_digit() {
            let (da, db) = (digits(a), digits(b));
            let (ta, tb) = (zeros(da), zeros(db));
            let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
            if o != Ordering::Equal {
                return o;
            }
            (a, b) = (&a[da.len()..], &b[db.len()..]);
        } else {
            let o = x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase());
            if o != Ordering::Equal {
                return o;
            }
            (a, b) = (&a[1..], &b[1..]);
        }
    }
    a.len().cmp(&b.len())
}

fn digits(s: &[u8]) -> &[u8] {
    &s[..s
        .iter()
        .position(|c| !c.is_ascii_digit())
        .unwrap_or(s.len())]
}

fn zeros(s: &[u8]) -> &[u8] {
    &s[s.iter().position(|b| *b != b'0').unwrap_or(s.len())..]
}

/// Reads at most `limit` bytes of `r` through the operation's byte budget. Past `limit` it is
/// `TooLarge` unless `truncate`, which keeps the first `limit` bytes.
fn read_limited(
    r: impl Read,
    limit: u64,
    truncate: bool,
    budget: &Cell<u64>,
) -> Result<Vec<u8>, Error> {
    let mut out = vec![];
    let counted = Counted { inner: r, budget };
    match counted.take(limit + 1).read_to_end(&mut out) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::FileTooLarge => return Err(Error::TooLarge),
        Err(_) => return Err(Error::Corrupt),
    }
    if out.len() as u64 > limit {
        if !truncate {
            return Err(Error::TooLarge);
        }
        out.truncate(limit as usize);
    }
    Ok(out)
}

struct Counted<'a, R> {
    inner: R,
    budget: &'a Cell<u64>,
}

impl<R: Read> Read for Counted<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let left = self.budget.get();
        if n as u64 > left {
            self.budget.set(0);
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "decompression budget exceeded",
            ));
        }
        self.budget.set(left - n as u64);
        Ok(n)
    }
}

/// `(width, height)` of an image from its first bytes; `(0, 0)` when they say nothing.
pub fn dimensions(bytes: &[u8]) -> (u32, u32) {
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

type ZipFile = ZipArchive<BufReader<File>>;

fn open_zip(path: &Path) -> Result<ZipFile, Error> {
    let f = File::open(path).map_err(|_| Error::Missing)?;
    ZipArchive::new(BufReader::new(f)).map_err(|_| Error::Corrupt)
}

/// The pages of a zip as `(entry index, name)` in reading order.
fn zip_names(z: &mut ZipFile) -> Result<Vec<(usize, String)>, Error> {
    if z.len() > MAX_ENTRIES {
        return Err(Error::TooLarge);
    }
    let mut out = vec![];
    for i in 0..z.len() {
        let f = z.by_index_raw(i).map_err(|_| Error::Corrupt)?;
        let kind = f.unix_mode().map_or(0o100000, |m| m & 0o170000);
        if f.is_dir() || kind != 0o100000 {
            continue;
        }
        if let Some(n) = f.name().ok().and_then(|n| page_name(&n)) {
            out.push((i, n));
        }
    }
    sorted(out)
}

fn sorted<T>(mut v: Vec<(T, String)>) -> Result<Vec<(T, String)>, Error> {
    if v.len() > MAX_PAGES {
        return Err(Error::TooLarge);
    }
    v.sort_by(|a, b| natural(&a.1, &b.1));
    Ok(v)
}

fn zip_read(
    z: &mut ZipFile,
    i: usize,
    head: bool,
    budget: &Cell<u64>,
    max: u64,
) -> Result<Vec<u8>, Error> {
    let f = z.by_index(i).map_err(|e| match e {
        zip::result::ZipError::UnsupportedArchive(m)
            if m == zip::result::ZipError::PASSWORD_REQUIRED =>
        {
            Error::Unsupported("encrypted")
        }
        zip::result::ZipError::UnsupportedArchive(_) => Error::Unsupported("zip method"),
        _ => Error::Corrupt,
    })?;
    let cap = max.min(
        f.compressed_size()
            .saturating_mul(MAX_RATIO)
            .max(RATIO_FLOOR),
    );
    read_limited(
        f,
        if head { cap.min(HEADER_BYTES) } else { cap },
        head,
        budget,
    )
}

/// What one pass over an archive learns: the pages in reading order, for a solid format the
/// archive position of each (`ordinals`) and, when the pages fit `SOLID_CACHE_BYTES`, the pages
/// themselves.
pub struct Listing {
    pub pages: Vec<Page>,
    pub ordinals: Option<Vec<usize>>,
    pub solid: Option<Vec<Vec<u8>>>,
}

/// Whether reading one page decodes what precedes it (7z, RAR).
pub fn is_solid(path: &Path) -> Result<bool, Error> {
    Ok(sniff(path)? == Kind::Lib)
}

/// The libarchive reads, in process. In production they run in a child process (`sandbox.rs`).
#[cfg(all(target_os = "linux", feature = "libarchive"))]
pub(super) mod local {
    use super::*;
    use crate::comics::ar::{Fail, Reader, Src};

    fn map(f: Fail) -> Error {
        match f {
            Fail::Corrupt => Error::Corrupt,
            Fail::TooLarge => Error::TooLarge,
        }
    }

    /// One pass over the entries in archive order: `on(ordinal, name, size, reader)` runs for each
    /// page and returns `false` to stop; at most `budget` bytes are decoded, and never more than
    /// the ratio allows over the file (an entry can declare 0 and still decode). Every entry is
    /// read to its end through the budget: `Reader` never lets libarchive skip.
    pub(in crate::comics) fn each(
        src: &Src<'_>,
        budget: u64,
        name_of: fn(&str) -> Option<String>,
        mut on: impl FnMut(usize, String, u64, &mut Reader) -> Result<bool, Error>,
    ) -> Result<(), Error> {
        let len = src.len();
        let budget = budget.min(len.saturating_mul(MAX_RATIO).max(RATIO_FLOOR));
        let mut r = Reader::open(src, budget).map_err(map)?;
        let (mut entries, mut declared) = (0usize, 0u64);
        while let Some(h) = r.next().map_err(map)? {
            entries += 1;
            declared = declared.saturating_add(h.size);
            if entries > MAX_ENTRIES
                || declared > MAX_TOTAL_BYTES
                || declared > len.saturating_mul(MAX_RATIO).max(RATIO_FLOOR)
            {
                return Err(Error::TooLarge);
            }
            if h.dir && h.size == 0 {
                continue;
            }
            let name = (h.regular && !h.hardlink)
                .then(|| h.name.as_deref().and_then(name_of))
                .flatten();
            let Some(name) = name else {
                r.drain().map_err(map)?;
                continue;
            };
            if h.encrypted {
                return Err(Error::Unsupported("encrypted"));
            }
            if h.size > MAX_ENTRY_BYTES {
                return Err(Error::TooLarge);
            }
            if !on(entries - 1, name, h.size, &mut r)? {
                return Ok(());
            }
            r.drain().map_err(map)?;
        }
        Ok(())
    }

    /// The current entry's bytes (`size` is its declared size, already under the entry cap), sized
    /// to fit: `TooLarge` past the entry cap.
    fn take(r: &mut Reader, size: u64, cap: u64) -> Result<Vec<u8>, Error> {
        let mut out = Vec::with_capacity(size as usize);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = r.read(&mut buf).map_err(map)?;
            if n == 0 {
                out.shrink_to_fit();
                return Ok(out);
            }
            out.extend_from_slice(&buf[..n]);
            if out.len() as u64 > cap {
                return Err(Error::TooLarge);
            }
        }
    }

    pub fn list(src: &Src<'_>) -> Result<Listing, Error> {
        let mut found: Vec<(String, usize, Page, Option<Vec<u8>>)> = vec![];
        let mut kept = 0u64;
        each(src, MAX_TOTAL_BYTES, page_name, |ord, name, size, r| {
            let bytes = take(r, size, MAX_ENTRY_BYTES)?;
            let (width, height) = dimensions(&bytes[..bytes.len().min(HEADER_BYTES as usize)]);
            let keep = kept + bytes.capacity() as u64 <= SOLID_CACHE_BYTES;
            if keep {
                kept += bytes.capacity() as u64;
            }
            found.push((name, ord, Page { width, height }, keep.then_some(bytes)));
            Ok(true)
        })?;
        found.sort_by(|a, b| natural(&a.0, &b.0));
        if found.len() > MAX_PAGES {
            return Err(Error::TooLarge);
        }
        let solid = found
            .iter()
            .all(|f| f.3.is_some())
            .then(|| found.iter_mut().filter_map(|f| f.3.take()).collect());
        Ok(Listing {
            ordinals: Some(found.iter().map(|f| f.1).collect()),
            pages: found.into_iter().map(|f| f.2).collect(),
            solid,
        })
    }

    /// `(ordinal, name)` of every page in reading order.
    pub fn names(src: &Src<'_>) -> Result<Vec<(usize, String)>, Error> {
        let mut out = vec![];
        each(src, MAX_TOTAL_BYTES, page_name, |o, n, _, _| {
            out.push((o, n));
            Ok(true)
        })?;
        sorted(out)
    }

    /// The page at archive position `ordinal`: one pass.
    pub fn page_at(src: &Src<'_>, ordinal: usize) -> Result<Vec<u8>, Error> {
        let mut found = None;
        each(src, MAX_TOTAL_BYTES, page_name, |o, _, size, r| {
            if o != ordinal {
                return Ok(true);
            }
            found = Some(take(r, size, MAX_ENTRY_BYTES)?);
            Ok(false)
        })?;
        found.ok_or(Error::Missing)
    }

    /// The archive-root `ComicInfo.xml`, `None` when there is none: one pass.
    pub fn info(src: &Src<'_>) -> Result<Option<Vec<u8>>, Error> {
        let mut found = None;
        each(src, INFO_SCAN_BYTES, info_name, |_, _, size, r| {
            if size > MAX_INFO_BYTES {
                return Err(Error::TooLarge);
            }
            found = Some(take(r, size, MAX_INFO_BYTES)?);
            Ok(false)
        })?;
        Ok(found)
    }

    /// Page `index` alone: a pass for the order, then one for the page.
    pub fn page(src: &Src<'_>, index: usize) -> Result<Vec<u8>, Error> {
        let at = names(src)?.get(index).ok_or(Error::Missing)?.0;
        page_at(src, at)
    }
}

/// 7z and RAR need libarchive, which only the Linux build with the `libarchive` feature links.
#[cfg(not(all(target_os = "linux", feature = "libarchive")))]
pub(super) mod local {
    use super::*;

    pub fn list(_: &Path) -> Result<Listing, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn names(_: &Path) -> Result<Vec<(usize, String)>, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn count(_: &Path) -> Result<usize, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn page_at(_: &Path, _: usize) -> Result<Vec<u8>, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn info(_: &Path) -> Result<Option<Vec<u8>>, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn page(_: &Path, _: usize) -> Result<Vec<u8>, Error> {
        Err(Error::Unsupported("libarchive"))
    }
}

/// 7z and RAR reads: in a child process in production, in process under the unit tests.
#[cfg(all(target_os = "linux", feature = "libarchive"))]
mod lib {
    use super::*;
    use crate::comics::{ar::Src, sandbox};

    pub fn list(path: &Path) -> Result<Listing, Error> {
        if sandbox::enabled() {
            sandbox::list(path)
        } else {
            local::list(&Src::Path(path))
        }
    }

    pub fn count(path: &Path) -> Result<usize, Error> {
        if sandbox::enabled() {
            sandbox::count(path)
        } else {
            local::names(&Src::Path(path)).map(|n| n.len())
        }
    }

    pub fn page_at(path: &Path, ordinal: usize) -> Result<Vec<u8>, Error> {
        if sandbox::enabled() {
            sandbox::page_at(path, ordinal)
        } else {
            local::page_at(&Src::Path(path), ordinal)
        }
    }

    pub fn info(path: &Path) -> Result<Option<Vec<u8>>, Error> {
        if sandbox::enabled() {
            sandbox::info(path)
        } else {
            local::info(&Src::Path(path))
        }
    }

    pub fn page(path: &Path, index: usize) -> Result<Vec<u8>, Error> {
        if sandbox::enabled() {
            sandbox::page(path, index)
        } else {
            local::page(&Src::Path(path), index)
        }
    }
}

#[cfg(not(all(target_os = "linux", feature = "libarchive")))]
use local as lib;

/// The pages in reading order with their dimensions (an unreadable header or a page past the
/// probe budget gives `0 x 0`, the page keeps its index).
pub fn list(path: &Path) -> Result<Listing, Error> {
    let listing = match sniff(path)? {
        Kind::Zip => {
            let mut z = open_zip(path)?;
            let budget = Cell::new(MAX_TOTAL_BYTES);
            let mut left = DIMS_BUDGET;
            let mut pages = vec![];
            for (i, _) in zip_names(&mut z)? {
                let (width, height) = if left == 0 {
                    (0, 0)
                } else {
                    match zip_read(&mut z, i, true, &budget, MAX_ENTRY_BYTES) {
                        Ok(b) => {
                            left = left.saturating_sub(b.len() as u64);
                            dimensions(&b)
                        }
                        Err(Error::TooLarge) if budget.get() == 0 => return Err(Error::TooLarge),
                        Err(_) => (0, 0),
                    }
                };
                pages.push(Page { width, height });
            }
            Listing {
                pages,
                ordinals: None,
                solid: None,
            }
        }
        Kind::Lib => lib::list(path)?,
    };
    if listing.pages.is_empty() {
        return Err(Error::NoPages);
    }
    Ok(listing)
}

pub fn pages(path: &Path) -> Result<Vec<Page>, Error> {
    list(path).map(|l| l.pages)
}

/// The number of pages, from the entry list alone (a solid archive is read through once).
pub fn page_count(path: &Path) -> Result<usize, Error> {
    let n = match sniff(path)? {
        Kind::Zip => zip_names(&mut open_zip(path)?)?.len(),
        Kind::Lib => lib::count(path)?,
    };
    if n == 0 { Err(Error::NoPages) } else { Ok(n) }
}

/// The page at archive position `ordinal` (from a `Listing`'s `ordinals`) of a solid archive.
pub fn page_at(path: &Path, ordinal: usize) -> Result<Vec<u8>, Error> {
    lib::page_at(path, ordinal)
}

/// The bytes of the archive-root `ComicInfo.xml` (at most `MAX_INFO_BYTES`), `None` when there is
/// none. A zip entry reads through the ratio cap and the operation budget like a page.
pub fn info(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match sniff(path)? {
        Kind::Zip => {
            let mut z = open_zip(path)?;
            if z.len() > MAX_ENTRIES {
                return Err(Error::TooLarge);
            }
            for i in 0..z.len() {
                let f = z.by_index_raw(i).map_err(|_| Error::Corrupt)?;
                let regular = f.unix_mode().map_or(0o100000, |m| m & 0o170000) == 0o100000;
                if f.is_dir() || !regular || !f.name().ok().is_some_and(|n| info_name(&n).is_some())
                {
                    continue;
                }
                drop(f);
                return zip_read(&mut z, i, false, &Cell::new(MAX_INFO_BYTES), MAX_INFO_BYTES)
                    .map(Some);
            }
            Ok(None)
        }
        Kind::Lib => lib::info(path),
    }
}

/// The original bytes of page `index` (0-based, reading order).
pub fn page(path: &Path, index: usize) -> Result<Vec<u8>, Error> {
    match sniff(path)? {
        Kind::Zip => {
            let mut z = open_zip(path)?;
            let names = zip_names(&mut z)?;
            let (i, _) = names.get(index).ok_or(Error::Missing)?;
            zip_read(
                &mut z,
                *i,
                false,
                &Cell::new(MAX_TOTAL_BYTES),
                MAX_ENTRY_BYTES,
            )
        }
        Kind::Lib => lib::page(path, index),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![];
        image::RgbImage::new(w, h)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    struct Tmp(std::path::PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("fliks-comics-{}-{tag}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> std::path::PathBuf {
            let p = self.0.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// `(name, bytes, symlink, deflate)`.
    fn zip(entries: &[(&str, Vec<u8>, bool, bool)]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(vec![]));
        for (n, b, link, deflate) in entries {
            let o = SimpleFileOptions::default().compression_method(if *deflate {
                CompressionMethod::Deflated
            } else {
                CompressionMethod::Stored
            });
            if *link {
                w.add_symlink(*n, String::from_utf8_lossy(b), o).unwrap();
            } else {
                w.start_file(*n, o).unwrap();
                w.write_all(b).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    fn plain(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        zip(&entries
            .iter()
            .map(|(n, b)| (*n, b.clone(), false, false))
            .collect::<Vec<_>>())
    }

    #[test]
    fn a_zip_comic_info_is_read_at_the_root_within_its_cap() {
        let t = Tmp::new("info");
        let xml = b"<ComicInfo><Series>A</Series></ComicInfo>".to_vec();
        let p = t.file(
            "a.cbz",
            &plain(&[("p1.png", png(1, 1)), ("ComicInfo.xml", xml.clone())]),
        );
        assert_eq!(info(&p), Ok(Some(xml.clone())));
        let p = t.file(
            "b.cbz",
            &plain(&[("p1.png", png(1, 1)), ("x/ComicInfo.xml", xml)]),
        );
        assert_eq!(info(&p), Ok(None));
        let big = vec![b' '; MAX_INFO_BYTES as usize + 1];
        let p = t.file("c.cbz", &plain(&[("ComicInfo.xml", big)]));
        assert_eq!(info(&p), Err(Error::TooLarge));
        let bomb = zip(&[("ComicInfo.xml", vec![b' '; 8 * 1024 * 1024], false, true)]);
        assert_eq!(info(&t.file("d.cbz", &bomb)), Err(Error::TooLarge));
    }

    #[test]
    fn pages_are_in_natural_order_with_their_sizes() {
        let t = Tmp::new("order");
        let p = t.file(
            "a.cbz",
            &plain(&[
                ("p10.png", png(10, 20)),
                ("p2.png", png(2, 4)),
                ("P1.PNG", png(1, 3)),
                ("notes.txt", b"x".to_vec()),
            ]),
        );
        let got: Vec<(u32, u32)> = pages(&p)
            .unwrap()
            .iter()
            .map(|p| (p.width, p.height))
            .collect();
        assert_eq!(got, [(1, 3), (2, 4), (10, 20)]);
        assert_eq!(page_count(&p), Ok(3));
        assert_eq!(page(&p, 1).unwrap(), png(2, 4));
        assert_eq!(page(&p, 3), Err(Error::Missing));
    }

    #[test]
    fn hostile_names_and_kinds_are_not_pages() {
        let t = Tmp::new("names");
        let p = t.file(
            "a.cbz",
            &zip(&[
                ("ok.png", png(1, 1), false, false),
                ("../evil.png", png(1, 1), false, false),
                ("a/../b.png", png(1, 1), false, false),
                ("/abs.png", png(1, 1), false, false),
                ("C:/drive.png", png(1, 1), false, false),
                (".hidden.png", png(1, 1), false, false),
                ("__MACOSX/._ok.png", png(1, 1), false, false),
                ("dir/.cache/x.png", png(1, 1), false, false),
                ("link.png", b"ok.png".to_vec(), true, false),
                ("nested.cbz", png(1, 1), false, false),
                ("win\\page2.png", png(1, 1), false, false),
            ]),
        );
        assert_eq!(page_count(&p), Ok(2));
        assert_eq!(page_name("a\\b.png").as_deref(), Some("a/b.png"));
        assert_eq!(page_name("a\0.png"), None);
    }

    #[test]
    fn a_bomb_is_refused_while_reading_not_from_the_declared_size() {
        let t = Tmp::new("bomb");
        let big = vec![0u8; (MAX_ENTRY_BYTES + 1) as usize];
        let p = t.file("a.cbz", &zip(&[("p1.png", big, false, true)]));
        assert_eq!(page(&p, 0), Err(Error::TooLarge));
        // a ratio over the cap is refused too, though under the per-entry cap
        let ratio = vec![0u8; (RATIO_FLOOR * 4) as usize];
        let p = t.file("b.cbz", &zip(&[("p1.png", ratio, false, true)]));
        assert_eq!(page(&p, 0), Err(Error::TooLarge));
        // pages stay listed: a refused header is a 0 x 0 page
        assert_eq!(pages(&p).unwrap().len(), 1);
    }

    #[test]
    fn too_many_entries_or_pages_are_refused() {
        let t = Tmp::new("many");
        let entries: Vec<(String, Vec<u8>, bool, bool)> = (0..MAX_PAGES + 1)
            .map(|i| (format!("{i}.png"), vec![1], false, false))
            .collect();
        let p = t.file(
            "a.cbz",
            &zip(&entries
                .iter()
                .map(|(n, b, m, d)| (n.as_str(), b.clone(), *m, *d))
                .collect::<Vec<_>>()),
        );
        assert_eq!(page_count(&p), Err(Error::TooLarge));
    }

    #[test]
    fn a_corrupt_entry_is_an_error_for_that_page_only() {
        let t = Tmp::new("corrupt");
        let mut bytes = plain(&[("p1.png", png(3, 3)), ("p2.png", vec![0xAB; 64])]);
        let at = bytes.windows(4).position(|w| w == [0xAB; 4]).unwrap();
        bytes[at] ^= 0xFF;
        let p = t.file("a.cbz", &bytes);
        let list = pages(&p).unwrap();
        assert_eq!((list[0].width, list[1].width), (3, 0));
        assert_eq!(page(&p, 0).unwrap(), png(3, 3));
    }

    #[test]
    fn garbage_and_unsupported_files_are_errors_never_panics() {
        let t = Tmp::new("garbage");
        assert_eq!(
            pages(&t.file("a.cbz", b"not an archive")),
            Err(Error::Corrupt)
        );
        assert_eq!(
            pages(&t.file("b.cbz", b"PK\x03\x04truncated")),
            Err(Error::Corrupt)
        );
        assert_eq!(
            pages(&t.file("c.pdf", b"%PDF-1.7")),
            Err(Error::Unsupported("pdf"))
        );
        assert!(pages(&t.file("d.cbr", b"Rar!\x1a\x07\x01\x00garbage")).is_err());
        assert!(pages(&t.file("e.cb7", b"7z\xBC\xAF\x27\x1C\x00\x04garbage")).is_err());
        assert_eq!(pages(&t.0.join("missing.cbz")), Err(Error::Missing));
        assert_eq!(
            pages(&t.file("f.cbz", &plain(&[("a.txt", b"x".to_vec())]))),
            Err(Error::NoPages)
        );
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["10.png", "2.png", "a/1.png", "01.png", "B.png", "a.png"];
        v.sort_by(|a, b| natural(a, b));
        assert_eq!(
            v,
            ["01.png", "2.png", "10.png", "a.png", "a/1.png", "B.png"]
        );
    }

    #[cfg(all(target_os = "linux", feature = "libarchive"))]
    mod seven {
        use super::*;
        use crate::comics::ar::Src;
        use libarchive2::{ArchiveFormat, EntryMut, FileType, WriteArchive};

        /// The writer converts names through the thread's locale, so it runs under UTF-8; the
        /// reader under test runs under the C locale.
        fn seven(path: &std::path::Path, files: &[(&str, &[u8])], link: Option<&str>) {
            // SAFETY: static NUL-terminated name; the thread's locale is restored and freed below.
            unsafe {
                let loc = libc::newlocale(
                    libc::LC_CTYPE_MASK,
                    c"C.UTF-8".as_ptr(),
                    std::ptr::null_mut(),
                );
                assert!(!loc.is_null(), "no C.UTF-8 locale");
                let prev = libc::uselocale(loc);
                write_seven(path, files, link);
                libc::uselocale(prev);
                libc::freelocale(loc);
            }
        }

        fn write_seven(path: &std::path::Path, files: &[(&str, &[u8])], link: Option<&str>) {
            let mut w = WriteArchive::new()
                .format(ArchiveFormat::SevenZip)
                .open_file(path)
                .unwrap();
            for (n, b) in files {
                w.add_file(n, b).unwrap();
            }
            if let Some(l) = link {
                let mut e = EntryMut::new();
                e.set_pathname(l).unwrap();
                e.set_file_type(FileType::SymbolicLink);
                e.set_symlink("p1.png").unwrap();
                e.set_size(0);
                w.write_header(&e).unwrap();
            }
            w.finish().unwrap();
        }

        #[test]
        fn a_7z_comic_info_is_read_at_the_root_only() {
            let t = Tmp::new("seveninfo");
            let p = t.0.join("a.cb7");
            seven(
                &p,
                &[("p1.png", &png(2, 2)), ("comicinfo.XML", b"<ComicInfo/>")],
                None,
            );
            assert_eq!(info(&p), Ok(Some(b"<ComicInfo/>".to_vec())));
            seven(
                &p,
                &[("p1.png", &png(2, 2)), ("sub/ComicInfo.xml", b"x")],
                None,
            );
            assert_eq!(info(&p), Ok(None));
            seven(&p, &[("ComicInfo.xml", &vec![b' '; 1024 * 1024 + 1])], None);
            assert_eq!(info(&p), Err(Error::TooLarge));
        }

        #[test]
        fn a_7z_reads_in_memory_and_skips_links() {
            let t = Tmp::new("seven");
            let p = t.0.join("a.cb7");
            let (a, b) = (png(4, 6), png(2, 2));
            seven(
                &p,
                &[
                    ("p2.png", &b),
                    ("p10.png", &b),
                    ("p1.png", &a),
                    ("../x.png", &b),
                ],
                Some("link.png"),
            );
            let list = pages(&p).unwrap();
            assert_eq!(list.iter().map(|p| p.width).collect::<Vec<_>>(), [4, 2, 2]);
            assert_eq!(page(&p, 0).unwrap(), a);
            assert_eq!(page(&p, 2).unwrap(), b);
            assert_eq!(page_count(&p), Ok(3));
        }

        fn crc32(data: &[u8]) -> u32 {
            let mut crc = !0u32;
            for b in data {
                crc ^= u32::from(*b);
                for _ in 0..8 {
                    crc = (crc >> 1) ^ (0xEDB8_8320 & 0u32.wrapping_sub(crc & 1));
                }
            }
            !crc
        }

        fn vint(mut n: u64) -> Vec<u8> {
            let mut out = vec![];
            loop {
                let b = (n & 0x7F) as u8;
                n >>= 7;
                out.push(if n == 0 { b } else { b | 0x80 });
                if n == 0 {
                    return out;
                }
            }
        }

        /// A RAR5 archive of stored files, built by hand: libarchive cannot write RAR.
        fn rar5(files: &[(&str, &[u8])]) -> Vec<u8> {
            let block = |body: Vec<u8>| {
                let mut h = vint(body.len() as u64);
                h.extend(body);
                let mut out = crc32(&h).to_le_bytes().to_vec();
                out.extend(h);
                out
            };
            let mut out = b"Rar!\x1A\x07\x01\x00".to_vec();
            out.extend(block([vint(1), vint(0), vint(0)].concat()));
            for (name, data) in files {
                if let Some(dir) = name.strip_suffix('/') {
                    // A directory entry: an empty data area, DIRECTORY file flag, no CRC.
                    let body = [
                        vint(2),
                        vint(0x0002),
                        vint(0),
                        vint(0x0001),
                        vint(0),
                        vint(0o040_755),
                        vint(0),
                        vint(1),
                        vint(dir.len() as u64),
                        dir.as_bytes().to_vec(),
                    ]
                    .concat();
                    out.extend(block(body));
                    continue;
                }
                let body = [
                    vint(2),
                    vint(0x0002),
                    vint(data.len() as u64),
                    vint(0x0004),
                    vint(data.len() as u64),
                    vint(0o100_644),
                    crc32(data).to_le_bytes().to_vec(),
                    vint(0),
                    vint(1),
                    vint(name.len() as u64),
                    name.as_bytes().to_vec(),
                ]
                .concat();
                out.extend(block(body));
                out.extend_from_slice(data);
            }
            out.extend(block([vint(5), vint(0), vint(0)].concat()));
            out
        }

        #[test]
        fn a_rar5_reads_in_memory() {
            let t = Tmp::new("rar");
            let (a, b) = (png(5, 7), png(3, 3));
            let p = t.file(
                "a.cbr",
                &rar5(&[("p2.png", &b), ("p1.png", &a), ("notes.txt", b"x")]),
            );
            assert_eq!(page_count(&p), Ok(2));
            assert_eq!(page(&p, 0).unwrap(), a);
            assert_eq!(
                pages(&p)
                    .unwrap()
                    .iter()
                    .map(|p| p.width)
                    .collect::<Vec<_>>(),
                [5, 3]
            );
        }

        #[test]
        fn a_rar5_with_a_directory_entry_reads() {
            let t = Tmp::new("rardir");
            let a = png(5, 7);
            let p = t.file("a.cbr", &rar5(&[("issue/", b""), ("issue/p1.png", &a)]));
            assert_eq!(page_count(&p), Ok(1));
            assert_eq!(page(&p, 0).unwrap(), a);
        }

        #[test]
        fn a_non_page_entry_counts_against_the_budget_too() {
            let t = Tmp::new("budget");
            let p = t.file(
                "a.cbr",
                &rar5(&[("big.bin", &vec![7u8; 1024 * 1024]), ("p1.png", &png(2, 2))]),
            );
            let mut seen = 0;
            let r = local::each(&Src::Path(&p), 100 * 1024, page_name, |_, _, _, _| {
                seen += 1;
                Ok(true)
            });
            assert_eq!((r, seen), (Err(Error::TooLarge), 0));
            assert_eq!(
                local::each(&Src::Path(&p), 2 * 1024 * 1024, page_name, |_, _, _, _| Ok(
                    true
                )),
                Ok(())
            );
        }

        #[test]
        fn non_ascii_names_read_under_the_c_locale() {
            let t = Tmp::new("locale");
            let p = t.0.join("a.cb7");
            let a = png(4, 6);
            seven(
                &p,
                &[("\u{e9}t\u{e9} 1.png", &a), ("\u{65e5}\u{672c}.png", &a)],
                None,
            );
            assert_eq!(page_count(&p), Ok(2));
            assert_eq!(page(&p, 0).unwrap(), a);
        }

        #[test]
        fn a_7z_bomb_is_refused_from_its_headers() {
            let t = Tmp::new("sevenbomb");
            let p = t.0.join("b.cb7");
            let big = vec![0u8; (RATIO_FLOOR * 8) as usize];
            seven(&p, &[("p1.png", &big)], None);
            assert_eq!(pages(&p), Err(Error::TooLarge));
        }
    }
}
