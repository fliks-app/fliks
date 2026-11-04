//! A minimal read-only libarchive reader for 7z and RAR (`docs/spec/comics.md`, rule 22): the only
//! `unsafe` of the comic code. Formats are limited to 7zip, rar and rar5, with no filter and so no
//! external program; nothing is extracted, entries are read through `read`.
use libarchive2_sys as sys;
use std::{
    ffi::{CStr, CString},
    os::{fd::AsFd, raw::c_void, unix::ffi::OsStrExt},
    path::Path,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Fail {
    /// Not an archive libarchive reads, or a read error.
    Corrupt,
    /// The reads exceeded the budget.
    TooLarge,
}

pub struct Header {
    /// UTF-8, whatever the process locale; `None` when the archive has no name for the entry.
    pub name: Option<String>,
    pub regular: bool,
    /// A directory: rar5 refuses to read one, so it is skipped.
    pub dir: bool,
    pub hardlink: bool,
    pub encrypted: bool,
    /// The size the header declares.
    pub size: u64,
}

pub struct Reader {
    raw: *mut sys::archive,
    budget: u64,
    utf8: Option<Utf8>,
}

/// A thread-local UTF-8 locale for as long as the reader lives: libarchive converts 7z and RAR
/// names to the current locale, and under the image's C locale it drops the non-ASCII ones.
struct Utf8 {
    prev: libc::locale_t,
}

/// The `C.UTF-8` locale, made once and never freed (0 when the system has none).
static UTF8_LOCALE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

impl Utf8 {
    fn enter() -> Option<Self> {
        let loc = *UTF8_LOCALE.get_or_init(|| {
            // SAFETY: static NUL-terminated name; a null result is checked.
            let loc = unsafe {
                libc::newlocale(
                    libc::LC_CTYPE_MASK,
                    c"C.UTF-8".as_ptr(),
                    std::ptr::null_mut(),
                )
            };
            if loc.is_null() {
                tracing::warn!(
                    "no C.UTF-8 locale: non-ASCII names in 7z and RAR archives are lost"
                );
            }
            loc as usize
        });
        if loc == 0 {
            return None;
        }
        // SAFETY: `loc` is a valid locale that lives for the process; `prev` is restored on drop.
        let prev = unsafe { libc::uselocale(loc as libc::locale_t) };
        Some(Self { prev })
    }
}

impl Drop for Utf8 {
    fn drop(&mut self) {
        // SAFETY: restores the locale this thread had.
        unsafe { libc::uselocale(self.prev) };
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        // SAFETY: `raw` came from `archive_read_new` and is freed exactly once, here.
        unsafe { sys::archive_read_free(self.raw) };
        self.utf8 = None;
    }
}

fn ok(code: std::os::raw::c_int) -> bool {
    code == sys::ARCHIVE_OK as std::os::raw::c_int
}

/// A C string as UTF-8, lossily.
///
/// # Safety
/// `p` is null or a NUL-terminated string that outlives the call.
unsafe fn text(p: *const std::os::raw::c_char) -> Option<String> {
    // SAFETY: the caller's contract.
    (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

/// Where an archive is read from: a path, or the descriptor the parent opened and passed as stdin
/// (the sandboxed child has no path to open).
pub enum Src<'a> {
    Path(&'a Path),
    Stdin,
}

impl Src<'_> {
    /// The size of the archive file.
    pub fn len(&self) -> u64 {
        match self {
            Src::Path(p) => std::fs::metadata(p).map_or(0, |m| m.len()),
            Src::Stdin => std::io::stdin()
                .as_fd()
                .try_clone_to_owned()
                .ok()
                .and_then(|fd| std::fs::File::from(fd).metadata().ok())
                .map_or(0, |m| m.len()),
        }
    }
}

/// Makes the `C.UTF-8` locale now, so that its absence is logged once by a process that logs.
pub fn probe_locale() {
    drop(Utf8::enter());
}

impl Reader {
    /// Opens the archive for reading; every byte `read` returns counts against `budget`.
    pub fn open(src: &Src<'_>, budget: u64) -> Result<Self, Fail> {
        // A descriptor of its own at offset 0: one process may read the archive several times.
        let fd = match src {
            Src::Stdin => {
                // SAFETY: dup and lseek on descriptor 0, the archive file the parent passed.
                let fd = unsafe { libc::dup(0) };
                if fd < 0 || unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
                    return Err(Fail::Corrupt);
                }
                fd
            }
            Src::Path(_) => -1,
        };
        let c = match src {
            Src::Path(p) => {
                Some(CString::new(p.as_os_str().as_bytes()).map_err(|_| Fail::Corrupt)?)
            }
            Src::Stdin => None,
        };
        // SAFETY: no arguments; a null result is checked.
        let raw = unsafe { sys::archive_read_new() };
        if raw.is_null() {
            return Err(Fail::Corrupt);
        }
        let r = Self {
            raw,
            budget,
            utf8: Utf8::enter(),
        };
        // SAFETY: `raw` is a live read handle; `c` is NUL-terminated and outlives the open call;
        // `fd` is a duplicate of the archive file the parent passed as stdin.
        let opened = unsafe {
            ok(sys::archive_read_support_format_7zip(raw))
                && ok(sys::archive_read_support_format_rar(raw))
                && ok(sys::archive_read_support_format_rar5(raw))
                && match &c {
                    Some(c) => ok(sys::archive_read_open_filename(raw, c.as_ptr(), 64 * 1024)),
                    None => ok(sys::archive_read_open_fd(raw, fd, 64 * 1024)),
                }
        };
        if opened { Ok(r) } else { Err(Fail::Corrupt) }
    }

    /// The next entry, `None` at the end. A warning (a name the locale cannot convert, say) is
    /// not an error.
    pub fn next(&mut self) -> Result<Option<Header>, Fail> {
        let mut entry: *mut sys::archive_entry = std::ptr::null_mut();
        // SAFETY: `raw` is live and `entry` is a valid out pointer.
        let code = unsafe { sys::archive_read_next_header(self.raw, &mut entry) };
        if code == sys::ARCHIVE_EOF as std::os::raw::c_int {
            return Ok(None);
        }
        if (!ok(code) && code != sys::ARCHIVE_WARN) || entry.is_null() {
            return Err(Fail::Corrupt);
        }
        // SAFETY: `entry` is valid until the next header call; the strings are copied out here.
        unsafe {
            let name = text(sys::archive_entry_pathname_utf8(entry))
                .or_else(|| text(sys::archive_entry_pathname(entry)));
            Ok(Some(Header {
                name,
                regular: sys::archive_entry_filetype(entry) & 0o170000 == 0o100000,
                dir: sys::archive_entry_filetype(entry) & 0o170000 == 0o040000,
                hardlink: !sys::archive_entry_hardlink(entry).is_null(),
                encrypted: sys::archive_entry_is_encrypted(entry) != 0,
                size: u64::try_from(sys::archive_entry_size(entry)).unwrap_or(0),
            }))
        }
    }

    /// Up to `buf.len()` bytes of the current entry; 0 at its end.
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, Fail> {
        // SAFETY: `raw` is live; `buf` is valid for `buf.len()` writes.
        let n = unsafe {
            sys::archive_read_data(self.raw, buf.as_mut_ptr().cast::<c_void>(), buf.len())
        };
        let n = usize::try_from(n).map_err(|_| Fail::Corrupt)?;
        if n as u64 > self.budget {
            self.budget = 0;
            return Err(Fail::TooLarge);
        }
        self.budget -= n as u64;
        Ok(n)
    }

    /// Reads the rest of the entry. libarchive never skips what the caller does not read: its own
    /// skip would decode a solid block outside the budget.
    pub fn drain(&mut self) -> Result<(), Fail> {
        let mut buf = [0u8; 64 * 1024];
        while self.read(&mut buf)? > 0 {}
        Ok(())
    }
}
