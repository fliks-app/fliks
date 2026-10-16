//! Generates `FNS` distinct functions so the component reaches the download plugin's size.
use std::fmt::Write;

fn main() {
    let n: usize = std::env::var("BIG_FNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4000);
    println!("cargo:rerun-if-env-changed=BIG_FNS");
    let mut s = String::new();
    for i in 0..n {
        let k = (i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        writeln!(s, "#[inline(never)] fn f{i}(mut x: u64) -> u64 {{").unwrap();
        writeln!(s, "  for j in 0..(x & 3) {{ match (x ^ j) % 12 {{").unwrap();
        for arm in 0..11u64 {
            writeln!(
                s,
                "    {arm} => {{ x = x.wrapping_mul({}).rotate_left({}) ^ {}; }}",
                k.wrapping_add(arm * 2 + 1),
                (i as u64 + arm) % 63 + 1,
                k >> (arm % 7)
            )
            .unwrap();
        }
        writeln!(s, "    _ => {{ x = x.wrapping_add({k}); }} }} }} x }}").unwrap();
    }
    write!(s, "pub static FNS: [fn(u64) -> u64; {n}] = [").unwrap();
    for i in 0..n {
        write!(s, "f{i},").unwrap();
    }
    s.push_str("];\n");
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("gen.rs"),
        s,
    )
    .unwrap();
}
