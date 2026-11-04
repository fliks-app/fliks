//! Comics: archive reading and the page routes (`docs/spec/comics.md`, pages rules).
pub mod archive;
mod pages;

pub(crate) use pages::cover;
pub use pages::{__path_page, __path_pages, page, pages, router};
