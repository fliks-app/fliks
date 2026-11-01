//! KOReader partial MD5 (`books-files.md` rules 40-43), a pure MD5 over caller-supplied reads.

const S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

#[derive(Clone)]
struct Md5 {
    state: [u32; 4],
    buf: Vec<u8>,
    len: u64,
}

impl Md5 {
    fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            buf: Vec::with_capacity(64),
            len: 0,
        }
    }

    fn block(&mut self, chunk: &[u8]) {
        let m: Vec<u32> = chunk
            .as_chunks::<4>()
            .0
            .iter()
            .map(|w| u32::from_le_bytes(*w))
            .collect();
        let [mut a, mut b, mut c, mut d] = self.state;
        for (i, &shift) in S.iter().enumerate() {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            // K[i] = floor(2^32 * abs(sin(i + 1)))
            let k = ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32;
            let t = a.wrapping_add(f).wrapping_add(k).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(t.rotate_left(shift));
        }
        for (s, v) in self.state.iter_mut().zip([a, b, c, d]) {
            *s = s.wrapping_add(v);
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.len += data.len() as u64;
        while !data.is_empty() {
            let take = (64 - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buf.len() == 64 {
                let full = std::mem::take(&mut self.buf);
                self.block(&full);
            }
        }
    }

    fn hex(mut self) -> String {
        let bits = self.len.wrapping_mul(8);
        let pad = if self.buf.len() < 56 { 56 } else { 120 } - self.buf.len();
        let mut tail = vec![0x80];
        tail.resize(pad, 0);
        tail.extend_from_slice(&bits.to_le_bytes());
        self.update(&tail);
        self.state
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

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
    Ok(md5.hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md5_hex(data: &[u8]) -> String {
        let mut m = Md5::new();
        m.update(data);
        m.hex()
    }

    #[test]
    fn md5_matches_the_rfc_1321_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(
                b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"
            ),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
        // 55, 56 and 64 bytes sit on the padding boundaries
        assert_eq!(md5_hex(&[b'a'; 55]), "ef1772b6dff9a122358552954ad0df65");
        assert_eq!(md5_hex(&[b'a'; 56]), "3b0c8ac703f828b04c6c197006d17218");
        assert_eq!(md5_hex(&[b'a'; 64]), "014842d480b571495a4a0363793f7367");
    }
}
