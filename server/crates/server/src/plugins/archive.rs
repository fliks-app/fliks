//! `.fkplugin` reader: the archive guards of `plugins.md` rules 13-16 with yauzl 3.4's verdicts.
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use unicode_normalization::UnicodeNormalization;

pub const PREAMBLE: [u8; 8] = [0, b'a', b's', b'm', 0x0d, 0x00, 0x01, 0x00];
pub const MAX_ARCHIVE_BYTES: usize = 33 << 20;
pub const MAX_TOTAL_BYTES: u64 = 48 << 20;
pub const MAX_MANIFEST_BYTES: u64 = 256 << 10;
const MAX_ENTRIES: usize = 4;
const MAX_RATIO: f64 = 100.0;
const ENTRY_NAMES: [&str; 5] = [
    "plugin.json",
    "plugin.json.sig",
    "plugin.wasm",
    "logo.svg",
    "logo.png",
];
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// A refusal: `code` is the contract, `detail` log text.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
}

pub fn refuse(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        code,
        detail: detail.into(),
    }
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn max_bytes_for(name: &str) -> u64 {
    match name {
        "plugin.json" => MAX_MANIFEST_BYTES,
        "plugin.json.sig" => 256,
        "plugin.wasm" => 32 << 20,
        _ => 64 << 10,
    }
}

/// One central-directory entry as yauzl decodes it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    flags: u16,
    method: u16,
    compressed: u64,
    uncompressed: u64,
    external: u32,
    local_offset: u64,
    extra: Vec<(u16, Vec<u8>)>,
}

const CP437: &str = "\u{0}☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

fn decode(b: &[u8], utf8: bool) -> String {
    if utf8 {
        return String::from_utf8_lossy(b).into_owned();
    }
    let table: Vec<char> = CP437.chars().collect();
    b.iter().map(|x| table[*x as usize]).collect()
}

fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for x in b {
        c ^= *x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0xedb8_8320
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], i: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(i..i + 8)?.try_into().ok()?))
}

const EOF: &str = "unexpected EOF";

/// The opened central directory: `(entry count, comment, cd offset)`.
fn open(buf: &[u8]) -> Result<(usize, String, u64), String> {
    let size = buf.len();
    let window = (20 + 22 + 0xffff).min(size);
    let start = size - window;
    if window >= 22 {
        for i in (0..=window - 22).rev() {
            let at = start + i;
            if u32_at(buf, at) != Some(0x0605_4b50) {
                continue;
            }
            let disk = u16_at(buf, at + 4).ok_or(EOF)?;
            let mut count = u16_at(buf, at + 10).ok_or(EOF)? as u64;
            let mut cd = u32_at(buf, at + 16).ok_or(EOF)? as u64;
            let comment_len = u16_at(buf, at + 20).ok_or(EOF)? as usize;
            let expected = size - at - 22;
            if comment_len != expected {
                return Err(format!(
                    "Invalid comment length. Expected: {expected}. Found: {comment_len}."
                ));
            }
            let comment = decode(&buf[at + 22..], false);
            if i >= 20 && u32_at(buf, at - 20) == Some(0x0706_4b50) {
                let off = u64_at(buf, at - 12).ok_or(EOF)? as usize;
                let rec = buf.get(off..off + 56).ok_or(EOF)?;
                if u32_at(rec, 0) != Some(0x0606_4b50) {
                    return Err("invalid zip64 end of central directory record signature".into());
                }
                let disk = u32_at(rec, 16).ok_or(EOF)?;
                if disk != 0 {
                    return Err(format!(
                        "multi-disk zip files are not supported: found disk number: {disk}"
                    ));
                }
                count = u64_at(rec, 32).ok_or(EOF)?;
                cd = u64_at(rec, 48).ok_or(EOF)?;
                return Ok((count as usize, comment, cd));
            }
            if disk != 0 {
                return Err(format!(
                    "multi-disk zip files are not supported: found disk number: {disk}"
                ));
            }
            return Ok((count as usize, comment, cd));
        }
    }
    Err("End of central directory record signature not found. Either not a zip file, or file is truncated.".into())
}

