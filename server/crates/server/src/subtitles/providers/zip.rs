//! Subtitle extraction from a ZIP body (`zip-utils.ts`, Subsynchro's variant), over the central directory.
use miniz_oxide::inflate::decompress_to_vec_with_limit;

/// Largest subtitle taken out of an archive (`SUBTITLE_UPLOAD_MAX_BYTES`, F56).
pub const MAX_EXTRACTED: usize = 5 * 1024 * 1024;
const NO_SUBTITLE: &str = "No subtitle file found in ZIP archive";

struct Entry<'a> {
    name: String,
    method: u16,
    data: &'a [u8],
    size: usize,
}

fn u16_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?).into())
}

fn u32_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
}

/// Entries listed by the central directory; a truncated one ends the list.
fn entries(zip: &[u8]) -> Vec<Entry<'_>> {
    let eocd = (0..zip.len().saturating_sub(21))
        .rev()
        .take(65_557)
        .find(|&i| zip[i..].starts_with(b"PK\x05\x06"));
    let Some(eocd) = eocd else { return vec![] };
    let (Some(count), Some(mut at)) = (u16_at(zip, eocd + 10), u32_at(zip, eocd + 16)) else {
        return vec![];
    };
    let mut out = vec![];
    for _ in 0..count {
        if !zip.get(at..).is_some_and(|r| r.starts_with(b"PK\x01\x02")) {
            break;
        }
        let (Some(method), Some(comp), Some(size), Some(nlen), Some(elen), Some(clen), Some(local)) = (
            u16_at(zip, at + 10),
            u32_at(zip, at + 20),
            u32_at(zip, at + 24),
            u16_at(zip, at + 28),
            u16_at(zip, at + 30),
            u16_at(zip, at + 32),
            u32_at(zip, at + 42),
        ) else {
            break;
        };
        let Some(name) = zip.get(at + 46..at + 46 + nlen) else {
            break;
        };
        at += 46 + nlen + elen + clen;
        if !zip
            .get(local..)
            .is_some_and(|r| r.starts_with(b"PK\x03\x04"))
        {
            break;
        }
        let (Some(ln), Some(le)) = (u16_at(zip, local + 26), u16_at(zip, local + 28)) else {
            break;
        };
        let start = local + 30 + ln + le;
        let Some(data) = zip.get(start..start + comp) else {
            break;
        };
        out.push(Entry {
            name: String::from_utf8_lossy(name).into_owned(),
            method: method as u16,
            data,
            size,
        });
    }
    out
}

fn read(e: &Entry<'_>) -> Result<Option<Vec<u8>>, String> {
    if e.size > MAX_EXTRACTED {
        return Err("Subtitle file in the archive is too large".into());
    }
    match e.method {
        0 if e.data.len() > MAX_EXTRACTED => {
            Err("Subtitle file in the archive is too large".into())
        }
        0 => Ok(Some(e.data.to_vec())),
        8 => decompress_to_vec_with_limit(e.data, MAX_EXTRACTED)
            .map(Some)
            .map_err(|_| "Subtitle file in the archive is invalid or too large".into()),
        _ => Ok(None),
    }
}

fn is_subtitle(name: &str, exts: &[&str]) -> bool {
    let n = name.to_lowercase();
    exts.iter().any(|e| n.ends_with(e))
}

/// The first `.srt .ass .ssa .sub .vtt` entry (`fallback_first`: else the first entry of any name).
pub fn extract_subtitle(zip: &[u8], fallback_first: bool) -> Result<Vec<u8>, String> {
    const EXTS: [&str; 5] = [".srt", ".ass", ".ssa", ".sub", ".vtt"];
    let all: Vec<Entry<'_>> = entries(zip)
        .into_iter()
        .filter(|e| !e.name.ends_with('/') && !e.data.is_empty())
        .collect();
    for e in all.iter().filter(|e| is_subtitle(&e.name, &EXTS)) {
        if let Some(d) = read(e)? {
            return Ok(d);
        }
    }
    if fallback_first {
        for e in &all {
            if let Some(d) = read(e)? {
                return Ok(d);
            }
        }
    }
    Err(NO_SUBTITLE.into())
}
