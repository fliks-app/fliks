//! Pure rules of the catalog read routes (`docs/spec/media-query.md`).
pub mod path;
pub mod query;
pub mod search;
pub mod similarity;

/// Container extensions treated as a playable video file (lower-case, dot-prefixed).
pub const VIDEO_EXTS: [&str; 8] = [
    ".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv",
];
