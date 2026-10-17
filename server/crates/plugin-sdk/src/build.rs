//! Build and packaging (SDK-12): the release component, `plugin.json` from the template, the
//! deterministic archive, and `verify` through the host's own `inspect`.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use fliks_server::plugins::archive::{pack, sha256_hex};
use fliks_server::plugins::manifest::{Inspected, check_files, inspect};
use fliks_server::plugins::trust;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const TARGET: &str = "wasm32-wasip2";
/// The host's cap per entry (`plugins.md` rule 14).
pub const MAX_WASM: usize = 32 << 20;

pub type Error = String;

/// A plugin crate as `cargo metadata` describes it.
#[derive(Debug, Clone)]
pub struct Crate {
    pub dir: PathBuf,
    pub name: String,
    pub version: String,
    pub lib: String,
    pub target_dir: PathBuf,
}

fn cargo() -> Command {
    Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
}

impl Crate {
    pub fn at(dir: &Path) -> Result<Crate, Error> {
        let manifest = dir.join("Cargo.toml");
        let out = cargo()
            .args([
                "metadata",
                "--format-version",
                "1",
                "--no-deps",
                "--manifest-path",
            ])
            .arg(&manifest)
            .output()
            .map_err(|e| format!("cargo metadata: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        let m: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let manifest = manifest.canonicalize().map_err(|e| e.to_string())?;
        let pkg = m["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["manifest_path"].as_str().map(PathBuf::from).as_ref() == Some(&manifest))
            .ok_or("no package at this path")?;
        let lib = pkg["targets"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| {
                t["kind"]
                    .as_array()
                    .is_some_and(|k| k.iter().any(|k| k == "cdylib"))
            })
            .and_then(|t| t["name"].as_str())
            .ok_or("the crate has no cdylib target")?;
        Ok(Crate {
            dir: manifest
                .parent()
                .expect("a manifest has a dir")
                .to_path_buf(),
            name: pkg["name"].as_str().unwrap_or_default().to_owned(),
            version: pkg["version"].as_str().unwrap_or_default().to_owned(),
            lib: lib.replace('-', "_"),
            target_dir: PathBuf::from(m["target_directory"].as_str().unwrap_or_default()),
        })
    }

    pub fn wasm_path(&self) -> PathBuf {
        self.target_dir
            .join(TARGET)
            .join("release")
            .join(format!("{}.wasm", self.lib))
    }

    /// `cargo build --release --target wasm32-wasip2` of this package.
    pub fn build(&self) -> Result<PathBuf, Error> {
        let status = cargo()
            .args(["build", "--release", "--target", TARGET, "--manifest-path"])
            .arg(self.dir.join("Cargo.toml"))
            .status()
            .map_err(|e| format!("cargo build: {e}"))?;
        if !status.success() {
            return Err(format!("cargo build failed: {status}"));
        }
        Ok(self.wasm_path())
    }

    pub fn template(&self) -> Result<Value, Error> {
        let p = self.dir.join("plugin.template.json");
        let t = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        serde_json::from_slice(&t).map_err(|e| format!("{}: {e}", p.display()))
    }

    /// The archive of the built component: `<id>-<version>.fkplugin` and its bytes.
    pub fn package(&self, key: Option<&SigningKey>) -> Result<(String, Vec<u8>), Error> {
        let template = self.template()?;
        let wasm = std::fs::read(self.wasm_path())
            .map_err(|e| format!("{}: {e}", self.wasm_path().display()))?;
        let logo = match template["logo"].as_str() {
            Some(name) => {
                let name = logo_name(name)?;
                let bytes =
                    std::fs::read(self.dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
                Some((name.to_owned(), bytes))
            }
            None => None,
        };
        let logo = logo.as_ref().map(|(n, b)| (n.as_str(), b.as_slice()));
        let manifest = manifest(&template, &self.version, &wasm, logo);
        let name = format!(
            "{}-{}.fkplugin",
            manifest["id"].as_str().unwrap_or_default(),
            self.version
        );
        Ok((name, archive(&manifest, &wasm, logo, key)?))
    }
}

/// The only logo names the host accepts (rule 13), checked before anything is read.
pub fn logo_name(name: &str) -> Result<&str, Error> {
    match name {
        "logo.svg" | "logo.png" => Ok(name),
        _ => Err(format!("logo {name:?} must be logo.svg or logo.png")),
    }
}

/// The template plus `version` and `files` (sha256 of `plugin.wasm` and the logo).
pub fn manifest(
    template: &Value,
    version: &str,
    wasm: &[u8],
    logo: Option<(&str, &[u8])>,
) -> Value {
    let mut m = template.clone();
    m["version"] = json!(version);
    m["files"] = json!({ "plugin.wasm": sha256_hex(wasm) });
    if let Some((name, bytes)) = logo {
        m["files"][name] = json!(sha256_hex(bytes));
    }
    m
}

/// `plugin.json.sig` as the host decodes it (rule 15): base64 of the ed25519 signature.
pub fn sign(manifest: &[u8], key: &SigningKey) -> String {
    use base64::Engine;
    let sig = key.sign(manifest).to_bytes();
    format!(
        "{}\n",
        base64::engine::general_purpose::STANDARD.encode(sig)
    )
}

/// Store-only, fixed DOS time, no data descriptor or ZIP64: the host's own writer.
pub fn archive(
    manifest: &Value,
    wasm: &[u8],
    logo: Option<(&str, &[u8])>,
    key: Option<&SigningKey>,
) -> Result<Vec<u8>, Error> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    let sig = key.map(|k| sign(&bytes, k));
    let mut entries: Vec<(&str, &[u8])> = vec![("plugin.json", &bytes)];
    if let Some(s) = &sig {
        entries.push(("plugin.json.sig", s.as_bytes()));
    }
    entries.push(("plugin.wasm", wasm));
    if let Some((name, b)) = logo {
        entries.push((name, b));
    }
    Ok(pack(&entries))
}

fn hex32(hex: &str) -> Result<[u8; 32], Error> {
    let hex = hex.trim();
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("zz"), 16))
        .collect::<Result<_, _>>()
        .map_err(|_| "the key is not hex")?;
    Ok(bytes.try_into().map_err(|_| "the key is not 32 bytes")?)
}

/// A dev key from 64 hex characters (the 32-byte seed).
pub fn dev_key(hex: &str) -> Result<SigningKey, Error> {
    Ok(SigningKey::from_bytes(&hex32(hex)?))
}

/// A trust key from 64 hex characters (the ed25519 public key the host checks against).
pub fn public_key(hex: &str) -> Result<VerifyingKey, Error> {
    VerifyingKey::from_bytes(&hex32(hex)?).map_err(|e| format!("not an ed25519 public key: {e}"))
}

/// The host's `inspect` and file checks, the size budget and the component's world.
pub fn verify(archive: &[u8], extra_keys: trust::Keys, budget: usize) -> Result<Inspected, Error> {
    let mut keys = trust::official_keys();
    keys.extend(extra_keys);
    let refusal = |r: fliks_server::plugins::archive::Refusal| format!("{}: {}", r.code, r.detail);
    let i = inspect(archive, true, &keys).map_err(refusal)?;
    check_files(&i).map_err(refusal)?;
    let wasm = i.archive.get("plugin.wasm").ok_or("no plugin.wasm")?;
    if wasm.len() > budget {
        return Err(format!(
            "plugin.wasm is {} bytes, over the {budget} byte budget",
            wasm.len()
        ));
    }
    check_world(wasm)?;
    Ok(i)
}

/// Every import is one of the `plugin` world's and the only export is `guest`.
pub fn check_world(wasm: &[u8]) -> Result<(), Error> {
    use wit_parser::decoding::{DecodedWasm, decode};
    let mut world = wit_parser::Resolve::default();
    let (pkg, _) = world
        .push_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/wit"))
        .map_err(|e| e.to_string())?;
    let w = world
        .select_world(&[pkg], Some("plugin"))
        .map_err(|e| e.to_string())?;
    let allowed: BTreeSet<String> = world.worlds[w]
        .imports
        .keys()
        .map(|k| world.name_world_key(k))
        .collect();
    let DecodedWasm::Component(r, cw) = decode(wasm).map_err(|e| format!("{e:#}"))? else {
        return Err("plugin.wasm is not a component".into());
    };
    let foreign: Vec<String> = r.worlds[cw]
        .imports
        .keys()
        .map(|k| r.name_world_key(k))
        .filter(|n| !allowed.contains(n))
        .collect();
    if !foreign.is_empty() {
        return Err(format!(
            "imports outside the plugin world: {}",
            foreign.join(", ")
        ));
    }
    let exports: Vec<String> = r.worlds[cw]
        .exports
        .keys()
        .map(|k| r.name_world_key(k))
        .collect();
    if exports != ["fliks:plugin/guest@2.0.0"] {
        return Err(format!(
            "exports {} instead of fliks:plugin/guest@2.0.0",
            exports.join(", ")
        ));
    }
    Ok(())
}

const USAGE: &str = "usage: xtask build|package [<crate dir>] [--key <hex seed file>] [--out <dir>] \
[--max-mib <n>] | verify <archive> [--key <hex public key file>] [--max-mib <n>]";

/// The whole CLI of a plugin repository's thin `cargo xtask` (arguments after the program).
pub fn cli(args: &[String]) -> Result<(), Error> {
    let (cmd, rest) = args.split_first().ok_or(USAGE)?;
    let (mut path, mut key, mut out, mut budget) = (None, None, PathBuf::from("."), MAX_WASM);
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let mut value = || it.next().cloned().ok_or(USAGE);
        match a.as_str() {
            "--key" => {
                let file = value()?;
                key = Some(std::fs::read_to_string(&file).map_err(|e| format!("{file}: {e}"))?);
            }
            "--out" => out = PathBuf::from(value()?),
            "--max-mib" => {
                budget = value()?
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_mul(1 << 20))
                    .ok_or(USAGE)?;
            }
            p if path.is_none() && !p.starts_with("--") => path = Some(PathBuf::from(p)),
            _ => return Err(USAGE.into()),
        }
    }
    let path = path.unwrap_or_else(|| PathBuf::from("."));
    let trusted = |k: VerifyingKey| vec![("dev".to_owned(), k.to_bytes())];
    match cmd.as_str() {
        "build" => {
            println!("{}", Crate::at(&path)?.build()?.display());
        }
        "package" => {
            let key = key.as_deref().map(dev_key).transpose()?;
            let c = Crate::at(&path)?;
            c.build()?;
            let (name, bytes) = c.package(key.as_ref())?;
            let extra = key.map_or_else(Vec::new, |k| trusted(k.verifying_key()));
            verify(&bytes, extra, budget)?;
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let file = out.join(name);
            std::fs::write(&file, &bytes).map_err(|e| format!("{}: {e}", file.display()))?;
            println!("{}", file.display());
        }
        "verify" => {
            let extra = match key.as_deref() {
                Some(k) => trusted(public_key(k)?),
                None => vec![],
            };
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let i = verify(&bytes, extra, budget)?;
            println!("{} {} {}", i.id, i.version, i.signature.as_str());
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
