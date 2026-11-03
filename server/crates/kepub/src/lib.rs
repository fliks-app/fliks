//! EPUB to KEPUB conversion: a pure-Rust port of the default transforms of kepubify
//! (https://github.com/pgaskin/kepubify, MIT).
mod content;
mod dom;
mod entities;
mod opf;

use dom::Node;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{self, Read, Seek, Write};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_entries: usize,
    /// Cap on one entry once decompressed, whatever the archive declares.
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    /// Cap on a document that is parsed in memory (package, content, container).
    pub max_document_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_entries: 20_000,
            max_entry_bytes: 512 << 20,
            max_total_bytes: 2 << 30,
            max_document_bytes: 8 << 20,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Zip(String),
    Io(String),
    /// No `container.xml` rootfile, or the package it names is missing or unreadable.
    NoPackage,
    TooLarge,
    TooManyEntries,
    Malformed(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Zip(e) => write!(f, "zip: {e}"),
            Error::Io(e) => write!(f, "io: {e}"),
            Error::NoPackage => f.write_str("no package document"),
            Error::TooLarge => f.write_str("archive exceeds the size limits"),
            Error::TooManyEntries => f.write_str("too many archive entries"),
            Error::Malformed(w) => write!(f, "malformed document: {w}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Zip(e.to_string())
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl From<dom::DomError> for Error {
    fn from(_: dom::DomError) -> Self {
        Error::Malformed("nesting or node count too large")
    }
}

/// A safe archive path: relative, no `..`, no backslash, no NUL.
fn safe_name(n: &str) -> bool {
    !n.is_empty()
        && !n.starts_with('/')
        && !n.contains(['\\', '\0'])
        && !n.split('/').any(|p| p == "..")
        && !n.as_bytes().get(1).is_some_and(|c| *c == b':')
}

/// Metadata and OS junk kepubify strips.
fn filtered(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    matches!(
        base,
        "calibre_bookmarks.txt" | "iTunesMetadata.plist" | "iTunesArtwork.plist"
    ) || base.eq_ignore_ascii_case(".ds_store")
        || base.eq_ignore_ascii_case("thumbs.db")
        || name.starts_with("__MACOSX/")
}

fn read_capped<R: Read>(r: R, cap: u64) -> Result<Vec<u8>, Error> {
    let mut buf = vec![];
    r.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(Error::TooLarge);
    }
    Ok(buf)
}

/// The entries that are kept: safe name, not a directory, not filtered, first of its name.
struct Index {
    exact: HashMap<String, usize>,
    lower: HashMap<String, usize>,
}

impl Index {
    fn find(&self, name: &str) -> Option<usize> {
        self.exact
            .get(name)
            .or_else(|| self.lower.get(&name.to_lowercase()))
            .copied()
    }
}

fn read_by_name<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    idx: &Index,
    name: &str,
    cap: u64,
) -> Result<Option<Vec<u8>>, Error> {
    match idx.find(name) {
        Some(i) => Ok(Some(read_capped(zip.by_index(i)?, cap)?)),
        None => Ok(None),
    }
}

