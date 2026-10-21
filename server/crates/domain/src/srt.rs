//! SRT parsing for translation (`srt.util.ts`).
use crate::js::rx;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cue {
    pub timing: String,
    pub text: String,
}

/// Tolerant of a BOM, CRLF/CR, a missing index and a missing or whitespace-only separator.
pub fn parse_srt(content: &str) -> Vec<Cue> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = vec![];
    for block in rx!(r"\n[ \t]*\n").split(&normalized) {
        let lines: Vec<&str> = block.split('\n').collect();
        let timing_at = |from: usize| (from..lines.len()).find(|&i| lines[i].contains("-->"));
        let mut start = timing_at(0);
        while let Some(s) = start {
            let next = timing_at(s + 1);
            let end = match next {
                None => lines.len(),
                Some(n) if n > 0 && rx!(r"^[0-9]+$").is_match(crate::js::trim(lines[n - 1])) => {
                    n - 1
                }
                Some(n) => n,
            };
            let text = lines[(s + 1).min(end)..end].join("\n");
            let text = crate::js::trim(&text);
            if !text.is_empty() {
                cues.push(Cue {
                    timing: crate::js::trim(lines[s]).to_owned(),
                    text: text.to_owned(),
                });
            }
            start = next;
        }
    }
    cues
}

pub fn serialize_srt(cues: &[Cue]) -> String {
    let body: Vec<String> = cues
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}\n{}\n{}", i + 1, c.timing, c.text))
        .collect();
    body.join("\n\n") + "\n"
}

/// Decodes subtitle bytes: a BOM wins, valid UTF-8 is kept, anything else is Windows-1252.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some((enc, skip)) = encoding_rs::Encoding::for_bom(bytes) {
        return enc
            .decode_without_bom_handling(&bytes[skip..])
            .0
            .into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::decode_text;

    // BOM, then UTF-8, then Windows-1252; never lossy.
    #[test]
    fn text_decodes_bom_then_utf8_then_windows_1252() {
        assert_eq!(decode_text(b"caf\xE9"), "café");
        assert_eq!(decode_text("café".as_bytes()), "café");
        assert_eq!(decode_text(b"\xFF\xFEc\0a\0"), "ca");
        assert_eq!(decode_text(b"\xEF\xBB\xBFok"), "ok");
    }
}
