//! The disk half of a commit: the journal and the idempotent swap of a staged output for its source.
//! Every step checks what is on disk first, so a crash at any point is finished by running it again.
use super::settings::OriginalPolicy;
use crate::ingest::fsx;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Which inode a path was when the journal was written; `dev`/`ino` are 0 where the OS has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ident {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
}

pub fn ident(path: &Path) -> io::Result<Ident> {
    let m = fs::metadata(path)?;
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (m.dev(), m.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);
    Ok(Ident {
        dev,
        ino,
        size: m.len(),
    })
}

/// Whether `path` is the inode `id` names (the size only, where the OS gives no inode).
pub fn is(path: &Path, id: &Ident) -> bool {
    ident(path).is_ok_and(|n| {
        if id.ino == 0 {
            n.size == id.size
        } else {
            (n.dev, n.ino) == (id.dev, id.ino)
        }
    })
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
        if j.target == j.source && is(&j.source, &j.source_id) {
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

/// Puts the original back at `source` and the current file in the trash slot, for a restore: the output
/// must still be the file the job produced (`staged_id`).
pub fn restore(j: &Journal, back: &Path) -> io::Result<()> {
    if !is(&j.target, &j.staged_id) || !is(back, &j.source_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is not the one the job produced",
        ));
    }
    let parked = back.with_extension("restoring");
    fsx::rename_retry(&j.target, &parked)?;
    if let Err(e) = fsx::rename_noreplace(back, &j.source) {
        let _ = fsx::rename_noreplace(&parked, &j.target);
        return Err(e);
    }
    fsx::rename_noreplace(&parked, back)
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

    #[test]
    fn restore_swaps_back_only_the_file_the_job_produced() {
        let (d, j) = world(OriginalPolicy::Trash);
        perform(&j).unwrap();
        let b = j.backup.clone().unwrap();
        restore(&j, &b).unwrap();
        assert_eq!(fs::read(&j.source).unwrap(), b"original");
        assert_eq!(fs::read(&b).unwrap(), b"new");
        fs::write(&j.source, b"edited elsewhere").unwrap();
        assert!(restore(&j, &b).is_err());
        fs::remove_dir_all(d).unwrap();
    }
}
