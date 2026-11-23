//! The media write services: creation, import, refresh, removal, relocation and the shared field writer.
pub(crate) mod album_import;
pub(crate) mod body;
pub(crate) mod book_import;
pub(crate) mod comic_import;
pub mod fields;
mod identified;
mod import;
mod monitored;
pub mod orphans;
mod refresh;
mod relocate;
mod remove;

pub use album_import::import_album_for_request;
pub use book_import::import_book_for_request;
pub use identified::*;
pub use import::*;
pub use monitored::*;
pub use refresh::*;
pub use relocate::*;
pub use remove::*;

use crate::http::AppError;

pub(crate) fn already_running() -> AppError {
    AppError::conflict("errors.already_running")
}