/// The next central-directory entry at `*cursor`, with yauzl's own per-entry errors.
fn read_entry(buf: &[u8], cursor: &mut u64) -> Result<Entry, String> {
    let at = *cursor as usize;
    let h = buf.get(at..at + 46).ok_or(EOF)?;
    let sig = u32_at(h, 0).unwrap_or(0);
    if sig != 0x0201_4b50 {
        return Err(format!(
            "invalid central directory file header signature: 0x{sig:x}"
        ));
    }
    let flags = u16_at(h, 8).unwrap_or(0);
    let method = u16_at(h, 10).unwrap_or(0);
    let mut compressed = u32_at(h, 20).unwrap_or(0) as u64;
    let mut uncompressed = u32_at(h, 24).unwrap_or(0) as u64;
    let (n, m, k) = (
        u16_at(h, 28).unwrap_or(0) as usize,
        u16_at(h, 30).unwrap_or(0) as usize,
        u16_at(h, 32).unwrap_or(0) as usize,
    );
    let external = u32_at(h, 38).unwrap_or(0);
    let mut local_offset = u32_at(h, 42).unwrap_or(0) as u64;
    if flags & 0x40 != 0 {
        return Err("strong encryption is not supported".into());
    }
    let rest = buf.get(at + 46..at + 46 + n + m + k).ok_or(EOF)?;
    let (raw_name, raw_extra) = (&rest[..n], &rest[n..n + m]);
    let mut extra = vec![];
    let mut i = 0;
    while i + 3 < raw_extra.len() {
        let id = u16_at(raw_extra, i).unwrap_or(0);
        let len = u16_at(raw_extra, i + 2).unwrap_or(0) as usize;
        let end = i + 4 + len;
        if end > raw_extra.len() {
            return Err("extra field length exceeds extra field buffer size".into());
        }
        extra.push((id, raw_extra[i + 4..end].to_vec()));
        i = end;
    }
    let unicode = extra.iter().find_map(|(id, d)| {
        (*id == 0x7075 && d.len() >= 6 && d[0] == 1 && u32_at(d, 1) == Some(crc32(raw_name)))
            .then(|| decode(&d[5..], true))
    });
    let name = unicode.unwrap_or_else(|| decode(raw_name, flags & 0x800 != 0));
    if name.contains('\\') {
        return Err(format!("invalid characters in fileName: {name}"));
    }
    let b = name.as_bytes();
    if name.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
        return Err(format!("absolute path: {name}"));
    }
    if name.split('/').any(|s| s == "..") {
        return Err(format!("invalid relative path: {name}"));
    }
    *cursor += (46 + n + m + k) as u64;
    if let Some((_, d)) = extra.iter().find(|(id, _)| *id == 1) {
        let mut j = 0;
        let mut take = |field: &mut u64, what: &str| -> Result<(), String> {
            if *field == 0xffff_ffff {
                *field = u64_at(d, j).ok_or_else(|| {
                    format!("zip64 extended information extra field does not include {what}")
                })?;
                j += 8;
            }
            Ok(())
        };
        take(&mut uncompressed, "uncompressed size")?;
        take(&mut compressed, "compressed size")?;
        take(&mut local_offset, "relative header offset")?;
    }
    if method == 0 {
        let expected = uncompressed + if flags & 1 != 0 { 12 } else { 0 };
        if compressed != expected {
            return Err(format!(
                "compressed/uncompressed size mismatch for stored file: {compressed} != {uncompressed}"
            ));
        }
    }
    Ok(Entry {
        name,
        flags,
        method,
        compressed,
        uncompressed,
        external,
        local_offset,
        extra,
    })
}

/// The inflated bytes of an entry, held to its declared size (`validateEntrySizes`).
fn read_data(buf: &[u8], e: &Entry) -> Result<Vec<u8>, String> {
    if e.method != 0 && e.method != 8 {
        return Err(format!("unsupported compression method: {}", e.method));
    }
    let at = e.local_offset as usize;
    let h = buf.get(at..at + 30).ok_or(EOF)?;
    let sig = u32_at(h, 0).unwrap_or(0);
    if sig != 0x0403_4b50 {
        return Err(format!("invalid local file header signature: 0x{sig:x}"));
    }
    let start = at + 30 + u16_at(h, 26).unwrap_or(0) as usize + u16_at(h, 28).unwrap_or(0) as usize;
    let end = start as u64 + e.compressed;
    if end > buf.len() as u64 {
        return Err(format!(
            "file data overflows file bounds: {start} + {} > {}",
            e.compressed,
            buf.len()
        ));
    }
    let data = &buf[start..end as usize];
    if e.method == 0 {
        return Ok(data.to_vec());
    }
    let limit = e.uncompressed as usize + 1;
    let out = miniz_oxide::inflate::decompress_to_vec_with_limit(data, limit)
        .map_err(|e| format!("invalid deflate data: {:?}", e.status))?;
    if out.len() as u64 > e.uncompressed {
        return Err(format!(
            "too many bytes in the stream. expected {}. got at least {}",
            e.uncompressed,
            out.len()
        ));
    }
    if (out.len() as u64) < e.uncompressed {
        return Err(format!(
            "not enough bytes in the stream. expected {}. got only {}",
            e.uncompressed,
            out.len()
        ));
    }
    Ok(out)
}

