//! The package metadata and cover of an EPUB (`docs/spec/book-ingest.md` rule 11).
use fliks_domain::books::opf::{self, OpfMetadata};
use std::{fs::File, io::Read, path::Path};
use zip::ZipArchive;

/// The cap on `container.xml` and the OPF (`books-files.md` rule 4).
pub const OPF_CAP: u64 = 2 * 1024 * 1024;
const COVER_CAP: u64 = 16 * 1024 * 1024;

pub struct Epub {
    pub meta: OpfMetadata,
    pub cover: Option<Vec<u8>>,
}

pub enum EntryError {
    Missing,
    TooLarge,
}

/// An entry read through a cap, whatever size the archive declares.
pub fn read_entry<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    cap: u64,
) -> Result<Vec<u8>, EntryError> {
    let mut f = zip.by_name(name).map_err(|_| EntryError::Missing)?;
    let mut buf = vec![];
    f.by_ref()
        .take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|_| EntryError::Missing)?;
    if buf.len() as u64 > cap {
        return Err(EntryError::TooLarge);
    }
    Ok(buf)
}

fn entry<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    cap: u64,
) -> Option<Vec<u8>> {
    read_entry(zip, name, cap).ok()
}

/// The package path: `container.xml`'s rootfile, else the first `.opf` of the archive.
pub fn rootfile<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>) -> Option<String> {
    entry(zip, "META-INF/container.xml", OPF_CAP)
        .and_then(|c| opf::container_rootfile(&c))
        .or_else(|| {
            zip.file_names()
                .filter_map(Result::ok)
                .find(|n| n.to_lowercase().ends_with(".opf"))
                .map(|n| n.into_owned())
        })
}

fn image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"GIF8")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

pub fn read_epub_from<R: Read + std::io::Seek>(r: R) -> Option<Epub> {
    let mut zip = ZipArchive::new(r).ok()?;
    let rootfile = rootfile(&mut zip)?;
    let meta = opf::parse(&entry(&mut zip, &rootfile, OPF_CAP)?);
    let cover = meta
        .cover_href
        .as_deref()
        .map(|h| opf::resolve_href(&rootfile, h))
        .and_then(|n| entry(&mut zip, &n, COVER_CAP))
        .filter(|b| image(b));
    Some(Epub { meta, cover })
}

/// Blocking; `None` for a file that is no zip, has no OPF or cannot be read.
pub fn read_epub(path: &Path) -> Option<Epub> {
    read_epub_from(std::io::BufReader::new(File::open(path).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    fn zip(entries: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
        let mut w = ZipWriter::new(Cursor::new(vec![]));
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (n, b) in entries {
            w.start_file(*n, o).unwrap();
            w.write_all(b).unwrap();
        }
        let mut c = w.finish().unwrap();
        c.set_position(0);
        c
    }

    const CONTAINER: &[u8] = br#"<?xml version="1.0"?><container><rootfiles>
      <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nxxxx";

    #[test]
    fn epub2_reads_metadata_and_cover() {
        let opf = br#"<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
          <dc:title>Le Phare des Brumes</dc:title>
          <dc:creator opf:role="aut">Aldric Vexmoor</dc:creator>
          <dc:language>fr</dc:language><dc:identifier opf:scheme="ISBN">9791234567896</dc:identifier>
          <meta name="cover" content="cover-img"/></metadata>
          <manifest><item id="cover-img" href="images/cover.png" media-type="image/png"/></manifest></package>"#;
        let e = read_epub_from(zip(&[
            ("META-INF/container.xml", CONTAINER),
            ("OEBPS/content.opf", opf),
            ("OEBPS/images/cover.png", PNG),
        ]))
        .unwrap();
        assert_eq!(e.meta.title.as_deref(), Some("Le Phare des Brumes"));
        assert_eq!(e.meta.creators[0].name, "Aldric Vexmoor");
        assert_eq!(e.cover.as_deref(), Some(PNG));
    }

    #[test]
    fn epub3_without_container_falls_back_to_the_first_opf() {
        let opf = br##"<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title id="t">Mirelune</dc:title><meta refines="#t" property="title-type">main</meta></metadata>
          <manifest><item id="c" href="c.jpg" properties="cover-image" media-type="image/jpeg"/></manifest></package>"##;
        let e = read_epub_from(zip(&[("book.opf", opf), ("c.jpg", b"\xFF\xD8\xFFabc")])).unwrap();
        assert_eq!(e.meta.title.as_deref(), Some("Mirelune"));
        assert!(e.cover.is_some());
    }

    #[test]
    fn a_cover_that_is_not_an_image_is_dropped() {
        let opf = br#"<package><metadata><meta name="cover" content="c"/></metadata>
          <manifest><item id="c" href="c.png"/></manifest></package>"#;
        let e = read_epub_from(zip(&[("a.opf", opf), ("c.png", b"not an image")])).unwrap();
        assert!(e.cover.is_none());
    }

    #[test]
    fn an_opf_over_the_cap_is_no_metadata() {
        let big = vec![b' '; OPF_CAP as usize + 1];
        assert!(read_epub_from(zip(&[("a.opf", &big)])).is_none());
    }

    #[test]
    fn no_zip_and_no_opf_are_nothing() {
        assert!(read_epub_from(Cursor::new(b"plain text".to_vec())).is_none());
        assert!(read_epub_from(zip(&[("a.txt", b"x")])).is_none());
    }
}
