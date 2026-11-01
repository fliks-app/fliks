//! KOReader partial MD5 (`books-files.md` rules 40-43), over caller-supplied reads.
use md5::{Digest, Md5};

/// `util.partialMD5` of koreader/frontend/util.lua: 1024-byte reads at `lshift(1024, 2*i)` for i in -1..=10,
/// stopping at the first empty read. `read_at(offset, len)` returns the bytes there, short or empty at EOF.
/// LuaJIT masks the shift count to 5 bits, so i = -1 reads at offset 0 (not 256).
pub fn partial_md5<E>(
    mut read_at: impl FnMut(u64, usize) -> Result<Vec<u8>, E>,
) -> Result<String, E> {
    let mut md5 = Md5::new();
    for i in -1i32..=10 {
        let offset = if i < 0 { 0 } else { 1024u64 << (2 * i) };
        let chunk = read_at(offset, 1024)?;
        if chunk.is_empty() {
            break;
        }
        md5.update(&chunk);
    }
    Ok(md5.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes of the generated files: a pattern for the first 2 MiB, zeros beyond.
    fn synthetic(size: u64, offset: u64, len: usize) -> Vec<u8> {
        let end = size.min(offset + len as u64);
        (offset..end)
            .map(|i| {
                if i < 1 << 21 {
                    (i * 131 + (i >> 7)) as u8
                } else {
                    0
                }
            })
            .collect()
    }

    #[test]
    fn partial_md5_reproduces_koreader_lua() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/books-koreader/cases.json"
        );
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 25);
        for c in cases {
            let size = c["input"]["size"].as_u64().unwrap();
            let got = partial_md5(|off, len| Ok::<_, ()>(synthetic(size, off, len))).unwrap();
            assert_eq!(got, c["expected"].as_str().unwrap(), "size {size}");
        }
    }

    #[test]
    fn a_read_error_is_returned_not_read_as_the_end() {
        let got = partial_md5(|off, _| if off == 0 { Ok(vec![1]) } else { Err("io") });
        assert_eq!(got, Err("io"));
    }
}