fn classify(msg: &str) -> &'static str {
    let has = |s: &str| msg.contains(s);
    if has("invalid characters in fileName") || has("invalid relative path") {
        "PLUGIN_PATH_SEPARATOR"
    } else if has("absolute path") {
        "PLUGIN_ABSOLUTE_PATH"
    } else if has("strong encryption") {
        "PLUGIN_ENCRYPTED"
    } else if has("Invalid comment length") {
        "PLUGIN_TRAILING_DATA"
    } else if has("compressed/uncompressed size mismatch") {
        "PLUGIN_TOO_LARGE"
    } else if has("unsupported compression method") {
        "PLUGIN_COMPRESSION_METHOD"
    } else {
        "PLUGIN_MALFORMED_ARCHIVE"
    }
}

fn find_all(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len()).filter(|w| *w == needle).count()
}

/// The guarded archive: its entries (names in central-directory order) and their bytes.
#[derive(Debug, Clone)]
pub struct Archive {
    pub sha256: String,
    pub entries: BTreeMap<String, Vec<u8>>,
    pub order: Vec<String>,
}

impl Archive {
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.entries.get(name).map(Vec::as_slice)
    }
}

/// Rule 13 in order; every entry is read (sizes checked) before the archive is accepted.
pub fn read(buf: &[u8]) -> Result<Archive, Refusal> {
    if buf.len() < 4 || buf[..4] != [0x50, 0x4b, 0x03, 0x04] {
        return Err(refuse(
            "PLUGIN_BAD_MAGIC",
            "archive does not start with the ZIP local-file-header signature",
        ));
    }
    if buf.len() > MAX_ARCHIVE_BYTES {
        return Err(refuse(
            "PLUGIN_TOO_LARGE",
            format!("archive is {} bytes, cap is {MAX_ARCHIVE_BYTES}", buf.len()),
        ));
    }
    if find_all(buf, &[0x50, 0x4b, 0x05, 0x06]) > 1 {
        return Err(refuse(
            "PLUGIN_TRAILING_DATA",
            "archive contains more than one end-of-central-directory signature",
        ));
    }
    let sha256 = sha256_hex(buf);
    let (count, comment, cd) = open(buf).map_err(|m| refuse(classify(&m), m))?;
    if !comment.is_empty() {
        return Err(refuse(
            "PLUGIN_ARCHIVE_COMMENT",
            "archive carries a nonzero comment",
        ));
    }
    if count > MAX_ENTRIES {
        return Err(refuse(
            "PLUGIN_TOO_MANY_ENTRIES",
            format!("{count} entries, cap is {MAX_ENTRIES}"),
        ));
    }
    let (mut exact, mut lower) = (HashSet::new(), HashSet::new());
    let (mut logo, mut total, mut cursor) = (false, 0u64, cd);
    let mut walked = vec![];
    for _ in 0..count {
        let e = read_entry(buf, &mut cursor).map_err(|m| refuse(classify(&m), m))?;
        let n = &e.name;
        let q = serde_json::to_string(n).unwrap_or_default();
        if n.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
            return Err(refuse(
                "PLUGIN_CONTROL_CHAR",
                format!("control character in entry name {q}"),
            ));
        }
        if n.nfc().collect::<String>() != *n {
            return Err(refuse(
                "PLUGIN_NOT_NFC",
                format!("entry name {q} is not NFC-normalised"),
            ));
        }
        if n.contains('/') {
            return Err(refuse(
                "PLUGIN_PATH_SEPARATOR",
                format!("entry name {q} contains a path separator"),
            ));
        }
        let nb = n.as_bytes();
        if n.starts_with('/') || (nb.len() >= 2 && nb[0].is_ascii_alphabetic() && nb[1] == b':') {
            return Err(refuse(
                "PLUGIN_ABSOLUTE_PATH",
                format!("entry name {q} is an absolute path"),
            ));
        }
        if e.external & 0x10 != 0 {
            return Err(refuse(
                "PLUGIN_DIRECTORY_ENTRY",
                format!("entry {q} is flagged as a directory"),
            ));
        }
        let kind = (e.external >> 16) & 0xf000;
        if kind != 0 && kind != 0x8000 {
            return Err(refuse(
                "PLUGIN_SYMLINK",
                format!("entry {q} is not a regular file (type 0{kind:o})"),
            ));
        }
        if exact.contains(n) || lower.contains(&n.to_lowercase()) {
            return Err(refuse(
                "PLUGIN_DUPLICATE_ENTRY",
                format!("duplicate entry {q}"),
            ));
        }
        exact.insert(n.clone());
        lower.insert(n.to_lowercase());
        if !ENTRY_NAMES.contains(&n.as_str()) {
            return Err(refuse(
                "PLUGIN_UNEXPECTED_ENTRY",
                format!("{q} is not one of the legal entry names"),
            ));
        }
        if n.starts_with("logo.") {
            if logo {
                return Err(refuse(
                    "PLUGIN_DUPLICATE_ENTRY",
                    "archive carries more than one logo entry",
                ));
            }
            logo = true;
        }
        if e.extra.iter().any(|(id, _)| *id == 1) {
            return Err(refuse(
                "PLUGIN_ZIP64",
                format!("entry {q} carries a ZIP64 extra field"),
            ));
        }
        if e.flags & 0x8 != 0 {
            return Err(refuse(
                "PLUGIN_DATA_DESCRIPTOR",
                format!("entry {q} uses a data descriptor"),
            ));
        }
        if e.flags & 1 != 0 {
            return Err(refuse(
                "PLUGIN_ENCRYPTED",
                format!("entry {q} is encrypted"),
            ));
        }
        if e.method != 0 && e.method != 8 {
            return Err(refuse(
                "PLUGIN_COMPRESSION_METHOD",
                format!("entry {q} uses compression method {}", e.method),
            ));
        }
        let cap = max_bytes_for(n);
        if e.uncompressed > cap {
            let code = if n == "plugin.json" {
                "PLUGIN_MANIFEST_TOO_LARGE"
            } else {
                "PLUGIN_TOO_LARGE"
            };
            return Err(refuse(
                code,
                format!("entry {q} declares {} bytes, cap is {cap}", e.uncompressed),
            ));
        }
        if e.compressed > 0 {
            let ratio = e.uncompressed as f64 / e.compressed as f64;
            if ratio > MAX_RATIO {
                return Err(refuse(
                    "PLUGIN_RATIO",
                    format!("entry {q} has a {ratio:.1}:1 compression ratio"),
                ));
            }
        } else if e.uncompressed > 0 {
            return Err(refuse(
                "PLUGIN_RATIO",
                format!("entry {q} declares content from zero compressed bytes"),
            ));
        }
        total += e.uncompressed;
        walked.push(e);
    }
    if total > MAX_TOTAL_BYTES {
        return Err(refuse(
            "PLUGIN_TOO_LARGE",
            format!("archive declares {total} uncompressed bytes, cap is {MAX_TOTAL_BYTES}"),
        ));
    }
    if !walked.iter().any(|e| e.name == "plugin.json") {
        return Err(refuse(
            "PLUGIN_BAD_MANIFEST",
            "archive has no plugin.json entry",
        ));
    }
    let mut entries = BTreeMap::new();
    for e in &walked {
        let data = read_data(buf, e).map_err(|m| {
            refuse(
                "PLUGIN_TOO_LARGE",
                format!("entry content did not match its declared size: {m}"),
            )
        })?;
        entries.insert(e.name.clone(), data);
    }
    Ok(Archive {
        sha256,
        order: walked.into_iter().map(|e| e.name).collect(),
        entries,
    })
}

