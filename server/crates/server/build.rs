//! Embeds the archives pinned in `server/providers.lock` (`id version sha256 zipUrl` per line).
//! An archive already in `server/bundled-plugins/` with the pinned sha256 is used as is, so an
//! offline build only needs that directory; a missing one is fetched with `curl`.
use sha2::{Digest, Sha256};
use std::{env, fmt::Write as _, fs, path::PathBuf, process::Command};

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let lock = root.join("providers.lock");
    let dir = root.join("bundled-plugins");
    println!("cargo:rerun-if-changed={}", lock.display());
    println!("cargo:rerun-if-changed={}", dir.display());
    let text = fs::read_to_string(&lock).unwrap_or_default();
    let mut out = String::from("pub static ARCHIVES: &[(&str, &str, &[u8])] = &[\n");
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let f: Vec<&str> = line.split_whitespace().collect();
        let [id, version, sha, url] = f[..] else {
            panic!("providers.lock: expected `id version sha256 zipUrl`, got `{line}`");
        };
        let path = dir.join(format!("{id}-{version}.fkplugin"));
        if !path.exists() {
            fs::create_dir_all(&dir).unwrap();
            let tmp = path.with_extension(format!("{}.part", std::process::id()));
            let ok = Command::new("curl")
                .args(["-fsSL", "--retry", "3", "-o"])
                .arg(&tmp)
                .arg(url)
                .status()
                .is_ok_and(|s| s.success());
            assert!(
                ok,
                "providers.lock: cannot fetch {url} (offline? put the archive at {})",
                path.display()
            );
            let got = sha256_hex(&fs::read(&tmp).unwrap());
            assert!(
                got == sha,
                "{url}: sha256 {got} differs from providers.lock {sha}"
            );
            fs::rename(&tmp, &path).unwrap();
        }
        let got = sha256_hex(&fs::read(&path).unwrap());
        assert!(
            got == sha,
            "{}: sha256 {got} differs from providers.lock {sha}",
            path.display()
        );
        let path = path.canonicalize().unwrap();
        writeln!(
            out,
            "    ({id:?}, {version:?}, include_bytes!({:?})),",
            path.display().to_string()
        )
        .unwrap();
    }
    out.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("bundled.rs"),
        out,
    )
    .unwrap();
}
