//! Comic archives read in memory, never extracted (`docs/spec/comics.md`, archive rules). The format
//! is sniffed from the magic bytes, so a `.cbr` that is a zip reads as one. Zip goes through `zip`,
//! 7z and RAR through libarchive, read-only: no call that touches the filesystem is made.
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

fn zip_read(z: &mut ZipFile, i: usize, head: bool, budget: &Cell<u64>) -> Result<Vec<u8>, Error> {
    let f = z.by_index(i).map_err(|e| match e {
        zip::result::ZipError::UnsupportedArchive(_) => Error::Unsupported("encrypted"),
        _ => Error::Corrupt,
    })?;
    let cap = MAX_ENTRY_BYTES.min(
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

#[cfg(target_os = "linux")]
mod lib {
    use super::*;
    use libarchive2::{FileType, ReadArchive};

    /// What a header says about an entry; `name` is set for a page that may be read.
    struct Header {
        name: Option<String>,
        size: u64,
        encrypted: bool,
    }

    /// Walks the entries of a 7z or RAR in archive order; `on(name, archive)` runs for each page and
    /// returns `false` to stop. Headers are bounded as a whole: libarchive decodes what a solid block
    /// skips, so the declared sizes are capped before any of it is asked for.
    fn lib_each(
        path: &Path,
        mut on: impl FnMut(String, &mut ReadArchive<'_>) -> Result<bool, Error>,
    ) -> Result<(), Error> {
        let len = std::fs::metadata(path).map_or(0, |m| m.len());
        let mut ar = ReadArchive::open(path).map_err(|_| Error::Corrupt)?;
        let (mut entries, mut declared) = (0usize, 0u64);
        loop {
            let h = match ar.next_entry() {
                Ok(Some(e)) => Header {
                    name: (e.file_type() == FileType::RegularFile && e.hardlink().is_none())
                        .then(|| e.pathname().and_then(|n| page_name(&n)))
                        .flatten(),
                    size: u64::try_from(e.size()).unwrap_or(0),
                    encrypted: e.is_encrypted(),
                },
                Ok(None) => return Ok(()),
                Err(_) => return Err(Error::Corrupt),
            };
            entries += 1;
            declared = declared.saturating_add(h.size);
            if entries > MAX_ENTRIES
                || declared > MAX_TOTAL_BYTES
                || declared > len.saturating_mul(MAX_RATIO).max(RATIO_FLOOR)
            {
                return Err(Error::TooLarge);
            }
            let Some(name) = h.name else { continue };
            if h.encrypted {
                return Err(Error::Unsupported("encrypted"));
            }
            if h.size > MAX_ENTRY_BYTES {
                return Err(Error::TooLarge);
            }
            if !on(name, &mut ar)? {
                return Ok(());
            }
        }
    }

    /// The current entry's first `limit` bytes through the budget; `truncate` as in `read_limited`.
    fn lib_read(
        ar: &mut ReadArchive<'_>,
        limit: u64,
        truncate: bool,
        budget: &Cell<u64>,
    ) -> Result<Vec<u8>, Error> {
        let mut out = vec![];
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = ar.read_data(&mut buf).map_err(|_| Error::Corrupt)?;
            if n == 0 {
                return Ok(out);
            }
            let left = budget.get();
            if n as u64 > left {
                return Err(Error::TooLarge);
            }
            budget.set(left - n as u64);
            let room = (limit + 1).saturating_sub(out.len() as u64) as usize;
            out.extend_from_slice(&buf[..n.min(room)]);
            if out.len() as u64 > limit {
                if !truncate {
                    return Err(Error::TooLarge);
                }
                out.truncate(limit as usize);
                return Ok(out);
            }
        }
    }

    fn lib_names(path: &Path) -> Result<Vec<String>, Error> {
        let mut out = vec![];
        lib_each(path, |n, _| {
            out.push(((), n));
            Ok(true)
        })?;
        Ok(sorted(out)?.into_iter().map(|p| p.1).collect())
    }

    pub fn pages(path: &Path) -> Result<Vec<Page>, Error> {
        let budget = Cell::new(MAX_TOTAL_BYTES);
        let mut found = vec![];
        lib_each(path, |n, ar| {
            let (width, height) = match lib_read(ar, HEADER_BYTES, true, &budget) {
                Ok(b) => dimensions(&b),
                Err(Error::TooLarge) if budget.get() == 0 => return Err(Error::TooLarge),
                Err(_) => (0, 0),
            };
            found.push((Page { width, height }, n));
            Ok(true)
        })?;
        Ok(sorted(found)?.into_iter().map(|p| p.0).collect())
    }

    pub fn names(path: &Path) -> Result<Vec<String>, Error> {
        lib_names(path)
    }

    pub fn page(path: &Path, index: usize) -> Result<Vec<u8>, Error> {
        let raw = lib_names(path)?.get(index).ok_or(Error::Missing)?.clone();
        let mut found = None;
        lib_each(path, |n, ar| {
            if n != raw {
                return Ok(true);
            }
            found = Some(lib_read(
                ar,
                MAX_ENTRY_BYTES,
                false,
                &Cell::new(MAX_TOTAL_BYTES),
            )?);
            Ok(false)
        })?;
        found.ok_or(Error::Corrupt)
    }
}

/// 7z and RAR need libarchive, which only the Linux build links.
#[cfg(not(target_os = "linux"))]
mod lib {
    use super::*;

    pub fn pages(_: &Path) -> Result<Vec<Page>, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn names(_: &Path) -> Result<Vec<String>, Error> {
        Err(Error::Unsupported("libarchive"))
    }

    pub fn page(_: &Path, _: usize) -> Result<Vec<u8>, Error> {
        Err(Error::Unsupported("libarchive"))
    }
}

/// The dimensions of every page, in reading order. An unreadable header gives `0 x 0`, the page keeps its index.
pub fn pages(path: &Path) -> Result<Vec<Page>, Error> {
    let pages = match sniff(path)? {
        Kind::Zip => {
            let mut z = open_zip(path)?;
            let budget = Cell::new(MAX_TOTAL_BYTES);
            let mut out = vec![];
            for (i, _) in zip_names(&mut z)? {
                let (width, height) = match zip_read(&mut z, i, true, &budget) {
                    Ok(b) => dimensions(&b),
                    Err(Error::TooLarge) if budget.get() == 0 => return Err(Error::TooLarge),
                    Err(_) => (0, 0),
                };
                out.push(Page { width, height });
            }
            out
        }
        Kind::Lib => lib::pages(path)?,
    };
    if pages.is_empty() {
        return Err(Error::NoPages);
    }
    Ok(pages)
}

/// The number of pages, from the entry list alone.
pub fn page_count(path: &Path) -> Result<usize, Error> {
    let n = match sniff(path)? {
        Kind::Zip => zip_names(&mut open_zip(path)?)?.len(),
        Kind::Lib => lib::names(path)?.len(),
    };
    if n == 0 { Err(Error::NoPages) } else { Ok(n) }
}

/// The original bytes of page `index` (0-based, reading order).
pub fn page(path: &Path, index: usize) -> Result<Vec<u8>, Error> {
    match sniff(path)? {
        Kind::Zip => {
            let mut z = open_zip(path)?;
            let names = zip_names(&mut z)?;
            let (i, _) = names.get(index).ok_or(Error::Missing)?;
            zip_read(&mut z, *i, false, &Cell::new(MAX_TOTAL_BYTES))
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

    #[cfg(target_os = "linux")]
    mod seven {
        use super::*;
        use libarchive2::{ArchiveFormat, EntryMut, FileType, WriteArchive};

        fn seven(path: &std::path::Path, files: &[(&str, &[u8])], link: Option<&str>) {
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
        fn a_7z_bomb_is_refused_from_its_headers() {
            let t = Tmp::new("sevenbomb");
            let p = t.0.join("b.cb7");
            let big = vec![0u8; (RATIO_FLOOR * 8) as usize];
            seven(&p, &[("p1.png", &big)], None);
            assert_eq!(pages(&p), Err(Error::TooLarge));
        }
    }
}
