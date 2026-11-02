//! Book ingest (`docs/spec/books-files.md`): the parts that read files or need a digest crate, and the
//! EPUB reader routes (`docs/spec/books-reader.md`).
pub mod koreader;
pub mod reader;

pub use reader::{__path_resource, resource, router};
