//! Pure rules of the catalog read routes (`docs/spec/media-query.md`).
pub mod bonus;
pub mod kind;
pub mod path;
pub mod query;
pub mod release;
pub mod search;
pub mod similarity;

/// Container extensions treated as a playable video file (lower-case, dot-prefixed).
pub const VIDEO_EXTS: [&str; 14] = [
    ".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv", ".webm", ".m4v", ".mpg",
    ".mpeg", ".ogm", ".mts",
];
