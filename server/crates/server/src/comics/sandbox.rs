//! The libarchive reads of 7z and RAR in a child process (`docs/spec/comics.md`, rule 22): libarchive
//! allocates from header counts before the server sees an entry, so a few kilobytes of hostile 7z
//! can ask for gigabytes, and a memory-safety bug stays in the child. The server re-executes its own
//! image as a hidden subcommand. Isolated: allocation (`RLIMIT_AS`), CPU (`RLIMIT_CPU` and a
//! wall-clock kill), crashes, privileges (the child runs as `nobody` when the server is root, with
//! no new privileges, and is killed with its parent), file writes (`RLIMIT_FSIZE` 0), and the
//! archive path (the parent opens the file and passes it as stdin). Not isolated: the network and
//! the rest of the filesystem a `nobody` may read; there is no seccomp filter yet. Budgets, caches
//! and the job slots stay in the parent.
use super::{
    ar::Src,
    archive::{Error, Listing, MAX_ENTRY_BYTES, MAX_PAGES, Page, SOLID_CACHE_BYTES, local},
};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, BufWriter, Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub const SUBCOMMAND: &str = "comic-archive";
/// Address space of the child.
const CHILD_MEMORY: u64 = 1024 * 1024 * 1024;
const CHILD_CPU_SECS: u64 = 120;
const CHILD_WALL: Duration = Duration::from_secs(120);
/// The user and group of the child when the server runs as root.
const NOBODY: u32 = 65534;

static EXE: OnceLock<PathBuf> = OnceLock::new();

/// The image the child runs, for a host that is not the server binary (the integration tests).
pub fn set_exe(path: PathBuf) {
    let _ = EXE.set(path);
}

/// The child path is the production one; the unit tests of the lib read in process.
pub fn enabled() -> bool {
    !cfg!(test) || EXE.get().is_some()
}

/// The running image as a real path: a child that dropped its privileges cannot follow
/// `/proc/self/exe`.
fn exe() -> PathBuf {
    EXE.get().cloned().unwrap_or_else(|| {
        std::fs::read_link("/proc/self/exe")
            .unwrap_or_else(|_| crate::plugins::compile::own_image())
    })
}

fn code(e: &Error) -> u8 {
    match e {
        Error::Corrupt => 1,
        Error::TooLarge => 2,
        Error::Unsupported("encrypted") => 3,
        Error::NoPages => 4,
        Error::Missing => 5,
        Error::Unsupported(_) => 6,
    }
}

fn error_of(c: u8) -> Error {
    match c {
        2 => Error::TooLarge,
        3 => Error::Unsupported("encrypted"),
        4 => Error::NoPages,
        5 => Error::Missing,
        6 => Error::Unsupported("libarchive"),
        _ => Error::Corrupt,
    }
}

// ---- the child ----

