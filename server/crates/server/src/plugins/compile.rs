//! Component compile and the authenticated `.cwasm` cache (`plugins.md` Host design): the compile
//! runs in a child process of the server's own image, one at a time.
use super::archive::sha256_hex;
use super::runtime::{Env, set_mode};
use sha2::{Digest, Sha256};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmtime::Engine;
use wasmtime::component::Component;

pub const SUBCOMMAND: &str = "compile-component";

/// The running image: `/proc/self/exe` so a binary replaced on disk is never the compiler.
pub fn own_image() -> PathBuf {
    if cfg!(target_os = "linux") {
        PathBuf::from("/proc/self/exe")
    } else {
        std::env::current_exe().unwrap_or_default()
    }
}

/// The hidden subcommand: wasm on stdin, the serialised component on stdout.
pub fn child_main() -> ExitCode {
    let mut wasm = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut wasm) {
        eprintln!("cannot read the component: {e}");
        return ExitCode::FAILURE;
    }
    let out = Engine::new(&super::runtime::engine_config())
        .and_then(|engine| engine.precompile_component(&wasm));
    match out {
        Ok(bytes) => match std::io::stdout().write_all(&bytes) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("cannot write the component: {e}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

struct Feed(Sha256);

impl Hasher for Feed {
    fn write(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    fn finish(&self) -> u64 {
        0
    }
}

/// Lowercase sha256 of what `precompile_compatibility_hash` feeds a hasher: stable across builds.
pub fn fingerprint(engine: &Engine) -> String {
    let mut f = Feed(Sha256::new());
    engine.precompile_compatibility_hash().hash(&mut f);
    f.0.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug)]
pub enum LoadError {
    /// The compiler refused the component: `invalid-component`.
    Invalid(String),
    /// Ours: logged, the package stays as it was.
    Host(String),
}

pub struct Loaded {
    pub component: Component,
    pub elapsed: Duration,
    pub cache_hit: bool,
}

pub fn cache_path(dir: &Path, wasm_sha: &str, fp: &str) -> PathBuf {
    dir.join("cwasm").join(format!("{wasm_sha}-{fp}.cwasm"))
}

static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs the compile child; `Invalid` carries its message, never a path.
pub async fn compile_in_child(
    compiler: &Path,
    kill: Duration,
    wasm: &[u8],
) -> Result<Vec<u8>, LoadError> {
    let _one = ONE.lock().await;
    let mut child = tokio::process::Command::new(compiler)
        .arg(SUBCOMMAND)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| LoadError::Host(format!("cannot start the compiler: {e}")))?;
    let mut stdin = child.stdin.take().expect("piped");
    let (mut stdout, mut stderr) = (
        child.stdout.take().expect("piped"),
        child.stderr.take().expect("piped"),
    );
    let wasm = wasm.to_vec();
    let run = async {
        let feed = async move {
            let _ = stdin.write_all(&wasm).await;
            drop(stdin);
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (_, o, e) = tokio::join!(
            feed,
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err)
        );
        o.map_err(|e| LoadError::Host(e.to_string()))?;
        e.map_err(|e| LoadError::Host(e.to_string()))?;
        let status = child
            .wait()
            .await
            .map_err(|e| LoadError::Host(e.to_string()))?;
        if status.success() {
            Ok(out)
        } else {
            let msg = String::from_utf8_lossy(&err).trim().to_owned();
            Err(LoadError::Invalid(if msg.is_empty() {
                format!("compiler exited with {status}")
            } else {
                msg
            }))
        }
    };
    match tokio::time::timeout(kill, run).await {
        Ok(r) => r,
        Err(_) => Err(LoadError::Invalid("compile timed out".into())),
    }
}

async fn compile(env: &Env, wasm: &[u8]) -> Result<Vec<u8>, LoadError> {
    #[cfg(feature = "parity")]
    if env.cfg.compile_in_process {
        let (engine, wasm) = (env.engine.clone(), wasm.to_vec());
        return tokio::task::spawn_blocking(move || engine.precompile_component(&wasm))
            .await
            .map_err(|e| LoadError::Host(e.to_string()))?
            .map_err(|e| LoadError::Invalid(format!("{e:#}")));
    }
    compile_in_child(&env.cfg.compiler, env.cfg.compile_kill, wasm).await
}

/// The component from the cache when the row authenticates the file, else compiled and cached.
pub async fn load(env: &Env, id: &str, wasm: &[u8]) -> Result<Loaded, LoadError> {
    let engine = &env.engine;
    let fp = fingerprint(engine);
    let path = cache_path(&env.cfg.runtime_dir, &sha256_hex(wasm), &fp);
    let host = |e: sqlx::Error| LoadError::Host(e.to_string());
    let (sha, eng): (Option<String>, Option<String>) = sqlx::query_as(
        r#"SELECT "cwasmSha256", "cwasmEngine" FROM plugin_packages WHERE "pluginId" = $1"#,
    )
    .bind(id)
    .fetch_one(&env.core)
    .await
    .map_err(host)?;
    let t = Instant::now();
    if eng.as_deref() == Some(fp.as_str())
        && let Ok(bytes) = tokio::fs::read(&path).await
        && sha.as_deref() == Some(sha256_hex(&bytes).as_str())
    {
        // SAFETY: the bytes are the ones this host serialised, authenticated by the row's sha256.
        match unsafe { Component::deserialize(engine, &bytes) } {
            Ok(component) => {
                return Ok(Loaded {
                    component,
                    elapsed: t.elapsed(),
                    cache_hit: true,
                });
            }
            Err(e) => tracing::warn!("plugin \"{id}\" cached component refused ({e}); recompiling"),
        }
    }
    let bytes = compile(env, wasm).await?;
    let elapsed = t.elapsed();
    let dir = path.parent().expect("cwasm dir").to_path_buf();
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        set_mode(&dir, 0o700);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &bytes)?;
        set_mode(&tmp, 0o600);
        std::fs::rename(&tmp, &path)
    };
    write().map_err(|e| LoadError::Host(format!("cannot write the component cache: {e}")))?;
    sqlx::query(r#"UPDATE plugin_packages SET "cwasmSha256" = $2, "cwasmEngine" = $3 WHERE "pluginId" = $1"#)
        .bind(id)
        .bind(sha256_hex(&bytes))
        .bind(&fp)
        .execute(&env.core)
        .await
        .map_err(host)?;
    // SAFETY: produced by our own compiler image from the archive's checked bytes, hashed above.
    let component = unsafe { Component::deserialize(engine, &bytes) }
        .map_err(|e| LoadError::Host(format!("compiled component refused: {e}")))?;
    Ok(Loaded {
        component,
        elapsed,
        cache_hit: false,
    })
}

/// Removes cache files no installed package's wasm matches (boot, uninstall).
pub fn sweep(dir: &Path, keep: &[String]) {
    let Ok(rd) = std::fs::read_dir(dir.join("cwasm")) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !keep.iter().any(|k| name.starts_with(&format!("{k}-"))) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