/// PNG by magic bytes; SVG rooted at `<svg>` with no script content (rule 14).
pub fn sniff_logo(name: &str, content: &[u8]) -> Option<Refusal> {
    if name == "logo.png" {
        return (!content.starts_with(&PNG_MAGIC)).then(|| {
            refuse(
                "PLUGIN_BAD_LOGO",
                "logo.png does not start with the PNG magic bytes",
            )
        });
    }
    let text = String::from_utf8_lossy(content).to_lowercase();
    let tag = |t: &str| {
        text.match_indices(t)
            .any(|(i, _)| text[i + t.len()..].starts_with(|c: char| c == '>' || c.is_whitespace()))
    };
    if !tag("<svg") {
        return Some(refuse(
            "PLUGIN_BAD_LOGO",
            "logo.svg has no <svg> root element",
        ));
    }
    if tag("<script") {
        return Some(refuse(
            "PLUGIN_BAD_LOGO",
            "logo.svg contains a <script> element",
        ));
    }
    let handler = regex::Regex::new(r"\son[a-z]+\s*=").expect("static");
    if handler.is_match(&text) {
        return Some(refuse(
            "PLUGIN_BAD_LOGO",
            "logo.svg contains an event-handler attribute",
        ));
    }
    if text.contains("javascript:") {
        return Some(refuse(
            "PLUGIN_BAD_LOGO",
            "logo.svg contains a javascript: URI",
        ));
    }
    None
}

