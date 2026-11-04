//! Comics: archive reading and the page routes (`docs/spec/comics.md`, pages rules).
#[cfg(target_os = "linux")]
mod ar;
pub mod archive;
mod cache;
mod pages;

pub use pages::{__path_page, __path_pages, page, pages, router};
pub(crate) use pages::{blocking, cover};
