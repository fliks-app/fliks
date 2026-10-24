//! Pure rules of the catalog read routes (`docs/spec/media-query.md`).
pub mod bonus;
pub mod path;
pub mod query;
pub mod search;
pub mod similarity;

/// Container extensions treated as a playable video file (lower-case, dot-prefixed).
pub const VIDEO_EXTS: [&str; 14] = [
    ".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv", ".webm", ".m4v", ".mpg",
    ".mpeg", ".ogm", ".mts",
];

/// Episode numbers on disk in one season: `(number, endNumber, hasFile)` rows, each file covering
/// its own number and, for a multi-episode file, every number up to its end.
pub fn episodes_on_disk(
    eps: impl IntoIterator<Item = (i32, Option<i32>, bool)>,
) -> std::collections::BTreeSet<i32> {
    let mut out = std::collections::BTreeSet::new();
    for (number, end, _) in eps.into_iter().filter(|e| e.2) {
        out.extend(number..=end.filter(|n| *n > number).unwrap_or(number));
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn episodes_on_disk() {
        let disk = super::episodes_on_disk([
            (1, Some(3), true),
            (2, None, false),
            (5, Some(4), true),
            (6, None, false),
        ]);
        assert_eq!(disk.into_iter().collect::<Vec<_>>(), [1, 2, 3, 5]);
    }
}