/// Serve-time logo: `logo.png` preferred, classified by its bytes, re-sniffed (rule 49).
pub fn verified_logo(archive: &[u8]) -> Option<(&'static str, Vec<u8>)> {
    let a = read(archive).ok()?;
    let content = a.get("logo.png").or_else(|| a.get("logo.svg"))?.to_vec();
    if content.starts_with(&PNG_MAGIC) {
        return sniff_logo("logo.png", &content)
            .is_none()
            .then_some(("image/png", content));
    }
    sniff_logo("logo.svg", &content)
        .is_none()
        .then_some(("image/svg+xml", content))
}

/// Builds an unsigned store-only archive (tests and the SDK harness).
pub fn pack(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let (mut out, mut cd) = (Vec::new(), Vec::new());
    for (name, data) in entries {
        let off = out.len() as u32;
        let crc = crc32(data);
        let mut h = vec![];
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&[20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0]);
        h.extend_from_slice(&crc.to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&h);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        cd.extend_from_slice(&[20, 3, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0]);
        cd.extend_from_slice(&crc.to_le_bytes());
        cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0; 8]);
        cd.extend_from_slice(&(0o100644u32 << 16).to_le_bytes());
        cd.extend_from_slice(&off.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&cd);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(b: &[u8]) -> &'static str {
        read(b).unwrap_err().code
    }

    #[test]
    fn pack_reads_back() {
        let a = read(&pack(&[
            ("plugin.json", b"{}"),
            ("logo.svg", b"<svg></svg>"),
        ]))
        .unwrap();
        assert_eq!(a.order, ["plugin.json", "logo.svg"]);
        assert_eq!(a.get("plugin.json"), Some(&b"{}"[..]));
    }

    #[test]
    fn guards() {
        assert_eq!(code(b"nope"), "PLUGIN_BAD_MAGIC");
        let ok = pack(&[("plugin.json", b"{}")]);
        let mut trailing = ok.clone();
        trailing.extend_from_slice(b"x");
        assert_eq!(code(&trailing), "PLUGIN_TRAILING_DATA");
        assert_eq!(code(&pack(&[("x.txt", b"a")])), "PLUGIN_UNEXPECTED_ENTRY");
        assert_eq!(code(&pack(&[("a/b", b"a")])), "PLUGIN_PATH_SEPARATOR");
        assert_eq!(code(&pack(&[("..", b"a")])), "PLUGIN_PATH_SEPARATOR");
        assert_eq!(code(&pack(&[("/abs", b"a")])), "PLUGIN_ABSOLUTE_PATH");
        assert_eq!(code(&pack(&[("a\u{1}", b"a")])), "PLUGIN_CONTROL_CHAR");
        assert_eq!(code(&pack(&[("logo.svg", b"")])), "PLUGIN_BAD_MANIFEST");
        assert_eq!(
            code(&pack(&[("plugin.json", b"{}"), ("PLUGIN.JSON", b"{}")])),
            "PLUGIN_DUPLICATE_ENTRY"
        );
        let five: Vec<(&str, &[u8])> = vec![("a", b""); 5];
        assert_eq!(code(&pack(&five)), "PLUGIN_TOO_MANY_ENTRIES");
        let big = vec![0u8; 300 << 10];
        assert_eq!(
            code(&pack(&[("plugin.json", &big)])),
            "PLUGIN_MANIFEST_TOO_LARGE"
        );
    }

    #[test]
    fn cp437_has_256_chars() {
        assert_eq!(CP437.chars().count(), 256);
    }

    #[test]
    fn logos() {
        assert!(sniff_logo("logo.svg", b"<svg viewBox='0 0 1 1'></svg>").is_none());
        assert!(sniff_logo("logo.svg", b"<svg><script>x</script></svg>").is_some());
        assert!(sniff_logo("logo.svg", b"<svg onload=x></svg>").is_some());
        assert!(sniff_logo("logo.svg", b"<html/>").is_some());
        assert!(sniff_logo("logo.png", b"GIF89a").is_some());
    }
}
