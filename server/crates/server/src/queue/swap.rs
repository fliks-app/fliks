//! The disk half of a commit: the journal and the idempotent swap of a staged output for its source.
//! Every step checks what is on disk first, so a crash at any point is finished by running it again.
use super::settings::OriginalPolicy;
use crate::ingest::fsx;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// What a file was when the journal was written. `dev`/`ino` only speed the match up (0 where the OS has
/// none, and unstable across remounts); the content identity is size, mtime and a hash of both ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ident {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_ns: i64,
    pub ends: String,
}

const END: u64 = 1 << 20;

/// SHA-256 of the first and the last MiB.
fn ends(path: &Path, size: u64) -> io::Result<String> {
    use io::{Read, Seek, SeekFrom};
    use sha2::{Digest, Sha256};
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = Vec::new();
    f.by_ref().take(END).read_to_end(&mut buf)?;
    h.update(&buf);
    if size > END {
        buf.clear();
        f.seek(SeekFrom::Start(size.saturating_sub(END).max(END)))?;
        f.read_to_end(&mut buf)?;
        h.update(&buf);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn stat(m: &fs::Metadata) -> (u64, u64, i64) {
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (m.dev(), m.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i64);
    (dev, ino, mtime)
}

pub fn ident(path: &Path) -> io::Result<Ident> {
    let m = fs::metadata(path)?;
    let (dev, ino, mtime_ns) = stat(&m);
    Ok(Ident {
        dev,
        ino,
        size: m.len(),
        mtime_ns,
        ends: ends(path, m.len())?,
    })
}

/// Whether `path` is the file `id` names: the same inode where the OS gives a stable one, else the same
/// size, mtime and ends (a rename keeps all three).
pub fn is(path: &Path, id: &Ident) -> bool {
    let Ok(m) = fs::metadata(path) else {
        return false;
    };
    let (dev, ino, mtime_ns) = stat(&m);
    if m.len() != id.size {
        return false;
    }
    if ino != 0 && (dev, ino) == (id.dev, id.ino) {
        return true;
    }
    mtime_ns == id.mtime_ns && ends(path, id.size).is_ok_and(|e| e == id.ends)
}

/// What a commit is about to do, written before the disk is touched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub source: PathBuf,
    pub staged: PathBuf,
    /// Where the output ends up: `source`, or the renamed path.
    pub target: PathBuf,
    pub policy: OriginalPolicy,
    pub source_id: Ident,
    pub staged_id: Ident,
    /// The original's second name: `.fliks-trash/<job>.bak` or `<source>.orig`; none for `delete`.
    pub backup: Option<PathBuf>,
    /// Where the original waits when the filesystem cannot hard link.
    pub old: PathBuf,
    /// Companion files that follow a rename, `(from, to)`.
    pub companions: Vec<(PathBuf, PathBuf)>,
}

/// The paths of a commit: the flat trash under the library root, `<source>.orig`, or nothing.
pub fn backup_path(
    policy: OriginalPolicy,
    root: &Path,
    source: &Path,
    job: i64,
) -> Option<PathBuf> {
    match policy {
        OriginalPolicy::Trash => Some(root.join(".fliks-trash").join(format!("{job}.bak"))),
        OriginalPolicy::Keep => {
            let mut n = source.as_os_str().to_owned();
            n.push(".orig");
            Some(PathBuf::from(n))
        }
        OriginalPolicy::Delete => None,
    }
}

pub fn old_path(source: &Path, job: i64) -> PathBuf {
    source.with_file_name(format!(".fliks-opt-{job}.old"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Swapped {
    /// The target holds the output; the original is where the policy put it.
    Done,
    /// Neither the staged output nor a placed output is there: nothing was replaced.
    Nothing,
}

/// Runs, or finishes, the swap. `Err` is a transient failure (a locked file): the journal stays.
pub fn perform(j: &Journal) -> io::Result<Swapped> {
    let placed = is(&j.target, &j.staged_id);
    if !placed {
        if !is(&j.staged, &j.staged_id) {
            return Ok(Swapped::Nothing);
        }
        save_original(j)?;
        if j.target == j.source {
            // The path holds the original or, once it waits at `.old`, nothing: replacing is safe.
            if fs::symlink_metadata(&j.source).is_ok() && !is(&j.source, &j.source_id) {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            fsx::rename_retry(&j.staged, &j.target)?;
        } else {
            fsx::rename_noreplace(&j.staged, &j.target)?;
        }
    }
    settle_original(j)?;
    for (from, to) in &j.companions {
        if fs::symlink_metadata(from).is_ok() && fs::symlink_metadata(to).is_err() {
            fsx::rename_noreplace(from, to)?;
        }
    }
    Ok(Swapped::Done)
}

/// The original gets its second name before the output replaces it: a hard link, or, on a filesystem
/// without them, a move to `.old` (the path is empty for a moment, the journal covers it).
fn save_original(j: &Journal) -> io::Result<()> {
    if !is(&j.source, &j.source_id) {
        return Ok(());
    }
    match &j.backup {
        Some(b) if fs::symlink_metadata(b).is_err() => {
            if fsx::link_new(&j.source, b)?.is_none() {
                fsx::rename_retry(&j.source, &j.old)?;
            }
        }
        Some(_) => {}
        None => {}
    }
    Ok(())
}

/// After the placement: the old name goes (or is moved to its policy place).
fn settle_original(j: &Journal) -> io::Result<()> {
    if j.source != j.target && is(&j.source, &j.source_id) {
        fs::remove_file(&j.source)?;
    }
    if fs::symlink_metadata(&j.old).is_ok() {
        match &j.backup {
            Some(b) if fs::symlink_metadata(b).is_err() => {
                fs::create_dir_all(b.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
                fsx::move_file(&j.old, b, false)?;
            }
            _ => fs::remove_file(&j.old)?,
        }
    }
    Ok(())
}

/// Gives the original its place back after a swap that placed nothing: `.old` returns to the source
/// path and a backup link of the unchanged source goes.
pub fn abort(j: &Journal) -> io::Result<()> {
    if is(&j.target, &j.staged_id) {
        return Ok(());
    }
    if fs::symlink_metadata(&j.source).is_err() && is(&j.old, &j.source_id) {
        fsx::rename_noreplace(&j.old, &j.source)?;
    }
    if let Some(b) = &j.backup
        && is(&j.source, &j.source_id)
        && same_file(b, &j.source)
    {
        fs::remove_file(b)?;
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => (x.dev(), x.ino()) == (y.dev(), y.ino()),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(_: &Path, _: &Path) -> bool {
    false
}

/// The optimized file of a restore waits here, never under the name that holds the original.
pub fn optimized_slot(root: &Path, job: i64) -> PathBuf {
    root.join(".fliks-trash")
        .join(format!("{job}.optimized.bak"))
}

/// A restore, written before the disk is touched: the original comes back to `source`, the optimized
/// file goes to `slot`, renamed companions return to their old names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Restore {
    pub target: PathBuf,
    pub source: PathBuf,
    pub back: PathBuf,
    pub slot: PathBuf,
    pub optimized: Ident,
    pub original: Ident,
    pub companions: Vec<(PathBuf, PathBuf)>,
}

impl Restore {
    fn parked(&self) -> PathBuf {
        let mut n = self.back.as_os_str().to_owned();
        n.push(".restoring");
        PathBuf::from(n)
    }

    /// Both files are where the job left them.
    pub fn startable(&self) -> bool {
        is(&self.target, &self.optimized) && is(&self.back, &self.original)
    }
}

/// Runs, or finishes, a restore; every step looks at the disk first.
pub fn perform_restore(r: &Restore) -> io::Result<()> {
    let parked = r.parked();
    let started = fs::symlink_metadata(&parked).is_ok() || is(&r.source, &r.original);
    if !started && !r.startable() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is not the one the job produced",
        ));
    }
    if is(&r.target, &r.optimized) {
        fsx::rename_retry(&r.target, &parked)?;
    }
    if is(&r.back, &r.original) && fs::symlink_metadata(&r.source).is_err() {
        fsx::rename_noreplace(&r.back, &r.source)?;
    }
    if fs::symlink_metadata(&parked).is_ok() && fs::symlink_metadata(&r.slot).is_err() {
        fs::create_dir_all(r.slot.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        fsx::rename_noreplace(&parked, &r.slot)?;
    }
    for (from, to) in &r.companions {
        if fs::symlink_metadata(from).is_ok() && fs::symlink_metadata(to).is_err() {
            fsx::rename_noreplace(from, to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world(policy: OriginalPolicy) -> (PathBuf, Journal) {
        let d = std::env::temp_dir().join(format!(
            "fliks-swap-{}-{}",
            std::process::id(),
            fsx::tmp_name()
        ));
        fs::create_dir_all(&d).unwrap();
        let (source, staged) = (d.join("a.mkv"), d.join(".fliks-opt-7-1.tmp"));
        fs::write(&source, b"original").unwrap();
        fs::write(&staged, b"new").unwrap();
        let j = Journal {
            source_id: ident(&source).unwrap(),
            staged_id: ident(&staged).unwrap(),
            backup: backup_path(policy, &d, &source, 7),
            old: old_path(&source, 7),
            target: source.clone(),
            source,
            staged,
            policy,
            companions: vec![],
        };
        (d, j)
    }

    #[test]
    fn trash_keeps_the_original_under_a_second_name() {
        let (d, j) = world(OriginalPolicy::Trash);
        assert_eq!(perform(&j).unwrap(), Swapped::Done);
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        assert_eq!(fs::read(j.backup.as_ref().unwrap()).unwrap(), b"original");
        assert!(!j.staged.exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn keep_leaves_an_existing_orig_alone() {
        let (d, j) = world(OriginalPolicy::Keep);
        let orig = j.backup.clone().unwrap();
        fs::write(&orig, b"first original").unwrap();
        perform(&j).unwrap();
        assert_eq!(fs::read(&orig).unwrap(), b"first original");
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn delete_drops_the_original() {
        let (d, j) = world(OriginalPolicy::Delete);
        perform(&j).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_crash_after_the_backup_is_finished_by_running_again() {
        let (d, j) = world(OriginalPolicy::Trash);
        save_original(&j).unwrap();
        assert_eq!(perform(&j).unwrap(), Swapped::Done);
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        assert_eq!(perform(&j).unwrap(), Swapped::Done);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_crash_between_the_move_and_the_placement_is_finished() {
        let (d, j) = world(OriginalPolicy::Trash);
        fs::rename(&j.source, &j.old).unwrap();
        assert_eq!(perform(&j).unwrap(), Swapped::Done);
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        assert_eq!(fs::read(j.backup.as_ref().unwrap()).unwrap(), b"original");
        assert!(!j.old.exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn nothing_is_replaced_when_the_output_is_gone() {
        let (d, j) = world(OriginalPolicy::Trash);
        fs::remove_file(&j.staged).unwrap();
        assert_eq!(perform(&j).unwrap(), Swapped::Nothing);
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn other_hard_links_keep_the_old_bytes() {
        let (d, j) = world(OriginalPolicy::Delete);
        let other = d.join("seeding.mkv");
        fs::hard_link(&j.source, &other).unwrap();
        perform(&j).unwrap();
        assert_eq!(fs::read(&other).unwrap(), b"original");
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_rename_places_the_output_under_the_new_name_and_moves_companions() {
        let (d, mut j) = world(OriginalPolicy::Trash);
        j.target = d.join("b.mkv");
        let (from, to) = (d.join("a.fr.srt"), d.join("b.fr.srt"));
        fs::write(&from, b"sub").unwrap();
        j.companions = vec![(from.clone(), to.clone())];
        perform(&j).unwrap();
        assert_eq!(fs::read(&j.target).unwrap(), b"new");
        assert!(!j.source.exists() && !from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"sub");
        assert_eq!(fs::read(j.backup.as_ref().unwrap()).unwrap(), b"original");
        fs::remove_dir_all(d).unwrap();
    }

    fn restore_of(j: &Journal, slot: PathBuf) -> Restore {
        Restore {
            target: j.target.clone(),
            source: j.source.clone(),
            back: j.backup.clone().unwrap(),
            slot,
            optimized: j.staged_id.clone(),
            original: j.source_id.clone(),
            companions: vec![],
        }
    }

    #[cfg(unix)]
    #[test]
    fn abort_undoes_a_swap_that_placed_nothing() {
        let (d, j) = world(OriginalPolicy::Trash);
        save_original(&j).unwrap();
        let b = j.backup.clone().unwrap();
        assert!(b.exists());
        abort(&j).unwrap();
        assert!(!b.exists());
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        // Hidden at `.old` (no hard links): it comes back.
        fs::rename(&j.source, &j.old).unwrap();
        abort(&j).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        // Once placed, nothing is undone.
        perform(&j).unwrap();
        abort(&j).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"new");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn restore_swaps_back_only_the_file_the_job_produced() {
        let (d, j) = world(OriginalPolicy::Trash);
        perform(&j).unwrap();
        let r = restore_of(&j, j.backup.clone().unwrap());
        perform_restore(&r).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        assert_eq!(fs::read(&r.slot).unwrap(), b"new");
        perform_restore(&r).unwrap();
        fs::write(&j.source, b"edited elsewhere").unwrap();
        assert!(!r.startable());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_restore_under_keep_leaves_the_original_out_of_orig() {
        let (d, j) = world(OriginalPolicy::Keep);
        perform(&j).unwrap();
        let slot = d.join(".fliks-trash").join("7.bak");
        let r = restore_of(&j, slot.clone());
        perform_restore(&r).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        assert_eq!(fs::read(&slot).unwrap(), b"new");
        assert!(!r.back.exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_crash_midway_through_a_restore_is_finished() {
        let (d, j) = world(OriginalPolicy::Trash);
        perform(&j).unwrap();
        let r = restore_of(&j, j.backup.clone().unwrap());
        fs::rename(&r.target, r.parked()).unwrap();
        perform_restore(&r).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        assert_eq!(fs::read(&r.slot).unwrap(), b"new");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn identity_survives_a_changed_device_and_a_metadata_edit_does_not_pass_for_the_source() {
        let (d, mut j) = world(OriginalPolicy::Trash);
        j.staged_id.dev += 1;
        j.staged_id.ino += 1;
        assert!(is(&j.staged, &j.staged_id));
        let same_size = d.join("same-size.mkv");
        fs::write(&same_size, b"origina!").unwrap();
        assert!(!is(&same_size, &j.source_id));
        fs::remove_dir_all(d).unwrap();
    }
}