/// The hidden subcommand: `comic-archive <list|count|page|page-at> <n>`, the archive on stdin, the
/// answer on stdout.
pub fn child_main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(2).collect();
    let [op, n] = args.as_slice() else {
        return ExitCode::from(2);
    };
    let n: usize = n.to_str().and_then(|n| n.parse().ok()).unwrap_or(0);
    let path = &Src::Stdin;
    let mut out = BufWriter::new(io::stdout().lock());
    let wrote = match op.to_str() {
        Some("list") => answer(&mut out, local::list(path), write_listing),
        Some("count") => answer(&mut out, local::names(path), |w, n| {
            w.write_all(&(n.len() as u64).to_le_bytes())
        }),
        Some("page") => answer(&mut out, local::page(path, n), |w, b| write_bytes(w, b)),
        Some("page-at") => answer(&mut out, local::page_at(path, n), |w, b| write_bytes(w, b)),
        _ => return ExitCode::from(2),
    };
    match wrote.and_then(|()| out.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

fn answer<T>(
    w: &mut impl Write,
    r: Result<T, Error>,
    put: impl FnOnce(&mut dyn Write, &T) -> io::Result<()>,
) -> io::Result<()> {
    match r {
        Ok(v) => {
            w.write_all(&[0])?;
            put(w, &v)
        }
        Err(e) => w.write_all(&[code(&e)]),
    }
}

fn write_bytes(w: &mut dyn Write, b: &[u8]) -> io::Result<()> {
    w.write_all(&(b.len() as u64).to_le_bytes())?;
    w.write_all(b)
}

fn write_listing(w: &mut dyn Write, l: &Listing) -> io::Result<()> {
    w.write_all(&(l.pages.len() as u32).to_le_bytes())?;
    for p in &l.pages {
        w.write_all(&p.width.to_le_bytes())?;
        w.write_all(&p.height.to_le_bytes())?;
    }
    for o in l.ordinals.iter().flatten() {
        w.write_all(&(*o as u32).to_le_bytes())?;
    }
    w.write_all(&[u8::from(l.solid.is_some())])?;
    for b in l.solid.iter().flatten() {
        write_bytes(w, b)?;
    }
    Ok(())
}

// ---- the parent ----

fn limits() -> io::Result<()> {
    let set = |what: libc::__rlimit_resource_t, v: u64| {
        let l = libc::rlimit {
            rlim_cur: v,
            rlim_max: v,
        };
        // SAFETY: setrlimit is async-signal-safe and `l` is a valid struct.
        unsafe { libc::setrlimit(what, &l) };
    };
    set(libc::RLIMIT_AS, CHILD_MEMORY);
    set(libc::RLIMIT_CPU, CHILD_CPU_SECS);
    set(libc::RLIMIT_CORE, 0);
    set(libc::RLIMIT_FSIZE, 0);
    // SAFETY: prctl and close_range are plain syscalls; a failure leaves the close-on-exec
    // descriptors and the default death signal.
    unsafe {
        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
        // CLOEXEC rather than close: std's exec-error pipe survives, so a failed exec is reported.
        libc::syscall(libc::SYS_close_range, 3, u32::MAX, 4);
    }
    Ok(())
}

/// Runs one child on the archive and parses its answer from the pipe as it arrives; at most
/// `limit` bytes are read. A child that is killed, limited or cut short is an unreadable archive.
fn call<T>(
    op: &str,
    path: &Path,
    n: usize,
    limit: u64,
    parse: impl FnOnce(&mut dyn Read) -> Result<T, Error>,
) -> Result<T, Error> {
    static LOCALE: std::sync::Once = std::sync::Once::new();
    // The child has no log subscriber: the parent reports a missing C.UTF-8 once.
    LOCALE.call_once(super::ar::probe_locale);
    let archive = File::open(path).map_err(|_| Error::Missing)?;
    let mut cmd = Command::new(exe());
    cmd.arg(SUBCOMMAND)
        .arg(op)
        .arg(n.to_string())
        .env_clear()
        .stdin(Stdio::from(archive))
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        // std drops the supplementary groups when it changes the user of a root process.
        cmd.uid(NOBODY).gid(NOBODY);
    }
    // SAFETY: `limits` makes only async-signal-safe calls between fork and exec.
    unsafe { cmd.pre_exec(limits) };
    let mut child = cmd.spawn().map_err(|e| {
        tracing::warn!("comic archive child cannot start: {e}");
        Error::Corrupt
    })?;
    let pid = child.id() as libc::pid_t;
    // `reaped` is set, under its lock, before the child is waited for: the watcher kills only while
    // the pid is still ours, so a reused pid is never hit.
    let reaped = Arc::new(Mutex::new(false));
    let watch = reaped.clone();
    let spawned = std::thread::Builder::new().spawn(move || {
        let deadline = std::time::Instant::now() + CHILD_WALL;
        while std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            if *watch.lock().unwrap_or_else(|e| e.into_inner()) {
                return;
            }
        }
        let gone = watch.lock().unwrap_or_else(|e| e.into_inner());
        if !*gone {
            // SAFETY: a plain kill of our own unreaped child.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    });
    let Some(mut out) = child.stdout.take().filter(|_| spawned.is_ok()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Error::Corrupt);
    };
    let mut pipe = (&mut out).take(limit);
    let parsed = parse(&mut pipe);
    let over = pipe.limit() == 0;
    *reaped.lock().unwrap_or_else(|e| e.into_inner()) = true;
    let exited = child.try_wait().ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    match parsed {
        Ok(_) if over => Err(Error::TooLarge),
        Err(Error::Corrupt) => {
            tracing::warn!("comic archive child {op} gave no answer (exit {exited:?})");
            Err(Error::Corrupt)
        }
        r => r,
    }
}

fn u8_of(r: &mut dyn Read) -> Result<u8, Error> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b).map_err(|_| Error::Corrupt)?;
    Ok(b[0])
}

fn u32_of(r: &mut dyn Read) -> Result<u32, Error> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|_| Error::Corrupt)?;
    Ok(u32::from_le_bytes(b))
}

fn u64_of(r: &mut dyn Read) -> Result<u64, Error> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).map_err(|_| Error::Corrupt)?;
    Ok(u64::from_le_bytes(b))
}

/// A length-prefixed byte string of at most one entry.
fn bytes_of(r: &mut dyn Read) -> Result<Vec<u8>, Error> {
    let n = u64_of(r)?;
    if n > MAX_ENTRY_BYTES {
        return Err(Error::Corrupt);
    }
    let mut b = vec![0u8; n as usize];
    r.read_exact(&mut b).map_err(|_| Error::Corrupt)?;
    Ok(b)
}

fn status(r: &mut dyn Read) -> Result<(), Error> {
    match u8_of(r)? {
        0 => Ok(()),
        c => Err(error_of(c)),
    }
}

pub fn list(path: &Path) -> Result<Listing, Error> {
    call("list", path, 0, SOLID_CACHE_BYTES + (1 << 20), |r| {
        status(r)?;
        let n = u32_of(r)? as usize;
        if n > MAX_PAGES {
            return Err(Error::Corrupt);
        }
        let mut pages = Vec::with_capacity(n);
        for _ in 0..n {
            pages.push(Page {
                width: u32_of(r)?,
                height: u32_of(r)?,
            });
        }
        let ordinals = (0..n)
            .map(|_| u32_of(r).map(|o| o as usize))
            .collect::<Result<Vec<_>, _>>()?;
        let solid = if u8_of(r)? == 1 {
            Some((0..n).map(|_| bytes_of(r)).collect::<Result<Vec<_>, _>>()?)
        } else {
            None
        };
        Ok(Listing {
            pages,
            ordinals: Some(ordinals),
            solid,
        })
    })
}

pub fn count(path: &Path) -> Result<usize, Error> {
    call("count", path, 0, 64, |r| {
        status(r)?;
        let n = u64_of(r)?;
        if n > MAX_PAGES as u64 {
            return Err(Error::Corrupt);
        }
        Ok(n as usize)
    })
}

pub fn page(path: &Path, index: usize) -> Result<Vec<u8>, Error> {
    call("page", path, index, MAX_ENTRY_BYTES + (1 << 20), |r| {
        status(r)?;
        bytes_of(r)
    })
}

pub fn page_at(path: &Path, ordinal: usize) -> Result<Vec<u8>, Error> {
    call("page-at", path, ordinal, MAX_ENTRY_BYTES + (1 << 20), |r| {
        status(r)?;
        bytes_of(r)
    })
}