/// What the second pass needs: the rewritten package, the dummy page, the documents to transform.
struct Plan {
    opf_i: usize,
    opf: Vec<u8>,
    dummy: Option<(String, &'static str)>,
    docs: HashSet<usize>,
}

fn plan<R: Read + Seek>(zip: &mut ZipArchive<R>, idx: &Index, lim: &Limits) -> Result<Plan, Error> {
    let container = read_by_name(zip, idx, "META-INF/container.xml", lim.max_document_bytes)?
        .ok_or(Error::NoPackage)?;
    let mut nodes = dom::parse(&content::decode(&container), false)?;
    let rootfile = nodes
        .iter_mut()
        .find_map(|n| match n {
            Node::Element(e) if e.local() == "container" => e.child("rootfiles").map(|r| {
                let files: Vec<_> = r
                    .children
                    .iter()
                    .filter_map(|c| match c {
                        Node::Element(f) if f.local() == "rootfile" => {
                            f.attr("full-path").map(|p| (p, f.attr("media-type")))
                        }
                        _ => None,
                    })
                    .collect();
                let pick = files
                    .iter()
                    .find(|(_, m)| *m == Some("application/oebps-package+xml"))
                    .or(files.first());
                pick.map(|(p, _)| p.to_string())
            }),
            _ => None,
        })
        .flatten()
        .ok_or(Error::NoPackage)?;
    let opf_path = opf::resolve("", &rootfile).ok_or(Error::NoPackage)?;
    let opf_i = idx.find(&opf_path).ok_or(Error::NoPackage)?;
    // Hrefs resolve against the entry's real name, which may differ in case from the container's.
    let opf_path = zip
        .name_for_index(opf_i)
        .ok_or(Error::NoPackage)??
        .into_owned();
    let raw = read_capped(zip.by_index(opf_i)?, lim.max_document_bytes)?;
    let mut nodes = dom::parse(&content::decode(&raw), false)?;
    let pkg = opf::root(&mut nodes).ok_or(Error::NoPackage)?;

    let docs = opf::content_docs(pkg, &opf_path)
        .iter()
        .filter_map(|d| idx.find(d))
        .collect();
    opf::transform(pkg);
    let mut dummy = None;
    if let Some(first) = opf::first_spine_doc(pkg, &opf_path) {
        let first = read_by_name(zip, idx, &first, lim.max_document_bytes)?;
        let needed = first
            .is_some_and(|b| content::parse_doc(&b).is_ok_and(|d| content::needs_titlepage(&d)));
        if needed {
            // The package was already transformed: add_titlepage works on the same tree.
            let pkg = opf::root(&mut nodes).ok_or(Error::NoPackage)?;
            let path = opf::resolve(&opf_path, opf::DUMMY_HREF).filter(|p| idx.find(p).is_none());
            dummy = path
                .filter(|_| opf::add_titlepage(pkg))
                .map(|p| (p, opf::DUMMY_BODY));
        }
    }
    let opf = dom::serialize(&nodes, false).into_bytes();
    Ok(Plan {
        opf_i,
        opf,
        dummy,
        docs,
    })
}

/// Converts the EPUB in `input` to a KEPUB written to `output`.
pub fn convert<R: Read + Seek, W: Write + Seek>(
    input: R,
    output: W,
    lim: &Limits,
) -> Result<(), Error> {
    let mut zip = ZipArchive::new(input)?;
    if zip.len() > lim.max_entries {
        return Err(Error::TooManyEntries);
    }
    let mut idx = Index {
        exact: HashMap::new(),
        lower: HashMap::new(),
    };
    let (mut declared, mut names) = (0u64, vec![String::new(); zip.len()]);
    for (i, name) in names.iter_mut().enumerate() {
        let f = zip.by_index_raw(i)?;
        let Ok(n) = f.name().map(|n| n.into_owned()) else {
            continue;
        };
        if f.is_dir() || !safe_name(&n) || n == "mimetype" || filtered(&n) {
            continue;
        }
        if idx.exact.contains_key(&n) {
            continue;
        }
        if f.size() > lim.max_entry_bytes {
            return Err(Error::TooLarge);
        }
        declared = declared.saturating_add(f.size());
        if declared > lim.max_total_bytes {
            return Err(Error::TooLarge);
        }
        idx.lower.entry(n.to_lowercase()).or_insert(i);
        idx.exact.insert(n.clone(), i);
        *name = n;
    }
    let plan = plan(&mut zip, &idx, lim)?;

    let mut out = ZipWriter::new(output);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    out.start_file("mimetype", stored)?;
    out.write_all(b"application/epub+zip")?;

    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (i, name) in names.iter().enumerate() {
        if name.is_empty() {
            continue;
        }
        if i == plan.opf_i {
            out.start_file(name, deflated)?;
            out.write_all(&plan.opf)?;
        } else if plan.docs.contains(&i) {
            let raw = read_capped(zip.by_index(i)?, lim.max_document_bytes)?;
            out.start_file(name, deflated)?;
            out.write_all(&content::transform(&raw)?)?;
        } else {
            out.raw_copy_file(zip.by_index_raw(i)?)?;
        }
    }
    if let Some((name, body)) = plan.dummy {
        out.start_file(name, deflated)?;
        out.write_all(body.as_bytes())?;
    }
    out.finish()?;
    Ok(())
}

/// In-memory convenience over [`convert`].
pub fn convert_bytes(epub: &[u8], lim: &Limits) -> Result<Vec<u8>, Error> {
    let mut out = io::Cursor::new(Vec::new());
    convert(io::Cursor::new(epub), &mut out, lim)?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests;
