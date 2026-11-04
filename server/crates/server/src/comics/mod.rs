//! Comics: archive reading and the page routes (`docs/spec/comics.md`, pages rules).
#[cfg(all(target_os = "linux", feature = "libarchive"))]
mod ar;
pub mod archive;
mod cache;
mod pages;
#[cfg(all(target_os = "linux", feature = "libarchive"))]
pub mod sandbox;

pub use pages::{__path_page, __path_pages, page, pages, router};
pub(crate) use pages::{MAX_WIDTH, blocking_ingest, cover, serve_page};
