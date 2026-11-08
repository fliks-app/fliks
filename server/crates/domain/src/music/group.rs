//! Audio files into album candidates (`docs/spec/music.md`, section Grouping). Pure.
use std::collections::BTreeMap;

/// A file of the scan, `/`-separated relative to its folder root, with the album its tags name.
#[derive(Debug, Clone)]
pub struct Entry {
    pub rel: String,
    /// Normalised album and album artist, or the release id: files of the root are told apart by it.
    pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Album {
    /// The album folder with its disc folders taken off, `""` for files at the root.
    pub dir: String,
    pub key: Option<String>,
    /// Sorted by natural order of the path.
    pub files: Vec<String>,
    /// No other album holds this folder or one below it: the media is named by its folder.
    pub anchored: bool,
}

/// `CD1`, `Disc 2`, `Disk 1`, `Disque 1`, any case, the space optional.
pub fn is_disc_folder(seg: &str) -> bool {
    let s = seg.to_lowercase();
    ["cd", "disc", "disk", "disque"].iter().any(|p| {
        s.strip_prefix(p)
            .is_some_and(|n| !n.trim().is_empty() && n.trim().bytes().all(|b| b.is_ascii_digit()))
    })
}

/// The folder of a file, the disc folders off.
pub fn album_dir(rel: &str) -> String {
    let mut segs: Vec<&str> = rel.split('/').collect();
    segs.pop();
    while segs.last().is_some_and(|s| is_disc_folder(s)) {
        segs.pop();
    }
    segs.join("/")
}

/// The number of the innermost disc folder above a file (`CD 2/01.flac` is 2), when it has one.
pub fn disc_of_folder(rel: &str) -> Option<i32> {
    let mut segs: Vec<&str> = rel.split(['/', '\\']).collect();
    segs.pop();
    let seg = segs.pop().filter(|s| is_disc_folder(s))?;
    let n: String = seg.chars().filter(char::is_ascii_digit).collect();
    n.parse().ok().filter(|d| (1..=999).contains(d))
}

/// Digit runs compare as numbers, so `2` sorts before `10`.
fn natural(s: &str) -> Vec<(u64, String)> {
    let mut out = vec![];
    let lower = s.to_lowercase();
    let mut rest = lower.as_str();
    while !rest.is_empty() {
        let digits = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if digits > 0 {
            out.push((rest[..digits].parse().unwrap_or(u64::MAX), String::new()));
            rest = &rest[digits..];
        } else {
            let text = rest
                .find(|c: char| c.is_ascii_digit())
                .unwrap_or(rest.len());
            out.push((0, rest[..text].to_owned()));
            rest = &rest[text..];
        }
    }
    out
}

/// A folder holds one album, whatever its tags say; the files at the root make one album per key.
pub fn group(entries: &[Entry]) -> Vec<Album> {
    let mut by: BTreeMap<(String, Option<String>), Vec<String>> = BTreeMap::new();
    for e in entries {
        let dir = album_dir(&e.rel);
        let key = if dir.is_empty() { e.key.clone() } else { None };
        by.entry((dir, key)).or_default().push(e.rel.clone());
    }
    let dirs: Vec<String> = by.keys().map(|(d, _)| d.clone()).collect();
    by.into_iter()
        .map(|((dir, key), mut files)| {
            files.sort_by_key(|f| natural(f));
            let anchored = !dir.is_empty()
                && dirs
                    .iter()
                    .filter(|d| **d == dir || d.starts_with(&format!("{dir}/")))
                    .count()
                    == 1;
            Album {
                dir,
                key,
                files,
                anchored,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(rel: &str, key: Option<&str>) -> Entry {
        Entry {
            rel: rel.into(),
            key: key.map(str::to_owned),
        }
    }

    #[test]
    fn disc_folders_belong_to_their_album() {
        let a = group(&[
            e("Ana/Alpha/CD 1/01.flac", None),
            e("Ana/Alpha/CD 2/01.flac", None),
            e("Ana/Alpha/cover.jpg", None),
            e("Ana/Beta/01.flac", None),
        ]);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].dir, "Ana/Alpha");
        assert_eq!(a[0].files.len(), 3);
        assert!(a.iter().all(|x| x.anchored));
        assert_eq!(album_dir("x/Disque 3/a.mp3"), "x");
        assert_eq!(album_dir("x/CDs/a.mp3"), "x/CDs");
        assert_eq!(disc_of_folder("x/Disque 3/a.mp3"), Some(3));
        assert_eq!(disc_of_folder("x/CD2\\a.mp3"), Some(2));
        assert_eq!(disc_of_folder("x/CDs/a.mp3"), None);
        assert_eq!(disc_of_folder("a.mp3"), None);
    }

    #[test]
    fn the_root_is_split_by_tags_and_a_nested_album_unanchors_its_parent() {
        let a = group(&[
            e("a.mp3", Some("alpha")),
            e("b.mp3", Some("beta")),
            e("c.mp3", Some("alpha")),
            e("Ana/loose.mp3", None),
            e("Ana/Alpha/01.mp3", None),
        ]);
        assert_eq!(a.len(), 4);
        let root: Vec<_> = a.iter().filter(|x| x.dir.is_empty()).collect();
        assert_eq!(root.len(), 2);
        assert!(root.iter().all(|x| !x.anchored));
        let ana = a.iter().find(|x| x.dir == "Ana").unwrap();
        let alpha = a.iter().find(|x| x.dir == "Ana/Alpha").unwrap();
        assert!(!ana.anchored && alpha.anchored);
    }

    #[test]
    fn files_are_in_natural_order() {
        let a = group(&[e("A/10.mp3", None), e("A/2.mp3", None), e("A/1.mp3", None)]);
        assert_eq!(a[0].files, ["A/1.mp3", "A/2.mp3", "A/10.mp3"]);
    }
}
