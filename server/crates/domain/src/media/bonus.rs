//! Bonus clips inside a title's folder (`bonus-content.util.ts`).
use crate::js::rx;

/// A bonus-clip folder name; a scan-root child of that name is a title.
pub fn is_bonus_dir(name: &str) -> bool {
    rx!(i r"^(samples?|extras?|featurettes?|trailers?|interviews|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes)$")
        .is_match(name)
}

/// A release's sample clip: the stem ends with a `sample` token.
pub fn is_sample_file(file_name: &str) -> bool {
    let stem = match file_name.rfind('.') {
        Some(i) if i > 0 => &file_name[..i],
        _ => file_name,
    };
    rx!(i r"(?:^|[.\-_ ])sample$").is_match(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bonus_and_sample() {
        assert!(is_bonus_dir("Featurettes") && is_bonus_dir("behind.the-scenes"));
        assert!(!is_bonus_dir("Season 01") && !is_bonus_dir("extrasx"));
        assert!(is_sample_file("movie-sample.mkv") && is_sample_file("Sample.mkv"));
        assert!(!is_sample_file("Sampler.mkv") && !is_sample_file("samplefest.mkv"));
    }
}
